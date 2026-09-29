"""Content Refresh: scan synced content for stale items, AI-refresh a single
item (dry-run preview, or propose the rewrite as a content change set), and
a bulk background pass that drafts refreshed titles across sites.
"""
import json
import logging
from datetime import datetime, timezone
from typing import List

from fastapi import BackgroundTasks, Depends, HTTPException

from core.activity import log_activity
from core.ai import get_ai_response
from core.content_proposals import propose_content
from core.db import db
from core.prompts import HUMANIZE_DIRECTIVE
from core.router import api_router
from core.security import require_editor, require_user
from core.seo_impact import estimate_seo_impact
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from models.legacy import BulkContentRefreshRequest, ContentRefreshItem

logger = logging.getLogger(__name__)

STALE_AFTER_DAYS = 180


def _age_days(item: dict):
    modified = item.get("updated_at") or (item.get("frontmatter") or {}).get("date") or ""
    if not modified:
        return None, ""
    try:
        when = datetime.fromisoformat(str(modified).replace("Z", "+00:00"))
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - when).days, str(modified)
    except ValueError:
        return None, str(modified)


@api_router.get("/content-refresh/{site_id}")
async def get_content_refresh_items(site_id: str, _: dict = Depends(require_user)):
    return await db.content_refresh.find({"site_id": site_id}, {"_id": 0}).to_list(100)


@api_router.post("/content-refresh/{site_id}/scan")
async def scan_for_refresh(site_id: str, _: dict = Depends(require_editor)):
    """Identify synced content older than six months."""
    items = await db.content_items.find({"site_id": site_id}, {"_id": 0, "body": 0}).to_list(1000)
    refresh_items = []
    for content in items:
        age, modified = _age_days(content)
        if age is not None and age > STALE_AFTER_DAYS:
            refresh_items.append(ContentRefreshItem(
                site_id=site_id, content_id=content["content_id"], collection=content["collection"],
                slug=content["slug"], title=content.get("title", "Unknown"), url=content.get("url", ""),
                last_modified=modified, age_days=age, status="needs_refresh",
                recommended_action="Review and update content",
            ).model_dump())
    await db.content_refresh.delete_many({"site_id": site_id})
    if refresh_items:
        await db.content_refresh.insert_many([dict(i) for i in refresh_items])
    await log_activity(site_id, "content_scan", f"Found {len(refresh_items)} items needing refresh")
    return {"items_found": len(refresh_items), "items": refresh_items,
            "note": None if items else "No synced content — run a content sync for this site first."}


async def _ai_refresh(title: str, body: str) -> dict:
    prompt = f"""Refresh and update this content. Keep the same structure but:
1. Update any outdated information
2. Add new relevant sections if needed
3. Improve SEO
4. Make it more engaging

Original title: {title}
Original content: {body[:3000]}

Respond with JSON:
{{
    "title": "Updated title",
    "content": "Updated HTML content",
    "changes_made": ["change1", "change2", ...]
}}"""
    content = await get_ai_response(
        [
            {"role": "system", "content": f"You are an expert content writer. Update content while maintaining its core message.\n\n{HUMANIZE_DIRECTIVE}"},
            {"role": "user", "content": prompt},
        ],
        temperature=0.7,
        max_tokens=3000,
    )
    if "```json" in content:
        content = content.split("```json")[1].split("```")[0]
    elif "```" in content:
        content = content.split("```")[1].split("```")[0]
    return json.loads(content.strip())


@api_router.post("/content-refresh/{site_id}/refresh/{item_id}")
async def refresh_content(site_id: str, item_id: str, dry_run: bool = False, user: dict = Depends(require_editor)):
    """AI-refresh one stale item. Dry run returns the rewrite; otherwise the
    rewrite is proposed as a content change set against the item's current
    version (the bridge rejects it if the item changed in the meantime)."""
    item = await db.content_refresh.find_one({"id": item_id, "site_id": site_id}, {"_id": 0})
    if not item:
        raise HTTPException(status_code=404, detail="Refresh item not found")
    source = await db.content_items.find_one(
        {"site_id": site_id, "collection": item["collection"], "slug": item["slug"]}, {"_id": 0})
    if not source:
        raise HTTPException(status_code=404, detail="Original content not found; re-sync the site's content")
    try:
        refreshed = await _ai_refresh(source.get("title", ""), source.get("body", ""))
    except (ValueError, KeyError) as e:
        logger.error(f"Content refresh failed: {e}")
        raise HTTPException(status_code=502, detail="The AI response could not be parsed; try again")

    if dry_run:
        return {"dry_run": True, "new_content": refreshed.get("content", ""),
                "post_title": refreshed.get("title", source.get("title", "")),
                "content_id": source.get("content_id"), "post_url": source.get("url", "")}

    frontmatter = {**(source.get("frontmatter") or {}), "content_format": "html",
                   "updated": datetime.now(timezone.utc).date().isoformat()}
    frontmatter.pop("title", None)
    cs = await propose_content(
        site_id, actor=user, source="content-refresh", collection=source["collection"],
        title=f"Refresh: {source.get('title', source['slug'])}"[:200],
        description="Changes: " + "; ".join(refreshed.get("changes_made") or [])[:1500],
        items=[{"title": refreshed.get("title") or source.get("title"), "slug": source["slug"],
                "body": refreshed.get("content", ""),
                "status": "published" if source.get("status") == "published" else "draft",
                "frontmatter": frontmatter, "base_sha256": source.get("sha256")}])
    await db.content_refresh.update_one({"id": item_id}, {"$set": {
        "status": "proposed", "changeset_id": cs["id"], "proposed_at": datetime.now(timezone.utc).isoformat()}})
    await log_activity(site_id, "content_refresh_proposed", f"Proposed refresh of {item['title']} ({cs['id']})",
                       user_id=user["id"])
    return {**refreshed, "changeset": cs, "impact_estimate": estimate_seo_impact("content_refresh")}


@api_router.post("/content-refresh/bulk")
async def bulk_content_refresh(data: BulkContentRefreshRequest, background_tasks: BackgroundTasks,
                               _: dict = Depends(require_editor)):
    """Draft refreshed titles for stale or low-CTR content across sites
    (stored for review; nothing is written to any site)."""
    task_id = make_task_id()
    await create_task_queue(task_id, "bulk_content_refresh")
    background_tasks.add_task(_bulk_content_refresh, task_id, data.site_ids)
    return {"task_id": task_id}


async def _bulk_content_refresh(task_id: str, site_ids: List[str]):
    try:
        total_refreshed = 0
        for s_idx, site_id in enumerate(site_ids):
            items = await db.content_items.find({"site_id": site_id}, {"_id": 0}).to_list(200)
            stale = [i for i in items if (_age_days(i)[0] or 0) > 90]
            low_ctr_urls = {m.get("page_url", "") for m in
                            await db.seo_metrics.find({"site_id": site_id, "ctr": {"$lt": 2}}, {"_id": 0}).to_list(100)}
            stale += [i for i in items if i.get("url") in low_ctr_urls and i not in stale]

            for idx, item in enumerate(stale):
                pct = int(((s_idx * len(stale) + idx) / max(len(site_ids) * len(stale), 1)) * 100)
                await push_event(task_id, "progress", {"message": f"Refreshing: {item.get('title','')[:40]}...",
                                                       "percent": pct})
                try:
                    refreshed = await _ai_refresh(item.get("title", ""), str(item.get("body", ""))[:2000])
                    await db.content_refresh.update_one(
                        {"site_id": site_id, "collection": item["collection"], "slug": item["slug"]},
                        {"$set": {"status": "draft_ready", "refreshed_title": refreshed.get("title"),
                                  "content_id": item.get("content_id"), "title": item.get("title", ""),
                                  "url": item.get("url", ""),
                                  "refreshed_at": datetime.now(timezone.utc).isoformat()}},
                        upsert=True,
                    )
                    total_refreshed += 1
                except Exception as item_err:
                    logger.error(f"Bulk refresh item error: {item_err}")
            await log_activity(site_id, "bulk_content_refresh", f"Bulk refresh: {len(stale)} items drafted")
        await push_event(task_id, "complete", {"message": f"Bulk refresh complete: {total_refreshed} drafts ready",
                                               "percent": 100})
    except Exception as e:
        await push_event(task_id, "error", {"message": str(e)})
    finally:
        await finish_task(task_id)
