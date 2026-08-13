"""Google Custom Search (CSE) client — real web-search results for routes that
need to discover actual URLs/domains (guest-post sites, brand mentions,
influencers, communities, podcasts) instead of asking an LLM to invent them.

Credentials come from Settings.google_search_api_key / google_search_cx
(same fields already used by routers/calendar_competitor.py), falling back to
GOOGLE_SEARCH_API_KEY / GOOGLE_SEARCH_CX env vars.
"""
import os

import httpx

from core.crypto import get_decrypted_settings


async def _cse_credentials() -> tuple:
    settings = await get_decrypted_settings()
    api_key = settings.get("google_search_api_key") or os.environ.get("GOOGLE_SEARCH_API_KEY", "")
    cx = settings.get("google_search_cx") or os.environ.get("GOOGLE_SEARCH_CX", "")
    return api_key, cx


async def cse_available() -> bool:
    api_key, cx = await _cse_credentials()
    return bool(api_key and cx)


async def google_custom_search(query: str, num: int = 10) -> list:
    """Real Google Custom Search results: [{"title", "url", "snippet", "display_link"}, ...].

    Returns [] if CSE credentials aren't configured or every request fails.
    Callers MUST treat an empty list as "no real data available" and say so
    to the caller/user — never silently substitute invented results.
    """
    api_key, cx = await _cse_credentials()
    if not api_key or not cx:
        return []
    num = max(1, min(num, 20))
    results = []
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            start = 1
            while len(results) < num:
                page_size = min(10, num - len(results))
                resp = await client.get(
                    "https://www.googleapis.com/customsearch/v1",
                    params={"key": api_key, "cx": cx, "q": query, "num": page_size, "start": start},
                )
                if resp.status_code != 200:
                    break
                items = resp.json().get("items", [])
                if not items:
                    break
                for item in items:
                    results.append({
                        "title": item.get("title", ""),
                        "url": item.get("link", ""),
                        "snippet": item.get("snippet", ""),
                        "display_link": item.get("displayLink", ""),
                    })
                start += len(items)
                if len(items) < page_size:
                    break
    except Exception:
        pass  # partial results (if any) are still real; just stop paging
    return results[:num]
