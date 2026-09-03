"""Content routes for non-WordPress (Next.js) sites, via the SEO Bridge.

The WordPress equivalents live in routers/content_crud.py and drive the WP
REST API. These do the same job for a self-hosted Next.js site through the
bridge endpoint installed in that app (see nextjs-bridge/ at the repo root).
"""
import logging

from fastapi import Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from typing import List, Optional

from core.activity import log_activity
from core.router import api_router
from core.security import require_editor, require_user
from providers.nextjs import (
    bridge_clear_content_block, bridge_clear_image_alt, bridge_delete_post,
    bridge_get_content, bridge_get_images, bridge_get_page_content,
    bridge_get_page_images, bridge_get_post, bridge_health, bridge_list_posts,
    bridge_publish_post, bridge_set_content_block, bridge_set_image_alt,
    generate_alt_text_from_url, get_bridge_credentials,
)

logger = logging.getLogger(__name__)


class NextPostPublish(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: str
    content: str
    slug: Optional[str] = None
    description: Optional[str] = None
    tags: List[str] = []
    date: Optional[str] = None
    draft: bool = False
    # Extra frontmatter keys, for sites whose blog pages expect a schema
    # beyond the bridge's defaults (the health endpoint reports the real one).
    frontmatter: dict = {}


class NextContentBlockUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    path: str
    key: str
    value: str


class NextImageAltUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    path: str
    key: str
    alt: str


class NextImageGenerateAlt(BaseModel):
    model_config = ConfigDict(extra="ignore")
    path: str
    key: str
    src: str


@api_router.get("/nextjs/{site_id}/health")
async def nextjs_bridge_health(site_id: str, user=Depends(require_user)):
    """Connection test — also reports the content directory the bridge
    resolved and the frontmatter shape of an existing post, so a schema
    mismatch is visible before anything is published."""
    site = await get_bridge_credentials(site_id)
    return await bridge_health(site)


@api_router.get("/nextjs/{site_id}/posts")
async def nextjs_list_posts(site_id: str, user=Depends(require_user)):
    site = await get_bridge_credentials(site_id)
    return await bridge_list_posts(site)


@api_router.post("/nextjs/{site_id}/posts")
async def nextjs_publish_post(site_id: str, body: NextPostPublish, user=Depends(require_editor)):
    site = await get_bridge_credentials(site_id)
    result = await bridge_publish_post(site, body.model_dump(exclude_none=True))
    await log_activity(site_id, "nextjs_post_published",
                       f"Published '{body.title}' to {site.get('name', site_id)} (slug: {result.get('slug')})")
    return result


@api_router.get("/nextjs/{site_id}/posts/{slug}")
async def nextjs_get_post(site_id: str, slug: str, user=Depends(require_user)):
    site = await get_bridge_credentials(site_id)
    return await bridge_get_post(site, slug)


@api_router.delete("/nextjs/{site_id}/posts/{slug}")
async def nextjs_delete_post(site_id: str, slug: str, user=Depends(require_editor)):
    site = await get_bridge_credentials(site_id)
    result = await bridge_delete_post(site, slug)
    await log_activity(site_id, "nextjs_post_deleted", f"Deleted post '{slug}' from {site.get('name', site_id)}")
    return result


# --- Page body-copy blocks ---------------------------------------------------
# For static pages (not blog posts): specific pieces of copy the page's own
# code has opted into making editable (see nextjs-bridge/lib/page-content.ts).
# A page only appears below once it has actually rendered at least once with
# a wrapped block.

@api_router.get("/nextjs/{site_id}/pages")
async def nextjs_list_page_content(site_id: str, user=Depends(require_user)):
    site = await get_bridge_credentials(site_id)
    content = await bridge_get_content(site)
    return {
        "pages": [
            {"path": path, "blocks": {k: v for k, v in blocks.items() if k != "updatedAt"}}
            for path, blocks in content.items()
        ]
    }


@api_router.get("/nextjs/{site_id}/pages/content")
async def nextjs_get_page_content(site_id: str, path: str, user=Depends(require_user)):
    site = await get_bridge_credentials(site_id)
    blocks = await bridge_get_page_content(site, path)
    return {"path": path, "blocks": {k: v for k, v in blocks.items() if k != "updatedAt"}}


@api_router.put("/nextjs/{site_id}/pages/content")
async def nextjs_set_page_content(site_id: str, body: NextContentBlockUpdate, user=Depends(require_editor)):
    site = await get_bridge_credentials(site_id)
    result = await bridge_set_content_block(site, body.path, body.key, body.value)
    await log_activity(site_id, "nextjs_content_updated",
                       f"Updated '{body.key}' on {body.path} for {site.get('name', site_id)}")
    return result


@api_router.delete("/nextjs/{site_id}/pages/content")
async def nextjs_clear_page_content(site_id: str, path: str, key: Optional[str] = None, user=Depends(require_editor)):
    site = await get_bridge_credentials(site_id)
    result = await bridge_clear_content_block(site, path, key)
    await log_activity(site_id, "nextjs_content_cleared",
                       f"Cleared {'block ' + key if key else 'all blocks'} on {path} for {site.get('name', site_id)}")
    return result


# --- Image alt text -----------------------------------------------------------
# Images the page's own code has opted into making editable (see
# nextjs-bridge/lib/editable-image.tsx). A page only appears below once it
# has actually rendered at least once with a wrapped image.

@api_router.get("/nextjs/{site_id}/images")
async def nextjs_list_images(site_id: str, user=Depends(require_user)):
    site = await get_bridge_credentials(site_id)
    images = await bridge_get_images(site)
    return {"pages": [{"path": path, "images": items} for path, items in images.items()]}


@api_router.get("/nextjs/{site_id}/images/content")
async def nextjs_get_page_images(site_id: str, path: str, user=Depends(require_user)):
    site = await get_bridge_credentials(site_id)
    images = await bridge_get_page_images(site, path)
    return {"path": path, "images": images}


@api_router.put("/nextjs/{site_id}/images/content")
async def nextjs_set_image_alt(site_id: str, body: NextImageAltUpdate, user=Depends(require_editor)):
    site = await get_bridge_credentials(site_id)
    result = await bridge_set_image_alt(site, body.path, body.key, body.alt)
    await log_activity(site_id, "nextjs_image_alt_updated",
                       f"Set alt text for '{body.key}' on {body.path} for {site.get('name', site_id)}")
    return result


@api_router.delete("/nextjs/{site_id}/images/content")
async def nextjs_clear_image_alt(site_id: str, path: str, key: Optional[str] = None, user=Depends(require_editor)):
    site = await get_bridge_credentials(site_id)
    result = await bridge_clear_image_alt(site, path, key)
    await log_activity(site_id, "nextjs_image_alt_cleared",
                       f"Cleared {'image ' + key if key else 'all images'} on {path} for {site.get('name', site_id)}")
    return result


@api_router.post("/nextjs/{site_id}/images/generate-alt")
async def nextjs_generate_image_alt(site_id: str, body: NextImageGenerateAlt, user=Depends(require_editor)):
    site = await get_bridge_credentials(site_id)
    alt = await generate_alt_text_from_url(body.src, fallback_label=body.key)
    result = await bridge_set_image_alt(site, body.path, body.key, alt)
    await log_activity(site_id, "nextjs_image_alt_generated",
                       f"AI-generated alt text for '{body.key}' on {body.path} for {site.get('name', site_id)}")
    return result
