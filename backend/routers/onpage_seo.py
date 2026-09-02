"""On-page SEO audit that works on any platform.

Sources every signal from the rendered HTML of the live URL, so a Next.js
site, a WordPress site or anything else is audited the same way and the score
is comparable across them. Contrast routers/auto_seo.py, which reads Yoast /
RankMath fields through the WordPress REST API and therefore only ever works
for WordPress.
"""
import asyncio
import logging
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from core.activity import log_activity
from core.db import db
from core.http_headers import BROWSER_HEADERS
from core.router import api_router
from core.security import require_editor, require_user
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from providers.content import get_platform, get_site_any
from providers.nextjs import (
    bridge_clear_meta, bridge_list_meta, bridge_set_meta, get_bridge_credentials,
)
from providers.onpage import SCORING_FACTORS, audit_url

logger = logging.getLogger(__name__)

MAX_PAGES_PER_SCAN = 50
CRAWL_DELAY_SECONDS = 0.4  # polite pacing against the site's own server


def _route_path(url: str) -> str:
    """The override store is keyed by route path; audits record full URLs."""
    from urllib.parse import urlparse
    path = urlparse(url).path or "/"
    if len(path) > 1:
        path = path.rstrip("/")
    return path or "/"


class MetaUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    path: str = ""                      # route path, e.g. "/about"
    url: str = ""                       # or a full URL, converted to a path
    title: Optional[str] = None
    description: Optional[str] = None
    canonical: Optional[str] = None
    ogTitle: Optional[str] = None
    ogDescription: Optional[str] = None
    ogImage: Optional[str] = None
    noindex: Optional[bool] = None


class OnPageScanRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    urls: list[str] = []          # explicit list wins; otherwise auto-discovered
    max_pages: int = MAX_PAGES_PER_SCAN


async def _discover_urls(site: dict, limit: int) -> tuple[list[str], str]:
    """Prefer the sitemap (authoritative and platform-neutral); fall back to
    the synced content cache. Returns (urls, source) so the UI can say where
    the list came from rather than implying completeness it can't guarantee."""
    base = (site.get("url") or "").rstrip("/")
    urls: list[str] = []

    for candidate in (f"{base}/sitemap.xml", f"{base}/sitemap_index.xml", f"{base}/wp-sitemap.xml"):
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True, headers=BROWSER_HEADERS) as c:
                resp = await c.get(candidate)
            if resp.status_code != 200 or not resp.text.strip().startswith("<"):
                continue
            root = ET.fromstring(resp.text)
            locs = [el.text.strip() for el in root.iter("{http://www.sitemaps.org/schemas/sitemap/0.9}loc") if el.text]
            if not locs:
                locs = [el.text.strip() for el in root.iter("loc") if el.text]
            # A sitemap index points at more sitemaps; follow the first few.
            if locs and all(l.endswith(".xml") for l in locs[:3]):
                nested: list[str] = []
                for child in locs[:5]:
                    try:
                        async with httpx.AsyncClient(timeout=15, follow_redirects=True, headers=BROWSER_HEADERS) as c:
                            r2 = await c.get(child)
                        if r2.status_code == 200 and r2.text.strip().startswith("<"):
                            r2root = ET.fromstring(r2.text)
                            nested += [el.text.strip() for el in r2root.iter("{http://www.sitemaps.org/schemas/sitemap/0.9}loc") if el.text]
                    except Exception:
                        continue
                locs = [u for u in nested if not u.endswith(".xml")] or locs
            urls = [u for u in locs if u.startswith("http")]
            if urls:
                return urls[:limit], f"sitemap ({candidate.rsplit('/', 1)[-1]})"
        except Exception as e:
            logger.warning(f"Sitemap discovery failed at {candidate}: {e}")
            continue

    cached = await db.posts.find({"site_id": site["id"], "link": {"$nin": [None, ""]}},
                                {"_id": 0, "link": 1}).to_list(limit)
    urls = [d["link"] for d in cached if d.get("link")]
    if urls:
        return urls[:limit], "synced posts"
    if base:
        return [base], "homepage only"
    return [], "none"


@api_router.post("/onpage/{site_id}/scan")
async def scan_onpage_seo(site_id: str, req: OnPageScanRequest, background_tasks: BackgroundTasks,
                          user=Depends(require_editor)):
    """Crawl the site's live pages and score each one. Works on any platform."""
    site = await get_site_any(site_id)
    task_id = make_task_id()
    await create_task_queue(task_id)

    async def run(tid):
        try:
            limit = max(1, min(req.max_pages, 200))
            if req.urls:
                urls, source = req.urls[:limit], "supplied"
            else:
                await push_event(tid, "progress", {"message": "Discovering pages…"})
                urls, source = await _discover_urls(site, limit)

            if not urls:
                await push_event(tid, "error", {
                    "message": "No pages found to audit. Add a sitemap at /sitemap.xml, or sync the site first.",
                })
                return

            await push_event(tid, "progress", {"message": f"Auditing {len(urls)} pages from {source}…"})
            pages, failed = [], 0
            for idx, url in enumerate(urls, start=1):
                result = await audit_url(url)
                if not result["ok"]:
                    failed += 1
                pages.append(result)
                await push_event(tid, "progress", {
                    "message": f"Audited {idx}/{len(urls)} — {url}",
                    "current": idx, "total": len(urls),
                })
                if idx < len(urls):
                    await asyncio.sleep(CRAWL_DELAY_SECONDS)

            scored = [p for p in pages if p.get("score") is not None]
            site_score = round(sum(p["score"] for p in scored) / len(scored)) if scored else None

            # Which factors are dragging the site down, across all pages.
            factor_totals: dict[str, list[int]] = {}
            for p in scored:
                for key, value in (p.get("factor_scores") or {}).items():
                    factor_totals.setdefault(key, []).append(value)
            factor_summary = [
                {"key": key, "label": label, "weight": weight,
                 "average": round(sum(factor_totals.get(key, [0])) / max(len(factor_totals.get(key, [1])), 1))}
                for key, label, weight in SCORING_FACTORS
            ]

            audit = {
                "id": str(uuid.uuid4()),
                "site_id": site_id,
                "site_score": site_score,
                "pages_audited": len(scored),
                "pages_failed": failed,
                "url_source": source,
                "factor_summary": sorted(factor_summary, key=lambda f: f["average"]),
                "pages": sorted(pages, key=lambda p: (p.get("score") is None, p.get("score", 0))),
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            await db.onpage_audits.insert_one(dict(audit))
            audit.pop("_id", None)
            await log_activity(site_id, "onpage_audit",
                               f"On-page audit: {len(scored)} pages, site score {site_score}")
            await push_event(tid, "complete", {
                "message": f"Audited {len(scored)} pages — site score {site_score}.",
                "site_score": site_score, "pages_audited": len(scored), "pages_failed": failed,
            })
        except Exception as e:
            logger.error(f"On-page audit failed for {site_id}: {e}")
            await push_event(tid, "error", {"message": str(e)})
        finally:
            await finish_task(tid)

    background_tasks.add_task(run, task_id)
    return {"task_id": task_id}


@api_router.get("/onpage/{site_id}")
async def get_onpage_audit(site_id: str, user=Depends(require_user)):
    """The most recent audit for this site."""
    doc = await db.onpage_audits.find_one({"site_id": site_id}, {"_id": 0}, sort=[("created_at", -1)])
    if not doc:
        return {"site_id": site_id, "site_score": None, "pages": [], "factor_summary": [],
                "pages_audited": 0, "message": "No audit yet — run a scan."}
    return doc


@api_router.get("/onpage/{site_id}/pages")
async def list_onpage_pages(site_id: str, user=Depends(require_user)):
    """Every page known for this site, with its latest score and any SEO
    metadata override currently in force. This is the browse-and-fix view:
    pages come from the last audit (or the sitemap if none has run yet), and
    overrides come from the site's own bridge."""
    site = await get_site_any(site_id)
    platform = site.get("platform", "wordpress")

    audit = await db.onpage_audits.find_one({"site_id": site_id}, {"_id": 0}, sort=[("created_at", -1)])
    by_url: dict[str, dict] = {}
    for page in (audit or {}).get("pages", []):
        by_url[page["url"]] = page

    audited = bool(by_url)
    if not by_url:
        # No audit has run yet — list the pages we know about so they can still
        # be browsed and edited, explicitly flagged as un-audited rather than
        # left to look like fetch failures.
        urls, _source = await _discover_urls(site, MAX_PAGES_PER_SCAN)
        for u in urls:
            by_url[u] = {"url": u, "score": None, "issues": [], "ok": None, "audited": False}

    overrides: dict = {}
    meta_supported = platform != "wordpress"
    meta_error = None
    if meta_supported:
        try:
            bridge_site = await get_bridge_credentials(site_id)
            overrides = await bridge_list_meta(bridge_site)
        except HTTPException as e:
            meta_supported, meta_error = False, e.detail

    pages = []
    for url, page in by_url.items():
        route = _route_path(url)
        signals = page.get("signals") or {}
        pages.append({
            "url": url,
            "path": route,
            "score": page.get("score"),
            # `audited` distinguishes "we fetched it and it failed" from "we
            # have never looked at it" — conflating those told the user their
            # pages were unreachable when they simply hadn't been scanned.
            "audited": page.get("audited", audited),
            "ok": page.get("ok"),
            "error": page.get("error"),
            "signals": signals or None,
            "issue_count": len(page.get("issues") or []),
            "issues": page.get("issues") or [],
            "live_title": signals.get("title", ""),
            "live_description": signals.get("description", ""),
            "override": overrides.get(route),
        })
    pages.sort(key=lambda p: (p["score"] is None, p["score"] if p["score"] is not None else 0))

    return {
        "site_id": site_id,
        "platform": platform,
        "pages": pages,
        "meta_editing_supported": meta_supported,
        "meta_editing_note": meta_error or (
            None if meta_supported else
            "Editing metadata here is for non-WordPress sites. For WordPress, use the SEO page's apply-meta action."
        ),
        "audited_at": (audit or {}).get("created_at"),
    }


@api_router.put("/onpage/{site_id}/meta")
async def set_onpage_meta(site_id: str, body: MetaUpdate, user=Depends(require_editor)):
    """Set the meta title/description (and OG/canonical/noindex) for one page.

    Writes to the site's own override store through the bridge, so it applies
    to static pages as well as blog posts — a static page's metadata lives in
    generateMetadata() and cannot be rewritten from outside the repo."""
    if await get_platform(site_id) == "wordpress":
        raise HTTPException(
            status_code=400,
            detail="This endpoint writes overrides through the Next.js SEO Bridge. "
                   "For a WordPress site, use the SEO page's apply-meta action instead.",
        )
    raw = body.path.strip() or body.url.strip()
    if not raw:
        raise HTTPException(status_code=400, detail="Supply either `path` (e.g. \"/about\") or `url`.")
    # Accept a full URL in either field and always reduce it to a route path.
    # A full URL stored as the key would land under something like
    # "/https:/host/page" — an override the site could never read back.
    route = _route_path(raw) if "://" in raw else _route_path("http://x" + (raw if raw.startswith("/") else "/" + raw))

    fields = {k: v for k, v in body.model_dump(
        exclude={"path", "url"}, exclude_none=True).items()}
    if not fields:
        raise HTTPException(status_code=400, detail="Nothing to set — supply at least one field, e.g. `title`.")

    site = await get_bridge_credentials(site_id)
    result = await bridge_set_meta(site, route, fields)
    await log_activity(site_id, "onpage_meta_updated",
                       f"Updated SEO metadata for {route}: {', '.join(sorted(fields))}")

    # Re-score the live page so the caller sees the effect of the edit rather
    # than having to re-run a whole audit. The bridge revalidates on write, but
    # give the render a moment to land before fetching.
    rescored = None
    page_url = f"{(site.get('url') or '').rstrip('/')}{route}"
    try:
        await asyncio.sleep(1.5)
        fresh = await audit_url(page_url)
        if fresh.get("ok"):
            rescored = {
                "url": page_url,
                "score": fresh.get("score"),
                "issues": fresh.get("issues", []),
                "title": (fresh.get("signals") or {}).get("title", ""),
                "description": (fresh.get("signals") or {}).get("description", ""),
            }
            # Keep the stored audit in step so the table and site score reflect it.
            audit = await db.onpage_audits.find_one({"site_id": site_id}, sort=[("created_at", -1)])
            if audit:
                pages = audit.get("pages", [])
                for idx, existing in enumerate(pages):
                    if existing.get("url") == page_url:
                        pages[idx] = fresh
                        break
                scored = [p["score"] for p in pages if p.get("score") is not None]
                await db.onpage_audits.update_one(
                    {"_id": audit["_id"]},
                    {"$set": {"pages": pages,
                              "site_score": round(sum(scored) / len(scored)) if scored else None}},
                )
        else:
            rescored = {"url": page_url, "score": None, "error": fresh.get("error")}
    except Exception as e:
        logger.warning(f"Could not re-score {page_url} after a metadata update: {e}")

    return {**result, "rescored": rescored}


@api_router.delete("/onpage/{site_id}/meta")
async def clear_onpage_meta(site_id: str, path: str, user=Depends(require_editor)):
    """Remove the override for a route, handing control back to the page's own
    generateMetadata()."""
    if await get_platform(site_id) == "wordpress":
        raise HTTPException(status_code=400, detail="Not applicable to WordPress sites.")
    site = await get_bridge_credentials(site_id)
    result = await bridge_clear_meta(site, path)
    await log_activity(site_id, "onpage_meta_cleared", f"Cleared SEO metadata override for {path}")
    return result


@api_router.get("/onpage/{site_id}/history")
async def get_onpage_history(site_id: str, user=Depends(require_user)):
    """Score over time, so improvements are visible rather than asserted."""
    docs = await db.onpage_audits.find(
        {"site_id": site_id}, {"_id": 0, "created_at": 1, "site_score": 1, "pages_audited": 1},
    ).sort("created_at", -1).to_list(50)
    return list(reversed(docs))


@api_router.post("/onpage/{site_id}/page")
async def audit_single_page(site_id: str, req: OnPageScanRequest, user=Depends(require_editor)):
    """Audit one URL immediately, without a background task."""
    await get_site_any(site_id)
    if not req.urls:
        raise HTTPException(status_code=400, detail="Supply a URL in `urls`.")
    return await audit_url(req.urls[0])
