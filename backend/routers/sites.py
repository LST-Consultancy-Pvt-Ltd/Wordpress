"""WordPress site connections: list/create/get/delete, credential updates
(with auto JWT-token discovery/generation), connection/write-permission tests,
and content sync (pull posts/pages into the local cache).
"""
import logging
from datetime import datetime, timezone
from typing import List, Optional

import httpx
from fastapi import Depends, HTTPException
from pydantic import BaseModel

from core.activity import log_activity
from core.crypto import encrypt_field
from core.http_headers import BROWSER_HEADERS
from core.db import db
from core.router import api_router
from core.security import get_current_user, require_admin, require_editor
from models.legacy import WordPressSite, WordPressSiteCreate, WordPressSiteResponse
from providers.wordpress import _wp_auth_headers, get_wp_credentials, wp_api_request

logger = logging.getLogger(__name__)

@api_router.get("/sites", response_model=List[WordPressSiteResponse])
async def get_sites(current_user: Optional[dict] = Depends(get_current_user)):
    query = {}
    if current_user:
        query["user_id"] = current_user["id"]
    sites = await db.sites.find(query, {"_id": 0, "app_password": 0}).to_list(100)
    return sites

@api_router.post("/sites", response_model=WordPressSiteResponse)
async def create_site(site_data: WordPressSiteCreate, current_user: dict = Depends(require_editor)):
    user_id = current_user["id"]
    site = WordPressSite(**site_data.model_dump(exclude={"wp_password"}), user_id=user_id)

    if site.platform == "wordpress" and site.auth_type == "jwt":
        # Auto-generate JWT token using the plain password supplied by the user.
        # The plain password is NEVER stored — only the resulting JWT token is persisted.
        wp_password = site_data.wp_password.strip()
        if not wp_password and not site.jwt_token.strip():
            raise HTTPException(
                status_code=400,
                detail="For JWT auth, provide your WordPress admin password so a token can be auto-generated."
            )
        if not site.jwt_token.strip():
            base_url = site.url.rstrip("/")

            # Step 1: Auto-discover the JWT endpoint from the WP REST API index
            discovered_url = None
            try:
                async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as hc:
                    idx_resp = await hc.get(f"{base_url}/wp-json/")
                if idx_resp.status_code == 200:
                    idx_data = idx_resp.json()
                    namespaces = idx_data.get("namespaces", [])
                    routes = list(idx_data.get("routes", {}).keys())
                    # Map known JWT plugin namespaces -> token endpoint suffix
                    ns_map = {
                        "jwt-auth/v1": "/wp-json/jwt-auth/v1/token",
                        "jwt-auth/v2": "/wp-json/jwt-auth/v2/token",
                        "simple-jwt-login/v1": "/wp-json/simple-jwt-login/v1/auth",
                        "mo-jwt-auth/v1": "/wp-json/mo-jwt-auth/v1/generate-jwt-token",
                        "miniorange-jwt-auth/v1": "/wp-json/miniorange-jwt-auth/v1/token",
                    }
                    for ns, suffix in ns_map.items():
                        if ns in namespaces:
                            discovered_url = base_url + suffix
                            break
                    # Also scan raw routes for any jwt token endpoint
                    if not discovered_url:
                        for route in routes:
                            rl = route.lower()
                            if ("jwt" in rl or "simple-jwt" in rl) and ("token" in rl or "auth" in rl):
                                discovered_url = base_url + "/wp-json" + route.split("{")[0].rstrip("/")
                                break
            except Exception:
                pass  # Discovery is best-effort; fall through to hardcoded list

            # Step 2: Build ordered candidate list (discovered first, then fallbacks)
            candidates = []
            if discovered_url:
                candidates.append(discovered_url)
            for suffix in [
                "/wp-json/jwt-auth/v1/token",
                "/wp-json/simple-jwt-login/v1/auth",
                "/wp-json/jwt-auth/v2/token",
                "/wp-json/mo-jwt-auth/v1/generate-jwt-token",
                "/wp-json/miniorange-jwt-auth/v1/token",
            ]:
                url_candidate = base_url + suffix
                if url_candidate not in candidates:
                    candidates.append(url_candidate)

            # Step 3: Try each candidate
            token_resp = None
            last_err = ""
            tried = []
            for token_url in candidates:
                tried.append(token_url)
                try:
                    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as hc:
                        r = await hc.post(
                            token_url,
                            json={"username": site.username, "password": wp_password},
                            headers={"Content-Type": "application/json"},
                        )
                    if r.status_code == 200:
                        token_resp = r
                        break
                    elif r.status_code != 404:
                        # Non-404 error (e.g. 403, 401) — wrong credentials, stop here
                        token_resp = r
                        break
                    last_err = f"{token_url} -> 404"
                except Exception as exc:
                    last_err = str(exc)

            if token_resp is None:
                raise HTTPException(
                    status_code=502,
                    detail=(
                        f"Could not find a JWT token endpoint on {site.url}. "
                        f"Ensure a JWT plugin (e.g. 'JWT Authentication for WP REST API') is installed and active, "
                        f"and that WordPress Permalinks are NOT set to 'Plain' "
                        f"(Settings > Permalinks > Post name). "
                        f"Tried: {', '.join(tried)}. Last error: {last_err}"
                    )
                )
            if token_resp.status_code != 200:
                err = ""
                try:
                    err = token_resp.json().get("message", token_resp.text[:200])
                except Exception:
                    err = token_resp.text[:200]
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"JWT token generation failed ({token_resp.status_code}): {err}. "
                        f"Check that the username and password are correct."
                    )
                )
            token_data = token_resp.json()
            jwt_token = (
                token_data.get("token")
                or token_data.get("data", {}).get("token", "")
                or token_data.get("access_token", "")
            )
            if not jwt_token:
                raise HTTPException(
                    status_code=502,
                    detail=f"JWT plugin returned unexpected response: {token_resp.text[:300]}"
                )
            site.jwt_token = jwt_token
    elif site.platform == "wordpress" and site.auth_type == "app_password" and not site.app_password.strip():
        raise HTTPException(status_code=400, detail="Application Password is required when auth_type is 'app_password'.")

    if site.platform != "wordpress":
        # A non-WordPress site (e.g. a self-hosted Next.js build) has no
        # /wp-json to authenticate against, so it's tracked by URL for the
        # domain-level SEO features. Plain reachability is the only thing
        # meaningful to check, and no credentials are stored.
        site.username, site.app_password, site.jwt_token = "", "", ""
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True, headers=BROWSER_HEADERS) as hc:
                resp = await hc.get(site.url.rstrip("/"))
            site.status = "connected" if resp.status_code < 400 else "error"
            if resp.status_code >= 400:
                logger.warning(f"{site.url} returned HTTP {resp.status_code} on the reachability check")
        except Exception as e:
            logger.warning(f"Reachability check failed for {site.url}: {e}")
            site.status = "error"
    else:
        # Test WordPress connection — use /users/me which requires auth to verify credentials
        try:
            site_dict = site.model_dump()
            auth_resp = await wp_api_request(site_dict, "GET", "../users/me")
            if auth_resp.status_code == 200:
                site.status = "connected"
            elif auth_resp.status_code == 401:
                site.status = "auth_error"
                logger.warning(f"WordPress credentials invalid for {site.url}")
            else:
                # Fallback: try a public GET on posts — at least confirms URL is reachable
                pub_resp = await wp_api_request(site_dict, "GET", "posts?per_page=1")
                site.status = "connected" if pub_resp.status_code == 200 else "error"
        except Exception as e:
            logger.error(f"WordPress connection test failed: {e}")
            site.status = "error"

    # Encrypt sensitive fields before persisting
    site_to_save = site.model_dump()
    if site_to_save.get("app_password"):
        site_to_save["app_password"] = encrypt_field(site_to_save["app_password"])
    if site_to_save.get("jwt_token"):
        site_to_save["jwt_token"] = encrypt_field(site_to_save["jwt_token"])
    await db.sites.insert_one(site_to_save)
    await log_activity(site.id, "site_created",
                       f"Added {'WordPress' if site.platform == 'wordpress' else site.platform} site: {site.name}",
                       user_id=user_id)

    response_data = site.model_dump()
    response_data.pop("app_password", None)
    response_data.pop("jwt_token", None)
    return WordPressSiteResponse(**response_data)

@api_router.get("/sites/{site_id}", response_model=WordPressSiteResponse)
async def get_site(site_id: str):
    site = await db.sites.find_one({"id": site_id}, {"_id": 0, "app_password": 0})
    if not site:
        raise HTTPException(status_code=404, detail="Site not found")
    return WordPressSiteResponse(**site)

@api_router.delete("/sites/{site_id}")
async def delete_site(site_id: str, _: dict = Depends(require_admin)):
    result = await db.sites.delete_one({"id": site_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Site not found")
    return {"message": "Site deleted successfully"}

class UpdateCredentialsRequest(BaseModel):
    username: str = ""
    app_password: str = ""
    auth_type: str = "app_password"
    jwt_token: str = ""

@api_router.put("/sites/{site_id}/credentials")
async def update_site_credentials(site_id: str, payload: UpdateCredentialsRequest, user: dict = Depends(require_editor)):
    """Update WordPress credentials (username + app_password) for an existing site."""
    site = await db.sites.find_one({"id": site_id}, {"_id": 0})
    if not site:
        raise HTTPException(status_code=404, detail="Site not found")

    updates: dict = {}
    if payload.username.strip():
        updates["username"] = payload.username.strip()
    if payload.auth_type:
        updates["auth_type"] = payload.auth_type

    if payload.auth_type == "app_password":
        if not payload.app_password.strip():
            raise HTTPException(status_code=400, detail="Application Password is required.")
        updates["app_password"] = encrypt_field(payload.app_password.strip())
        updates["jwt_token"] = ""
    elif payload.auth_type == "jwt":
        if not payload.jwt_token.strip():
            raise HTTPException(status_code=400, detail="JWT token is required.")
        updates["jwt_token"] = encrypt_field(payload.jwt_token.strip())
        updates["app_password"] = ""

    # Test the new credentials before saving
    test_site = {**site, **updates}
    # Temporarily decrypt for the test
    test_site["app_password"] = payload.app_password.strip() if payload.auth_type == "app_password" else ""
    test_site["jwt_token"] = payload.jwt_token.strip() if payload.auth_type == "jwt" else ""

    try:
        test_resp = await wp_api_request(test_site, "GET", "../users/me")
        if test_resp.status_code == 401:
            detail_msg = ""
            try:
                detail_msg = test_resp.json().get("message", "")
            except Exception:
                pass
            raise HTTPException(
                status_code=400,
                detail=f"Credentials rejected by WordPress (401): {detail_msg}. Verify username and Application Password."
            )
        elif test_resp.status_code not in (200, 403):
            raise HTTPException(
                status_code=400,
                detail=f"WordPress returned HTTP {test_resp.status_code}. Check the site URL."
            )
        updates["status"] = "connected"
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not reach WordPress: {str(e)}")

    await db.sites.update_one({"id": site_id}, {"$set": updates})
    await log_activity(site_id, "credentials_updated", "WordPress credentials updated", user_id=user.get("sub"))
    return {"message": "Credentials updated and verified successfully."}

@api_router.post("/sites/{site_id}/test-connection")
async def test_site_connection(site_id: str):
    """Test WordPress credentials and return detailed status."""
    site = await get_wp_credentials(site_id)
    auth, req_headers = _wp_auth_headers(site)
    try:
        # Test 1: check authentication via /users/me
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True, auth=auth) as client:
            me_resp = await client.get(
                f"{site['url'].rstrip('/')}/wp-json/wp/v2/users/me",
                headers=req_headers
            )
        if me_resp.status_code == 200:
            user_data = me_resp.json()
            roles = user_data.get("roles", [])
            can_edit = bool({"administrator", "editor", "author"} & set(roles))
            await db.sites.update_one({"id": site_id}, {"$set": {"status": "connected"}})
            return {
                "status": "connected",
                "wp_user": user_data.get("name", ""),
                "roles": roles,
                "can_create_posts": can_edit,
                "warning": None if can_edit else "User role cannot create posts. Change role to Editor or Administrator in WordPress Admin → Users."
            }
        elif me_resp.status_code == 401:
            detail = ""
            try:
                detail = me_resp.json().get("message", "")
            except Exception:
                pass
            # Do NOT persist auth_error to DB — test is non-destructive; sync determines persisted status
            return {"status": "auth_error", "message": f"Invalid credentials: {detail}. Check: (1) username is your WP login name (not email/display name), (2) Application Password was generated in WP Admin → Users → Profile → Application Passwords, (3) if on Apache, add 'SetEnvIf Authorization \"(.*)\" HTTP_AUTHORIZATION=$1' to .htaccess."}
        else:
            return {"status": "error", "message": f"WordPress returned HTTP {me_resp.status_code}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@api_router.post("/sites/{site_id}/test-write")
async def test_site_write(site_id: str):
    """Test that the WP credentials have edit/write permissions."""
    site = await get_wp_credentials(site_id)
    auth, req_headers = _wp_auth_headers(site)
    base = f"{site['url'].rstrip('/')}/wp-json/wp/v2"
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True, auth=auth) as client:
            # Step 1: get any post
            list_resp = await client.get(f"{base}/posts?per_page=1&status=any", headers=req_headers)
            if list_resp.status_code != 200:
                return {"status": "error", "message": f"GET /posts returned {list_resp.status_code}: {list_resp.text[:200]}"}
            posts = list_resp.json()
            if not posts:
                return {"status": "ok", "message": "No posts found to test write — cannot confirm write permission."}
            post_id = posts[0]["id"]
            # Step 2: no-op update (send empty dict — WP accepts this and returns 200 if authed correctly)
            write_resp = await client.post(f"{base}/posts/{post_id}", headers=req_headers, json={})
            if write_resp.status_code in [200, 201]:
                return {"status": "ok", "message": f"Write access confirmed on post #{post_id}."}
            else:
                try:
                    wp_err = write_resp.json()
                    wp_detail = f"code={wp_err.get('code')} message={wp_err.get('message', '')[:200]}"
                except Exception:
                    wp_detail = write_resp.text[:300]
                return {
                    "status": "write_denied",
                    "http_status": write_resp.status_code,
                    "message": (
                        f"POST /posts/{post_id} returned {write_resp.status_code}: {wp_detail}. "
                        f"Ensure the Application Password user has Editor or Administrator role in WordPress Admin → Users."
                    ),
                }
    except Exception as exc:
        return {"status": "error", "message": str(exc)}

@api_router.post("/sites/{site_id}/sync")
async def sync_site(site_id: str):
    site = await get_wp_credentials(site_id)

    try:
        # Sync pages
        response = await wp_api_request(site, "GET", "pages?per_page=100")
        if response.status_code == 200:
            pages = response.json()
            for page in pages:
                await db.pages.update_one(
                    {"site_id": site_id, "wp_id": page["id"]},
                    {"$set": {
                        "site_id": site_id,
                        "wp_id": page["id"],
                        "title": page["title"]["rendered"],
                        "content": page["content"]["rendered"],
                        "status": page["status"],
                        "link": page["link"],
                        "modified": page["modified"],
                        "synced_at": datetime.now(timezone.utc).isoformat()
                    }},
                    upsert=True
                )

        # Sync posts
        response = await wp_api_request(site, "GET", "posts?per_page=100")
        if response.status_code == 200:
            posts = response.json()
            for post in posts:
                await db.posts.update_one(
                    {"site_id": site_id, "wp_id": post["id"]},
                    {"$set": {
                        "site_id": site_id,
                        "wp_id": post["id"],
                        "title": post["title"]["rendered"],
                        "content": post["content"]["rendered"],
                        "status": post["status"],
                        "link": post["link"],
                        "modified": post["modified"],
                        "categories": post.get("categories", []),
                        "tags": post.get("tags", []),
                        "synced_at": datetime.now(timezone.utc).isoformat()
                    }},
                    upsert=True
                )

        # Update site last_sync — only set connected if not already in a known-bad auth state
        await db.sites.update_one(
            {"id": site_id, "status": {"$ne": "auth_error"}},
            {"$set": {"last_sync": datetime.now(timezone.utc).isoformat(), "status": "connected"}}
        )
        # Always update last_sync regardless of auth status
        await db.sites.update_one(
            {"id": site_id},
            {"$set": {"last_sync": datetime.now(timezone.utc).isoformat()}}
        )

        await log_activity(site_id, "sync_completed", "Site data synchronized successfully")
        return {"message": "Site synced successfully"}

    except Exception as e:
        logger.error(f"Sync failed: {e}")
        await log_activity(site_id, "sync_failed", str(e), "error")
        raise HTTPException(status_code=500, detail=str(e))
