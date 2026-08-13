"""DataForSEO-backed keyword intelligence: search volume, keyword ideas, SERP
analysis, live rank tracking, backlinks, competitor keyword gap, and a
connection-test endpoint. Falls back to an AI estimate (clearly flagged
`is_estimated: true` via `_data_meta`) when no DataForSEO credentials are
configured.
"""
import json
from datetime import datetime, timezone

import httpx
from fastapi import Depends, HTTPException, Query
from pydantic import BaseModel
from typing import List

from core.activity import log_activity
from core.ai import get_ai_response
from core.crypto import get_decrypted_settings
from core.db import db
from core.router import api_router
from core.security import require_admin, require_editor, require_user
from providers.dataforseo import (
    DFS_TTL, _cache_get, _cache_key, _cache_set, _data_meta, _dfs_auth_header,
    _dfs_available, _dfs_check_spend, _get_dfs_credentials, dataforseo_post,
)
from providers.google_analytics import fetch_gsc_metrics

import logging
logger = logging.getLogger(__name__)


class KeywordMetricsRequest(BaseModel):
    keywords: List[str]
    location_code: int = 2840
    language_code: str = "en"

@api_router.post("/keywords/{site_id}/metrics")
async def get_keyword_metrics(site_id: str, data: KeywordMetricsRequest, _=Depends(require_editor)):
    """Get real keyword metrics (volume, CPC, competition) from DataForSEO."""
    keywords = [k.strip() for k in data.keywords if k.strip()][:100]
    if not keywords:
        raise HTTPException(status_code=400, detail="No keywords provided")

    cache_k = _cache_key("search_volume", keywords, data.location_code, data.language_code)
    cached = await _cache_get(cache_k, DFS_TTL["search_volume"])
    if cached:
        return {**cached, **_data_meta("dataforseo_cached", is_estimated=False)}

    if not await _dfs_available():
        # AI fallback
        ai_resp = await get_ai_response([
            {"role": "system", "content": "You are an SEO keyword data expert. Provide realistic estimates. Return JSON only."},
            {"role": "user", "content": f"Estimate monthly search volume, CPC, and competition for these keywords: {json.dumps(keywords)}. "
             f'Return JSON: {{"items": [{{"keyword": "...", "search_volume": <int>, "cpc": <float>, "competition": <float 0-1>, "competition_level": "LOW|MEDIUM|HIGH", "keyword_difficulty": <int 0-100>, "monthly_searches": []}}]}}'},
        ], max_tokens=2000, temperature=0.3)
        for fence in ["```json", "```"]:
            if fence in ai_resp:
                ai_resp = ai_resp.split(fence)[1].split("```")[0]
                break
        result = json.loads(ai_resp.strip())
        result["items"] = result.get("items", [])
        return {**result, **_data_meta("ai_estimate", is_estimated=True)}

    cost = len(keywords) * 0.0015
    await _dfs_check_spend(site_id, cost)

    try:
        result_data = await dataforseo_post("/v3/keywords_data/google_ads/search_volume/live", [{
            "keywords": keywords,
            "location_code": data.location_code,
            "language_code": data.language_code,
        }])
        items_raw = result_data[0].get("items", []) if result_data else []
        items = []
        for item in items_raw:
            comp = item.get("competition", 0) or 0
            items.append({
                "keyword": item.get("keyword", ""),
                "search_volume": item.get("search_volume", 0),
                "competition": comp,
                "competition_level": item.get("competition_level", "LOW"),
                "cpc": item.get("cpc", 0),
                "monthly_searches": item.get("monthly_searches", []),
                "keyword_difficulty": round(comp * 100),
            })

        result = {"items": items}
        await _cache_set(cache_k, result)
        await log_activity(site_id, "dataforseo_call", f"DataForSEO search_volume: ~${cost:.4f}")
        return {**result, **_data_meta("dataforseo", is_estimated=False)}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"DataForSEO search_volume failed: {e}")
        raise HTTPException(status_code=502, detail=f"DataForSEO API error: {str(e)}")


class KeywordIdeasRequest(BaseModel):
    seed_keyword: str
    location_code: int = 2840
    language_code: str = "en"
    limit: int = 50

@api_router.post("/keywords/{site_id}/ideas")
async def get_keyword_ideas(site_id: str, data: KeywordIdeasRequest, _=Depends(require_editor)):
    """Get related keyword ideas with metrics from DataForSEO."""
    seed = data.seed_keyword.strip()
    if not seed:
        raise HTTPException(status_code=400, detail="Seed keyword is required")

    cache_k = _cache_key("keyword_ideas", seed, data.location_code, data.language_code)
    cached = await _cache_get(cache_k, DFS_TTL["keyword_ideas"])
    if cached:
        return {**cached, **_data_meta("dataforseo_cached", is_estimated=False)}

    if not await _dfs_available():
        ai_resp = await get_ai_response([
            {"role": "system", "content": "You are an SEO keyword researcher. Return JSON only."},
            {"role": "user", "content": f"Generate {data.limit} related keyword ideas for: \"{seed}\". "
             f'For each keyword include volume, CPC, competition, and intent. '
             f'Return JSON: {{"items": [{{"keyword": "...", "search_volume": <int>, "cpc": <float>, "competition": <float 0-1>, "competition_level": "LOW|MEDIUM|HIGH", "intent": "informational|transactional|navigational|commercial"}}]}}'},
        ], max_tokens=3000, temperature=0.5)
        for fence in ["```json", "```"]:
            if fence in ai_resp:
                ai_resp = ai_resp.split(fence)[1].split("```")[0]
                break
        result = json.loads(ai_resp.strip())
        return {**result, **_data_meta("ai_estimate", is_estimated=True)}

    cost = 0.0015
    await _dfs_check_spend(site_id, cost)

    try:
        result_data = await dataforseo_post("/v3/keywords_data/google_ads/keywords_for_keywords/live", [{
            "keywords": [seed],
            "location_code": data.location_code,
            "language_code": data.language_code,
        }])
        items_raw = result_data[0].get("items", []) if result_data else []
        items_raw.sort(key=lambda x: x.get("search_volume", 0) or 0, reverse=True)
        items_raw = items_raw[:data.limit]

        items = []
        for item in items_raw:
            comp = item.get("competition", 0) or 0
            items.append({
                "keyword": item.get("keyword", ""),
                "search_volume": item.get("search_volume", 0),
                "cpc": item.get("cpc", 0),
                "competition": comp,
                "competition_level": item.get("competition_level", "LOW"),
                "keyword_difficulty": round(comp * 100),
                "intent": None,
            })

        # Batch classify intent via AI for top 20
        if items:
            top_kws = [i["keyword"] for i in items[:20]]
            try:
                ai_resp = await get_ai_response([
                    {"role": "user", "content": f"Classify these keywords by search intent. Return JSON only: "
                     f'{{"intents": {{"keyword": "informational|transactional|navigational|commercial"}}}} '
                     f"Keywords: {json.dumps(top_kws)}"},
                ], max_tokens=800, temperature=0.2)
                for fence in ["```json", "```"]:
                    if fence in ai_resp:
                        ai_resp = ai_resp.split(fence)[1].split("```")[0]
                        break
                intents = json.loads(ai_resp.strip()).get("intents", {})
                for item in items:
                    item["intent"] = intents.get(item["keyword"])
            except Exception:
                pass

        result = {"items": items, "seed_keyword": seed, "total_returned": len(items)}
        await _cache_set(cache_k, result)
        await log_activity(site_id, "dataforseo_call", f"DataForSEO keyword_ideas: ~${cost:.4f}")
        return {**result, **_data_meta("dataforseo", is_estimated=False)}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"DataForSEO keyword_ideas failed: {e}")
        raise HTTPException(status_code=502, detail=f"DataForSEO API error: {str(e)}")


class SERPAnalysisRequest(BaseModel):
    keyword: str
    location_code: int = 2840
    language_code: str = "en"
    device: str = "desktop"

@api_router.post("/keywords/{site_id}/serp")
async def get_serp_analysis(site_id: str, data: SERPAnalysisRequest, _=Depends(require_editor)):
    """Get real SERP results for a keyword from DataForSEO."""
    keyword = data.keyword.strip()
    if not keyword:
        raise HTTPException(status_code=400, detail="Keyword is required")

    cache_k = _cache_key("serp", keyword, data.location_code, data.language_code, data.device)
    cached = await _cache_get(cache_k, DFS_TTL["serp"])
    if cached:
        return {**cached, **_data_meta("dataforseo_cached", is_estimated=False)}

    if not await _dfs_available():
        ai_resp = await get_ai_response([
            {"role": "system", "content": "You are an SEO SERP analyst. Return JSON only."},
            {"role": "user", "content": f"Estimate the top 10 Google SERP results for: \"{keyword}\". "
             f'Return JSON: {{"organic": [{{"position": <int>, "title": "...", "url": "...", "domain": "...", "description": "...", "domain_rank": <int>}}], '
             f'"people_also_ask": [{{"question": "..."}}], "related_searches": [{{"query": "..."}}]}}'},
        ], max_tokens=2500, temperature=0.5)
        for fence in ["```json", "```"]:
            if fence in ai_resp:
                ai_resp = ai_resp.split(fence)[1].split("```")[0]
                break
        result = json.loads(ai_resp.strip())
        return {**result, **_data_meta("ai_estimate", is_estimated=True)}

    cost = 0.0006
    await _dfs_check_spend(site_id, cost)

    try:
        result_data = await dataforseo_post("/v3/serp/google/organic/live/advanced", [{
            "keyword": keyword,
            "location_code": data.location_code,
            "language_code": data.language_code,
            "device": data.device,
            "depth": 10,
        }])
        raw_items = result_data[0].get("items", []) if result_data else []

        organic = []
        people_also_ask = []
        related_searches = []
        featured_snippet = None

        for item in raw_items:
            # DataForSEO's SERP response isn't uniformly typed — some item
            # types (and their nested "items" sub-arrays, e.g. related_searches)
            # come back as plain strings rather than dicts. Handle both shapes
            # instead of assuming .get() always works, which was crashing this
            # endpoint with "'str' object has no attribute 'get'".
            if not isinstance(item, dict):
                continue
            item_type = item.get("type", "")
            if item_type == "organic":
                organic.append({
                    "position": item.get("rank_absolute", 0),
                    "title": item.get("title", ""),
                    "url": item.get("url", ""),
                    "domain": item.get("domain", ""),
                    "description": item.get("description", ""),
                    "breadcrumb": item.get("breadcrumb", ""),
                    "is_featured_snippet": False,
                    "domain_rank": item.get("domain_rank", 0),
                })
            elif item_type == "featured_snippet":
                featured_snippet = {
                    "title": item.get("title", ""),
                    "url": item.get("url", ""),
                    "domain": item.get("domain", ""),
                    "description": item.get("description", ""),
                }
            elif item_type == "people_also_ask":
                for sub in item.get("items", []):
                    if isinstance(sub, dict):
                        people_also_ask.append({"question": sub.get("title", "")})
                    elif isinstance(sub, str):
                        people_also_ask.append({"question": sub})
            elif item_type == "related_searches":
                for sub in item.get("items", []):
                    if isinstance(sub, dict):
                        related_searches.append({"query": sub.get("title", "")})
                    elif isinstance(sub, str):
                        related_searches.append({"query": sub})

        result = {
            "keyword": keyword,
            "organic": organic,
            "people_also_ask": people_also_ask,
            "related_searches": related_searches,
            "featured_snippet": featured_snippet,
        }
        await _cache_set(cache_k, result)
        await log_activity(site_id, "dataforseo_call", f"DataForSEO SERP: ~${cost:.4f}")
        return {**result, **_data_meta("dataforseo", is_estimated=False)}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"DataForSEO SERP failed: {e}")
        raise HTTPException(status_code=502, detail=f"DataForSEO API error: {str(e)}")


class LiveRankCheckRequest(BaseModel):
    keywords: List[str]
    domain: str
    location_code: int = 2840
    language_code: str = "en"

@api_router.post("/rank-tracker/{site_id}/check-live")
async def check_live_rankings(site_id: str, data: LiveRankCheckRequest, _=Depends(require_user)):
    """Check live SERP positions for keywords + domain via DataForSEO."""
    keywords = [k.strip() for k in data.keywords if k.strip()][:20]
    domain = data.domain.strip().lower()
    if not keywords or not domain:
        raise HTTPException(status_code=400, detail="Keywords and domain are required")

    results = []
    for kw in keywords:
        cache_k = _cache_key("rank_check", kw, domain, data.location_code, data.language_code)
        cached = await _cache_get(cache_k, DFS_TTL["rank_check"])
        if cached:
            results.append(cached)
            continue

        if not await _dfs_available():
            # GSC fallback
            try:
                settings = await get_decrypted_settings()
                site_doc = await db.sites.find_one({"id": site_id}, {"_id": 0})
                site_url = settings.get("gsc_site_url") or (site_doc.get("url", "") if site_doc else "")
                gsc_rows = await fetch_gsc_metrics(settings, site_url)
                gsc_pos = None
                for row in gsc_rows:
                    if kw.lower() in row.get("keyword", "").lower():
                        gsc_pos = round(row.get("ranking", 0))
                        break
                entry = {"keyword": kw, "position": gsc_pos, "position_change": None,
                         "url_ranking": None, "checked_at": datetime.now(timezone.utc).isoformat(),
                         **_data_meta("gsc", is_estimated=False)}
                results.append(entry)
                continue
            except Exception:
                pass
            # AI fallback
            results.append({"keyword": kw, "position": None, "position_change": None,
                            "url_ranking": None, "checked_at": datetime.now(timezone.utc).isoformat(),
                            **_data_meta("ai_estimate", is_estimated=True)})
            continue

        cost = 0.0006
        await _dfs_check_spend(site_id, cost)

        try:
            result_data = await dataforseo_post("/v3/serp/google/organic/live/advanced", [{
                "keyword": kw,
                "location_code": data.location_code,
                "language_code": data.language_code,
                "device": "desktop",
                "depth": 100,
            }])
            raw_items = result_data[0].get("items", []) if result_data else []
            position = None
            url_ranking = None
            for item in raw_items:
                if item.get("type") == "organic" and domain in (item.get("domain", "") or "").lower():
                    position = item.get("rank_absolute")
                    url_ranking = item.get("url", "")
                    break

            # Compare with previous snapshot
            prev = await db.rank_live_checks.find_one(
                {"site_id": site_id, "keyword": kw, "domain": domain},
                sort=[("checked_at", -1)]
            )
            prev_pos = prev.get("position") if prev else None
            position_change = None
            if prev_pos is not None and position is not None:
                position_change = prev_pos - position  # positive = improved

            entry = {
                "keyword": kw, "position": position, "position_change": position_change,
                "url_ranking": url_ranking, "checked_at": datetime.now(timezone.utc).isoformat(),
                **_data_meta("dataforseo", is_estimated=False),
            }
            await db.rank_live_checks.insert_one({
                "site_id": site_id, "keyword": kw, "domain": domain,
                "position": position, "url_ranking": url_ranking,
                "checked_at": datetime.now(timezone.utc),
            })
            await _cache_set(cache_k, entry)
            await log_activity(site_id, "dataforseo_call", f"DataForSEO rank_check '{kw}': ~${cost:.4f}")
            results.append(entry)
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"DataForSEO rank check '{kw}' failed: {e}")
            results.append({"keyword": kw, "position": None, "position_change": None,
                            "url_ranking": None, "checked_at": datetime.now(timezone.utc).isoformat(),
                            "error": str(e), **_data_meta("dataforseo", is_estimated=True)})

    return {"site_id": site_id, "domain": domain, "results": results}


class BacklinksLiveRequest(BaseModel):
    domain: str
    limit: int = 100

@api_router.post("/link-builder/{site_id}/backlinks-live")
async def get_live_backlinks(site_id: str, data: BacklinksLiveRequest, _=Depends(require_editor)):
    """Get real backlink data from DataForSEO Backlinks API."""
    domain = data.domain.strip().lower()
    if not domain:
        raise HTTPException(status_code=400, detail="Domain is required")

    cache_k_summary = _cache_key("backlink_summary", domain)
    cached_summary = await _cache_get(cache_k_summary, DFS_TTL["backlink_summary"])
    cache_k_list = _cache_key("backlink_list", domain, data.limit)
    cached_list = await _cache_get(cache_k_list, DFS_TTL["backlink_list"])

    if cached_summary and cached_list:
        return {**cached_summary, "backlinks": cached_list.get("backlinks", []),
                **_data_meta("dataforseo_cached", is_estimated=False)}

    if not await _dfs_available():
        ai_resp = await get_ai_response([
            {"role": "system", "content": "SEO backlink analyst. JSON only."},
            {"role": "user", "content": f"Estimate backlink profile for domain '{domain}'. "
             f'Return JSON: {{"total_backlinks": <int>, "referring_domains": <int>, "domain_rank": <int>, '
             f'"broken_backlinks": <int>, "dofollow_backlinks": <int>, "nofollow_backlinks": <int>, '
             f'"backlinks": [], "toxic_count": 0}}'},
        ], max_tokens=500, temperature=0.3)
        for fence in ["```json", "```"]:
            if fence in ai_resp:
                ai_resp = ai_resp.split(fence)[1].split("```")[0]
                break
        result = json.loads(ai_resp.strip())
        return {**result, **_data_meta("ai_estimate", is_estimated=True)}

    cost = 0.004  # summary + list
    await _dfs_check_spend(site_id, cost)

    try:
        # Backlink summary
        summary_data = await dataforseo_post("/v3/backlinks/summary/live", [{
            "target": domain, "include_subdomains": True,
        }])
        s = summary_data[0] if summary_data else {}
        summary = {
            "total_backlinks": s.get("backlinks", 0),
            "referring_domains": s.get("referring_domains", 0),
            "domain_rank": s.get("rank", 0),
            "broken_backlinks": s.get("broken_backlinks", 0),
            "referring_ips": s.get("referring_ips", 0),
            "dofollow_backlinks": s.get("dofollow", 0),
            "nofollow_backlinks": s.get("nofollow", 0),
        }
        await _cache_set(cache_k_summary, summary)

        # Detailed backlink list
        list_data = await dataforseo_post("/v3/backlinks/backlinks/live", [{
            "target": domain, "limit": data.limit, "mode": "as_is",
        }])
        raw_links = list_data[0].get("items", []) if list_data else []
        backlinks = []
        toxic_count = 0
        for bl in raw_links:
            spam = bl.get("spam_score", 0) or 0
            if spam > 40:
                toxic_count += 1
            backlinks.append({
                "source_url": bl.get("url_from", ""),
                "target_url": bl.get("url_to", ""),
                "anchor_text": bl.get("anchor", ""),
                "domain_rank": bl.get("domain_from_rank", 0),
                "is_dofollow": bl.get("dofollow", False),
                "first_seen": bl.get("first_seen", ""),
                "last_seen": bl.get("last_seen", ""),
                "spam_score": spam,
            })

        list_result = {"backlinks": backlinks}
        await _cache_set(cache_k_list, list_result)
        await log_activity(site_id, "dataforseo_call", f"DataForSEO backlinks: ~${cost:.4f}")
        return {**summary, "backlinks": backlinks, "toxic_count": toxic_count,
                **_data_meta("dataforseo", is_estimated=False)}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"DataForSEO backlinks failed: {e}")
        raise HTTPException(status_code=502, detail=f"DataForSEO API error: {str(e)}")


class CompetitorGapRequest(BaseModel):
    your_domain: str
    competitor_domains: List[str]
    location_code: int = 2840
    language_code: str = "en"

@api_router.post("/keywords/{site_id}/competitor-gap")
async def get_competitor_gap(site_id: str, data: CompetitorGapRequest, _=Depends(require_editor)):
    """Find keywords competitors rank for that you don't."""
    your_domain = data.your_domain.strip().lower()
    competitors = [d.strip().lower() for d in data.competitor_domains if d.strip()][:3]
    if not your_domain or not competitors:
        raise HTTPException(status_code=400, detail="Your domain and at least one competitor are required")

    cache_k = _cache_key("competitor_gap", your_domain, competitors, data.location_code)
    cached = await _cache_get(cache_k, DFS_TTL["competitor_gap"])
    if cached:
        return {**cached, **_data_meta("dataforseo_cached", is_estimated=False)}

    if not await _dfs_available():
        ai_resp = await get_ai_response([
            {"role": "system", "content": "SEO gap analysis expert. Return JSON only."},
            {"role": "user", "content": f"Estimate keyword gap between {your_domain} and {competitors}. "
             f'Return JSON: {{"gap_keywords": [{{"keyword": "...", "search_volume": <int>, "cpc": <float>, "competition_level": "LOW|MEDIUM|HIGH", "competing_domains": ["..."]}}], '
             f'"easy_wins": [{{"keyword": "...", "search_volume": <int>, "cpc": <float>, "competition_level": "LOW"}}]}}'},
        ], max_tokens=2000, temperature=0.5)
        for fence in ["```json", "```"]:
            if fence in ai_resp:
                ai_resp = ai_resp.split(fence)[1].split("```")[0]
                break
        result = json.loads(ai_resp.strip())
        return {**result, **_data_meta("ai_estimate", is_estimated=True)}

    cost = 0.0015 * (1 + len(competitors))
    await _dfs_check_spend(site_id, cost)

    try:
        # Get keywords for each domain
        async def _get_domain_kws(target: str):
            r = await dataforseo_post("/v3/keywords_data/google_ads/keywords_for_site/live", [{
                "target": target,
                "location_code": data.location_code,
                "language_code": data.language_code,
            }])
            items = r[0].get("items", []) if r else []
            return {item.get("keyword", ""): item for item in items if item.get("keyword")}

        your_kws_map = await _get_domain_kws(your_domain)
        your_kw_set = set(your_kws_map.keys())

        competitor_keywords = {}
        all_comp_kws = set()
        for comp in competitors:
            comp_map = await _get_domain_kws(comp)
            competitor_keywords[comp] = list(comp_map.keys())[:200]
            all_comp_kws.update(comp_map.keys())

        gap_set = all_comp_kws - your_kw_set
        gap_keywords = []
        for kw in gap_set:
            # Find the item data from any competitor
            item_data = None
            competing = []
            for comp in competitors:
                comp_map_kws = competitor_keywords.get(comp, [])
                if kw in comp_map_kws:
                    competing.append(comp)

            # Try to find metrics from the first competitor
            for comp in competitors:
                r = await dataforseo_post("/v3/keywords_data/google_ads/search_volume/live", [{
                    "keywords": [kw], "location_code": data.location_code, "language_code": data.language_code,
                }])
                if r and r[0].get("items"):
                    item_data = r[0]["items"][0]
                break

            if item_data:
                comp_val = item_data.get("competition", 0) or 0
                vol = item_data.get("search_volume", 0) or 0
                gap_keywords.append({
                    "keyword": kw,
                    "search_volume": vol,
                    "cpc": item_data.get("cpc", 0),
                    "competition_level": item_data.get("competition_level", "MEDIUM"),
                    "keyword_difficulty": round(comp_val * 100),
                    "competing_domains": competing,
                })

        gap_keywords.sort(key=lambda x: x.get("search_volume", 0), reverse=True)
        gap_keywords = gap_keywords[:100]
        easy_wins = [k for k in gap_keywords
                     if k.get("search_volume", 0) > 100 and k.get("competition_level") == "LOW"]

        result = {
            "your_domain": your_domain,
            "your_keyword_count": len(your_kw_set),
            "competitor_keywords": {c: len(kws) for c, kws in competitor_keywords.items()},
            "gap_keywords": gap_keywords,
            "easy_wins": easy_wins[:20],
        }
        await _cache_set(cache_k, result)
        await log_activity(site_id, "dataforseo_call", f"DataForSEO competitor_gap: ~${cost:.4f}")
        return {**result, **_data_meta("dataforseo", is_estimated=False)}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"DataForSEO competitor_gap failed: {e}")
        raise HTTPException(status_code=502, detail=f"DataForSEO API error: {str(e)}")


@api_router.get("/integrations/dataforseo/test")
async def test_dataforseo_connection(
    login: str = Query(None),
    password: str = Query(None),
    _=Depends(require_admin),
):
    """Test DataForSEO API connection and return account balance.
    Accepts optional login/password query params to test before saving."""
    # Use inline creds if provided, else fall back to stored creds
    if login and password:
        dfs_login, dfs_password = login, password
    else:
        dfs_login, dfs_password = await _get_dfs_credentials()
    if not dfs_login or not dfs_password:
        return {"connected": False, "error": "DataForSEO credentials not configured"}
    try:
        url = "https://api.dataforseo.com/v3/appendix/user_data"
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, headers=_dfs_auth_header(dfs_login, dfs_password))
            resp.raise_for_status()
            data = resp.json()
            tasks = data.get("tasks", [])
            result = tasks[0].get("result", []) if tasks else []
        if isinstance(result, list) and result:
            money = result[0].get("money", {})
        elif isinstance(result, dict):
            money = result.get("money", {})
        else:
            money = {}
        balance = money.get("balance", 0)
        return {"connected": True, "credits_usd": balance}
    except httpx.HTTPStatusError as e:
        return {"connected": False, "error": f"HTTP {e.response.status_code}: Authentication failed" if e.response.status_code == 401 else f"HTTP {e.response.status_code}"}
    except Exception as e:
        return {"connected": False, "error": str(e)}
