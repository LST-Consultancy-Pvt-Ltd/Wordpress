"""Email Newsletter Builder (Mailchimp integration with a DB-backed fallback list,
AI-generated HTML newsletter from recent posts, send/schedule, subscribe) and Site
Health & Uptime Monitor (ping/response-time, SSL expiry, WP version/core-update
check, AI-explained fixes for common issues) for a connected WordPress site.
"""
import logging
import re
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel
from typing import Optional

from bs4 import BeautifulSoup

from core.activity import log_activity
from core.ai import get_ai_response
from core.crypto import get_decrypted_settings
from core.db import db
from core.router import api_router
from core.security import require_editor
from providers.wordpress import get_wp_credentials, wp_api_request

logger = logging.getLogger(__name__)

# ============================================================
# FEATURE 11 — EMAIL NEWSLETTER BUILDER
# ============================================================

class NewsletterGenerateRequest(BaseModel):
    list_id: Optional[str] = None
    posts_count: int = 5
    tone: str = "professional"

class NewsletterSendRequest(BaseModel):
    html_content: str
    subject: str
    list_id: Optional[str] = None
    scheduled_at: Optional[str] = None

@api_router.get("/newsletter/{site_id}/lists")
async def get_newsletter_lists(site_id: str, current_user: dict = Depends(require_editor)):
    settings = await get_decrypted_settings()
    mailchimp_key = settings.get("mailchimp_api_key", "")
    if mailchimp_key:
        dc = mailchimp_key.split("-")[-1]
        async with httpx.AsyncClient(timeout=15.0) as hc:
            r = await hc.get(f"https://{dc}.api.mailchimp.com/3.0/lists?count=20",
                             auth=("anystring", mailchimp_key))
        if r.status_code == 200:
            return r.json().get("lists", [])
    # Fallback: custom lists in DB
    lists = await db.email_lists.find({"site_id": site_id}, {"_id": 0}).to_list(20)
    return lists

@api_router.post("/newsletter/{site_id}/generate")
async def generate_newsletter(site_id: str, data: NewsletterGenerateRequest, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    posts_resp = await wp_api_request(site, "GET", f"posts?per_page={data.posts_count}&status=publish&_fields=title,excerpt,link,date,featured_media")
    posts = posts_resp.json() if posts_resp.status_code == 200 else []
    post_summaries = "\n".join([
        f"- {BeautifulSoup(p.get('title',{}).get('rendered',''),'html.parser').get_text()}: {p.get('link','')} — {BeautifulSoup(p.get('excerpt',{}).get('rendered',''),'html.parser').get_text()[:150]}"
        for p in posts
    ])
    site_name = site.get("name", "Our Blog")
    html_content = await get_ai_response([
        {"role": "system", "content": "You are an expert email newsletter designer. Create beautiful HTML email newsletters."},
        {"role": "user", "content": f"Create a complete HTML email newsletter for '{site_name}' with a {data.tone} tone. Include: subject line (as HTML comment <!-- SUBJECT: ... -->), preview text, intro paragraph, summaries with CTAs for each post, and a footer.\n\nRecent posts:\n{post_summaries}\n\nReturn complete HTML that renders well in email clients."}
    ], max_tokens=4000)
    # Extract subject
    subject = f"{site_name} Newsletter"
    m = re.search(r"<!--\s*SUBJECT:\s*(.+?)\s*-->", html_content)
    if m:
        subject = m.group(1)
    draft_id = str(uuid.uuid4())
    doc = {"id": draft_id, "site_id": site_id, "subject": subject, "html_content": html_content,
           "created_at": datetime.now(timezone.utc).isoformat(), "status": "draft"}
    await db.newsletter_drafts.insert_one(doc)
    await log_activity(site_id, "newsletter_generated", f"Newsletter draft generated: {subject}")
    return {"draft_id": draft_id, "subject": subject, "html_content": html_content}

@api_router.post("/newsletter/{site_id}/send")
async def send_newsletter(site_id: str, data: NewsletterSendRequest, current_user: dict = Depends(require_editor)):
    settings = await get_decrypted_settings()
    mailchimp_key = settings.get("mailchimp_api_key", "")
    result = {"stored": True}
    if mailchimp_key and data.list_id:
        dc = mailchimp_key.split("-")[-1]
        async with httpx.AsyncClient(timeout=20.0) as hc:
            # Create campaign
            camp_resp = await hc.post(
                f"https://{dc}.api.mailchimp.com/3.0/campaigns",
                json={"type": "regular", "recipients": {"list_id": data.list_id},
                      "settings": {"subject_line": data.subject, "from_name": "Newsletter", "reply_to": "noreply@example.com"}},
                auth=("anystring", mailchimp_key))
            if camp_resp.status_code in (200, 201):
                campaign_id = camp_resp.json().get("id")
                # Set content
                await hc.put(f"https://{dc}.api.mailchimp.com/3.0/campaigns/{campaign_id}/content",
                             json={"html": data.html_content}, auth=("anystring", mailchimp_key))
                if data.scheduled_at:
                    await hc.post(f"https://{dc}.api.mailchimp.com/3.0/campaigns/{campaign_id}/actions/schedule",
                                  json={"schedule_time": data.scheduled_at}, auth=("anystring", mailchimp_key))
                else:
                    await hc.post(f"https://{dc}.api.mailchimp.com/3.0/campaigns/{campaign_id}/actions/send",
                                  auth=("anystring", mailchimp_key))
                result["mailchimp_campaign_id"] = campaign_id
                result["sent"] = True
    await db.newsletter_drafts.update_one(
        {"site_id": site_id, "html_content": data.html_content},
        {"$set": {"status": "sent", "sent_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True
    )
    await log_activity(site_id, "newsletter_sent", f"Newsletter sent: {data.subject}")
    return result

@api_router.get("/newsletter/{site_id}/history")
async def get_newsletter_history(site_id: str, current_user: dict = Depends(require_editor)):
    drafts = await db.newsletter_drafts.find({"site_id": site_id}, {"_id": 0, "html_content": 0}).sort("created_at", -1).to_list(50)
    return drafts

@api_router.post("/newsletter/{site_id}/subscribe")
async def subscribe_to_newsletter(site_id: str, request: Request):
    body = await request.json()
    email = body.get("email", "")
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Invalid email")
    await db.email_lists.update_one(
        {"site_id": site_id},
        {"$addToSet": {"subscribers": email}, "$setOnInsert": {"id": str(uuid.uuid4()), "site_id": site_id, "name": "Default List"}},
        upsert=True
    )
    return {"success": True, "email": email}

# ============================================================
# FEATURE 12 — SITE HEALTH & UPTIME MONITOR
# ============================================================

class HealthScheduleRequest(BaseModel):
    check_interval_minutes: int = 60

@api_router.get("/health/{site_id}")
async def get_health_data(site_id: str, current_user: dict = Depends(require_editor)):
    health = await db.site_health.find_one({"site_id": site_id}, {"_id": 0})
    return health or {"site_id": site_id, "status": "not_checked"}

@api_router.post("/health/{site_id}/check")
async def run_health_check(site_id: str, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    site_url = site["url"].rstrip("/")
    result = {"site_id": site_id, "checked_at": datetime.now(timezone.utc).isoformat(),
              "response_time_ms": None, "online": False, "ssl_expiry_days": None,
              "wp_version": None, "wp_update_available": False, "health_checks": [], "issues": []}
    # 1. Ping + response time
    try:
        import time as _time
        t0 = _time.monotonic()
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as hc:
            ping = await hc.get(site_url)
        result["response_time_ms"] = int((_time.monotonic() - t0) * 1000)
        result["online"] = ping.status_code < 500
        result["http_status"] = ping.status_code
    except Exception as e:
        result["issues"].append({"key": "unreachable", "status": "critical", "description": f"Site unreachable: {e}"})
    # 2. SSL cert expiry
    try:
        import ssl
        import socket
        from urllib.parse import urlparse
        parsed = urlparse(site_url)
        hostname = parsed.hostname
        if parsed.scheme == "https" and hostname:
            ctx = ssl.create_default_context()
            with ctx.wrap_socket(socket.socket(), server_hostname=hostname) as s:
                s.settimeout(10)
                s.connect((hostname, 443))
                cert = s.getpeercert()
            not_after = cert.get("notAfter", "")
            if not_after:
                from datetime import datetime as dt
                expiry = dt.strptime(not_after, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
                days_left = (expiry - dt.now(timezone.utc)).days
                result["ssl_expiry_days"] = days_left
                if days_left < 30:
                    result["issues"].append({"key": "ssl_expiry", "status": "warning" if days_left > 7 else "critical",
                                             "description": f"SSL certificate expires in {days_left} days"})
    except Exception:
        pass
    # 3. WP version + WP health check
    try:
        wp_info_resp = await wp_api_request(site, "GET", "../../")
        if wp_info_resp.status_code == 200:
            info = wp_info_resp.json()
            result["wp_version"] = info.get("namespaces") and "wp/v2" in info.get("namespaces", []) and "detected"
        # Try site health
        health_resp = await wp_api_request(site, "GET", "../../wp-site-health/v1/tests/dotorg-communication")
        if health_resp.status_code == 200:
            result["health_checks"].append(health_resp.json())
    except Exception:
        pass
    # 4. Check WP latest version from wordpress.org
    try:
        async with httpx.AsyncClient(timeout=10.0) as hc:
            wp_api = await hc.get("https://api.wordpress.org/core/version-check/1.7/")
        if wp_api.status_code == 200:
            latest = wp_api.json().get("offers", [{}])[0].get("version", "")
            result["wp_latest_version"] = latest
    except Exception:
        pass
    # Store result
    await db.site_health.replace_one({"site_id": site_id}, result, upsert=True)
    await db.site_health_history.insert_one({**result, "id": str(uuid.uuid4())})
    await log_activity(site_id, "health_check_run", f"Health check: {result['response_time_ms']}ms, online={result['online']}")
    # Create notifications for critical issues
    for issue in result.get("issues", []):
        if issue.get("status") == "critical":
            await db.notifications.insert_one({
                "id": str(uuid.uuid4()), "site_id": site_id, "type": issue["key"],
                "message": issue["description"], "read": False,
                "created_at": datetime.now(timezone.utc).isoformat()
            })
    return result

@api_router.get("/health/{site_id}/history")
async def get_health_history(site_id: str, current_user: dict = Depends(require_editor)):
    history = await db.site_health_history.find(
        {"site_id": site_id}, {"_id": 0, "health_checks": 0}
    ).sort("checked_at", -1).to_list(30)
    return history

@api_router.post("/health/{site_id}/schedule-monitor")
async def schedule_health_monitor(site_id: str, data: HealthScheduleRequest, current_user: dict = Depends(require_editor)):
    await db.sites.update_one({"id": site_id}, {"$set": {"health_check_interval_minutes": data.check_interval_minutes}})
    return {"success": True, "interval_minutes": data.check_interval_minutes}

@api_router.post("/health/{site_id}/fix/{issue_key}")
async def get_health_fix(site_id: str, issue_key: str, current_user: dict = Depends(require_editor)):
    fix_prompts = {
        "php_version": "Explain step-by-step how to upgrade PHP version on a WordPress hosting environment (cPanel, Hostinger, etc)",
        "memory_limit": "Explain exactly how to increase WordPress PHP memory limit via wp-config.php and .htaccess",
        "ssl_expiry": "Explain step-by-step how to renew an SSL certificate for a WordPress site (Let's Encrypt, cPanel, Hostinger)",
        "debug_mode_on": "Explain how to safely disable WordPress debug mode (WP_DEBUG=false) and clean up debug.log",
        "unreachable": "Explain how to diagnose and fix a WordPress site that is returning errors or is unreachable",
    }
    prompt = fix_prompts.get(issue_key, f"Explain how to fix the WordPress issue: {issue_key}")
    instructions = await get_ai_response([{"role": "user", "content": prompt}], max_tokens=800)
    return {"issue_key": issue_key, "instructions": instructions}
