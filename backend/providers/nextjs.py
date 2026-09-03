"""SEO Bridge client — publishes content into a self-hosted Next.js site.

The WordPress integration talks to a CMS that already exposes a REST API. A
plain Next.js app has none, so the site owner installs a small authenticated
endpoint (see nextjs-bridge/ at the repo root) that writes .mdx files into the
content directory their blog pages already read from, then revalidates the
affected routes. This module is the client for that endpoint — the Next.js
counterpart to providers/wordpress.py.

Errors are mapped to actionable HTTP responses rather than bare gateway
failures: a missing bridge, a wrong token and an unreachable site each say
what to fix. Nothing here ever invents a success.
"""
import base64
import logging
import os
from typing import Optional
from urllib.parse import quote

import anthropic
import httpx
from fastapi import HTTPException

from core.crypto import decrypt_field
from core.db import db

logger = logging.getLogger(__name__)

_TIMEOUT = 20.0


async def get_bridge_credentials(site_id: str, user_id: Optional[str] = None) -> dict:
    """The site plus its decrypted bridge token. Refuses clearly when the site
    is WordPress (wrong integration) or the bridge isn't configured yet."""
    query = {"id": site_id}
    if user_id and user_id != "global":
        query["user_id"] = user_id
    site = await db.sites.find_one(query, {"_id": 0})
    if not site:
        raise HTTPException(status_code=404, detail="Site not found")

    platform = site.get("platform", "wordpress")
    if platform == "wordpress":
        raise HTTPException(
            status_code=400,
            detail=f"'{site.get('name', 'This site')}' is a WordPress site — use the WordPress content features for it, not the Next.js bridge.",
        )
    if not site.get("bridge_url"):
        raise HTTPException(
            status_code=400,
            detail="No SEO Bridge configured for this site. Install the bridge endpoint in your Next.js app "
                   "(see nextjs-bridge/README.md), then add its URL and token to the site's settings.",
        )
    if site.get("bridge_token"):
        site["bridge_token"] = decrypt_field(site["bridge_token"])
    return site


async def bridge_request(site: dict, method: str, path: str = "", data: Optional[dict] = None) -> dict:
    """Call the site's bridge. Returns the parsed JSON body, or raises an
    HTTPException whose detail explains what the site owner needs to fix."""
    base = (site.get("bridge_url") or "").rstrip("/")
    token = site.get("bridge_token") or ""
    url = f"{base}/{path.lstrip('/')}" if path else base
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
            resp = await client.request(method, url, headers=headers, json=data)
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"The SEO Bridge at {base} timed out after {int(_TIMEOUT)}s.")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not reach the SEO Bridge at {base}: {e}")

    if resp.status_code == 401:
        raise HTTPException(status_code=400, detail="The SEO Bridge rejected the token. Check it matches SEO_BRIDGE_TOKEN on the site.")
    if resp.status_code == 503:
        raise HTTPException(status_code=400, detail="The SEO Bridge is installed but disabled — SEO_BRIDGE_TOKEN isn't set on the deployment.")
    if resp.status_code == 404:
        # Distinguish "no bridge" from "this bridge doesn't implement that
        # endpoint" — conflating them sent debugging in the wrong direction.
        raise HTTPException(
            status_code=400,
            detail=f"The SEO Bridge at {base} returned 404 for '{path or '/'}'. "
                   f"Either the bridge isn't deployed, or it implements a different endpoint for this "
                   f"operation — check GET {base}/health for what it supports.",
        )

    try:
        body = resp.json()
    except Exception:
        raise HTTPException(
            status_code=502,
            detail=f"The SEO Bridge returned a non-JSON response (HTTP {resp.status_code}) — "
                   f"the URL may be pointing at a page instead of the API route.",
        )

    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"SEO Bridge error: {body.get('error') or resp.text[:200]}")
    return body


async def bridge_health(site: dict) -> dict:
    return await bridge_request(site, "GET", "health")


async def bridge_list_posts(site: dict) -> list:
    body = await bridge_request(site, "GET", "posts")
    return body.get("posts", [])


async def bridge_publish_post(site: dict, post: dict) -> dict:
    """Create or replace a post. `post` mirrors the bridge contract:
    {title, content, slug?, description?, tags?, date?, draft?, frontmatter?}."""
    if not (post.get("title") or "").strip():
        raise HTTPException(status_code=400, detail="A title is required to publish a post.")
    slug = (post.get("slug") or "").strip()
    if slug:
        return await bridge_request(site, "PUT", f"posts/{slug}", post)
    return await bridge_request(site, "POST", "posts", post)


async def bridge_delete_post(site: dict, slug: str) -> dict:
    return await bridge_request(site, "DELETE", f"posts/{slug}")


async def bridge_get_post(site: dict, slug: str) -> dict:
    """Raw content of one post — {slug, frontmatter, raw}, `raw` including the
    frontmatter block, so callers editing the body must strip it first."""
    return await bridge_request(site, "GET", f"posts/{slug}")


# --- SEO metadata overrides -------------------------------------------------
# A static Next.js page keeps its metadata in generateMetadata(), so it can't
# be rewritten from outside the repo. The bridge instead stores overrides on
# the content volume, keyed by route path, which the page merges in at render
# time. That makes titles/descriptions editable for pages as well as posts.

def _normalize_meta_entry(entry: dict) -> dict:
    """Flatten either dialect into {title, description, ogImage}.

    Two bridge shapes exist in the wild: the reference implementation in
    nextjs-bridge/ returns a flat {title, description}, while a JSON-content
    bridge may nest them under `seo` or prefix them (`seoTitle`). Accept both
    rather than hard-coding one — guessing wrong reads as "no override set",
    which is silent and indistinguishable from working correctly.
    """
    seo = entry.get("seo") if isinstance(entry.get("seo"), dict) else {}
    out = {
        "title": seo.get("title") or entry.get("seoTitle") or entry.get("title"),
        "description": seo.get("description") or entry.get("seoDescription") or entry.get("description"),
        "ogImage": seo.get("ogImage") or entry.get("ogImage"),
    }
    return {k: v for k, v in out.items() if v}


async def bridge_list_meta(site: dict) -> dict:
    """Current SEO metadata for every page/post the bridge knows about, keyed
    by BOTH slug and leading-slash route path so callers can look it up either
    way (bridges key by slug; audits key by URL path)."""
    body = await bridge_request(site, "GET", "meta")

    # Reference dialect: {"meta": {"/about": {...}}}
    if isinstance(body.get("meta"), dict):
        return {k: _normalize_meta_entry(v or {}) for k, v in body["meta"].items()}

    # JSON-content dialect: {"pages": [{slug, seoTitle, seoDescription, ...}]}
    entries = body.get("pages") or body.get("posts") or []
    out: dict = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        slug = (entry.get("slug") or "").strip().strip("/")
        normalized = _normalize_meta_entry(entry)
        if not normalized:
            continue
        route = "/" + slug if slug else "/"
        out[route] = normalized
        if slug:
            out[slug] = normalized      # also addressable by bare slug
    return out


async def bridge_get_meta(site: dict, route_path: str) -> Optional[dict]:
    body = await bridge_request(site, "GET", f"meta?path={quote(route_path, safe='/')}")
    return body.get("meta")


async def bridge_get_page_meta(site: dict, slug: str) -> dict:
    """Current metadata for one page, flattened. {} when unknown."""
    try:
        body = await bridge_request(site, "GET", f"meta/{slug}")
    except HTTPException:
        return {}
    return _normalize_meta_entry(body if isinstance(body, dict) else {})


# Every field the SEO metadata contract defines. A bridge that stores
# overrides by route path can hold all of them; one that edits a page record
# by slug typically holds only the three that page record has a slot for.
META_FIELDS_FULL = ("title", "description", "canonical",
                    "ogTitle", "ogDescription", "ogImage", "noindex")
META_FIELDS_PAGES = ("title", "description", "ogImage")

# The home page has no slug of its own, so a slug-keyed bridge exposes it
# under a conventional name. Probed in this order.
HOME_SLUG_CANDIDATES = ("home", "index", "homepage")


async def bridge_meta_dialect(site: dict) -> str:
    """Which metadata contract this bridge implements: "meta-store" (overrides
    keyed by route path, every field supported) or "pages" (a page record
    edited by slug, three fields supported).

    Determined from the SHAPE of GET /meta rather than guessed, because
    guessing wrong is silent: a bridge handed a body it does not recognise
    answers 200 OK, echoes the metadata it already had and writes nothing.
    """
    try:
        body = await bridge_request(site, "GET", "meta")
    except HTTPException:
        return "pages"
    if isinstance(body, dict):
        if isinstance(body.get("meta"), dict):
            return "meta-store"
        if isinstance(body.get("pages"), list) or isinstance(body.get("posts"), list):
            return "pages"
    return "pages"


async def bridge_meta_capabilities(site: dict) -> dict:
    """What can actually be written for this site, so the UI can offer the
    fields that work and explain the ones that do not instead of accepting an
    edit the bridge will drop on the floor."""
    dialect = await bridge_meta_dialect(site)
    fields = META_FIELDS_FULL if dialect == "meta-store" else META_FIELDS_PAGES
    return {
        "dialect": dialect,
        "supported_fields": list(fields),
        "unsupported_fields": [f for f in META_FIELDS_FULL if f not in fields],
        "note": (
            "This bridge stores overrides by route path and can hold the full metadata set."
            if dialect == "meta-store" else
            "This bridge edits the page record by slug, which has slots for the SEO title, "
            "description and OG image only. Canonical, OG title/description and noindex live in "
            "the page's own generateMetadata() and have to be changed in the repo — the "
            "Next.js snippets on the Reporting tab generate that code for you."
        ),
    }


async def _resolve_page_slug(site: dict, route_path: str) -> str:
    """The slug a slug-keyed bridge files this route under. Everything but the
    home page is the path itself; the home page is probed against the
    conventional names, since an empty slug is not addressable in a URL."""
    slug = (route_path or "").strip().strip("/")
    if slug:
        return slug
    for candidate in HOME_SLUG_CANDIDATES:
        try:
            body = await bridge_request(site, "GET", f"pages/{candidate}")
        except HTTPException:
            continue
        if isinstance(body, dict) and (body.get("slug") is not None or body.get("seo")):
            return candidate
    raise HTTPException(
        status_code=400,
        detail="This bridge addresses pages by slug and does not expose the home page under any of "
               f"{', '.join(HOME_SLUG_CANDIDATES)}. Edit the home page's metadata in its own "
               "generateMetadata(), or add a /meta override store to the bridge.",
    )


async def bridge_set_meta(site: dict, route_path: str, fields: dict) -> dict:
    """Write SEO metadata for one route.

    Two contracts exist. A path-keyed override store (`PUT /meta` with a
    `path` in the body) accepts the whole metadata set. A slug-keyed page
    record (`PUT /pages/:slug`) accepts the SEO title, description and OG
    image, and silently ignores anything else — so the fields that could not
    be written are returned rather than reported as saved.

    On the slug-keyed contract the write REPLACES the metadata object, so the
    current value is read first and the incoming fields merged onto it;
    otherwise editing just the title would drop ogImage. And because a bridge
    handed an unrecognised body still answers 200 OK while echoing the
    UNCHANGED metadata, every attempt is verified against that echo — a
    dialect only counts as accepted when the values came back changed.
    """
    dialect = await bridge_meta_dialect(site)

    if dialect == "meta-store":
        payload = {"path": route_path or "/",
                   **{k: v for k, v in fields.items() if k in META_FIELDS_FULL}}
        result = await bridge_request(site, "PUT", "meta", payload)
        return {**(result if isinstance(result, dict) else {}),
                "dialect": dialect,
                "applied_fields": [k for k in fields if k in META_FIELDS_FULL],
                "unsupported_fields": [k for k in fields if k not in META_FIELDS_FULL]}

    slug = await _resolve_page_slug(site, route_path)
    unsupported = [k for k in fields if k not in META_FIELDS_PAGES and fields[k] is not None]

    current = await bridge_get_page_meta(site, slug)
    merged = {**current}
    for key in META_FIELDS_PAGES:
        if key in fields:
            merged[key] = fields[key]
    core = {k: v for k, v in merged.items() if k in META_FIELDS_PAGES and v not in (None, "")}
    # A field explicitly set to None/"" must reach the bridge as null so it
    # clears the stored value; dropping it would silently keep the old text.
    for key in META_FIELDS_PAGES:
        if key in fields and fields[key] in (None, ""):
            core[key] = None

    dialects = [
        ("top-level", core),
        ("nested seo", {"seo": {k: v for k, v in core.items() if v is not None}}),
        ("flat seoTitle", {
            **({"seoTitle": core["title"]} if "title" in core else {}),
            **({"seoDescription": core["description"]} if "description" in core else {}),
            **({"ogImage": core["ogImage"]} if "ogImage" in core else {}),
        }),
    ]

    desired = {k: v for k, v in core.items() if v is not None}
    last_resp: dict = {}
    for name, body in dialects:
        try:
            resp = await bridge_request(site, "PUT", f"pages/{slug}/", body)
        except HTTPException as e:
            # 400/502 means the shape was rejected outright — try the next
            # dialect. Anything else (404, 401) is about the page or the
            # token, and retrying a different body cannot help.
            if e.status_code not in (400, 502):
                raise
            continue
        last_resp = resp if isinstance(resp, dict) else {}
        if _meta_write_applied(last_resp, desired):
            if name != "top-level":
                logger.info(f"Meta write for '{slug}' accepted via '{name}' dialect")
            return {**last_resp, "dialect": dialect, "slug": slug,
                    "applied_fields": [k for k in fields if k in META_FIELDS_PAGES],
                    "unsupported_fields": unsupported}
        logger.info(f"Meta write for '{slug}' via '{name}' dialect returned OK but changed nothing; trying next")

    raise HTTPException(
        status_code=502,
        detail=f"The bridge accepted the update for '/{slug}' but the metadata did not change. "
               f"Its PUT /pages/{slug} handler answered OK without writing — check that it reads "
               f"'title' and 'description' from the request body and saves them to the page's "
               f"JSON/frontmatter.",
    )


def _meta_write_applied(resp: dict, desired: dict) -> bool:
    """True when the bridge's PUT echo shows the values we asked for.

    A bridge that ignores an unrecognised body still answers 200 and echoes the
    metadata it already had, so the echo — not the status code — is what tells
    a real write apart from a silent no-op. When there is no echo to inspect,
    give the bridge the benefit of the doubt rather than reporting a failure on
    a write that may well have landed.
    """
    echo = resp.get("seo") or resp.get("meta") or resp.get("page") or {}
    if not isinstance(echo, dict) or not echo:
        return True
    normalized = _normalize_meta_entry(echo)
    for key in ("title", "description"):
        if key in desired and normalized.get(key) not in (None, desired[key]):
            return False
    return True


async def bridge_clear_meta(site: dict, route_path: str) -> dict:
    """Remove the override for a route, handing control back to the page's own
    metadata. On a slug-keyed bridge there is no delete, so the supported
    fields are explicitly nulled — which is the same end state."""
    dialect = await bridge_meta_dialect(site)
    if dialect == "meta-store":
        return await bridge_request(site, "DELETE", f"meta?path={quote(route_path, safe='/')}")
    slug = await _resolve_page_slug(site, route_path)
    body = {field: None for field in META_FIELDS_PAGES}
    resp = await bridge_request(site, "PUT", f"pages/{slug}/", body)
    return {**(resp if isinstance(resp, dict) else {}), "cleared": route_path, "dialect": dialect}


# --- Page body-copy blocks ---------------------------------------------------
# generateMetadata() covers <title>/<meta>, but a static page's actual body
# text is compiled TSX and can't be rewritten the same way. A page that wants
# specific pieces of copy to be editable wraps them in getContentBlock() (see
# nextjs-bridge/lib/page-content.ts), which self-registers the block's default
# in the bridge's content store on first render — so a page only shows up
# below once it has actually been rendered at least once with a wrapped block.

async def bridge_get_content(site: dict) -> dict:
    """Every page's content-block overrides, keyed by route path."""
    body = await bridge_request(site, "GET", "content")
    return body.get("content") or {}


async def bridge_get_page_content(site: dict, route_path: str) -> dict:
    """{key: value} blocks for one page. {} when the page has none yet."""
    body = await bridge_request(site, "GET", f"content?path={quote(route_path, safe='/')}")
    return body.get("content") or {}


async def bridge_set_content_block(site: dict, route_path: str, key: str, value: str) -> dict:
    return await bridge_request(site, "PUT", "content", {"path": route_path, "key": key, "value": value})


async def bridge_clear_content_block(site: dict, route_path: str, key: Optional[str] = None) -> dict:
    """Removes one block, or (with `key` omitted) every block on the page."""
    qs = f"path={quote(route_path, safe='/')}"
    if key:
        qs += f"&key={quote(key)}"
    return await bridge_request(site, "DELETE", f"content?{qs}")


# --- Image alt text ----------------------------------------------------------
# A page that wants specific images editable wraps them in <EditableImg> (see
# nextjs-bridge/lib/editable-image.tsx), which self-registers the image's
# default alt (and src, for a thumbnail) on first render — a page only shows
# up below once it has actually been rendered at least once with a wrapped
# image, same as content blocks.

async def bridge_get_images(site: dict) -> dict:
    """Every page's registered images, keyed by route path."""
    body = await bridge_request(site, "GET", "images")
    return body.get("images") or {}


async def bridge_get_page_images(site: dict, route_path: str) -> dict:
    """{key: {alt, src?}} for one page. {} when the page has none yet."""
    body = await bridge_request(site, "GET", f"images?path={quote(route_path, safe='/')}")
    return body.get("images") or {}


async def bridge_set_image_alt(site: dict, route_path: str, key: str, alt: str) -> dict:
    return await bridge_request(site, "PUT", "images", {"path": route_path, "key": key, "alt": alt})


async def bridge_clear_image_alt(site: dict, route_path: str, key: Optional[str] = None) -> dict:
    """Removes one image's override, or (with `key` omitted) every image on the page."""
    qs = f"path={quote(route_path, safe='/')}"
    if key:
        qs += f"&key={quote(key)}"
    return await bridge_request(site, "DELETE", f"images?{qs}")


async def generate_alt_text_from_url(image_url: str, fallback_label: str = "") -> str:
    """Claude vision writes alt text for a publicly-reachable image URL — the
    Next.js counterpart to the WordPress AI alt-text generator in
    routers/admin_migration.py, which does the same thing for a WP media ID.
    Never raises: any failure falls back to a plain label so the caller
    always has something to save rather than a blocked action."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            img_resp = await client.get(image_url)
            img_resp.raise_for_status()
            img_b64 = base64.b64encode(img_resp.content).decode()
            content_type = img_resp.headers.get("content-type", "image/jpeg").split(";")[0]
    except Exception:
        return fallback_label or "Image"

    try:
        client = anthropic.AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
        msg = await client.messages.create(
            model="claude-opus-4-5",
            max_tokens=200,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": content_type, "data": img_b64}},
                    {"type": "text", "text": "Write a concise, descriptive SEO alt text for this image in under 125 characters. Return only the alt text, no quotes or explanation."},
                ],
            }],
        )
        return msg.content[0].text.strip().strip('"')
    except Exception:
        return fallback_label or "Image"
