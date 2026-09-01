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

import httpx
from fastapi import BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from core.activity import log_activity
from core.db import db
from core.http_headers import BROWSER_HEADERS
from core.router import api_router
from core.security import require_editor, require_user
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from providers.content import get_site_any
from providers.onpage import SCORING_FACTORS, audit_url

logger = logging.getLogger(__name__)

MAX_PAGES_PER_SCAN = 50
CRAWL_DELAY_SECONDS = 0.4  # polite pacing against the site's own server


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
