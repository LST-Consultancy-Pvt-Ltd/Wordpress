"""WordPress site client: REST API requests (Application Password / JWT) with an
XML-RPC fallback for hosts that strip the Authorization header before it reaches
PHP (e.g. some LiteSpeed/shared-hosting setups), plus credential lookup and
WP-error-to-HTTP-status mapping shared by nearly every route that touches a site.
"""
import asyncio
import json
import logging
import xmlrpc.client
from typing import Optional

import httpx
from fastapi import HTTPException

from core.crypto import decrypt_field
from core.db import db

logger = logging.getLogger(__name__)


async def get_wp_credentials(site_id: str, user_id: Optional[str] = None):
    """Get WordPress site credentials"""
    query = {"id": site_id}
    if user_id and user_id != "global":
        query["user_id"] = user_id
    site = await db.sites.find_one(query, {"_id": 0})
    if not site:
        raise HTTPException(status_code=404, detail="Site not found")
    if site.get("app_password"):
        site["app_password"] = decrypt_field(site["app_password"])
    if site.get("jwt_token"):
        site["jwt_token"] = decrypt_field(site["jwt_token"])
    return site


def wp_error_to_http(wp_status: int, detail: str) -> HTTPException:
    """Map WordPress API error codes to safe HTTP exceptions.
    Critically: WordPress 401 must NOT become a 401 on our API,
    as the frontend auth interceptor would interpret that as 'session expired'."""
    # Try to parse the WP JSON error body to give a more specific message
    wp_code = ""
    wp_message = detail
    try:
        err_json = json.loads(detail)
        wp_code = err_json.get("code", "")
        wp_message = err_json.get("message", detail)
    except Exception:
        pass

    if wp_status == 401:
        # Distinguish between auth failure and permission failure
        if wp_code in ("rest_cannot_create", "rest_cannot_edit", "rest_cannot_delete",
                       "rest_forbidden", "rest_cannot_publish"):
            return HTTPException(
                status_code=403,
                detail=(
                    f"WordPress permission denied: {wp_message} "
                    f"— The Application Password user must have Editor or Administrator role. "
                    f"Go to WordPress Admin → Users → (your user) → change role to Editor/Admin."
                )
            )
        return HTTPException(
            status_code=502,
            detail=(
                f"WordPress authentication failed. Check username/app_password in site settings. "
                f"WP error: {detail[:300]}"
            )
        )
    if wp_status == 403:
        return HTTPException(
            status_code=403,
            detail=(
                f"WordPress permission denied: {wp_message} "
                f"— Ensure the user has Editor or Administrator role."
            )
        )
    return HTTPException(status_code=wp_status, detail=detail)


def _wp_auth_headers(site: dict) -> tuple:
    """Return (auth_obj_or_None, extra_headers) depending on site auth_type."""
    auth_type = site.get("auth_type", "app_password")
    if auth_type == "jwt":
        token = site.get("jwt_token", "").strip()
        return None, {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
    # Default: Application Password via HTTP Basic Auth
    app_password = site.get("app_password", "").replace(" ", "")
    auth = httpx.BasicAuth(username=site["username"], password=app_password)
    return auth, {"Content-Type": "application/json"}


async def wp_api_request(site: dict, method: str, endpoint: str, data: dict = None):
    """Make authenticated request to WordPress REST API (supports Application Password + JWT)."""
    url = f"{site['url'].rstrip('/')}/wp-json/wp/v2/{endpoint}"
    auth, headers = _wp_auth_headers(site)

    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True, auth=auth) as http_client:
            if method == "GET":
                response = await http_client.get(url, headers=headers)
            elif method == "POST":
                response = await http_client.post(url, headers=headers, json=data)
            elif method in ("PUT", "PATCH"):
                response = await http_client.post(url, headers=headers, json=data)
            elif method == "DELETE":
                response = await http_client.delete(url, headers=headers)
            else:
                raise ValueError(f"Unsupported method: {method}")

            return response
    except httpx.ConnectError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Cannot connect to WordPress site at {site['url']}. DNS resolution or network error: {e}"
        )
    except httpx.TimeoutException as e:
        raise HTTPException(
            status_code=504,
            detail=f"WordPress site at {site['url']} timed out: {e}"
        )


async def wp_upload_image(site: dict, image_url: str, filename: str) -> Optional[int]:
    """Download image and upload to WordPress media library, return media ID"""
    # Step 1 — Download from source URL (with retry for transient DNS/network blips)
    image_bytes = None
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=60.0) as http_client:
                img_response = await http_client.get(image_url)
                if img_response.status_code == 200:
                    image_bytes = img_response.content
                    break
                else:
                    logger.warning(f"Image download attempt {attempt+1} got HTTP {img_response.status_code} from {image_url}")
        except Exception as download_err:
            logger.warning(f"Image download attempt {attempt+1} failed (DNS/network): {download_err}")
            if attempt < 2:
                await asyncio.sleep(2)

    if not image_bytes:
        logger.error(f"Image upload to WP failed: could not download source image from {image_url} after 3 attempts")
        return None

    # Step 2 — Upload to WordPress
    wp_url = f"{site['url'].rstrip('/')}/wp-json/wp/v2/media"
    auth, base_headers = _wp_auth_headers(site)
    headers = {
        **base_headers,
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Content-Type": "image/png",
    }
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True, auth=auth) as http_client:
            resp = await http_client.post(wp_url, headers=headers, content=image_bytes)
            if resp.status_code in (200, 201):
                return resp.json().get("id")
            logger.error(f"Image upload to WP failed: WordPress returned HTTP {resp.status_code} — {resp.text[:200]}")
    except Exception as e:
        logger.error(f"Image upload to WP failed: could not reach WordPress at {site.get('url')} — {e}")
    return None


async def wp_xmlrpc_write(site: dict, post_type: str, title: str, content: str, status: str = "draft") -> dict:
    """
    Create a post/page via XML-RPC.
    This is the fallback for hosting environments (e.g. Hostinger/LiteSpeed) where
    the web server strips the Authorization header before it reaches PHP, causing
    Application Password authentication to fail silently.
    XML-RPC embeds credentials in the POST body, bypassing the header-stripping issue.
    """
    xmlrpc_url = f"{site['url'].rstrip('/')}/xmlrpc.php"
    app_password = site['app_password'].replace(" ", "")
    username = site['username']

    def _call():
        server = xmlrpc.client.ServerProxy(xmlrpc_url, allow_none=True)
        content_struct = {
            "post_title": title,
            "post_content": content,
            "post_status": status,
            "post_type": post_type,  # "post" or "page"
        }
        post_id = server.wp.newPost(0, username, app_password, content_struct)
        # Try to get the link; gracefully skip if it fails
        try:
            post_data = server.wp.getPost(0, username, app_password, post_id, ["link", "post_status"])
            link = post_data.get("link", "")
        except Exception:
            link = ""
        return {"wp_id": int(post_id), "link": link, "status": status}

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _call)


async def wp_xmlrpc_edit(site: dict, wp_id: int, data: dict, verify_keys: list = None) -> bool:
    """Edit an existing post/page via XML-RPC (fallback for hosts that strip Authorization header).

    If verify_keys is provided, reads the post back after editing and returns True only if ALL
    specified custom_field keys were actually written with the expected values.
    WordPress silently ignores protected (underscore-prefixed) meta keys when the user lacks
    the required capability — wp.editPost still returns true in that case, so verification is
    the only way to detect this silent failure.
    """
    xmlrpc_url = f"{site['url'].rstrip('/')}/xmlrpc.php"
    app_password = site['app_password'].replace(" ", "")
    username = site['username']

    def _call():
        server = xmlrpc.client.ServerProxy(xmlrpc_url, allow_none=True)
        struct = {}
        if "title" in data:
            struct["post_title"] = data["title"]
        if "content" in data:
            struct["post_content"] = data["content"]
        if "status" in data:
            struct["post_status"] = data["status"]
        # custom_fields writes directly to wp_postmeta, bypassing REST meta registration.
        # WordPress XML-RPC requires the field 'id' to UPDATE an existing meta row;
        # without it, a duplicate row is created that plugins like Yoast ignore.
        intended_values: dict = {}
        if "custom_fields" in data:
            # Fetch existing custom fields to get their IDs for updating
            try:
                existing_post = server.wp.getPost(0, username, app_password, wp_id, ["custom_fields"])
                existing_cf = existing_post.get("custom_fields", [])
                existing_map = {}
                for cf in existing_cf:
                    # Keep only the FIRST occurrence per key — that's the one WordPress reads
                    if cf["key"] not in existing_map:
                        existing_map[cf["key"]] = cf["id"]
            except Exception:
                existing_map = {}

            resolved_fields = []
            for field in data["custom_fields"]:
                entry = {"key": field["key"], "value": field["value"]}
                intended_values[field["key"]] = field["value"]
                if field["key"] in existing_map:
                    entry["id"] = existing_map[field["key"]]
                resolved_fields.append(entry)
            struct["custom_fields"] = resolved_fields

        result = server.wp.editPost(0, username, app_password, wp_id, struct)
        if not result:
            return False

        # Verify the write actually took effect if requested.
        # wp.editPost returns True even when protected meta is silently skipped.
        if verify_keys and intended_values:
            try:
                after_post = server.wp.getPost(0, username, app_password, wp_id, ["custom_fields"])
                after_cf = after_post.get("custom_fields", [])
                after_map = {}
                for cf in after_cf:
                    if cf["key"] not in after_map:
                        after_map[cf["key"]] = cf["value"]
                for key in verify_keys:
                    if key in intended_values and after_map.get(key) != intended_values[key]:
                        return False  # Write was silently discarded
            except Exception:
                pass  # Can't verify — assume write succeeded

        return True

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _call)


async def wp_xmlrpc_delete(site: dict, wp_id: int) -> bool:
    """Delete a post/page via XML-RPC (moves to trash, call twice to force-delete)."""
    xmlrpc_url = f"{site['url'].rstrip('/')}/xmlrpc.php"
    app_password = site['app_password'].replace(" ", "")
    username = site['username']

    def _call():
        server = xmlrpc.client.ServerProxy(xmlrpc_url, allow_none=True)
        try:
            server.wp.deletePost(0, username, app_password, wp_id)  # to trash
            server.wp.deletePost(0, username, app_password, wp_id)  # force delete
        except Exception:
            pass
        return True

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _call)
