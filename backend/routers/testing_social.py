"""A/B Testing Engine (title/meta-desc variants pushed to WordPress, impression/
click tracking, AI-declared winner) and Social Media Auto-Poster (connect
accounts, AI-generate per-platform posts from a topic or a WP post, publish
now or queue for later, process the scheduled queue) for a connected site.
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
from providers.wordpress import get_wp_credentials, wp_api_request

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

@api_router.get("/ab/{site_id}")
async def list_ab_tests(site_id: str, current_user: dict = Depends(require_editor)):
    tests = await db.ab_tests.find({"site_id": site_id}, {"_id": 0}).sort("created_at", -1).to_list(100)
    return tests

@api_router.post("/ab/{site_id}/create")
async def create_ab_test(site_id: str, data: ABTestCreate, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    test_id = str(uuid.uuid4())
    # Push variant A to WordPress immediately
    ep = f"{data.content_type}s/{data.post_id}"
    if data.test_type == "title" and data.variant_a_title:
        await wp_api_request(site, "POST", ep, {"title": data.variant_a_title})
    doc = {
        "id": test_id, "site_id": site_id, "post_id": data.post_id,
        "content_type": data.content_type, "test_type": data.test_type,
        "variant_a_title": data.variant_a_title, "variant_b_title": data.variant_b_title,
        "variant_a_meta_desc": data.variant_a_meta_desc, "variant_b_meta_desc": data.variant_b_meta_desc,
        "variant_a_impressions": 0, "variant_b_impressions": 0,
        "variant_a_clicks": 0, "variant_b_clicks": 0,
        "active_variant": "a", "status": "running",
        "winner": None, "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.ab_tests.insert_one(doc)
    await log_activity(site_id, "ab_test_created", f"A/B test created for post {data.post_id}")
    return doc

@api_router.post("/ab/{site_id}/record-impression/{test_id}")
async def record_impression(site_id: str, test_id: str, variant: str = "a"):
    field = f"variant_{variant}_impressions"
    await db.ab_tests.update_one({"id": test_id, "site_id": site_id}, {"$inc": {field: 1}})
    return {"success": True}

@api_router.post("/ab/{site_id}/record-click/{test_id}")
async def record_click(site_id: str, test_id: str, variant: str = "a"):
    field = f"variant_{variant}_clicks"
    await db.ab_tests.update_one({"id": test_id, "site_id": site_id}, {"$inc": {field: 1}})
    return {"success": True}

@api_router.post("/ab/{site_id}/switch-variant/{test_id}")
async def switch_ab_variant(site_id: str, test_id: str, current_user: dict = Depends(require_editor)):
    test = await db.ab_tests.find_one({"id": test_id, "site_id": site_id})
    if not test:
        raise HTTPException(status_code=404, detail="Test not found")
    site = await get_wp_credentials(site_id, current_user["id"])
    ep = f"{test['content_type']}s/{test['post_id']}"
    if test["test_type"] == "title":
        await wp_api_request(site, "POST", ep, {"title": test["variant_b_title"]})
    await db.ab_tests.update_one({"id": test_id}, {"$set": {"active_variant": "b"}})
    await log_activity(site_id, "ab_test_switched", f"Switched to variant B for test {test_id}")
    return {"success": True, "active_variant": "b"}

@api_router.post("/ab/{site_id}/conclude/{test_id}")
async def conclude_ab_test(site_id: str, test_id: str, current_user: dict = Depends(require_editor)):
    test = await db.ab_tests.find_one({"id": test_id, "site_id": site_id})
    if not test:
        raise HTTPException(status_code=404, detail="Test not found")
    a_clicks = test.get("variant_a_clicks", 0)
    a_imp = test.get("variant_a_impressions", 1)
    b_clicks = test.get("variant_b_clicks", 0)
    b_imp = test.get("variant_b_impressions", 1)
    a_ctr = a_clicks / a_imp
    b_ctr = b_clicks / b_imp
    analysis = await get_ai_response([{"role": "user", "content": f"A/B test results:\nVariant A: {a_clicks} clicks / {a_imp} impressions (CTR: {a_ctr:.1%})\nVariant B: {b_clicks} clicks / {b_imp} impressions (CTR: {b_ctr:.1%})\nVariant A title: {test.get('variant_a_title','')}\nVariant B title: {test.get('variant_b_title','')}\n\nDeclare the winner and explain why in 2 sentences."}], max_tokens=300)
    winner = "b" if b_ctr > a_ctr else "a"
    # Push winning variant to WP
    site = await get_wp_credentials(site_id, current_user["id"])
    winning_title = test.get(f"variant_{winner}_title", "")
    if winning_title:
        ep = f"{test['content_type']}s/{test['post_id']}"
        await wp_api_request(site, "POST", ep, {"title": winning_title})
    await db.ab_tests.update_one({"id": test_id}, {"$set": {"status": "concluded", "winner": winner, "analysis": analysis}})
    await log_activity(site_id, "ab_test_concluded", f"A/B test {test_id} concluded, winner: variant {winner}")
    return {"winner": winner, "analysis": analysis, "a_ctr": a_ctr, "b_ctr": b_ctr}

@api_router.post("/ab/{site_id}/ai-generate-variants/{post_id}")
async def generate_ab_variants(site_id: str, post_id: int, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    resp = await wp_api_request(site, "GET", f"posts/{post_id}?_fields=title,excerpt,content")
    if resp.status_code != 200:
        raise HTTPException(status_code=404, detail="Post not found")
    post = resp.json()
    title = post.get("title", {}).get("rendered", "")
    excerpt = BeautifulSoup(post.get("excerpt", {}).get("rendered", ""), "html.parser").get_text()[:300]
    raw = await get_ai_response([
        {"role": "user", "content": f"Generate 3 alternative title variants and 3 meta description variants for A/B testing.\n\nOriginal title: {title}\nExcerpt: {excerpt}\n\nReturn JSON: {{\"title_variants\": [str, str, str], \"meta_desc_variants\": [str, str, str]}}"}
    ], max_tokens=600)
    try:
        start = raw.find("{")
        end = raw.rfind("}") + 1
        variants = json.loads(raw[start:end])
    except Exception:
        variants = {"title_variants": [], "meta_desc_variants": []}
    return variants

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
    """Generate social posts from a free-form topic (no WP post required)."""
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

@api_router.post("/social/{site_id}/generate-post/{wp_post_id}")
async def generate_social_post(site_id: str, wp_post_id: int, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    resp = await wp_api_request(site, "GET", f"posts/{wp_post_id}?_fields=title,excerpt,link,featured_media")
    if resp.status_code != 200:
        raise HTTPException(status_code=404, detail="Post not found")
    post = resp.json()
    title = BeautifulSoup(post.get("title", {}).get("rendered", ""), "html.parser").get_text()
    excerpt = BeautifulSoup(post.get("excerpt", {}).get("rendered", ""), "html.parser").get_text()[:400]
    url = post.get("link", "")
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

@api_router.post("/social/{site_id}/publish/{wp_post_id}")
async def publish_social_post(site_id: str, wp_post_id: int, data: SocialPublishRequest, current_user: dict = Depends(require_editor)):
    queue_id = str(uuid.uuid4())
    scheduled_at = data.scheduled_at or datetime.now(timezone.utc).isoformat()
    doc = {"id": queue_id, "site_id": site_id, "wp_post_id": wp_post_id, "platforms": data.platforms,
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
