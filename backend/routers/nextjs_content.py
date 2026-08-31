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
    bridge_delete_post, bridge_health, bridge_list_posts, bridge_publish_post,
    get_bridge_credentials,
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


@api_router.delete("/nextjs/{site_id}/posts/{slug}")
async def nextjs_delete_post(site_id: str, slug: str, user=Depends(require_editor)):
    site = await get_bridge_credentials(site_id)
    result = await bridge_delete_post(site, slug)
    await log_activity(site_id, "nextjs_post_deleted", f"Deleted post '{slug}' from {site.get('name', site_id)}")
    return result
