"""Indexing Tracker (sitemap/cache URL discovery cross-referenced against GSC
to find un-indexed pages, batch GSC sitemap submission).
"""
import logging
import uuid
from datetime import datetime, timezone

import httpx
from bs4 import BeautifulSoup
from fastapi import BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

from core.activity import log_activity
from core.crypto import get_decrypted_settings
from core.db import db
from core.http_headers import BROWSER_HEADERS
from core.router import api_router
from core.safe_fetch import SSRF_GUARD
from core.security import require_editor, require_user
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from providers.google_analytics import fetch_gsc_metrics, get_google_credentials

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────
# Feature: Indexing Tracker
# ─────────────────────────────────────────────────────────────────

class SitemapBatch(BaseModel):
    sitemap_url: str
    batch_size: int = 1000

@api_router.post("/indexing/{site_id}/check")
async def check_indexing_status(
    site_id: str,
    background_tasks: BackgroundTasks,
    _: dict = Depends(require_user),
):
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_check_indexing, task_id, site_id)
    return {"task_id": task_id}

async def _check_indexing(task_id: str, site_id: str):
    try:
        site = await db.sites.find_one({"id": site_id}, {"_id": 0})
        if not site:
            await push_event(task_id, "error", {"message": "Site not found"})
            return

        # Try fetching sitemap
        site_url = site.get("base_url", "").rstrip("/")
        sitemap_url = f"{site_url}/sitemap.xml"
        await push_event(task_id, "status", {"message": f"Fetching sitemap from {sitemap_url}...", "percent": 10})

        urls = []
        try:
            async with httpx.AsyncClient(event_hooks=SSRF_GUARD, timeout=15, follow_redirects=True, headers=BROWSER_HEADERS) as hc:
                resp = await hc.get(sitemap_url)
                if resp.status_code == 200:
                    soup = BeautifulSoup(resp.text, "xml")
                    for loc in soup.find_all("loc"):
                        urls.append(loc.get_text().strip())
        except Exception:
            pass

        if not urls:
            # Fallback: use cached pages/posts
            items = await db.content_items.find({"site_id": site_id, "url": {"$nin": [None, ""]}},
                                                {"_id": 0, "url": 1}).to_list(400)
            urls = [p["url"] for p in items]

        total = len(urls)
        await push_event(task_id, "status", {"message": f"Found {total} URLs. Checking GSC index status...", "percent": 20})

        # Check via GSC
        settings = await get_decrypted_settings()
        gsc_site_url = settings.get("gsc_site_url") or site_url
        gsc_rows = await fetch_gsc_metrics(settings, gsc_site_url)
        indexed_urls = {row.get("page_url", "") for row in gsc_rows}

        results = []
        batches = []
        week = 1
        batch_urls = []
        for url in urls:
            is_indexed = url in indexed_urls or any(url.rstrip("/") in iu for iu in indexed_urls)
            results.append({
                "url": url,
                "indexed": is_indexed,
                "priority": "high" if not is_indexed else "low",
            })
            if not is_indexed:
                batch_urls.append(url)
                if len(batch_urls) == 1000:
                    batches.append({"week": week, "urls": batch_urls, "count": len(batch_urls)})
                    batch_urls = []
                    week += 1
        if batch_urls:
            batches.append({"week": week, "urls": batch_urls, "count": len(batch_urls)})

        indexed_count = sum(1 for r in results if r["indexed"])
        doc = {
            "id": str(uuid.uuid4()),
            "site_id": site_id,
            "total_urls": total,
            "indexed_count": indexed_count,
            "not_indexed_count": total - indexed_count,
            "pages": results[:200],
            "submission_batches": batches[:8],
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.indexing_reports.replace_one({"site_id": site_id}, doc, upsert=True)

        await push_event(task_id, "complete", {
            "message": f"Done: {indexed_count}/{total} indexed",
            "percent": 100,
            "indexed": indexed_count,
            "total": total,
        })
        await log_activity(site_id, "indexing_checked", f"Indexing check: {indexed_count}/{total} indexed")
    except Exception as e:
        await push_event(task_id, "error", {"message": str(e)})
    finally:
        await finish_task(task_id)

@api_router.get("/indexing/{site_id}")
async def get_indexing_report(site_id: str, _: dict = Depends(require_user)):
    doc = await db.indexing_reports.find_one({"site_id": site_id}, {"_id": 0})
    if not doc:
        return {"site_id": site_id, "total_urls": 0, "indexed_count": 0, "not_indexed_count": 0, "pages": [], "submission_batches": [], "checked_at": None}
    return doc

@api_router.post("/indexing/{site_id}/submit-sitemap")
async def submit_sitemap_to_gsc(site_id: str, body: SitemapBatch, _: dict = Depends(require_editor)):
    settings = await get_decrypted_settings()
    try:
        from googleapiclient.discovery import build
        from googleapiclient.errors import HttpError
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="google-api-python-client is not installed. Run: pip install google-api-python-client"
        )
    try:
        creds = await get_google_credentials(settings)
        if not creds:
            raise HTTPException(
                status_code=400,
                detail="Google Search Console credentials not configured. Go to Settings → Google Integration and upload your service account JSON."
            )
        service = build("searchconsole", "v1", credentials=creds, cache_discovery=False)
        site_doc = await db.sites.find_one({"id": site_id}, {"_id": 0}) or {}
        # gsc_site_url must match exactly how the property is verified in GSC
        # (e.g. "https://example.com/" or "sc-domain:example.com")
        site_url = settings.get("gsc_site_url") or site_doc.get("base_url", "")
        if not site_url:
            raise HTTPException(
                status_code=400,
                detail="GSC site URL not set. Add 'gsc_site_url' in Settings (must match your GSC property exactly)."
            )
        try:
            service.sitemaps().submit(siteUrl=site_url, feedpath=body.sitemap_url).execute()
        except HttpError as he:
            status = he.resp.status if hasattr(he, 'resp') else 0
            if status == 403:
                raise HTTPException(
                    status_code=403,
                    detail=(
                        f"GSC permission denied. Ensure the service account is added as a verified owner of "
                        f"'{site_url}' in Google Search Console. Error: {he.error_details}"
                    )
                )
            elif status == 404:
                raise HTTPException(
                    status_code=404,
                    detail=(
                        f"GSC site '{site_url}' not found. The gsc_site_url in Settings must exactly match "
                        f"a verified property in Google Search Console (including trailing slash)."
                    )
                )
            raise HTTPException(status_code=502, detail=f"GSC API error {status}: {str(he)[:300]}")
        await log_activity(site_id, "sitemap_submitted", f"Submitted sitemap: {body.sitemap_url}")
        return {"submitted": True, "sitemap_url": body.sitemap_url, "gsc_site_url": site_url}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

