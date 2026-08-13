"""Media Library Manager (list/upload/delete/rename/compress WordPress media,
including a background bulk-compress task) and Comments Manager (list/approve/
spam/delete/bulk-action/AI-suggested-reply/auto-moderate WordPress comments).
"""
import base64
import io
import json
import logging
from typing import List

import httpx
from bs4 import BeautifulSoup
from fastapi import BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel

from core.activity import log_activity
from core.ai import get_ai_response
from core.router import api_router
from core.security import require_editor
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from providers.wordpress import get_wp_credentials, wp_api_request

logger = logging.getLogger(__name__)

# ============================================================
# FEATURE 1 — MEDIA LIBRARY MANAGER
# ============================================================

class MediaRenameRequest(BaseModel):
    title: str
    alt_text: str = ""

@api_router.get("/media/{site_id}")
async def get_media(site_id: str, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    resp = await wp_api_request(site, "GET", "media?per_page=100&_fields=id,title,alt_text,source_url,media_details,mime_type,date")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"WP error {resp.status_code}")
    return resp.json()

@api_router.post("/media/{site_id}/upload")
async def upload_media(site_id: str, request: Request, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    body = await request.body()
    content_type = request.headers.get("Content-Type", "application/octet-stream")
    filename = request.headers.get("X-Filename", "upload.jpg")
    wp_url = site["url"].rstrip("/") + "/wp-json/wp/v2/media"
    app_password = site["app_password"].replace(" ", "")
    b64 = base64.b64encode(f"{site['username']}:{app_password}".encode()).decode()
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as hc:
        resp = await hc.post(wp_url, content=body, headers={
            "Content-Type": content_type,
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Authorization": f"Basic {b64}",
        })
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=resp.text[:300])
    await log_activity(site_id, "media_uploaded", f"Uploaded {filename}")
    return resp.json()

@api_router.delete("/media/{site_id}/{media_id}")
async def delete_media(site_id: str, media_id: int, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    resp = await wp_api_request(site, "DELETE", f"media/{media_id}?force=true")
    await log_activity(site_id, "media_deleted", f"Deleted media {media_id}")
    return {"success": True}

@api_router.post("/media/{site_id}/rename/{media_id}")
async def rename_media(site_id: str, media_id: int, data: MediaRenameRequest, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    resp = await wp_api_request(site, "POST", f"media/{media_id}", {"title": data.title, "alt_text": data.alt_text})
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=resp.text[:300])
    await log_activity(site_id, "media_renamed", f"Renamed media {media_id} to {data.title}")
    return resp.json()

@api_router.post("/media/{site_id}/compress/{media_id}")
async def compress_media(site_id: str, media_id: int, current_user: dict = Depends(require_editor)):
    try:
        from PIL import Image
    except ImportError:
        raise HTTPException(status_code=500, detail="Pillow not installed. Run: pip install Pillow")
    site = await get_wp_credentials(site_id, current_user["id"])
    # Get media info
    info_resp = await wp_api_request(site, "GET", f"media/{media_id}")
    if info_resp.status_code != 200:
        raise HTTPException(status_code=404, detail="Media not found")
    info = info_resp.json()
    src_url = info.get("source_url")
    if not src_url:
        raise HTTPException(status_code=400, detail="No source URL")
    filename = src_url.split("/")[-1]
    ext = filename.rsplit(".", 1)[-1].lower()
    mime_map = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
    mime = mime_map.get(ext, "image/jpeg")
    # Download original
    async with httpx.AsyncClient(timeout=60.0) as hc:
        dl = await hc.get(src_url)
    if dl.status_code != 200:
        raise HTTPException(status_code=502, detail="Could not download original image")
    # Compress with Pillow
    img = Image.open(io.BytesIO(dl.content))
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")
    buf = io.BytesIO()
    fmt = "PNG" if ext == "png" else "JPEG"
    if fmt == "JPEG":
        img.save(buf, format=fmt, quality=80, optimize=True)
    else:
        img.save(buf, format=fmt, optimize=True)
    buf.seek(0)
    compressed_bytes = buf.read()
    # Upload compressed version
    wp_url = site["url"].rstrip("/") + "/wp-json/wp/v2/media"
    app_password = site["app_password"].replace(" ", "")
    b64 = base64.b64encode(f"{site['username']}:{app_password}".encode()).decode()
    new_filename = f"compressed_{filename}"
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as hc:
        up_resp = await hc.post(wp_url, content=compressed_bytes, headers={
            "Content-Type": mime,
            "Content-Disposition": f'attachment; filename="{new_filename}"',
            "Authorization": f"Basic {b64}",
        })
    if up_resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail="Re-upload failed")
    new_media = up_resp.json()
    original_size = len(dl.content)
    compressed_size = len(compressed_bytes)
    await log_activity(site_id, "media_compressed",
        f"Compressed {filename}: {original_size // 1024}KB → {compressed_size // 1024}KB")
    return {"success": True, "new_media_id": new_media.get("id"), "original_size": original_size,
            "compressed_size": compressed_size, "saved_bytes": original_size - compressed_size}

@api_router.post("/media/{site_id}/bulk-compress")
async def bulk_compress_media(site_id: str, background_tasks: BackgroundTasks, current_user: dict = Depends(require_editor)):
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_bulk_compress_task, task_id, site_id, current_user["id"])
    return {"task_id": task_id}

async def _bulk_compress_task(task_id: str, site_id: str, user_id: str):
    try:
        from PIL import Image
    except ImportError:
        await push_event(task_id, "error", {"message": "Pillow not installed"})
        await finish_task(task_id)
        return
    site = await get_wp_credentials(site_id, user_id)
    await push_event(task_id, "progress", {"percent": 5, "message": "Fetching media list..."})
    resp = await wp_api_request(site, "GET", "media?per_page=100&mime_type=image&_fields=id,source_url,media_details")
    if resp.status_code != 200:
        await push_event(task_id, "error", {"message": "Could not fetch media"})
        await finish_task(task_id)
        return
    items = resp.json()
    # Filter images > 200KB
    large = []
    for item in items:
        details = item.get("media_details", {}) or {}
        fsize = details.get("filesize", 0)
        if fsize > 200 * 1024:
            large.append(item)
    if not large:
        await push_event(task_id, "complete", {"message": "No images over 200KB found"})
        await finish_task(task_id)
        return
    compressed = 0
    for idx, item in enumerate(large):
        pct = 10 + int(85 * idx / len(large))
        await push_event(task_id, "progress", {"percent": pct, "message": f"Compressing {item['id']} ({idx+1}/{len(large)})..."})
        try:
            src_url = item.get("source_url", "")
            ext = src_url.rsplit(".", 1)[-1].lower()
            async with httpx.AsyncClient(timeout=60.0) as hc:
                dl = await hc.get(src_url)
            if dl.status_code != 200:
                continue
            img = Image.open(io.BytesIO(dl.content))
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGB")
            buf = io.BytesIO()
            fmt = "PNG" if ext == "png" else "JPEG"
            if fmt == "JPEG":
                img.save(buf, format=fmt, quality=80, optimize=True)
            else:
                img.save(buf, format=fmt, optimize=True)
            buf.seek(0)
            compressed_bytes = buf.read()
            if len(compressed_bytes) >= len(dl.content):
                continue  # no gain, skip
            filename = src_url.split("/")[-1]
            mime = "image/png" if ext == "png" else "image/jpeg"
            wp_url = site["url"].rstrip("/") + "/wp-json/wp/v2/media"
            app_password = site["app_password"].replace(" ", "")
            b64 = base64.b64encode(f"{site['username']}:{app_password}".encode()).decode()
            async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as hc:
                await hc.post(wp_url, content=compressed_bytes, headers={
                    "Content-Type": mime,
                    "Content-Disposition": f'attachment; filename="opt_{filename}"',
                    "Authorization": f"Basic {b64}",
                })
            compressed += 1
        except Exception:
            pass
    await push_event(task_id, "complete", {"message": f"Done. Compressed {compressed}/{len(large)} images."})
    await log_activity(site_id, "media_bulk_compressed", f"Bulk compressed {compressed} images")
    await finish_task(task_id)

# ============================================================
# FEATURE 2 — COMMENTS MANAGER
# ============================================================

class CommentReplyRequest(BaseModel):
    content: str
    parent_id: int

@api_router.get("/comments/{site_id}")
async def get_comments(site_id: str, status: str = "hold", current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    resp = await wp_api_request(site, "GET", f"comments?per_page=100&status={status}&_fields=id,author_name,author_email,content,post,date,status,link")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=resp.text[:300])
    return resp.json()

@api_router.post("/comments/{site_id}/approve/{comment_id}")
async def approve_comment(site_id: str, comment_id: int, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    resp = await wp_api_request(site, "POST", f"comments/{comment_id}", {"status": "approved"})
    await log_activity(site_id, "comment_approved", f"Comment {comment_id} approved")
    return {"success": True}

@api_router.post("/comments/{site_id}/spam/{comment_id}")
async def spam_comment(site_id: str, comment_id: int, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    await wp_api_request(site, "POST", f"comments/{comment_id}", {"status": "spam"})
    await log_activity(site_id, "comment_spammed", f"Comment {comment_id} marked spam")
    return {"success": True}

@api_router.delete("/comments/{site_id}/{comment_id}")
async def delete_comment(site_id: str, comment_id: int, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    await wp_api_request(site, "DELETE", f"comments/{comment_id}?force=true")
    await log_activity(site_id, "comment_deleted", f"Comment {comment_id} deleted")
    return {"success": True}

class BulkCommentAction(BaseModel):
    ids: List[int]
    action: str  # approve | spam | delete

@api_router.post("/comments/{site_id}/bulk-action")
async def bulk_comment_action(site_id: str, data: BulkCommentAction, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    results = []
    for cid in data.ids:
        try:
            if data.action == "approve":
                await wp_api_request(site, "POST", f"comments/{cid}", {"status": "approved"})
            elif data.action == "spam":
                await wp_api_request(site, "POST", f"comments/{cid}", {"status": "spam"})
            elif data.action == "delete":
                await wp_api_request(site, "DELETE", f"comments/{cid}?force=true")
            results.append({"id": cid, "success": True})
        except Exception as e:
            results.append({"id": cid, "success": False, "error": str(e)})
    await log_activity(site_id, "comments_bulk_action", f"Bulk {data.action}: {len(data.ids)} comments")
    return {"results": results}

@api_router.post("/comments/{site_id}/ai-reply/{comment_id}")
async def ai_reply_comment(site_id: str, comment_id: int, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    resp = await wp_api_request(site, "GET", f"comments/{comment_id}?_fields=id,author_name,content,post")
    if resp.status_code != 200:
        raise HTTPException(status_code=404, detail="Comment not found")
    c = resp.json()
    comment_text = BeautifulSoup(c.get("content", {}).get("rendered", ""), "html.parser").get_text()
    reply_text = await get_ai_response([
        {"role": "system", "content": "You are a helpful, professional blog author responding to reader comments. Be warm, concise, and on-brand."},
        {"role": "user", "content": f"A reader named '{c.get('author_name', 'Reader')}' left this comment:\n\n{comment_text}\n\nWrite a polite, helpful reply in 2-4 sentences."}
    ], max_tokens=300)
    return {"suggested_reply": reply_text, "comment_id": comment_id}

@api_router.post("/comments/{site_id}/post-reply/{comment_id}")
async def post_comment_reply(site_id: str, comment_id: int, data: CommentReplyRequest, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    payload = {"content": data.content, "parent": comment_id, "post": data.parent_id}
    resp = await wp_api_request(site, "POST", "comments", payload)
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=resp.text[:300])
    await log_activity(site_id, "comment_replied", f"Replied to comment {comment_id}")
    return resp.json()

@api_router.post("/comments/{site_id}/auto-moderate")
async def auto_moderate_comments(site_id: str, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    resp = await wp_api_request(site, "GET", "comments?per_page=100&status=hold&_fields=id,author_name,content,author_email")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Could not fetch pending comments")
    comments = resp.json()
    if not comments:
        return {"approved": 0, "spammed": 0, "deleted": 0}
    comment_list = []
    for c in comments:
        text = BeautifulSoup(c.get("content", {}).get("rendered", ""), "html.parser").get_text()
        comment_list.append(f"ID:{c['id']} Author:{c.get('author_name','')} Text:{text[:200]}")
    prompt = "Classify each comment as 'approve', 'spam', or 'delete'. Reply ONLY with a JSON array of objects: [{\"id\": <int>, \"action\": \"approve\"|\"spam\"|\"delete\"}]. Comments:\n" + "\n".join(comment_list)
    raw = await get_ai_response([{"role": "user", "content": prompt}], max_tokens=1000)
    try:
        start = raw.find("[")
        end = raw.rfind("]") + 1
        decisions = json.loads(raw[start:end])
    except Exception:
        raise HTTPException(status_code=500, detail="AI returned invalid JSON")
    approved = spammed = deleted = 0
    for d in decisions:
        try:
            cid = int(d["id"])
            action = d["action"]
            if action == "approve":
                await wp_api_request(site, "POST", f"comments/{cid}", {"status": "approved"})
                approved += 1
            elif action == "spam":
                await wp_api_request(site, "POST", f"comments/{cid}", {"status": "spam"})
                spammed += 1
            elif action == "delete":
                await wp_api_request(site, "DELETE", f"comments/{cid}?force=true")
                deleted += 1
        except Exception:
            pass
    await log_activity(site_id, "comments_auto_moderated",
        f"Auto-moderated: {approved} approved, {spammed} spammed, {deleted} deleted")
    return {"approved": approved, "spammed": spammed, "deleted": deleted}
