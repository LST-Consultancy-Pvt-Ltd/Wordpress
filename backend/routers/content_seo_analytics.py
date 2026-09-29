"""
Content & SEO analytics features: Predictive Ranking Model, Competitor Content
Comparison, Anchor Text Distribution, Social Signal SEO Mapping, and A/B Title
SEO Testing.

Moved verbatim from two separate non-adjacent locations in the original
server.py (lines 2776-2819 and lines 2988-3259).
"""
import json
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import Depends, HTTPException
from pydantic import BaseModel

from core.activity import log_activity
from core.ai import get_ai_response
from core.db import db
from core.router import api_router  # the shared APIRouter instance
from core.safe_fetch import SSRF_GUARD
from core.security import require_editor, require_user
from providers.sites import get_site

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
        async with httpx.AsyncClient(event_hooks=SSRF_GUARD, timeout=15, follow_redirects=True) as client:
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
    site = await get_site(site_id)
    site_url = site["base_url"].rstrip("/")
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



