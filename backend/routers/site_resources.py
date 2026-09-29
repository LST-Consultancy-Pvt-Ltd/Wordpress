"""Read-only site resources proxied from the bridge (inventory, content,
revisions, operations status/logs, bridge audit) plus the content read-cache
sync that feeds the generic analysers."""
import hashlib
import re
from datetime import datetime, timezone
from typing import Literal, Optional
from urllib.parse import quote

from fastapi import Depends, HTTPException, Query

from core.activity import log_activity
from core.audit import audit
from core.db import db
from core.router import api_router
from core.security import require_admin, require_editor, require_user
from providers.bridge_client import BridgeError, require_capability
from providers.sites import get_site_and_client

COLLECTION_RE = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SERVICE_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$")


def _check(pattern: re.Pattern, value: str, what: str) -> str:
    if not pattern.match(value or ""):
        raise HTTPException(status_code=400, detail=f"invalid {what}")
    return value


async def _get(site_id: str, path: str, capability: Optional[str] = None, params: Optional[dict] = None):
    site, client = await get_site_and_client(site_id)
    if capability:
        require_capability(site, capability)
    try:
        return await client.request("GET", path, params=params)
    except BridgeError as e:
        raise e.to_http()


InventoryKind = Literal["routes", "metadata", "blocks", "assets", "redirects", "unsupported"]


@api_router.get("/sites/{site_id}/inventory/{kind}")
async def inventory(site_id: str, kind: InventoryKind, cursor: Optional[str] = None,
                    limit: int = Query(50, ge=1, le=200), _: dict = Depends(require_user)):
    params = {"cursor": cursor, "limit": limit} if kind == "assets" else None
    return await _get(site_id, f"/inventory/{kind}", "inventory", params)


@api_router.get("/sites/{site_id}/content/collections")
async def content_collections(site_id: str, _: dict = Depends(require_user)):
    return await _get(site_id, "/content/collections", "content.read")


@api_router.get("/sites/{site_id}/content/{collection}/items")
async def content_items(site_id: str, collection: str, status: Literal["draft", "published", "all"] = "all",
                        cursor: Optional[str] = None, limit: int = Query(50, ge=1, le=200),
                        _: dict = Depends(require_user)):
    _check(COLLECTION_RE, collection, "collection")
    return await _get(site_id, f"/content/{collection}/items", "content.read",
                      {"status": status, "cursor": cursor, "limit": limit})


@api_router.get("/sites/{site_id}/content/{collection}/items/{slug}")
async def content_item(site_id: str, collection: str, slug: str, _: dict = Depends(require_user)):
    _check(COLLECTION_RE, collection, "collection")
    _check(SLUG_RE, slug, "slug")
    return await _get(site_id, f"/content/{collection}/items/{slug}", "content.read")


@api_router.get("/sites/{site_id}/revisions")
async def revisions(site_id: str, cursor: Optional[str] = None, limit: int = Query(50, ge=1, le=200),
                    _: dict = Depends(require_user)):
    return await _get(site_id, "/revisions", None, {"cursor": cursor, "limit": limit})


@api_router.get("/sites/{site_id}/revisions/{revision_id}")
async def revision(site_id: str, revision_id: str, _: dict = Depends(require_user)):
    return await _get(site_id, f"/revisions/{quote(revision_id, safe='')}")


@api_router.get("/sites/{site_id}/ops/status")
async def ops_status(site_id: str, _: dict = Depends(require_user)):
    return await _get(site_id, "/ops/status", "deploy")


@api_router.get("/sites/{site_id}/ops/logs")
async def ops_logs(site_id: str, service: str, tail: int = Query(200, ge=1, le=2000),
                   _: dict = Depends(require_user)):
    _check(SERVICE_RE, service, "service")
    return await _get(site_id, "/ops/logs", "ops.logs", {"service": service, "tail": tail})


@api_router.get("/sites/{site_id}/bridge/audit")
async def bridge_audit(site_id: str, cursor: Optional[str] = None, limit: int = Query(50, ge=1, le=200),
                       _: dict = Depends(require_admin)):
    return await _get(site_id, "/audit", None, {"cursor": cursor, "limit": limit})


def stable_content_id(collection: str, slug: str) -> int:
    """Deterministic numeric id for a content item, for analysers that key on
    an integer. Derived from collection/slug so re-syncs never renumber."""
    return int(hashlib.sha256(f"{collection}/{slug}".encode()).hexdigest()[:12], 16)


@api_router.post("/sites/{site_id}/content/sync")
async def sync_content(site_id: str, user: dict = Depends(require_editor)):
    """Mirror bridge content into db.content_items (read cache only — never
    written back). Items removed on the site are removed from the cache."""
    site, client = await get_site_and_client(site_id)
    require_capability(site, "content.read")
    base = site["base_url"].rstrip("/")
    synced, failed, seen = 0, 0, set()
    try:
        collections = (await client.request("GET", "/content/collections")).get("items", [])
        for coll in collections:
            cid = coll.get("id")
            if not cid or not COLLECTION_RE.match(cid):
                continue
            cursor = None
            while True:
                page = await client.request("GET", f"/content/{cid}/items",
                                            params={"status": "all", "limit": 200, "cursor": cursor})
                for entry in page.get("items", []):
                    slug = entry.get("slug")
                    if not slug or not SLUG_RE.match(slug):
                        continue
                    try:
                        full = await client.request("GET", f"/content/{cid}/items/{slug}")
                    except BridgeError:
                        failed += 1
                        continue
                    fm = full.get("frontmatter") or {}
                    route = fm.get("route") or coll.get("route_pattern", f"/{cid}/[slug]").replace("[slug]", slug)
                    seen.add((cid, slug))
                    await db.content_items.update_one(
                        {"site_id": site_id, "collection": cid, "slug": slug},
                        {"$set": {
                            "site_id": site_id, "collection": cid, "slug": slug,
                            "content_id": stable_content_id(cid, slug),
                            "title": fm.get("title") or entry.get("title") or slug,
                            "body": full.get("body", ""), "frontmatter": fm,
                            "status": full.get("status") or entry.get("status"),
                            "url": f"{base}{route}", "route": route, "sha256": full.get("sha256"),
                            "updated_at": entry.get("updated_at"),
                            "synced_at": datetime.now(timezone.utc).isoformat(),
                        }}, upsert=True)
                    synced += 1
                cursor = page.get("next_cursor")
                if not cursor:
                    break
    except BridgeError as e:
        raise e.to_http()
    stale = await db.content_items.find({"site_id": site_id}, {"_id": 0, "collection": 1, "slug": 1}).to_list(10000)
    removed = 0
    for doc in stale:
        if (doc["collection"], doc["slug"]) not in seen:
            await db.content_items.delete_one({"site_id": site_id, "collection": doc["collection"], "slug": doc["slug"]})
            removed += 1
    await db.sites.update_one({"id": site_id}, {"$set": {"last_content_sync": datetime.now(timezone.utc).isoformat()}})
    await log_activity(site_id, "content_synced", f"Synced {synced} content item(s) from the bridge", user_id=user["id"])
    await audit("site.content_sync", actor=user, site=site, detail={"synced": synced, "failed": failed, "removed": removed})
    return {"synced": synced, "failed": failed, "removed": removed}
