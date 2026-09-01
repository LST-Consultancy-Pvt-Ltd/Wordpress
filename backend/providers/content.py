"""Platform-neutral content writes.

The WordPress write paths in routers/content_crud.py (and friends) carry real
complexity — XML-RPC fallbacks for hosts that strip auth headers, rendered vs
raw fields, numeric category/tag IDs. Refactoring all of that into a shared
abstraction would risk the one path that already works in production for no
gain on the WordPress side.

So this module implements the *Next.js* half only, matching each endpoint's
existing contract (including its `wp_id` identity), and the endpoints branch
to it at the top. WordPress code below the branch stays untouched.

Identity: a Next.js post is keyed by slug, but every route signature and the
whole frontend key on a numeric `wp_id`. `stable_post_id()` derives one from
the slug so nothing upstream has to change; the slug remains the real key and
is stored alongside it in db.posts.
"""
import hashlib
import logging
import re
from datetime import datetime, timezone

from fastapi import HTTPException

from core.db import db
from providers.nextjs import (
    bridge_delete_post, bridge_health, bridge_publish_post, bridge_request,
    get_bridge_credentials,
)

logger = logging.getLogger(__name__)

_FRONTMATTER_RE = re.compile(r"^---\r?\n.*?\r?\n---\r?\n?", re.S)


def stable_post_id(slug: str) -> int:
    """A deterministic positive int for a slug, so `wp_id`-keyed routes and UI
    keep working for Next.js posts without an API change."""
    return int(hashlib.sha1(slug.encode("utf-8")).hexdigest()[:8], 16)


def strip_frontmatter(raw: str) -> str:
    return _FRONTMATTER_RE.sub("", raw or "")


async def get_site_any(site_id: str, user_id: str | None = None) -> dict:
    """The site document regardless of platform.

    For features that only need the site's public URL and then speak plain
    HTTP to it — sitemap.xml, robots.txt, uptime probes, PageSpeed. Those work
    on any platform, so they must NOT go through get_wp_credentials(), whose
    WordPress-only guard would refuse them for a Next.js site even though
    nothing WordPress-specific is involved."""
    query = {"id": site_id}
    if user_id and user_id != "global":
        query["user_id"] = user_id
    site = await db.sites.find_one(query, {"_id": 0})
    if not site:
        raise HTTPException(status_code=404, detail="Site not found")
    return site


async def get_platform(site_id: str) -> str:
    site = await db.sites.find_one({"id": site_id}, {"_id": 0, "platform": 1})
    if not site:
        raise HTTPException(status_code=404, detail="Site not found")
    return site.get("platform", "wordpress")


async def is_wordpress(site_id: str) -> bool:
    return await get_platform(site_id) == "wordpress"


async def blog_base(site: dict) -> str:
    """The public blog path, taken from what the bridge actually reports it
    revalidates rather than guessed."""
    try:
        health = await bridge_health(site)
    except HTTPException:
        health = {}
    return (health.get("revalidatePaths") or ["/blog"])[0].rstrip("/")


async def _slug_for(site_id: str, wp_id: int) -> str:
    doc = await db.posts.find_one({"site_id": site_id, "wp_id": wp_id}, {"_id": 0, "slug": 1})
    if not doc or not doc.get("slug"):
        raise HTTPException(
            status_code=404,
            detail="Post not found in the local cache. Run a sync for this site first so its posts are known here.",
        )
    return doc["slug"]


async def _cache_post(site_id: str, site: dict, slug: str, title: str, content: str, status: str, base: str):
    await db.posts.update_one(
        {"site_id": site_id, "slug": slug},
        {"$set": {
            "site_id": site_id,
            "wp_id": stable_post_id(slug),
            "slug": slug,
            "title": title,
            "content": content,
            "content_format": "mdx",
            "status": status,
            "link": f"{(site.get('url') or '').rstrip('/')}{base}/{slug}",
            "modified": datetime.now(timezone.utc).isoformat(),
            "synced_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )


async def nextjs_create_post(site_id: str, title: str, content: str, status: str = "draft",
                             description: str = "", tags: list | None = None) -> dict:
    site = await get_bridge_credentials(site_id)
    result = await bridge_publish_post(site, {
        "title": title,
        "content": content,
        "draft": status != "publish",
        "description": description or None,
        "tags": tags or [],
    })
    slug = result.get("slug", "")
    base = await blog_base(site)
    await _cache_post(site_id, site, slug, title, content, status, base)
    link = f"{(site.get('url') or '').rstrip('/')}{base}/{slug}"
    return {"message": "Post created", "wp_id": stable_post_id(slug), "slug": slug, "link": link}


async def nextjs_update_post(site_id: str, wp_id: int, post_data: dict) -> dict:
    """Partial update. The bridge's PUT replaces the file, so the current post
    is read first and the incoming fields merged onto it — otherwise sending
    only a title would silently wipe the body."""
    site = await get_bridge_credentials(site_id)
    slug = await _slug_for(site_id, wp_id)

    current = await bridge_request(site, "GET", f"posts/{slug}")
    frontmatter = current.get("frontmatter", {}) or {}
    body = strip_frontmatter(current.get("raw", ""))

    title = post_data.get("title", frontmatter.get("title", slug))
    if isinstance(title, dict):          # WP-shaped {"rendered": ...} payloads
        title = title.get("rendered", slug)
    content = post_data.get("content", body)
    if isinstance(content, dict):
        content = content.get("rendered", body)
    status = post_data.get("status") or ("draft" if frontmatter.get("draft") == "true" else "publish")

    await bridge_publish_post(site, {
        "slug": slug,
        "title": title,
        "content": content,
        "draft": status != "publish",
        "description": post_data.get("description") or frontmatter.get("description") or None,
        "date": frontmatter.get("date") or None,
    })
    base = await blog_base(site)
    await _cache_post(site_id, site, slug, title, content, status, base)
    return {"message": "Post updated", "wp_id": wp_id, "slug": slug}


async def nextjs_delete_post(site_id: str, wp_id: int) -> dict:
    site = await get_bridge_credentials(site_id)
    slug = await _slug_for(site_id, wp_id)
    await bridge_delete_post(site, slug)
    await db.posts.delete_one({"site_id": site_id, "wp_id": wp_id})
    return {"message": "Post deleted", "slug": slug}
