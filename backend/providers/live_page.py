"""Fetch and parse a page of a managed site as a crawler sees it."""
from typing import Optional

import httpx
from bs4 import BeautifulSoup
from fastapi import HTTPException

from core.db import db
from core.http_headers import BROWSER_HEADERS
from providers.seo_audit import route_path


def normalise_route(site: dict, raw: str) -> tuple[str, str]:
    """(route, absolute URL) for a route or a full URL on the site."""
    base = site["base_url"].rstrip("/")
    raw = (raw or "").strip() or "/"
    route = route_path(raw) if "://" in raw else route_path(base + (raw if raw.startswith("/") else "/" + raw))
    return route, base + ("" if route == "/" else route)


async def fetch_page(site: dict, raw: str) -> dict:
    route, url = normalise_route(site, raw)
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers=BROWSER_HEADERS) as client:
            resp = await client.get(url)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Could not fetch {url}: {type(e).__name__}")
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"{url} returned HTTP {resp.status_code}")
    soup = BeautifulSoup(resp.text, "html.parser")
    title = soup.title.get_text(strip=True) if soup.title else ""
    canonical_tag = soup.find("link", rel="canonical")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    main = soup.find("main") or soup.body or soup
    return {"route": route, "url": url, "title": title,
            "canonical": (canonical_tag.get("href") or "") if canonical_tag else "",
            "text": main.get_text(separator=" ", strip=True)}


async def known_routes(site_id: str, limit: int = 200) -> list[dict]:
    """Pages from the latest on-page audit, else synced content: [{route, url, title, canonical}]."""
    audit = await db.onpage_audits.find_one({"site_id": site_id}, {"_id": 0}, sort=[("created_at", -1)])
    out: list[dict] = []
    for p in (audit or {}).get("pages", [])[:limit]:
        sig = p.get("signals") or {}
        out.append({"route": p.get("path") or route_path(p["url"]), "url": p["url"], "title": sig.get("title", ""),
                    "canonical": sig.get("canonical", ""), "audited": True})
    if out:
        return out
    items = await db.content_items.find({"site_id": site_id, "url": {"$nin": [None, ""]}},
                                        {"_id": 0, "url": 1, "title": 1, "route": 1}).to_list(limit)
    return [{"route": i.get("route") or route_path(i["url"]), "url": i["url"], "title": i.get("title", ""),
             "canonical": None, "audited": False} for i in items]


def merge_json_ld(existing: Optional[list], new_obj: dict) -> list:
    """Replace any existing JSON-LD object of the same @type, else append."""
    kept = [o for o in (existing or []) if isinstance(o, dict) and o.get("@type") != new_obj.get("@type")]
    return kept + [new_obj]
