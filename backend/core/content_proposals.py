"""Turn generated content (blog posts, programmatic pages, refreshed
articles) into `content.upsert` change sets.

Every content producer goes through here, so none of them can write to a
site directly: the result is always a change set in `planned` state that a
person reviews, or that the site's auto-apply policy explicitly covers.
"""
import re
import unicodedata
from typing import Optional

from fastapi import HTTPException

from core.changesets import create_changeset
from providers.bridge_client import capability_enabled
from providers.sites import get_site

SLUG_MAX = 120


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return text[:SLUG_MAX].strip("-") or "untitled"


def writable_collections(site: dict) -> list[dict]:
    adapters = (site.get("capabilities") or {}).get("content_adapters") or []
    return [a for a in adapters if "create" in (a.get("operations") or [])]


def pick_collection(site: dict, preferred: Optional[str] = None) -> str:
    if not capability_enabled(site, "content.write"):
        raise HTTPException(status_code=422, detail={
            "code": "CAPABILITY_UNSUPPORTED", "capability": "content.write",
            "message": "This site's bridge has no writable content collection. Configure a content adapter "
                       "(e.g. an MDX collection) on the bridge, then refresh the connection."})
    options = writable_collections(site)
    if preferred:
        if any(a.get("id") == preferred for a in options):
            return preferred
        raise HTTPException(status_code=400, detail=f"collection '{preferred}' is not writable on this site")
    if not options:
        raise HTTPException(status_code=422, detail={
            "code": "CAPABILITY_UNSUPPORTED", "capability": "content.write",
            "message": "The bridge reports content.write but no collection accepts new items."})
    return options[0]["id"]


def upsert_op(collection: str, *, title: str, body: str, slug: Optional[str] = None, status: str = "draft",
              frontmatter: Optional[dict] = None, base_sha256: Optional[str] = None) -> dict:
    fm = {"title": title}
    fm.update({k: v for k, v in (frontmatter or {}).items() if v not in (None, "", [], {})})
    return {
        "op": "content.upsert", "collection": collection, "slug": slugify(slug or title),
        "status": "published" if status in ("publish", "published") else "draft",
        "frontmatter": fm, "body": body or "", "base_sha256": base_sha256,
    }


async def propose_content(site_id: str, *, actor: dict, items: list[dict], title: str, source: str,
                          collection: Optional[str] = None, description: str = "") -> dict:
    """items: [{title, body, slug?, status?, frontmatter?, base_sha256?}] → a planned change set."""
    site = await get_site(site_id)
    coll = pick_collection(site, collection)
    ops, seen = [], set()
    for item in items:
        op = upsert_op(coll, title=item["title"], body=item.get("body", ""), slug=item.get("slug"),
                       status=item.get("status", "draft"), frontmatter=item.get("frontmatter"),
                       base_sha256=item.get("base_sha256"))
        # Two generated posts with the same slug would silently overwrite each other.
        base, n = op["slug"], 2
        while op["slug"] in seen:
            op["slug"] = f"{base[:SLUG_MAX - 4]}-{n}"
            n += 1
        seen.add(op["slug"])
        ops.append(op)
    return await create_changeset(site_id, title=title, operations=ops, actor=actor, source=source,
                                  description=description)
