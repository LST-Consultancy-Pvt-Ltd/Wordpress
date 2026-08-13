"""Backup & Restore Manager (snapshot posts/pages/menus/media-meta/settings to
Mongo, restore from a snapshot, both as background tasks) and Redirect Manager
(list/create/delete redirects, mirror to the Redirection plugin if active,
AI-suggested redirects for broken links, bulk-create) for a connected site.
"""
import base64
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import List

import httpx
from fastapi import BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

from core.activity import log_activity
from core.ai import get_ai_response
from core.db import db
from core.router import api_router
from core.security import require_editor
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from providers.wordpress import get_wp_credentials, wp_api_request

logger = logging.getLogger(__name__)

# ============================================================
# FEATURE 7 — BACKUP & RESTORE MANAGER
# ============================================================

class BackupScheduleRequest(BaseModel):
    frequency: str = "weekly"  # daily | weekly
    time_of_day: str = "02:00"

@api_router.get("/backups/{site_id}")
async def list_backups(site_id: str, current_user: dict = Depends(require_editor)):
    backups = await db.backups.find({"site_id": site_id}, {"_id": 0, "snapshot": 0}).sort("created_at", -1).to_list(50)
    return backups

@api_router.post("/backups/{site_id}/create")
async def create_backup(site_id: str, background_tasks: BackgroundTasks, current_user: dict = Depends(require_editor)):
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_create_backup_task, task_id, site_id, current_user["id"])
    return {"task_id": task_id}

async def _create_backup_task(task_id: str, site_id: str, user_id: str):
    site = await get_wp_credentials(site_id, user_id)
    await push_event(task_id, "progress", {"percent": 5, "message": "Starting backup..."})
    snapshot = {"posts": [], "pages": [], "settings": {}, "menus": [], "media_meta": []}
    # Posts
    await push_event(task_id, "progress", {"percent": 15, "message": "Backing up posts..."})
    posts_resp = await wp_api_request(site, "GET", "posts?per_page=100&status=any&context=edit")
    if posts_resp.status_code == 200:
        snapshot["posts"] = posts_resp.json()
    # Pages
    await push_event(task_id, "progress", {"percent": 30, "message": "Backing up pages..."})
    pages_resp = await wp_api_request(site, "GET", "pages?per_page=100&status=any&context=edit")
    if pages_resp.status_code == 200:
        snapshot["pages"] = pages_resp.json()
    # Menus
    await push_event(task_id, "progress", {"percent": 50, "message": "Backing up menus..."})
    menus_resp = await wp_api_request(site, "GET", "menus")
    if menus_resp.status_code == 200:
        snapshot["menus"] = menus_resp.json() if isinstance(menus_resp.json(), list) else []
    # Media metadata
    await push_event(task_id, "progress", {"percent": 65, "message": "Backing up media metadata..."})
    media_resp = await wp_api_request(site, "GET", "media?per_page=100&_fields=id,title,alt_text,source_url,date")
    if media_resp.status_code == 200:
        snapshot["media_meta"] = media_resp.json()
    # Site settings
    await push_event(task_id, "progress", {"percent": 80, "message": "Backing up settings..."})
    settings_resp = await wp_api_request(site, "GET", "settings")
    if settings_resp.status_code == 200:
        snapshot["settings"] = settings_resp.json()
    size_bytes = len(json.dumps(snapshot).encode())
    backup_id = str(uuid.uuid4())
    backup_doc = {
        "id": backup_id,
        "site_id": site_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "size_bytes": size_bytes,
        "post_count": len(snapshot["posts"]),
        "page_count": len(snapshot["pages"]),
        "media_count": len(snapshot["media_meta"]),
        "status": "completed",
        "snapshot": snapshot,
    }
    await db.backups.insert_one(backup_doc)
    await push_event(task_id, "complete", {"message": f"Backup complete. {len(snapshot['posts'])} posts, {len(snapshot['pages'])} pages, {size_bytes // 1024}KB."})
    await log_activity(site_id, "backup_created", f"Backup created: {size_bytes // 1024}KB")
    await finish_task(task_id)

@api_router.post("/backups/{site_id}/restore/{backup_id}")
async def restore_backup(site_id: str, backup_id: str, background_tasks: BackgroundTasks, current_user: dict = Depends(require_editor)):
    backup = await db.backups.find_one({"id": backup_id, "site_id": site_id})
    if not backup:
        raise HTTPException(status_code=404, detail="Backup not found")
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_restore_backup_task, task_id, site_id, backup_id, current_user["id"])
    return {"task_id": task_id}

async def _restore_backup_task(task_id: str, site_id: str, backup_id: str, user_id: str):
    backup = await db.backups.find_one({"id": backup_id, "site_id": site_id})
    site = await get_wp_credentials(site_id, user_id)
    snapshot = backup.get("snapshot", {})
    success_count = 0
    fail_count = 0
    total = len(snapshot.get("posts", [])) + len(snapshot.get("pages", []))
    done = 0
    await push_event(task_id, "progress", {"percent": 5, "message": "Starting restore..."})
    for post in snapshot.get("posts", []):
        done += 1
        pct = 10 + int(80 * done / max(total, 1))
        await push_event(task_id, "progress", {"percent": pct, "message": f"Restoring post: {post.get('title', {}).get('raw', '')[:40]}..."})
        try:
            payload = {
                "title": post.get("title", {}).get("raw", ""),
                "content": post.get("content", {}).get("raw", ""),
                "status": post.get("status", "draft"),
                "slug": post.get("slug", ""),
            }
            resp = await wp_api_request(site, "POST", f"posts/{post.get('id', '')}", payload)
            if resp.status_code in (200, 201):
                success_count += 1
            else:
                fail_count += 1
        except Exception:
            fail_count += 1
    for page in snapshot.get("pages", []):
        done += 1
        pct = 10 + int(80 * done / max(total, 1))
        await push_event(task_id, "progress", {"percent": pct, "message": f"Restoring page: {page.get('title', {}).get('raw', '')[:40]}..."})
        try:
            payload = {
                "title": page.get("title", {}).get("raw", ""),
                "content": page.get("content", {}).get("raw", ""),
                "status": page.get("status", "draft"),
            }
            resp = await wp_api_request(site, "POST", f"pages/{page.get('id', '')}", payload)
            if resp.status_code in (200, 201):
                success_count += 1
            else:
                fail_count += 1
        except Exception:
            fail_count += 1
    await push_event(task_id, "complete", {"message": f"Restore complete: {success_count} succeeded, {fail_count} failed."})
    await log_activity(site_id, "backup_restored", f"Backup {backup_id} restored: {success_count} items")
    await finish_task(task_id)

@api_router.delete("/backups/{site_id}/{backup_id}")
async def delete_backup(site_id: str, backup_id: str, current_user: dict = Depends(require_editor)):
    result = await db.backups.delete_one({"id": backup_id, "site_id": site_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Backup not found")
    return {"success": True}

@api_router.post("/backups/{site_id}/schedule")
async def schedule_backup(site_id: str, data: BackupScheduleRequest, current_user: dict = Depends(require_editor)):
    await db.sites.update_one({"id": site_id}, {"$set": {"backup_schedule": data.model_dump()}})
    await log_activity(site_id, "backup_scheduled", f"Backup scheduled: {data.frequency} at {data.time_of_day}")
    return {"success": True, "schedule": data.model_dump()}

# ============================================================
# FEATURE 8 — REDIRECT MANAGER
# ============================================================

class RedirectCreate(BaseModel):
    from_url: str
    to_url: str
    redirect_type: int = 301

class BulkRedirectCreate(BaseModel):
    redirects: List[dict]

@api_router.get("/redirects/{site_id}")
async def list_redirects(site_id: str, current_user: dict = Depends(require_editor)):
    items = await db.redirects.find({"site_id": site_id}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return items

@api_router.post("/redirects/{site_id}")
async def create_redirect(site_id: str, data: RedirectCreate, current_user: dict = Depends(require_editor)):
    redir_id = str(uuid.uuid4())
    doc = {"id": redir_id, "site_id": site_id, "from_url": data.from_url, "to_url": data.to_url,
           "redirect_type": data.redirect_type, "created_at": datetime.now(timezone.utc).isoformat(), "hit_count": 0}
    await db.redirects.insert_one(doc)
    # Try Redirection plugin REST API
    site = await get_wp_credentials(site_id, current_user["id"])
    rp_url = site["url"].rstrip("/") + "/wp-json/redirection/v1/redirect"
    app_password = site["app_password"].replace(" ", "")
    b64 = base64.b64encode(f"{site['username']}:{app_password}".encode()).decode()
    try:
        async with httpx.AsyncClient(timeout=10.0) as hc:
            await hc.post(rp_url, json={"url": data.from_url, "action_data": {"url": data.to_url}, "action_type": "url", "match_type": "url", "status": "enabled"}, headers={"Authorization": f"Basic {b64}", "Content-Type": "application/json"})
    except Exception:
        pass  # Plugin not active — redirect is stored in MongoDB anyway
    await log_activity(site_id, "redirect_created", f"{data.from_url} → {data.to_url}")
    return doc

@api_router.delete("/redirects/{site_id}/{redirect_id}")
async def delete_redirect(site_id: str, redirect_id: str, current_user: dict = Depends(require_editor)):
    await db.redirects.delete_one({"id": redirect_id, "site_id": site_id})
    return {"success": True}

@api_router.post("/redirects/{site_id}/ai-suggest")
async def ai_suggest_redirects(site_id: str, current_user: dict = Depends(require_editor)):
    broken = await db.broken_links.find({"site_id": site_id, "status": "broken"}, {"_id": 0}).to_list(50)
    if not broken:
        return {"suggestions": []}
    # Get site content for context
    site = await get_wp_credentials(site_id, current_user["id"])
    posts_resp = await wp_api_request(site, "GET", "posts?per_page=50&_fields=slug,link,title")
    pages_resp = await wp_api_request(site, "GET", "pages?per_page=50&_fields=slug,link,title")
    content_urls = []
    if posts_resp.status_code == 200:
        content_urls += [f"{p['link']} ({p.get('title',{}).get('rendered','')})" for p in posts_resp.json()]
    if pages_resp.status_code == 200:
        content_urls += [f"{p['link']} ({p.get('title',{}).get('rendered','')})" for p in pages_resp.json()]
    broken_list = "\n".join([f"- {b.get('url', '')}" for b in broken[:30]])
    content_list = "\n".join(content_urls[:50])
    raw = await get_ai_response([
        {"role": "user", "content": f"Suggest the best redirect target for each broken URL from the available content. Return JSON array: [{{\"from_url\": str, \"to_url\": str, \"reason\": str}}]\n\nBroken URLs:\n{broken_list}\n\nAvailable content:\n{content_list}"}
    ], max_tokens=2000)
    try:
        start = raw.find("[")
        end = raw.rfind("]") + 1
        suggestions = json.loads(raw[start:end])
    except Exception:
        suggestions = []
    return {"suggestions": suggestions}

@api_router.post("/redirects/{site_id}/bulk-create")
async def bulk_create_redirects(site_id: str, data: BulkRedirectCreate, current_user: dict = Depends(require_editor)):
    created = []
    for r in data.redirects:
        redir_id = str(uuid.uuid4())
        doc = {"id": redir_id, "site_id": site_id, "from_url": r.get("from_url", r.get("from", "")),
               "to_url": r.get("to_url", r.get("to", "")), "redirect_type": r.get("type", 301),
               "created_at": datetime.now(timezone.utc).isoformat(), "hit_count": 0}
        await db.redirects.insert_one(doc)
        created.append(doc)
    await log_activity(site_id, "redirects_bulk_created", f"Created {len(created)} redirects")
    return {"created": len(created), "redirects": created}
