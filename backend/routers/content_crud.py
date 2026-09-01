"""Pages Management and Posts Management: create/update/delete WordPress
pages/posts via the REST API, with an XML-RPC fallback for hosts that strip
the Authorization header (Hostinger/LiteSpeed).
"""
import logging
import xmlrpc.client
from datetime import datetime, timezone

import httpx
from fastapi import Depends, HTTPException

from core.activity import log_activity
from core.db import db
from core.router import api_router
from core.security import require_editor
from models.legacy import PageCreate, PostCreate
from providers.content import (
    is_wordpress, nextjs_create_post, nextjs_delete_post, nextjs_update_post,
)
from providers.wordpress import (
    get_wp_credentials, wp_api_request, wp_error_to_http, wp_xmlrpc_delete,
    wp_xmlrpc_edit, wp_xmlrpc_write,
)

logger = logging.getLogger(__name__)

# ========================
# Routes: Pages Management
# ========================

@api_router.get("/pages/{site_id}")
async def get_pages(site_id: str):
    pages = await db.pages.find({"site_id": site_id}, {"_id": 0}).to_list(100)
    return pages

@api_router.post("/pages")
async def create_page(page_data: PageCreate, _: dict = Depends(require_editor)):
    site = await get_wp_credentials(page_data.site_id)
    wp_data = {
        "title": page_data.title,
        "content": page_data.content,
        "status": page_data.status
    }
    try:
        response = await wp_api_request(site, "POST", "pages", wp_data)
        if response.status_code in [200, 201]:
            wp_page = response.json()
            page_doc = {
                "site_id": page_data.site_id,
                "wp_id": wp_page["id"],
                "title": wp_page["title"]["rendered"],
                "content": wp_page["content"]["rendered"],
                "status": wp_page["status"],
                "link": wp_page["link"],
                "created_at": datetime.now(timezone.utc).isoformat()
            }
            await db.pages.insert_one(page_doc)
            await log_activity(page_data.site_id, "page_created", f"Created page: {page_data.title}")
            return {"message": "Page created", "wp_id": wp_page["id"], "link": wp_page["link"]}
        elif response.status_code in [401, 403]:
            # Fallback: Hostinger/LiteSpeed strips Authorization header — use XML-RPC instead
            logger.info(f"REST API auth failed for page create ({response.status_code}), trying XML-RPC fallback")
            try:
                result = await wp_xmlrpc_write(site, "page", page_data.title, page_data.content, page_data.status)
                page_doc = {
                    "site_id": page_data.site_id,
                    "wp_id": result["wp_id"],
                    "title": page_data.title,
                    "content": page_data.content,
                    "status": result["status"],
                    "link": result.get("link", ""),
                    "created_at": datetime.now(timezone.utc).isoformat()
                }
                await db.pages.insert_one(page_doc)
                await log_activity(page_data.site_id, "page_created", f"Created page (XML-RPC): {page_data.title}")
                return {"message": "Page created", "wp_id": result["wp_id"], "link": result.get("link", "")}
            except xmlrpc.client.Fault as xmlrpc_fault:
                raise HTTPException(status_code=502, detail=(
                    f"Both REST API and XML-RPC failed. "
                    f"REST: {response.text[:150]}. "
                    f"XML-RPC fault: {xmlrpc_fault.faultString}. "
                    f"Fix for Hostinger: add this to WordPress .htaccess → "
                    f"RewriteRule .* - [E=HTTP_AUTHORIZATION:%{{HTTP:Authorization}}]"
                ))
            except Exception as xmlrpc_err:
                raise HTTPException(status_code=502, detail=(
                    f"Both REST API and XML-RPC failed. "
                    f"REST error: {response.text[:150]}. "
                    f"XML-RPC error: {str(xmlrpc_err)[:200]}. "
                    f"Fix for Hostinger/LiteSpeed: In WordPress Admin → .htaccess add: "
                    f"RewriteRule .* - [E=HTTP_AUTHORIZATION:%{{HTTP:Authorization}}]"
                ))
        else:
            raise wp_error_to_http(response.status_code, response.text)
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        raise HTTPException(status_code=500, detail=str(e))

@api_router.put("/pages/{site_id}/{wp_id}")
async def update_page(site_id: str, wp_id: int, page_data: dict, _: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id)

    try:
        response = await wp_api_request(site, "PUT", f"pages/{wp_id}", page_data)
        if response.status_code == 200:
            wp_page = response.json()
            update_fields = {
                "title": wp_page["title"]["rendered"],
                "content": wp_page["content"]["rendered"],
                "status": wp_page["status"],
                "modified": datetime.now(timezone.utc).isoformat()
            }
            await db.pages.update_one({"site_id": site_id, "wp_id": wp_id}, {"$set": update_fields})
            await log_activity(site_id, "page_updated", f"Updated page ID: {wp_id}")
            return {"message": "Page updated"}
        elif response.status_code in [401, 403]:
            logger.info(f"REST API auth failed for page update ({response.status_code}), trying XML-RPC fallback")
            await wp_xmlrpc_edit(site, wp_id, page_data)
            new_status = page_data.get("status", "")
            db_update = {"modified": datetime.now(timezone.utc).isoformat()}
            if "title" in page_data: db_update["title"] = page_data["title"]
            if "content" in page_data: db_update["content"] = page_data["content"]
            if new_status: db_update["status"] = new_status
            await db.pages.update_one({"site_id": site_id, "wp_id": wp_id}, {"$set": db_update})
            await log_activity(site_id, "page_updated", f"Updated page ID: {wp_id} (XML-RPC)")
            return {"message": "Page updated"}
        else:
            raise wp_error_to_http(response.status_code, response.text)
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        raise HTTPException(status_code=500, detail=str(e))

@api_router.delete("/pages/{site_id}/{wp_id}")
async def delete_page(site_id: str, wp_id: int, _: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id)
    try:
        response = await wp_api_request(site, "DELETE", f"pages/{wp_id}?force=true")
        if response.status_code == 200:
            await db.pages.delete_one({"site_id": site_id, "wp_id": wp_id})
            await log_activity(site_id, "page_deleted", f"Deleted page ID: {wp_id}")
            return {"message": "Page deleted"}
        elif response.status_code in [401, 403]:
            logger.info(f"REST API auth failed for page delete ({response.status_code}), trying XML-RPC fallback")
            await wp_xmlrpc_delete(site, wp_id)
            await db.pages.delete_one({"site_id": site_id, "wp_id": wp_id})
            await log_activity(site_id, "page_deleted", f"Deleted page ID: {wp_id} (XML-RPC)")
            return {"message": "Page deleted"}
        else:
            raise wp_error_to_http(response.status_code, response.text)
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        raise HTTPException(status_code=500, detail=str(e))

# ========================
# Routes: Posts Management
# ========================

@api_router.get("/posts/{site_id}")
async def get_posts(site_id: str):
    posts = await db.posts.find({"site_id": site_id}, {"_id": 0}).to_list(100)
    return posts

@api_router.post("/posts")
async def create_post(post_data: PostCreate, _: dict = Depends(require_editor)):
    # Non-WordPress sites publish through their SEO Bridge instead; the
    # WordPress path below (with its XML-RPC fallback) is left untouched.
    if not await is_wordpress(post_data.site_id):
        result = await nextjs_create_post(
            post_data.site_id, post_data.title, post_data.content, post_data.status,
        )
        await log_activity(post_data.site_id, "post_created", f"Created post: {post_data.title}")
        return result
    site = await get_wp_credentials(post_data.site_id)
    wp_data = {
        "title": post_data.title,
        "content": post_data.content,
        "status": post_data.status,
        "categories": post_data.categories,
        "tags": post_data.tags
    }
    try:
        response = await wp_api_request(site, "POST", "posts", wp_data)
        if response.status_code in [200, 201]:
            wp_post = response.json()
            post_doc = {
                "site_id": post_data.site_id,
                "wp_id": wp_post["id"],
                "title": wp_post["title"]["rendered"],
                "content": wp_post["content"]["rendered"],
                "status": wp_post["status"],
                "link": wp_post["link"],
                "categories": wp_post.get("categories", []),
                "tags": wp_post.get("tags", []),
                "created_at": datetime.now(timezone.utc).isoformat()
            }
            await db.posts.insert_one(post_doc)
            await log_activity(post_data.site_id, "post_created", f"Created post: {post_data.title}")
            return {"message": "Post created", "wp_id": wp_post["id"], "link": wp_post["link"]}
        elif response.status_code in [401, 403]:
            # Fallback: Hostinger/LiteSpeed strips Authorization header — use XML-RPC instead
            logger.info(f"REST API auth failed for post create ({response.status_code}), trying XML-RPC fallback")
            try:
                result = await wp_xmlrpc_write(site, "post", post_data.title, post_data.content, post_data.status)
                post_doc = {
                    "site_id": post_data.site_id,
                    "wp_id": result["wp_id"],
                    "title": post_data.title,
                    "content": post_data.content,
                    "status": result["status"],
                    "link": result.get("link", ""),
                    "categories": post_data.categories,
                    "tags": post_data.tags,
                    "created_at": datetime.now(timezone.utc).isoformat()
                }
                await db.posts.insert_one(post_doc)
                await log_activity(post_data.site_id, "post_created", f"Created post (XML-RPC): {post_data.title}")
                return {"message": "Post created", "wp_id": result["wp_id"], "link": result.get("link", "")}
            except xmlrpc.client.Fault as xmlrpc_fault:
                raise HTTPException(status_code=502, detail=(
                    f"Both REST API and XML-RPC failed. "
                    f"REST: {response.text[:150]}. "
                    f"XML-RPC fault: {xmlrpc_fault.faultString}. "
                    f"Fix for Hostinger: add this to WordPress .htaccess → "
                    f"RewriteRule .* - [E=HTTP_AUTHORIZATION:%{{HTTP:Authorization}}]"
                ))
            except Exception as xmlrpc_err:
                raise HTTPException(status_code=502, detail=(
                    f"Both REST API and XML-RPC failed. "
                    f"REST error: {response.text[:150]}. "
                    f"XML-RPC error: {str(xmlrpc_err)[:200]}. "
                    f"Fix for Hostinger/LiteSpeed: In WordPress Admin → .htaccess add: "
                    f"RewriteRule .* - [E=HTTP_AUTHORIZATION:%{{HTTP:Authorization}}]"
                ))
        else:
            raise wp_error_to_http(response.status_code, response.text)
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        raise HTTPException(status_code=500, detail=str(e))

@api_router.put("/posts/{site_id}/{wp_id}")
async def update_post(site_id: str, wp_id: int, post_data: dict, _: dict = Depends(require_editor)):
    if not await is_wordpress(site_id):
        result = await nextjs_update_post(site_id, wp_id, post_data)
        await log_activity(site_id, "post_updated", f"Updated post: {result.get('slug', wp_id)}")
        return result
    site = await get_wp_credentials(site_id)
    try:
        response = await wp_api_request(site, "PUT", f"posts/{wp_id}", post_data)
        if response.status_code == 200:
            wp_post = response.json()
            update_fields = {
                "title": wp_post["title"]["rendered"],
                "content": wp_post["content"]["rendered"],
                "status": wp_post["status"],
                "modified": datetime.now(timezone.utc).isoformat()
            }
            await db.posts.update_one({"site_id": site_id, "wp_id": wp_id}, {"$set": update_fields})
            await log_activity(site_id, "post_updated", f"Updated post ID: {wp_id}")
            return {"message": "Post updated"}
        elif response.status_code in [401, 403]:
            logger.info(f"REST API auth failed for post update ({response.status_code}), trying XML-RPC fallback")
            await wp_xmlrpc_edit(site, wp_id, post_data)
            new_status = post_data.get("status", "")
            db_update = {"modified": datetime.now(timezone.utc).isoformat()}
            if "title" in post_data: db_update["title"] = post_data["title"]
            if "content" in post_data: db_update["content"] = post_data["content"]
            if new_status: db_update["status"] = new_status
            await db.posts.update_one({"site_id": site_id, "wp_id": wp_id}, {"$set": db_update})
            await log_activity(site_id, "post_updated", f"Updated post ID: {wp_id} (XML-RPC)")
            return {"message": "Post updated"}
        else:
            raise wp_error_to_http(response.status_code, response.text)
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        raise HTTPException(status_code=500, detail=str(e))

@api_router.delete("/posts/{site_id}/{wp_id}")
async def delete_post(site_id: str, wp_id: int, _: dict = Depends(require_editor)):
    if not await is_wordpress(site_id):
        result = await nextjs_delete_post(site_id, wp_id)
        await log_activity(site_id, "post_deleted", f"Deleted post: {result.get('slug', wp_id)}")
        return result
    site = await get_wp_credentials(site_id)
    try:
        response = await wp_api_request(site, "DELETE", f"posts/{wp_id}?force=true")
        if response.status_code == 200:
            await db.posts.delete_one({"site_id": site_id, "wp_id": wp_id})
            await log_activity(site_id, "post_deleted", f"Deleted post ID: {wp_id}")
            return {"message": "Post deleted"}
        elif response.status_code in [401, 403]:
            logger.info(f"REST API auth failed for post delete ({response.status_code}), trying XML-RPC fallback")
            await wp_xmlrpc_delete(site, wp_id)
            await db.posts.delete_one({"site_id": site_id, "wp_id": wp_id})
            await log_activity(site_id, "post_deleted", f"Deleted post ID: {wp_id} (XML-RPC)")
            return {"message": "Post deleted"}
        else:
            raise wp_error_to_http(response.status_code, response.text)
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        raise HTTPException(status_code=500, detail=str(e))
