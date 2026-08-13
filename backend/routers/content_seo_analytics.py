"""
Content & SEO analytics features: Predictive Ranking Model, Competitor Content
Comparison, Anchor Text Distribution, Social Signal SEO Mapping, and A/B Title
SEO Testing.

Moved verbatim from two separate non-adjacent locations in the original
server.py (lines 2776-2819 and lines 2988-3259).
"""
from fastapi import HTTPException, Depends
from pydantic import BaseModel
from datetime import datetime, timezone, timedelta
import uuid
import httpx
import json

from core.db import db
from core.security import get_current_user, require_user, require_editor
from core.activity import log_activity
from providers.wordpress import get_wp_credentials, wp_api_request
from core.ai import get_ai_response
from core.router import api_router  # the shared APIRouter instance

# ========================
# FEATURE: Predictive Ranking Model (Module 5)
# ========================

@api_router.get("/rank-tracker/{site_id}/predictions")
async def predict_keyword_rankings(site_id: str, _=Depends(require_editor)):
    """Linear regression on last 30 days to forecast rank trend."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    snapshots = await db.tracked_keywords.find({"site_id": site_id, "tracked_at": {"$gte": cutoff}}, {"_id": 0}).sort("tracked_at", 1).to_list(60)
    if len(snapshots) < 3:
        return {"site_id": site_id, "predictions": [], "message": "Need at least 3 data points"}

    from collections import defaultdict
    kw_series = defaultdict(list)
    for i, snap in enumerate(snapshots):
        for kw in snap.get("keywords", []):
            keyword = kw.get("keyword", "")
            position = kw.get("position", 0)
            if keyword and position > 0:
                kw_series[keyword].append({"day": i, "position": position})

    predictions = []
    for keyword, series in kw_series.items():
        if len(series) < 3:
            continue
        n = len(series)
        x_vals = [s["day"] for s in series]
        y_vals = [s["position"] for s in series]
        x_mean = sum(x_vals) / n
        y_mean = sum(y_vals) / n
        num = sum((x - x_mean) * (y - y_mean) for x, y in zip(x_vals, y_vals))
        den = sum((x - x_mean) ** 2 for x in x_vals)
        slope = num / den if den != 0 else 0
        intercept = y_mean - slope * x_mean
        predicted = max(1, round(slope * (x_vals[-1] + 30) + intercept, 1))
        trend = "improving" if slope < -0.1 else ("declining" if slope > 0.1 else "stable")
        predictions.append({"keyword": keyword, "current_position": y_vals[-1], "predicted_position_30d": predicted,
            "trend": trend, "slope": round(slope, 3), "data_points": n,
            "confidence": "high" if n >= 14 else ("medium" if n >= 7 else "low")})

    predictions.sort(key=lambda x: abs(x["slope"]), reverse=True)
    return {"site_id": site_id, "predictions": predictions, "snapshot_count": len(snapshots)}


# ========================
# FEATURE: Competitor Content Comparison (Module 10)
# ========================

class CompareCompetitorRequest(BaseModel):
    text: str
    competitor_url: str

@api_router.post("/ai-content-detector/{site_id}/compare-competitor")
async def compare_competitor_content(site_id: str, data: CompareCompetitorRequest, _=Depends(require_user)):
    """Compare user content against a competitor URL for SEO gaps and advantages."""
    text = data.text.strip()
    competitor_url = data.competitor_url.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required")
    if not competitor_url:
        raise HTTPException(status_code=400, detail="Competitor URL is required")

    # Fetch competitor page
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            resp = await client.get(competitor_url, headers={"User-Agent": "Mozilla/5.0 (compatible; SEOBot/1.0)"})
            resp.raise_for_status()
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(resp.text, "html.parser")
            for tag in soup(["script", "style", "nav", "footer", "header"]):
                tag.decompose()
            competitor_text = soup.get_text(separator="\n", strip=True)[:3000]
    except httpx.ConnectError:
        raise HTTPException(status_code=502, detail="Could not connect to competitor URL")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Competitor URL timed out")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch competitor page: {str(e)}")

    user_text = text[:3000]
    prompt = f"""Compare these two pieces of content for SEO quality. Respond with JSON only.

YOUR CONTENT:
\"\"\"{user_text}\"\"\"

COMPETITOR CONTENT:
\"\"\"{competitor_text}\"\"\"

Return JSON:
{{
  "your_score": {{ "word_count": <n>, "readability": "good"|"average"|"poor", "keyword_density": "optimal"|"low"|"high",
    "content_depth": <1-10>, "structure_quality": <1-10> }},
  "competitor_score": {{ "word_count": <n>, "readability": "good"|"average"|"poor", "keyword_density": "optimal"|"low"|"high",
    "content_depth": <1-10>, "structure_quality": <1-10> }},
  "gaps": ["topics or angles the competitor covers that you don't"],
  "advantages": ["areas where your content is stronger"],
  "verdict": "your_content_better"|"competitor_better"|"roughly_equal",
  "recommendations": ["actionable suggestions to improve your content"]
}}"""

    try:
        ai_resp = await get_ai_response([
            {"role": "system", "content": "SEO content analyst. JSON only."},
            {"role": "user", "content": prompt},
        ], max_tokens=1500, temperature=0.3)
        if "```json" in ai_resp:
            ai_resp = ai_resp.split("```json")[1].split("```")[0]
        elif "```" in ai_resp:
            ai_resp = ai_resp.split("```")[1].split("```")[0]
        result = json.loads(ai_resp.strip())
        await log_activity(site_id, "compare_competitor", f"Compared with {competitor_url}: {result.get('verdict', 'unknown')}")
        return {"site_id": site_id, "competitor_url": competitor_url, **result}
    except json.JSONDecodeError:
        return {"site_id": site_id, "competitor_url": competitor_url, "raw_analysis": ai_resp, "error": "Could not parse structured response"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ========================
# FEATURE: Anchor Text Distribution (Module 9)
# ========================

@api_router.get("/link-builder/{site_id}/anchor-distribution")
async def anchor_text_distribution(site_id: str, _=Depends(require_editor)):
    """Analyze backlink anchor text distribution: branded, exact-match, partial, generic, naked URL."""
    site = await get_wp_credentials(site_id, _["id"])
    site_url = site["url"].rstrip("/")
    from urllib.parse import urlparse
    site_domain = urlparse(site_url).hostname or ""
    brand_name = site_domain.split(".")[0].lower()

    backlinks = await db.backlink_data.find({"site_id": site_id}, {"_id": 0}).to_list(500)
    if not backlinks:
        try:
            ai_resp = await get_ai_response([
                {"role": "system", "content": "SEO backlink analyst. JSON only."},
                {"role": "user", "content": f"""Anchor text distribution for '{site_domain}'. Return JSON:
{{"total_backlinks": <n>, "distribution": {{"branded": {{"count": <n>, "percentage": <0-100>, "examples": []}},
"exact_match": {{"count": <n>, "percentage": <0-100>, "examples": []}},
"partial_match": {{"count": <n>, "percentage": <0-100>, "examples": []}},
"generic": {{"count": <n>, "percentage": <0-100>, "examples": ["click here"]}},
"naked_url": {{"count": <n>, "percentage": <0-100>, "examples": ["{site_url}"]}}}},
"health_assessment": "natural"|"over_optimized"|"needs_diversification", "recommendations": ["r1"]}}"""},
            ], max_tokens=1000)
            if "```json" in ai_resp:
                ai_resp = ai_resp.split("```json")[1].split("```")[0]
            elif "```" in ai_resp:
                ai_resp = ai_resp.split("```")[1].split("```")[0]
            result = json.loads(ai_resp.strip())
            result["source"] = "ai_estimate"
            return result
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    categories = {"branded": [], "exact_match": [], "partial_match": [], "generic": [], "naked_url": []}
    generic_anchors = {"click here", "read more", "learn more", "here", "this", "visit", "link", "source", "website"}
    for bl in backlinks:
        anchor = bl.get("anchor_text", "").strip().lower()
        if not anchor or anchor in generic_anchors:
            categories["generic"].append(anchor)
        elif site_domain in anchor or brand_name in anchor:
            categories["branded"].append(anchor)
        elif anchor.startswith("http") or anchor.startswith("www."):
            categories["naked_url"].append(anchor)
        else:
            categories["partial_match"].append(anchor)

    total = max(len(backlinks), 1)
    distribution = {cat: {"count": len(anchors), "percentage": round(len(anchors) / total * 100, 1),
        "examples": list(set(anchors))[:5]} for cat, anchors in categories.items()}

    health = "natural"
    if distribution.get("exact_match", {}).get("percentage", 0) > 60:
        health = "over_optimized"
    elif distribution.get("branded", {}).get("percentage", 0) < 10:
        health = "needs_diversification"

    return {"site_id": site_id, "total_backlinks": len(backlinks), "distribution": distribution, "health_assessment": health, "source": "actual_data"}


# ========================
# FEATURE: Social Signal SEO Mapping (Module 9)
# ========================

@api_router.get("/link-builder/{site_id}/social-signals")
async def social_signal_mapping(site_id: str, _=Depends(require_editor)):
    """Map social engagement signals to SEO performance for top posts."""
    site = await get_wp_credentials(site_id, _["id"])

    # Fetch recent posts from WP
    resp = await wp_api_request(site, "GET", "posts?per_page=20&orderby=date&order=desc&_fields=id,title,link")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch posts from WordPress")
    posts = resp.json()
    if not posts:
        return {"site_id": site_id, "posts": []}

    # Check DB for cached social data
    cached = await db.social_signals.find({"site_id": site_id}).to_list(100)
    cached_map = {str(c.get("wp_id")): c for c in cached}

    results = []
    for post in posts[:20]:
        wp_id = str(post.get("id", ""))
        title_raw = post.get("title", {})
        title = title_raw.get("rendered", "") if isinstance(title_raw, dict) else str(title_raw)
        link = post.get("link", "")

        if wp_id in cached_map:
            c = cached_map[wp_id]
            results.append({
                "title": title, "url": link, "wp_id": wp_id,
                "shares": c.get("shares", 0), "likes": c.get("likes", 0),
                "comments": c.get("comments", 0), "signal_score": c.get("signal_score", 0),
                "seo_position": c.get("seo_position"), "platforms": c.get("platforms", []),
            })
        else:
            # Use AI to estimate social signals
            results.append({
                "title": title, "url": link, "wp_id": wp_id,
                "shares": 0, "likes": 0, "comments": 0,
                "signal_score": 0, "seo_position": None, "platforms": [],
            })

    # If no cached data, generate AI estimates for all posts
    if not cached:
        try:
            titles_list = "\n".join([f"- {r['title']}" for r in results[:10]])
            ai_resp = await get_ai_response([
                {"role": "system", "content": "Social media SEO analyst. JSON only."},
                {"role": "user", "content": f"""Estimate social engagement for these blog posts. Return JSON:
{{"posts": [{{"title": "<title>", "shares": <n>, "likes": <n>, "comments": <n>,
"signal_score": <0-100>, "seo_position": <1-100 or null>, "platforms": ["twitter", "facebook", ...]}}]}}

Posts:
{titles_list}"""},
            ], max_tokens=2000, temperature=0.4)
            if "```json" in ai_resp:
                ai_resp = ai_resp.split("```json")[1].split("```")[0]
            elif "```" in ai_resp:
                ai_resp = ai_resp.split("```")[1].split("```")[0]
            ai_data = json.loads(ai_resp.strip())
            ai_posts = ai_data.get("posts", [])
            for i, ap in enumerate(ai_posts):
                if i < len(results):
                    results[i].update({
                        "shares": ap.get("shares", 0), "likes": ap.get("likes", 0),
                        "comments": ap.get("comments", 0), "signal_score": ap.get("signal_score", 0),
                        "seo_position": ap.get("seo_position"), "platforms": ap.get("platforms", []),
                    })
        except Exception:
            pass

    await log_activity(site_id, "social_signals", f"Social signal mapping: {len(results)} posts analyzed")
    return {"site_id": site_id, "posts": results}


# ========================
# FEATURE: A/B Title SEO Testing (Module 5)
# ========================

class ABTitleTestRequest(BaseModel):
    wp_id: int
    content_type: str = "post"
    variant_title: str

@api_router.post("/ab-testing/{site_id}/title-test")
async def create_ab_title_test(site_id: str, data: ABTitleTestRequest, _=Depends(require_editor)):
    """Create A/B test for post title (SEO title variant). Track CTR via GSC."""
    site = await get_wp_credentials(site_id, _["id"])
    endpoint = "pages" if data.content_type == "page" else "posts"
    resp = await wp_api_request(site, "GET", f"{endpoint}/{data.wp_id}?_fields=id,title,link")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch post")

    post = resp.json()
    title_raw = post.get("title", {})
    original_title = title_raw.get("rendered", "") if isinstance(title_raw, dict) else str(title_raw)

    test_id = str(uuid.uuid4())
    test_doc = {"id": test_id, "site_id": site_id, "type": "title_test", "wp_id": data.wp_id,
        "content_type": data.content_type, "original_title": original_title, "variant_title": data.variant_title,
        "post_url": post.get("link", ""), "status": "running", "created_at": datetime.now(timezone.utc).isoformat(),
        "phase": "original", "phase_switch_at": (datetime.now(timezone.utc) + timedelta(days=3)).isoformat(),
        "conclude_at": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
        "metrics": {"original": {"impressions": 0, "clicks": 0, "ctr": 0}, "variant": {"impressions": 0, "clicks": 0, "ctr": 0}}}
    await db.ab_title_tests.insert_one(test_doc)
    await log_activity(site_id, "ab_title_test_created", f"Title A/B test: '{original_title}' vs '{data.variant_title}'")
    return test_doc

@api_router.get("/ab-testing/{site_id}/title-tests")
async def list_title_tests(site_id: str, _=Depends(get_current_user)):
    return await db.ab_title_tests.find({"site_id": site_id}, {"_id": 0}).sort("created_at", -1).to_list(50)

@api_router.post("/ab-testing/{site_id}/title-test/{test_id}/conclude")
async def conclude_title_test(site_id: str, test_id: str, _=Depends(require_editor)):
    """Conclude A/B title test and declare winner based on CTR."""
    test = await db.ab_title_tests.find_one({"id": test_id, "site_id": site_id}, {"_id": 0})
    if not test:
        raise HTTPException(status_code=404, detail="Test not found")

    metrics = test.get("metrics", {})
    orig_ctr = metrics.get("original", {}).get("ctr", 0)
    var_ctr = metrics.get("variant", {}).get("ctr", 0)
    winner = "variant" if var_ctr > orig_ctr else "original"
    winning_title = test["variant_title"] if winner == "variant" else test["original_title"]

    if winner == "variant":
        site = await get_wp_credentials(site_id, _["id"])
        endpoint = "pages" if test["content_type"] == "page" else "posts"
        await wp_api_request(site, "POST", f"{endpoint}/{test['wp_id']}", json_data={"title": test["variant_title"]})

    await db.ab_title_tests.update_one({"id": test_id},
        {"$set": {"status": "concluded", "winner": winner, "winning_title": winning_title,
                  "concluded_at": datetime.now(timezone.utc).isoformat()}})
    await log_activity(site_id, "ab_title_concluded", f"Title test: '{winning_title}' won ({winner})")
    return {"test_id": test_id, "winner": winner, "winning_title": winning_title, "original_ctr": orig_ctr, "variant_ctr": var_ctr}
