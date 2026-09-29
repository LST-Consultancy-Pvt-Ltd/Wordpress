"""Social Media Auto-Poster: connect accounts, AI-generate per-platform posts
from a topic or a synced content item, publish now or queue for later, and
process the scheduled queue.
"""
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import List, Optional

import httpx
from bs4 import BeautifulSoup
from fastapi import Body, Depends, HTTPException
from pydantic import BaseModel

from core.activity import log_activity
from core.ai import get_ai_response
from core.db import db
from core.router import api_router
from core.security import require_editor
from providers.sites import get_site

logger = logging.getLogger(__name__)

# ============================================================
# FEATURE 9 — A/B TESTING ENGINE
# ============================================================

class ABTestCreate(BaseModel):
    post_id: int
    content_type: str = "post"
    test_type: str = "title"  # title | meta_desc | content_intro
    variant_a_title: str = ""
    variant_b_title: str = ""
    variant_a_meta_desc: str = ""
    variant_b_meta_desc: str = ""

# ============================================================
# FEATURE 10 — SOCIAL MEDIA AUTO-POSTER
# ============================================================

class SocialAccountConnect(BaseModel):
    platform: str
    access_token: str
    account_name: str
    page_id: Optional[str] = None

class SocialPublishRequest(BaseModel):
    platforms: List[str]
    content: Optional[dict] = None
    scheduled_at: Optional[str] = None

class SocialAutoPostSettings(BaseModel):
    auto_post_on_publish: bool = False
    default_platforms: List[str] = []
    post_delay_minutes: int = 0

@api_router.get("/social/{site_id}/accounts")
async def get_social_accounts(site_id: str, current_user: dict = Depends(require_editor)):
    accounts = await db.social_accounts.find({"site_id": site_id}, {"_id": 0, "access_token": 0}).to_list(20)
    return accounts

@api_router.post("/social/{site_id}/connect")
async def connect_social_account(site_id: str, data: SocialAccountConnect, current_user: dict = Depends(require_editor)):
    account_id = str(uuid.uuid4())
    doc = {"id": account_id, "site_id": site_id, "platform": data.platform,
           "account_name": data.account_name, "page_id": data.page_id,
           "access_token": data.access_token,
           "connected_at": datetime.now(timezone.utc).isoformat()}
    await db.social_accounts.replace_one({"site_id": site_id, "platform": data.platform}, doc, upsert=True)
    await log_activity(site_id, "social_connected", f"Connected {data.platform} account: {data.account_name}")
    return {"success": True, "id": account_id, "platform": data.platform}

@api_router.delete("/social/{site_id}/accounts/{account_id}")
async def disconnect_social_account(site_id: str, account_id: str, current_user: dict = Depends(require_editor)):
    await db.social_accounts.delete_one({"id": account_id, "site_id": site_id})
    return {"success": True}

@api_router.post("/social/{site_id}/generate-post")
async def generate_social_post_topic(site_id: str, data: dict = Body(...), current_user: dict = Depends(require_editor)):
    """Generate social posts from a free-form topic (no content item required)."""
    topic = (data.get("topic") or "").strip()
    platform = data.get("platform", "all")
    if not topic:
        raise HTTPException(status_code=422, detail="topic is required")
    raw = await get_ai_response([
        {"role": "system", "content": "You are a social media expert creating platform-specific content."},
        {"role": "user", "content": (
            f"Create engaging social media posts about this topic: {topic}\n\n"
            "Return ONLY a JSON object with keys: twitter (280 chars max with hashtags), "
            "linkedin (professional tone, 3-5 sentences, 3-5 hashtags), "
            "facebook (casual and engaging), instagram (caption + 10 hashtags)"
        )}
    ], max_tokens=1000)
    try:
        start = raw.find("{")
        end = raw.rfind("}") + 1
        variants = json.loads(raw[start:end])
    except Exception:
        variants = {"twitter": topic, "linkedin": topic, "facebook": topic, "instagram": topic}
    return variants

@api_router.post("/social/{site_id}/generate-post/{content_id}")
async def generate_social_post(site_id: str, content_id: int, current_user: dict = Depends(require_editor)):
    await get_site(site_id)
    post = await db.content_items.find_one({"site_id": site_id, "content_id": content_id}, {"_id": 0})
    if not post:
        raise HTTPException(status_code=404, detail="Content item not found; sync the site's content first")
    title = post.get("title", "")
    excerpt = ((post.get("frontmatter") or {}).get("description")
               or BeautifulSoup(post.get("body", ""), "html.parser").get_text())[:400]
    url = post.get("url", "")
    raw = await get_ai_response([
        {"role": "system", "content": "You are a social media expert creating platform-specific content."},
        {"role": "user", "content": f"Create social media posts for this blog article.\nTitle: {title}\nExcerpt: {excerpt}\nURL: {url}\n\nReturn JSON with keys: twitter (280 chars max with hashtags), linkedin (professional + hashtags), facebook (casual engaging), instagram (caption + 10 hashtags)"}
    ], max_tokens=1000)
    try:
        start = raw.find("{")
        end = raw.rfind("}") + 1
        variants = json.loads(raw[start:end])
    except Exception:
        variants = {"twitter": f"{title} {url}", "linkedin": f"{title}\n\n{excerpt}\n\n{url}", "facebook": f"{title} - {url}", "instagram": f"{title}\n\n{url}"}
    return variants

@api_router.post("/social/{site_id}/publish/{content_id}")
async def publish_social_post(site_id: str, content_id: int, data: SocialPublishRequest, current_user: dict = Depends(require_editor)):
    queue_id = str(uuid.uuid4())
    scheduled_at = data.scheduled_at or datetime.now(timezone.utc).isoformat()
    doc = {"id": queue_id, "site_id": site_id, "content_id": content_id, "platforms": data.platforms,
           "content": data.content or {}, "scheduled_at": scheduled_at,
           "status": "pending", "created_at": datetime.now(timezone.utc).isoformat()}
    await db.social_queue.insert_one(doc)
    # If no scheduled time or immediate, publish now
    from datetime import datetime as dt
    sched_dt = dt.fromisoformat(scheduled_at.replace("Z", "+00:00")) if scheduled_at else dt.now(timezone.utc)
    if sched_dt <= dt.now(timezone.utc):
        results = await _publish_to_platforms(site_id, doc)
        await db.social_queue.update_one({"id": queue_id}, {"$set": {"status": "published", "publish_results": results}})
        return {"success": True, "queue_id": queue_id, "status": "published", "results": results}
    return {"success": True, "queue_id": queue_id, "status": "scheduled", "scheduled_at": scheduled_at}

async def _publish_to_platforms(site_id: str, queue_doc: dict) -> dict:
    results = {}
    accounts = await db.social_accounts.find({"site_id": site_id}, {"_id": 0}).to_list(20)
    account_map = {a["platform"]: a for a in accounts}
    content = queue_doc.get("content", {})
    for platform in queue_doc.get("platforms", []):
        account = account_map.get(platform)
        if not account:
            results[platform] = {"success": False, "error": "Account not connected"}
            continue
        token = account.get("access_token", "")
        try:
            if platform == "twitter":
                async with httpx.AsyncClient(timeout=15.0) as hc:
                    r = await hc.post("https://api.twitter.com/2/tweets",
                        json={"text": content.get("twitter", "")[:280]},
                        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
                ok = r.status_code in (200, 201)
                if not ok:
                    logger.error(f"Twitter post failed ({r.status_code}): {r.text[:400]}")
                results[platform] = {"success": ok, "status_code": r.status_code,
                                     "error": r.text[:300] if not ok else None}
            elif platform == "facebook":
                page_id = account.get("page_id") or "me"
                msg = content.get("facebook") or content.get(list(content.keys())[0], "") if content else ""
                async with httpx.AsyncClient(timeout=15.0) as hc:
                    r = await hc.post(
                        f"https://graph.facebook.com/v19.0/{page_id}/feed",
                        data={"message": msg, "access_token": token},
                    )
                resp_json = {}
                try:
                    resp_json = r.json()
                except Exception:
                    pass
                # Facebook returns 200 even on error — check response body
                fb_error = resp_json.get("error", {})
                ok = r.status_code in (200, 201) and not fb_error and resp_json.get("id")
                if not ok:
                    err_msg = fb_error.get("message") or r.text[:300]
                    logger.error(f"Facebook post failed ({r.status_code}): {err_msg}")
                    results[platform] = {"success": False, "status_code": r.status_code, "error": err_msg}
                else:
                    results[platform] = {"success": True, "post_id": resp_json.get("id")}
            elif platform == "linkedin":
                # LinkedIn needs the URN of the person/org, not just account_name
                author_urn = account.get("author_urn") or f"urn:li:person:{account.get('page_id') or account.get('account_name','')}"
                async with httpx.AsyncClient(timeout=15.0) as hc:
                    r = await hc.post("https://api.linkedin.com/v2/ugcPosts",
                        json={"author": author_urn, "lifecycleState": "PUBLISHED",
                              "specificContent": {"com.linkedin.ugc.ShareContent": {
                                  "shareCommentary": {"text": content.get("linkedin", "")},
                                  "shareMediaCategory": "NONE"}},
                              "visibility": {"com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"}},
                        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
                ok = r.status_code in (200, 201)
                if not ok:
                    logger.error(f"LinkedIn post failed ({r.status_code}): {r.text[:400]}")
                results[platform] = {"success": ok, "status_code": r.status_code,
                                     "error": r.text[:300] if not ok else None}
            else:
                results[platform] = {"success": False, "error": f"{platform} not implemented"}
        except Exception as e:
            logger.error(f"Platform publish exception ({platform}): {e}")
            results[platform] = {"success": False, "error": str(e)}
    return results

@api_router.get("/social/{site_id}/queue")
async def get_social_queue(site_id: str, current_user: dict = Depends(require_editor)):
    items = await db.social_queue.find({"site_id": site_id}, {"_id": 0}).sort("scheduled_at", -1).to_list(100)
    return items

@api_router.post("/social/{site_id}/auto-post-settings")
async def save_auto_post_settings(site_id: str, data: SocialAutoPostSettings, current_user: dict = Depends(require_editor)):
    await db.sites.update_one({"id": site_id}, {"$set": {"social_auto_post": data.model_dump()}})
    return {"success": True}

@api_router.post("/social/{site_id}/process-queue")
async def process_social_queue(site_id: str, current_user: dict = Depends(require_editor)):
    from datetime import datetime as dt
    now_iso = dt.now(timezone.utc).isoformat()
    pending = await db.social_queue.find(
        {"site_id": site_id, "status": "pending", "scheduled_at": {"$lte": now_iso}},
        {"_id": 0}
    ).to_list(50)
    published = 0
    for item in pending:
        results = await _publish_to_platforms(site_id, item)
        await db.social_queue.update_one({"id": item["id"]}, {"$set": {"status": "published", "publish_results": results}})
        published += 1
    return {"published": published}
