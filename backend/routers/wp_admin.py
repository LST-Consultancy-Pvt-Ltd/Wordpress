"""User & Role Manager (list/create/update/delete WordPress users, reset password)
and Plugin & Theme Manager (list/activate/deactivate plugins and themes, AI-driven
plugin security scan) for a connected WordPress site.
"""
import base64
import json
import logging
from typing import Optional

import httpx
from fastapi import Depends, HTTPException
from pydantic import BaseModel

from core.activity import log_activity
from core.ai import get_ai_response
from core.router import api_router
from core.security import require_editor
from providers.wordpress import get_wp_credentials, wp_api_request

logger = logging.getLogger(__name__)

# ============================================================
# FEATURE 3 — USER & ROLE MANAGER
# ============================================================

class WPUserCreate(BaseModel):
    username: str
    email: str
    password: str
    role: str = "subscriber"
    first_name: str = ""
    last_name: str = ""

class WPUserUpdate(BaseModel):
    role: Optional[str] = None
    email: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None

@api_router.get("/wp-users/{site_id}")
async def get_wp_users(site_id: str, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    resp = await wp_api_request(site, "GET", "users?per_page=100&context=edit&_fields=id,name,slug,email,roles,registered_date,link,avatar_urls,meta")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=resp.text[:300])
    return resp.json()

@api_router.post("/wp-users/{site_id}")
async def create_wp_user(site_id: str, data: WPUserCreate, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    payload = {"username": data.username, "email": data.email, "password": data.password,
                "roles": [data.role], "first_name": data.first_name, "last_name": data.last_name}
    resp = await wp_api_request(site, "POST", "users", payload)
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=resp.text[:300])
    await log_activity(site_id, "wp_user_created", f"Created WP user {data.username}")
    return resp.json()

@api_router.put("/wp-users/{site_id}/{user_id}")
async def update_wp_user(site_id: str, user_id: int, data: WPUserUpdate, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    payload = {k: v for k, v in data.model_dump().items() if v is not None}
    if "role" in payload:
        payload["roles"] = [payload.pop("role")]
    resp = await wp_api_request(site, "POST", f"users/{user_id}", payload)
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=resp.text[:300])
    await log_activity(site_id, "wp_user_updated", f"Updated WP user {user_id}")
    return resp.json()

@api_router.delete("/wp-users/{site_id}/{user_id}")
async def delete_wp_user(site_id: str, user_id: int, reassign: int = 1, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    resp = await wp_api_request(site, "DELETE", f"users/{user_id}?force=true&reassign={reassign}")
    await log_activity(site_id, "wp_user_deleted", f"Deleted WP user {user_id}, posts reassigned to {reassign}")
    return {"success": True}

@api_router.post("/wp-users/{site_id}/reset-password/{user_id}")
async def reset_wp_user_password(site_id: str, user_id: int, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    import secrets
    new_password = secrets.token_urlsafe(16)
    resp = await wp_api_request(site, "POST", f"users/{user_id}", {"password": new_password})
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=resp.text[:300])
    await log_activity(site_id, "wp_user_password_reset", f"Password reset for WP user {user_id}")
    return {"success": True, "new_password": new_password}

# ============================================================
# FEATURE 4 — PLUGIN & THEME MANAGER
# ============================================================

@api_router.get("/plugins-themes/{site_id}/plugins")
async def get_plugins(site_id: str, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    wp_url = site["url"].rstrip("/") + "/wp-json/wp/v2/plugins"
    app_password = site["app_password"].replace(" ", "")
    b64 = base64.b64encode(f"{site['username']}:{app_password}".encode()).decode()
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as hc:
        resp = await hc.get(wp_url, headers={"Authorization": f"Basic {b64}"})
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=resp.text[:300])
    return resp.json()

async def _plugin_action(site: dict, plugin_slug: str, action: str):
    wp_url = site["url"].rstrip("/") + f"/wp-json/wp/v2/plugins/{plugin_slug}"
    app_password = site["app_password"].replace(" ", "")
    b64 = base64.b64encode(f"{site['username']}:{app_password}".encode()).decode()
    status_map = {"activate": "active", "deactivate": "inactive"}
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as hc:
        if action in ("activate", "deactivate"):
            resp = await hc.post(wp_url, json={"status": status_map[action]},
                                 headers={"Authorization": f"Basic {b64}", "Content-Type": "application/json"})
        else:  # update — WP REST doesn't support direct update; return instructions
            return {"success": False, "message": "Plugin updates via REST API require WP-CLI or the Automatic Updates REST endpoint. Use WP Admin instead."}
    return resp.json() if resp.status_code in (200, 201) else {"success": False, "error": resp.text[:200]}

@api_router.post("/plugins-themes/{site_id}/plugins/{plugin_slug:path}/activate")
async def activate_plugin(site_id: str, plugin_slug: str, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    result = await _plugin_action(site, plugin_slug, "activate")
    await log_activity(site_id, "plugin_activated", f"Plugin {plugin_slug} activated")
    return result

@api_router.post("/plugins-themes/{site_id}/plugins/{plugin_slug:path}/deactivate")
async def deactivate_plugin(site_id: str, plugin_slug: str, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    result = await _plugin_action(site, plugin_slug, "deactivate")
    await log_activity(site_id, "plugin_deactivated", f"Plugin {plugin_slug} deactivated")
    return result

@api_router.post("/plugins-themes/{site_id}/plugins/{plugin_slug:path}/update")
async def update_plugin(site_id: str, plugin_slug: str, current_user: dict = Depends(require_editor)):
    return {"success": False, "message": "Plugin updates require WP-CLI or WP Admin. The WP REST API does not support remote plugin updates for security reasons."}

@api_router.get("/plugins-themes/{site_id}/themes")
async def get_themes(site_id: str, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    wp_url = site["url"].rstrip("/") + "/wp-json/wp/v2/themes"
    app_password = site["app_password"].replace(" ", "")
    b64 = base64.b64encode(f"{site['username']}:{app_password}".encode()).decode()
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as hc:
        resp = await hc.get(wp_url, headers={"Authorization": f"Basic {b64}"})
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=resp.text[:300])
    return resp.json()

@api_router.post("/plugins-themes/{site_id}/themes/{stylesheet}/activate")
async def activate_theme(site_id: str, stylesheet: str, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    wp_url = site["url"].rstrip("/") + f"/wp-json/wp/v2/themes/{stylesheet}"
    app_password = site["app_password"].replace(" ", "")
    b64 = base64.b64encode(f"{site['username']}:{app_password}".encode()).decode()
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as hc:
        resp = await hc.post(wp_url, json={"status": "active"},
                             headers={"Authorization": f"Basic {b64}", "Content-Type": "application/json"})
    await log_activity(site_id, "theme_activated", f"Theme {stylesheet} activated")
    return resp.json() if resp.status_code in (200, 201) else {"success": False, "error": resp.text[:200]}

@api_router.post("/plugins-themes/{site_id}/security-scan")
async def plugin_security_scan(site_id: str, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    wp_url = site["url"].rstrip("/") + "/wp-json/wp/v2/plugins"
    app_password = site["app_password"].replace(" ", "")
    b64 = base64.b64encode(f"{site['username']}:{app_password}".encode()).decode()
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as hc:
        resp = await hc.get(wp_url, headers={"Authorization": f"Basic {b64}"})
    plugins = resp.json() if resp.status_code == 200 else []
    plugin_list = "\n".join([f"- {p.get('name','?')} v{p.get('version','?')} (author: {p.get('author','?')}, status: {p.get('status','?')})" for p in plugins[:30]])
    scan_result = await get_ai_response([
        {"role": "system", "content": "You are a WordPress security expert. Analyze plugins and flag security risks."},
        {"role": "user", "content": f"Analyze these WordPress plugins and classify each as 'safe', 'warning', or 'critical'. For each flagged plugin, explain why. Return JSON array: [{{\"name\": str, \"risk\": \"safe\"|\"warning\"|\"critical\", \"reason\": str}}]\n\nPlugins:\n{plugin_list}"}
    ], max_tokens=2000)
    try:
        start = scan_result.find("[")
        end = scan_result.rfind("]") + 1
        risks = json.loads(scan_result[start:end])
    except Exception:
        risks = []
    await log_activity(site_id, "plugin_security_scanned", f"Scanned {len(plugins)} plugins")
    return {"plugins_scanned": len(plugins), "risks": risks}
