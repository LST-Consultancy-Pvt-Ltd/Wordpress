"""Navigation Management (sync WP menus) and Content Refresh (scan for stale
content, AI-refresh a single item or dry-run preview, bulk refresh across sites
as a background task).
"""
import json
import logging
from datetime import datetime, timezone
from typing import List

from fastapi import BackgroundTasks, Depends, HTTPException

from core.activity import log_activity
from core.ai import get_ai_response
from core.db import db
from core.prompts import HUMANIZE_DIRECTIVE
from core.router import api_router
from core.security import require_editor
from core.seo_impact import estimate_seo_impact
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from models.legacy import BulkContentRefreshRequest, ContentRefreshItem
from providers.wordpress import get_wp_credentials, wp_api_request

logger = logging.getLogger(__name__)

# ========================
# Routes: Navigation Management
# ========================

@api_router.get("/navigation/{site_id}")
async def get_navigation(site_id: str):
    menus = await db.navigation.find({"site_id": site_id}, {"_id": 0}).to_list(100)
    return menus

@api_router.post("/navigation/{site_id}/sync")
async def sync_navigation(site_id: str):
    site = await get_wp_credentials(site_id)

    try:
        response = await wp_api_request(site, "GET", "menus")
        if response.status_code == 200:
            menus = response.json()
            for menu in menus:
                await db.navigation.update_one(
                    {"site_id": site_id, "wp_menu_id": menu["id"]},
                    {"$set": {
                        "site_id": site_id,
                        "wp_menu_id": menu["id"],
                        "name": menu.get("name", ""),
                        "items": menu.get("items", []),
                        "synced_at": datetime.now(timezone.utc).isoformat()
                    }},
                    upsert=True
                )
            await log_activity(site_id, "navigation_synced", f"Synced {len(menus)} menus")
            return {"message": f"Synced {len(menus)} menus"}
        return {"message": "No menus found or endpoint not available"}
    except Exception as e:
        logger.error(f"Navigation sync failed: {e}")
        return {"message": "Menu sync not available - WordPress menus API may require additional plugin"}

# ========================
# Routes: Content Refresh
# ========================

@api_router.get("/content-refresh/{site_id}")
async def get_content_refresh_items(site_id: str):
    items = await db.content_refresh.find({"site_id": site_id}, {"_id": 0}).to_list(100)
    return items

@api_router.post("/content-refresh/{site_id}/scan")
async def scan_for_refresh(site_id: str):
    """Scan posts/pages and identify content that needs refreshing"""
    posts = await db.posts.find({"site_id": site_id}, {"_id": 0}).to_list(100)
    pages = await db.pages.find({"site_id": site_id}, {"_id": 0}).to_list(100)

    all_content = posts + pages
    refresh_items = []

    for content in all_content:
        modified = content.get("modified", content.get("created_at", ""))
        if modified:
            try:
                modified_date = datetime.fromisoformat(modified.replace("Z", "+00:00"))
                age_days = (datetime.now(timezone.utc) - modified_date).days

                if age_days > 180:  # Content older than 6 months
                    item = ContentRefreshItem(
                        site_id=site_id,
                        post_id=content.get("wp_id", 0),
                        title=content.get("title", "Unknown"),
                        url=content.get("link", ""),
                        last_modified=modified,
                        age_days=age_days,
                        status="needs_refresh",
                        recommended_action="Review and update content"
                    )
                    refresh_items.append(item.model_dump())
            except Exception:
                pass

    # Store refresh items
    if refresh_items:
        await db.content_refresh.delete_many({"site_id": site_id})
        await db.content_refresh.insert_many(refresh_items)

    await log_activity(site_id, "content_scan", f"Found {len(refresh_items)} items needing refresh")
    return {"items_found": len(refresh_items), "items": refresh_items}

@api_router.post("/content-refresh/{site_id}/refresh/{item_id}")
async def refresh_content(site_id: str, item_id: str, dry_run: bool = False, _: dict = Depends(require_editor)):
    """Use AI to refresh outdated content"""
    item = await db.content_refresh.find_one({"id": item_id, "site_id": site_id}, {"_id": 0})
    if not item:
        raise HTTPException(status_code=404, detail="Refresh item not found")

    # Get original content
    post = await db.posts.find_one({"site_id": site_id, "wp_id": item["post_id"]}, {"_id": 0})
    if not post:
        post = await db.pages.find_one({"site_id": site_id, "wp_id": item["post_id"]}, {"_id": 0})

    if not post:
        raise HTTPException(status_code=404, detail="Original content not found")

    prompt = f"""Refresh and update this content. Keep the same structure but:
1. Update any outdated information
2. Add new relevant sections if needed
3. Improve SEO
4. Make it more engaging

Original title: {post.get('title', '')}
Original content: {post.get('content', '')[:3000]}

Respond with JSON:
{{
    "title": "Updated title",
    "content": "Updated HTML content",
    "changes_made": ["change1", "change2", ...]
}}"""

    try:
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

        refreshed = json.loads(content.strip())

        if dry_run:
            return {
                "dry_run": True,
                "new_content": refreshed.get("content", ""),
                "post_title": refreshed.get("title", post.get("title", "")),
                "wp_id": item.get("post_id"),
                "post_url": post.get("link", ""),
            }

        # Update status
        await db.content_refresh.update_one(
            {"id": item_id},
            {"$set": {"status": "refreshed", "refreshed_at": datetime.now(timezone.utc).isoformat()}}
        )

        await log_activity(site_id, "content_refreshed", f"Refreshed: {item['title']}")
        refreshed["impact_estimate"] = estimate_seo_impact("content_refresh")
        return refreshed

    except Exception as e:
        logger.error(f"Content refresh failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.post("/content-refresh/bulk")
async def bulk_content_refresh(data: BulkContentRefreshRequest, background_tasks: BackgroundTasks):
    """Queue all stale content (age > 90d OR ctr < 2%) across sites for AI rewriting."""
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_bulk_content_refresh, task_id, data.site_ids)
    return {"task_id": task_id}

async def _bulk_content_refresh(task_id: str, site_ids: List[str]):
    try:
        total_refreshed = 0
        for s_idx, site_id in enumerate(site_ids):
            posts = await db.posts.find({"site_id": site_id}, {"_id": 0}).to_list(200)
            pages = await db.pages.find({"site_id": site_id}, {"_id": 0}).to_list(200)
            all_content = posts + pages
            stale = []
            for item in all_content:
                modified = item.get("modified", item.get("created_at", ""))
                if modified:
                    try:
                        mod_date = datetime.fromisoformat(modified.replace("Z", "+00:00"))
                        age = (datetime.now(timezone.utc) - mod_date).days
                        if age > 90:
                            stale.append(item)
                    except Exception:
                        pass
            # Also add items with CTR < 2%
            low_ctr_urls = set()
            metrics = await db.seo_metrics.find({"site_id": site_id, "ctr": {"$lt": 2}}, {"_id": 0}).to_list(100)
            for m in metrics:
                low_ctr_urls.add(m.get("page_url", ""))
            for item in all_content:
                if item.get("link") in low_ctr_urls and item not in stale:
                    stale.append(item)

            for idx, item in enumerate(stale):
                pct = int(((s_idx * len(stale) + idx) / max(len(site_ids) * len(stale), 1)) * 100)
                await push_event(task_id, "progress", {
                    "message": f"Refreshing: {item.get('title','')[:40]}...",
                    "percent": pct
                })
                try:
                    prompt = f"""Update and improve this content for SEO and freshness.

{HUMANIZE_DIRECTIVE}

Title: {item.get('title','')}
Content: {str(item.get('content',''))[:2000]}
Return JSON: {{"title": "...", "content": "...", "changes": [...]}}"""
                    raw = await get_ai_response(
                        [{"role": "user", "content": prompt}],
                        max_tokens=2000,
                    )
                    if "```json" in raw:
                        raw = raw.split("```json")[1].split("```")[0]
                    refreshed = json.loads(raw.strip())
                    await db.content_refresh.update_one(
                        {"site_id": site_id, "post_id": item.get("wp_id")},
                        {"$set": {"status": "refreshed", "refreshed_title": refreshed.get("title"), "refreshed_at": datetime.now(timezone.utc).isoformat()}},
                        upsert=True
                    )
                    total_refreshed += 1
                except Exception as item_err:
                    logger.error(f"Bulk refresh item error: {item_err}")

            await log_activity(site_id, "bulk_content_refresh", f"Bulk refresh: {len(stale)} items queued")

        await push_event(task_id, "complete", {"message": f"Bulk refresh complete: {total_refreshed} items refreshed", "percent": 100})
    except Exception as e:
        await push_event(task_id, "error", {"message": str(e)})
    finally:
        await finish_task(task_id)
