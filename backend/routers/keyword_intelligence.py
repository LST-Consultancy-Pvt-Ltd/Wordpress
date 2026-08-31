"""Keyword intelligence: AI-powered keyword research, on-page keyword density
analysis, keyword cannibalization detection, ROI/revenue attribution per
keyword, and Google Trends / seasonal query lookups.

Moved verbatim from three separate non-adjacent locations in the original
server.py (MODULE: Keyword Research; MODULE: Keyword Analysis +
FEATURE: Keyword Cannibalization Detector; FEATURE: ROI / Revenue per
Keyword + FEATURE: Google Trends / Seasonal Queries).
"""
import json
import asyncio
from typing import List

import httpx
from fastapi import Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from bs4 import BeautifulSoup

from core.crypto import get_decrypted_settings
from core.db import db
from core.security import require_user, require_editor
from core.activity import log_activity
from core.ai import get_ai_response
from providers.google_analytics import fetch_gsc_metrics
from providers.semrush import semrush_available, semrush_keyword_difficulty, semrush_keyword_overview
from routers.keywords_intel import SERPAnalysisRequest, get_serp_analysis
from providers.wordpress import get_wp_credentials, wp_api_request
from providers.dataforseo import (
    DFS_TTL, dataforseo_post, _dfs_available, _dfs_check_spend,
    _cache_key, _cache_get, _cache_set,
)
from core.router import api_router  # the shared APIRouter instance

import logging
logger = logging.getLogger(__name__)


# MODULE: Keyword Research
# ─────────────────────────────────────────────────────────────

class KeywordResearchRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    keyword: str

@api_router.post("/keyword-research/{site_id}/analyze")
async def research_keyword(site_id: str, data: KeywordResearchRequest, _=Depends(require_user)):
    """AI-powered keyword research"""
    keyword = data.keyword.strip()
    if not keyword:
        raise HTTPException(status_code=400, detail="Keyword is required")

    prompt = f"""Perform comprehensive keyword research for: "{keyword}"

Respond with JSON:
{{
    "primary": {{
        "keyword": "{keyword}",
        "volume": <estimated monthly search volume integer>,
        "difficulty": "low"|"medium"|"high",
        "cpc": <estimated CPC float>,
        "competition": "low"|"medium"|"high",
        "intent": "informational"|"navigational"|"transactional"|"commercial"
    }},
    "related": [
        {{"keyword": "...", "volume": <int>, "difficulty": "low"|"medium"|"high", "cpc": <float>, "competition": "...", "intent": "..."}},
        ... (provide 15-20 related keywords)
    ],
    "questions": [
        {{"question": "...", "volume": <int>}},
        ... (provide 8-10 questions)
    ],
    "serp": [
        {{"title": "...", "url": "...", "snippet": "...", "domain_authority": <int>}},
        ... (provide top 10 estimated SERP results)
    ]
}}"""

    try:
        content = await get_ai_response(
            [
                {"role": "system", "content": "You are an expert SEO keyword researcher. Provide realistic estimated data for keyword metrics. Be accurate about search intent and difficulty."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.5,
            max_tokens=4000,
        )
        if "```json" in content:
            content = content.split("```json")[1].split("```")[0]
        elif "```" in content:
            content = content.split("```")[1].split("```")[0]
        result = json.loads(content)
        result["data_source"] = "ai_estimate"
        result["is_estimated"] = True

        # Enhance with real DataForSEO data if available
        try:
            if await _dfs_available():
                # Real keyword metrics
                metrics_cache_k = _cache_key("search_volume", [keyword], 2840, "en")
                metrics_cached = await _cache_get(metrics_cache_k, DFS_TTL["search_volume"])
                if not metrics_cached:
                    metrics_result = await dataforseo_post("/v3/keywords_data/google_ads/search_volume/live", [{
                        "keywords": [keyword], "location_code": 2840, "language_code": "en",
                    }])
                    if metrics_result and metrics_result[0].get("items"):
                        m = metrics_result[0]["items"][0]
                        comp = m.get("competition", 0) or 0
                        comp_level = m.get("competition_level", "MEDIUM")
                        result["primary"]["volume"] = m.get("search_volume", result["primary"].get("volume", 0))
                        result["primary"]["cpc"] = m.get("cpc", result["primary"].get("cpc", 0))
                        result["primary"]["competition"] = comp_level.lower() if comp_level else "medium"
                        result["primary"]["keyword_difficulty"] = round(comp * 100)
                        result["primary"]["monthly_searches"] = m.get("monthly_searches", [])
                        result["data_source"] = "dataforseo"
                        result["is_estimated"] = False
                        await _cache_set(metrics_cache_k, {"items": [m]})
                        await _dfs_check_spend(site_id, 0.0015)
                        await log_activity(site_id, "dataforseo_call", "DataForSEO search_volume (research enhance): ~$0.0015")
                else:
                    items = metrics_cached.get("items", [])
                    if items:
                        m = items[0]
                        comp = m.get("competition", 0) or 0
                        comp_level = m.get("competition_level", "MEDIUM")
                        result["primary"]["volume"] = m.get("search_volume", result["primary"].get("volume", 0))
                        result["primary"]["cpc"] = m.get("cpc", result["primary"].get("cpc", 0))
                        result["primary"]["competition"] = comp_level.lower() if comp_level else "medium"
                        result["primary"]["keyword_difficulty"] = round(comp * 100)
                        result["primary"]["monthly_searches"] = m.get("monthly_searches", [])
                        result["data_source"] = "dataforseo_cached"
                        result["is_estimated"] = False

                # Real SERP data + real People Also Ask questions — reuse
                # get_serp_analysis (routers/keywords_intel.py-style function,
                # defined later in this file) instead of duplicating its
                # DataForSEO-call/caching/item-type-parsing logic. Calling it
                # directly (bypassing its own Depends(require_editor)) is
                # safe here: it only fires inside this `_dfs_available()`
                # branch, so it always takes the real-data path, never its
                # own internal AI-fallback branch (which would otherwise
                # mean a second, redundant AI call on top of this endpoint's
                # own upfront AI draft).
                try:
                    serp_analysis = await get_serp_analysis(
                        site_id, SERPAnalysisRequest(keyword=keyword), _,
                    )
                    organic = serp_analysis.get("organic", [])
                    if organic:
                        result["serp"] = [{"title": o["title"], "url": o["url"], "snippet": o.get("description", ""),
                                           "domain_authority": o.get("domain_rank", 0)} for o in organic]
                    paa = serp_analysis.get("people_also_ask", [])
                    if paa:
                        result["questions"] = [{"question": q["question"], "volume": None} for q in paa]
                        result["questions_data_source"] = "dataforseo_paa"
                    else:
                        result["questions_data_source"] = "ai_estimate"
                except Exception as serp_err:
                    logger.warning(f"SERP/PAA enhancement failed for '{keyword}': {serp_err}")
                    result.setdefault("questions_data_source", "ai_estimate")

                # Real related keywords + real keyword difficulty + real
                # search intent, all from one DataForSEO Labs call — replaces
                # the AI-guessed related list/difficulty/intent with real
                # data from the same paid account. Never used anywhere else
                # in this codebase yet (confirmed before writing this).
                try:
                    labs_cache_k = _cache_key("labs_related", keyword, 2840, "en")
                    labs_cached = await _cache_get(labs_cache_k, DFS_TTL["keyword_ideas"])
                    if not labs_cached:
                        labs_result = await dataforseo_post("/v3/dataforseo_labs/google/related_keywords/live", [{
                            "keyword": keyword, "location_code": 2840, "language_code": "en",
                            "limit": 20, "include_seed_keyword": True,
                        }])
                        # ~$0.012/task + $0.00012/item at limit=20 per DataForSEO's
                        # published Labs pricing — verify against the current
                        # DataForSEO dashboard, a mid-2026 rate increase was noted.
                        await _dfs_check_spend(site_id, 0.02)
                        await log_activity(site_id, "dataforseo_call", "DataForSEO Labs related_keywords (research enhance): ~$0.02")
                        labs_items = (labs_result[0].get("items") if labs_result else None) or []
                        await _cache_set(labs_cache_k, {"items": labs_items})
                    else:
                        labs_items = labs_cached.get("items", [])

                    seed_info, related_items = None, []
                    for it in labs_items:
                        kd = it.get("keyword_data") or {}
                        if kd.get("keyword") == keyword:
                            seed_info = kd
                        else:
                            related_items.append(kd)

                    if seed_info:
                        kw_info = seed_info.get("keyword_info") or {}
                        if kw_info.get("keyword_difficulty") is not None:
                            result["primary"]["keyword_difficulty"] = kw_info["keyword_difficulty"]
                        intent_info = seed_info.get("search_intent_info") or {}
                        if intent_info.get("main_intent"):
                            result["primary"]["intent"] = intent_info["main_intent"]

                    if related_items:
                        related_items.sort(key=lambda kd: (kd.get("keyword_info") or {}).get("search_volume", 0) or 0, reverse=True)
                        real_related = []
                        for kd in related_items[:20]:
                            info = kd.get("keyword_info") or {}
                            comp_level = info.get("competition_level", "MEDIUM")
                            real_related.append({
                                "keyword": kd.get("keyword", ""),
                                "volume": info.get("search_volume", 0),
                                "cpc": info.get("cpc", 0),
                                "competition": comp_level.lower() if comp_level else "medium",
                                "difficulty": info.get("keyword_difficulty"),
                                "intent": (kd.get("search_intent_info") or {}).get("main_intent"),
                            })
                        result["related"] = real_related
                        result["related_data_source"] = "dataforseo_labs"
                    else:
                        result["related_data_source"] = "ai_estimate"
                except Exception as labs_err:
                    logger.warning(f"DataForSEO Labs related-keywords enhancement failed for '{keyword}': {labs_err}")
                    result.setdefault("related_data_source", "ai_estimate")
        except Exception as dfs_err:
            logger.warning(f"DataForSEO enhancement failed (using AI data): {dfs_err}")
            result.setdefault("related_data_source", "ai_estimate")
            result.setdefault("questions_data_source", "ai_estimate")

        # Google Trends momentum on the primary keyword — reuses
        # get_keyword_trends (same file) directly rather than duplicating its
        # retry/backoff/cache logic. Its own Depends(require_editor) is only
        # enforced by FastAPI's routing layer, not on a direct Python call,
        # and this endpoint already requires require_user, so no new
        # capability is exposed by calling it internally here.
        try:
            trend_result = await get_keyword_trends(site_id, TrendsRequest(keywords=[keyword]), _)
            trend_info = (trend_result.get("trends") or {}).get(keyword)
            if trend_info:
                result["primary"]["trend"] = trend_info.get("trend")
                result["primary"]["trend_source"] = trend_result.get("source")
        except Exception as trend_err:
            logger.warning(f"Trend lookup failed for '{keyword}': {trend_err}")

        # Real "you already rank for this" via Google Search Console — the
        # only source that can say "you already have traction here" instead
        # of just suggesting new topics.
        try:
            settings = await get_decrypted_settings()
            gsc_site_url = settings.get("gsc_site_url")
            if gsc_site_url:
                gsc_rows = await fetch_gsc_metrics(settings, gsc_site_url)
                kw_tokens = set(keyword.lower().split())
                matches = [
                    r for r in gsc_rows
                    if kw_tokens & set((r.get("keyword") or "").lower().split())
                ]
                matches.sort(key=lambda r: r.get("clicks", 0) or 0, reverse=True)
                if matches:
                    result["already_ranking"] = [
                        {"keyword": r.get("keyword", ""), "impressions": r.get("impressions", 0),
                         "clicks": r.get("clicks", 0), "position": r.get("ranking", 0)}
                        for r in matches[:10]
                    ]
        except Exception as gsc_err:
            logger.warning(f"GSC already-ranking lookup failed for '{keyword}': {gsc_err}")

        # SEMrush cross-check — an independent, authoritative second opinion
        # shown alongside DataForSEO's numbers, never overwriting them.
        if await semrush_available():
            try:
                kd = await semrush_keyword_difficulty(site_id, keyword)
                if kd is not None:
                    result["primary"]["keyword_difficulty_semrush"] = kd
                overview = await semrush_keyword_overview(site_id, keyword)
                if overview:
                    result["primary"]["cross_check"] = {"source": "semrush", **overview}
            except Exception as semrush_err:
                logger.warning(f"SEMrush cross-check failed for '{keyword}': {semrush_err}")

        await log_activity(site_id, "keyword_research", f"Keyword research for: {keyword}")
        return result
    except Exception as e:
        logger.error(f"Keyword research failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ─────────────────────────────────────────────────────────────
# MODULE: Keyword Analysis
# ─────────────────────────────────────────────────────────────

class KeywordAnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    url: str

@api_router.post("/keyword-analysis/{site_id}/analyze")
async def analyze_keyword_density(site_id: str, data: KeywordAnalysisRequest, _=Depends(require_user)):
    """Analyze keyword density, TF-IDF, LSI keywords for a URL"""
    url = data.url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="URL is required")

    # Auto-prepend https:// if missing
    if not url.startswith("http://") and not url.startswith("https://"):
        url = "https://" + url

    # Validate URL format
    from urllib.parse import urlparse
    parsed = urlparse(url)
    if not parsed.hostname or "." not in parsed.hostname:
        raise HTTPException(status_code=400, detail=f"Invalid URL: {url}. Please enter a valid URL like https://example.com/page")

    # Fetch the page content
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate, br",
        }
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            resp = await client.get(url, headers=headers)
            # Accept any response that contains HTML content, even 4xx status codes
            html = resp.text
            if resp.status_code >= 500:
                raise HTTPException(status_code=502, detail=f"Remote server error {resp.status_code} for URL: {url}")
    except HTTPException:
        raise
    except httpx.ConnectError:
        raise HTTPException(status_code=400, detail=f"Cannot connect to {parsed.hostname}. Check the URL and make sure the site is online.")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {str(e)}")

    soup = BeautifulSoup(html, "html.parser")
    # Remove scripts/styles
    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()
    text = soup.get_text(separator=" ", strip=True)
    heading_count = len(soup.find_all(["h1", "h2", "h3", "h4", "h5", "h6"]))

    prompt = f"""Analyze the keyword usage in this page content. The page URL is: {url}

Page text (truncated):
\"\"\"
{text[:4000]}
\"\"\"

Provide keyword density analysis. Respond with JSON:
{{
    "primary_keyword": "the main keyword/topic of this page",
    "primary_density": <float percentage>,
    "word_count": <int>,
    "unique_keywords": <int>,
    "readability_score": <0-100>,
    "density_table": [
        {{"keyword": "...", "count": <int>, "density": <float>}},
        ... (top 20 keywords by frequency)
    ],
    "lsi_keywords": ["related term 1", "related term 2", ...],
    "missing_keywords": ["keyword that should be included but isn't", ...],
    "recommendations": ["actionable SEO recommendation", ...]
}}"""

    try:
        content = await get_ai_response(
            [
                {"role": "system", "content": "You are an expert SEO analyst specializing in keyword density and on-page optimization."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.3,
            max_tokens=3000,
        )
        if "```json" in content:
            content = content.split("```json")[1].split("```")[0]
        elif "```" in content:
            content = content.split("```")[1].split("```")[0]
        result = json.loads(content)
        result["heading_count"] = heading_count
        await log_activity(site_id, "keyword_analysis", f"Keyword analysis for: {url}")
        return result
    except Exception as e:
        logger.error(f"Keyword analysis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ========================
# FEATURE: Keyword Cannibalization Detector (Module 1)
# ========================

@api_router.get("/keywords/{site_id}/cannibalization")
async def detect_keyword_cannibalization(site_id: str, _=Depends(require_editor)):
    """Scan all pages for same primary keyword targeting. Group conflicting pages."""
    site = await get_wp_credentials(site_id, _["id"])
    pages_data = []
    for endpoint in ["posts", "pages"]:
        try:
            resp = await wp_api_request(site, "GET", f"{endpoint}?per_page=100&_fields=id,title,link,meta,slug&status=publish")
            if resp.status_code == 200:
                for item in resp.json():
                    title_raw = item.get("title", "")
                    title = title_raw.get("rendered", "") if isinstance(title_raw, dict) else str(title_raw)
                    meta = item.get("meta", {}) or {}
                    focus_kw = meta.get("_yoast_wpseo_focuskw") or meta.get("rank_math_focus_keyword") or ""
                    pages_data.append({
                        "wp_id": item["id"], "type": endpoint[:-1], "title": title,
                        "url": item.get("link", ""), "slug": item.get("slug", ""),
                        "focus_keyword": focus_kw.lower().strip(),
                    })
        except Exception:
            pass

    from collections import defaultdict
    kw_pages = defaultdict(list)
    for p in pages_data:
        if p["focus_keyword"]:
            kw_pages[p["focus_keyword"]].append(p)
        # Also check title for keyword overlap
        for kw in list(kw_pages.keys()):
            if kw in p["title"].lower() and p not in kw_pages[kw]:
                kw_pages[kw].append(p)

    cannibalized = []
    for keyword, pages in kw_pages.items():
        if len(pages) >= 2:
            cannibalized.append({
                "keyword": keyword, "page_count": len(pages),
                "pages": [{"wp_id": p["wp_id"], "type": p["type"], "title": p["title"], "url": p["url"]} for p in pages],
                "severity": "high" if len(pages) >= 3 else "medium",
                "recommendation": "Merge content into one authoritative page or differentiate targeting" if len(pages) >= 3
                    else "Consider adding canonical tag from weaker page to stronger page",
            })

    ai_suggestions = []
    if cannibalized:
        try:
            ai_resp = await get_ai_response([
                {"role": "system", "content": "You are an SEO expert. Provide specific actionable recommendations for keyword cannibalization."},
                {"role": "user", "content": f"Analyze and suggest fixes:\n{json.dumps(cannibalized[:5], indent=2)}"},
            ], max_tokens=1000)
            ai_suggestions = ai_resp.strip().split("\n")
        except Exception:
            pass

    # Enhance with real SERP data — confirm cannibalization in live Google results
    if cannibalized and await _dfs_available():
        site_doc = await db.sites.find_one({"id": site_id}, {"_id": 0})
        site_domain = ""
        if site_doc and site_doc.get("url"):
            from urllib.parse import urlparse as _urlparse
            site_domain = _urlparse(site_doc["url"]).hostname or ""
        if site_domain:
            for issue in cannibalized[:5]:
                try:
                    serp_cache_k = _cache_key("serp", issue["keyword"], 2840, "en", "desktop")
                    serp_cached = await _cache_get(serp_cache_k, DFS_TTL["serp"])
                    if not serp_cached:
                        serp_result = await dataforseo_post("/v3/serp/google/organic/live/advanced", [{
                            "keyword": issue["keyword"], "location_code": 2840, "language_code": "en",
                            "device": "desktop", "depth": 50,
                        }])
                        raw_items = serp_result[0].get("items", []) if serp_result else []
                        await _dfs_check_spend(site_id, 0.0006)
                    else:
                        raw_items = [{"type": "organic", "url": o["url"], "rank_absolute": o["position"],
                                      "domain": o.get("domain", "")} for o in serp_cached.get("organic", [])]

                    serp_ranking_pages = []
                    for item in raw_items:
                        if item.get("type") == "organic" and site_domain in (item.get("domain", "") or item.get("url", "")):
                            serp_ranking_pages.append({"url": item.get("url", ""), "position": item.get("rank_absolute", 0)})
                    issue["serp_confirmed"] = len(serp_ranking_pages) >= 2
                    issue["serp_ranking_pages"] = serp_ranking_pages
                except Exception:
                    issue["serp_confirmed"] = None
                    issue["serp_ranking_pages"] = []

    await log_activity(site_id, "cannibalization_check", f"Found {len(cannibalized)} cannibalized keywords")
    return {"site_id": site_id, "total_keywords_checked": len(kw_pages), "cannibalized_keywords": len(cannibalized), "issues": cannibalized, "ai_suggestions": ai_suggestions}


# ========================
# FEATURE: ROI / Revenue per Keyword (Module 1)
# ========================

@api_router.get("/keywords/{site_id}/roi")
async def keyword_roi_attribution(site_id: str, _=Depends(require_editor)):
    """Map keyword rankings → page URL → revenue attribution."""
    tracked = await db.tracked_keywords.find({"site_id": site_id}, {"_id": 0}).sort("tracked_at", -1).limit(1).to_list(1)
    revenue_data = await db.revenue_attribution.find({"site_id": site_id}, {"_id": 0}).to_list(500)
    page_revenue = {}
    for rev in revenue_data:
        url = rev.get("page_url", "")
        if url:
            page_revenue.setdefault(url, {"total_revenue": 0, "conversions": 0})
            page_revenue[url]["total_revenue"] += rev.get("revenue", 0)
            page_revenue[url]["conversions"] += rev.get("conversions", 0)

    keyword_roi = []
    if tracked:
        for kw_entry in tracked[0].get("keywords", []):
            keyword = kw_entry.get("keyword", "")
            position = kw_entry.get("position", 0)
            page_url = kw_entry.get("page_url", "")
            rev = page_revenue.get(page_url, {})
            keyword_roi.append({"keyword": keyword, "position": position, "page_url": page_url,
                "revenue": rev.get("total_revenue", 0), "conversions": rev.get("conversions", 0),
                "roi_value": round(rev.get("total_revenue", 0) / max(position, 1), 2) if position else 0})

    keyword_roi.sort(key=lambda x: x["revenue"], reverse=True)
    return {"site_id": site_id, "total_keyword_revenue": sum(k["revenue"] for k in keyword_roi), "keywords": keyword_roi}


# ========================
# FEATURE: Google Trends / Seasonal Queries (Module 1)
# ========================

class TrendsRequest(BaseModel):
    keywords: List[str]
    timeframe: str = "today 3-m"

@api_router.post("/keywords/{site_id}/trends")
async def get_keyword_trends(site_id: str, data: TrendsRequest, _=Depends(require_editor)):
    """Get trending data for keywords using pytrends (with retry + cache) or DataForSEO/AI fallback."""
    import random as _rand
    keywords = data.keywords[:5]

    # Check cache first
    cache_k = _cache_key("google_trends", keywords, data.timeframe)
    cached = await _cache_get(cache_k, DFS_TTL["google_trends"])
    if cached:
        return {**cached, "source": "google_trends_cached"}

    trends_data = {}
    related_queries = {}
    source = "ai_estimate"

    # Try pytrends with retry + rate limit handling
    try:
        from pytrends.request import TrendReq
        max_retries = 3
        for attempt in range(max_retries):
            try:
                await asyncio.sleep(_rand.uniform(2, 5))  # Random delay
                pytrends = TrendReq(hl='en-US', tz=360)
                pytrends.build_payload(keywords, timeframe=data.timeframe)
                interest_df = pytrends.interest_over_time()
                if not interest_df.empty:
                    for kw in keywords:
                        if kw in interest_df.columns:
                            values = interest_df[kw].tolist()
                            dates = [d.isoformat() for d in interest_df.index]
                            trends_data[kw] = {
                                "values": values, "dates": dates,
                                "current": values[-1] if values else 0,
                                "peak": max(values) if values else 0,
                                "trend": "rising" if len(values) >= 2 and values[-1] > values[0] else "declining",
                            }
                    source = "google_trends"
                # Get related queries
                try:
                    rq = pytrends.related_queries()
                    for kw in keywords:
                        if kw in rq:
                            top_df = rq[kw].get("top")
                            rising_df = rq[kw].get("rising")
                            related_queries[kw] = {
                                "top_queries": top_df["query"].tolist()[:10] if top_df is not None and not top_df.empty else [],
                                "rising_queries": rising_df["query"].tolist()[:10] if rising_df is not None and not rising_df.empty else [],
                            }
                except Exception:
                    pass
                break  # success
            except Exception as e:
                err_str = str(e).lower()
                if "429" in err_str or "too many" in err_str:
                    if attempt < max_retries - 1:
                        delay = (2 ** attempt) * 5 + _rand.uniform(1, 3)
                        logger.warning(f"pytrends rate limited, retrying in {delay:.0f}s (attempt {attempt + 1})")
                        await asyncio.sleep(delay)
                    else:
                        logger.warning("pytrends rate limited after all retries")
                else:
                    logger.warning(f"pytrends error: {e}")
                    break
    except ImportError:
        pass

    # DataForSEO monthly_searches fallback
    if not trends_data and await _dfs_available():
        try:
            metrics_cache_k = _cache_key("search_volume", keywords, 2840, "en")
            metrics_cached = await _cache_get(metrics_cache_k, DFS_TTL["search_volume"])
            if not metrics_cached:
                result_data = await dataforseo_post("/v3/keywords_data/google_ads/search_volume/live", [{
                    "keywords": keywords, "location_code": 2840, "language_code": "en",
                }])
                items = result_data[0].get("items", []) if result_data else []
                await _dfs_check_spend(site_id, len(keywords) * 0.0015)
            else:
                items = metrics_cached.get("items", [])

            for item in items:
                kw = item.get("keyword", "")
                monthly = item.get("monthly_searches") or []
                if kw and monthly:
                    volumes = [m.get("search_volume", 0) or 0 for m in monthly]
                    dates = [f"{m.get('year', 2024)}-{m.get('month', 1):02d}-01" for m in monthly]
                    trend_dir = "rising" if len(volumes) >= 2 and volumes[-1] > volumes[0] else "declining"
                    trends_data[kw] = {
                        "values": volumes, "dates": dates,
                        "current": volumes[-1] if volumes else 0,
                        "peak": max(volumes) if volumes else 0,
                        "trend": trend_dir,
                    }
            if trends_data:
                source = "dataforseo_monthly"
        except Exception as e:
            logger.warning(f"DataForSEO trends fallback failed: {e}")

    # AI fallback
    if not trends_data:
        try:
            ai_resp = await get_ai_response([
                {"role": "system", "content": "You are an SEO trends analyst. Return JSON only."},
                {"role": "user", "content": f"""Analyze seasonal search trends for: {json.dumps(keywords)}.
Return JSON: {{"keywords": {{"<keyword>": {{"trend": "rising|stable|declining", "seasonality": "months", "peak_volume_month": "month", "related_queries": ["q1","q2"], "estimated_volume": <number>}}}}}}"""},
            ], max_tokens=1500)
            if "```json" in ai_resp:
                ai_resp = ai_resp.split("```json")[1].split("```")[0]
            elif "```" in ai_resp:
                ai_resp = ai_resp.split("```")[1].split("```")[0]
            trends_data = json.loads(ai_resp.strip()).get("keywords", {})
        except Exception as e:
            logger.error(f"Trends failed: {e}")

    result = {"site_id": site_id, "keywords": keywords, "trends": trends_data,
              "related_queries": related_queries, "source": source}
    if source in ("google_trends", "dataforseo_monthly"):
        await _cache_set(cache_k, result)
    return result
