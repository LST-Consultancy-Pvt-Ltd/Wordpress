"""Broken Link Detection: scan synced content for dead outbound links via
HEAD requests, list/dismiss results.
"""
import logging
import re
from typing import Optional

import httpx
from bs4 import BeautifulSoup
from fastapi import BackgroundTasks, HTTPException

from core.activity import log_activity
from core.db import db
from core.http_headers import BROWSER_HEADERS, INCONCLUSIVE_STATUSES
from core.router import api_router
from core.safe_fetch import SSRF_GUARD
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from models.legacy import BrokenLink

logger = logging.getLogger(__name__)

# Markdown link forms, for MDX/Markdown content synced from the bridge.
_MD_LINK_RE = re.compile(r"\[[^\]]*\]\(\s*(https?://[^)\s]+)")
_MD_AUTOLINK_RE = re.compile(r"<(https?://[^>\s]+)>")

# ========================
# Routes: Broken Link Detection
# ========================

@api_router.post("/broken-links/{site_id}/scan")
async def scan_broken_links(site_id: str, background_tasks: BackgroundTasks):
    """Queue a broken-link scan for all posts & pages. Returns task_id for SSE streaming."""
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_scan_broken_links, task_id, site_id)
    return {"task_id": task_id}


async def _scan_broken_links(task_id: str, site_id: str):
    try:
        site = await db.sites.find_one({"id": site_id}, {"_id": 0})
        if not site:
            await push_event(task_id, "error", {"message": "Site not found"})
            return

        # Synced content (db.content_items, filled by the content sync)
        all_content = await db.content_items.find({"site_id": site_id}, {"_id": 0}).to_list(1000)

        # Collect unique links per content item
        link_map: list[dict] = []  # {post_id, post_title, url}
        for item in all_content:
            body = item.get("body", "") or ""
            seen = set()

            hrefs = [tag["href"].strip() for tag in BeautifulSoup(body, "html.parser").find_all("a", href=True)]
            # Markdown/MDX content (Next.js sites) writes links as [text](url)
            # and <url>, which the HTML parser above cannot see — without this
            # a scan of an MDX site would report zero links and look clean.
            hrefs += [m.group(1).strip() for m in _MD_LINK_RE.finditer(body)]
            hrefs += [m.group(1).strip() for m in _MD_AUTOLINK_RE.finditer(body)]

            for href in hrefs:
                # Only check absolute HTTP(S) URLs
                if href.startswith("http://") or href.startswith("https://"):
                    if href not in seen:
                        seen.add(href)
                        link_map.append({
                            "post_id": item.get("content_id", 0),
                            "post_title": item.get("title", ""),
                            "url": href,
                        })

        total = len(link_map)
        await push_event(task_id, "status", {"message": f"Found {total} links to check...", "percent": 0})

        # Clear previous results for this site
        await db.broken_links.delete_many({"site_id": site_id})

        results = []
        async with httpx.AsyncClient(event_hooks=SSRF_GUARD, timeout=8.0, follow_redirects=True, headers=BROWSER_HEADERS) as hc:
            for idx, link in enumerate(link_map):
                pct = int(((idx + 1) / max(total, 1)) * 100)
                try:
                    resp = await hc.head(link["url"])
                    if resp.status_code in INCONCLUSIVE_STATUSES:
                        # HEAD blocked or not allowed — retry with a real GET
                        # before concluding the link is actually broken.
                        resp = await hc.get(link["url"])
                    if resp.status_code < 400:
                        link_status = "ok"
                    elif resp.status_code in INCONCLUSIVE_STATUSES:
                        # Still blocked/rate-limited even via GET — the site is
                        # bot-protected, not necessarily dead. Flag separately
                        # from a genuine "broken" so it isn't reported as dead.
                        link_status = "blocked"
                    else:
                        link_status = "broken"
                    status_code = resp.status_code
                except httpx.TimeoutException:
                    link_status = "timeout"
                    status_code = None
                except Exception:
                    link_status = "broken"
                    status_code = None

                record = BrokenLink(
                    site_id=site_id,
                    post_id=link["post_id"],
                    post_title=link["post_title"],
                    url=link["url"],
                    status=link_status,
                    status_code=status_code,
                )
                results.append(record.model_dump())

                if idx % 10 == 0 or idx == total - 1:
                    await push_event(task_id, "progress", {
                        "message": f"Checked {idx + 1}/{total} links...",
                        "percent": pct,
                    })

        if results:
            await db.broken_links.insert_many(results)

        broken_count = sum(1 for r in results if r["status"] == "broken")
        timeout_count = sum(1 for r in results if r["status"] == "timeout")
        blocked_count = sum(1 for r in results if r["status"] == "blocked")
        await push_event(task_id, "complete", {
            "message": (
                f"Scan complete: {total} links checked, {broken_count} broken, "
                f"{timeout_count} timed out, {blocked_count} blocked by the target site (may still be live)."
            ),
            "percent": 100,
            "total": total,
            "broken": broken_count,
            "timeout": timeout_count,
            "blocked": blocked_count,
        })
        await log_activity(site_id, "broken_links_scan", f"Scanned {total} links: {broken_count} broken, {blocked_count} blocked")
    except Exception as e:
        logger.error(f"Broken link scan failed: {e}")
        await push_event(task_id, "error", {"message": str(e)})
    finally:
        await finish_task(task_id)


@api_router.get("/broken-links/{site_id}")
async def get_broken_links(site_id: str, status: Optional[str] = None):
    """Return stored scan results for a site. Optionally filter by status (ok/broken/timeout)."""
    query: dict = {"site_id": site_id}
    if status:
        query["status"] = status
    links = await db.broken_links.find(query, {"_id": 0}).sort("scanned_at", -1).to_list(1000)
    return links


@api_router.delete("/broken-links/{site_id}/{link_id}")
async def dismiss_broken_link(site_id: str, link_id: str):
    """Dismiss / delete a single broken-link result."""
    result = await db.broken_links.delete_one({"id": link_id, "site_id": site_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Link record not found")
    return {"deleted": True}
