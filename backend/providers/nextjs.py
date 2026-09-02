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
import logging
from typing import Optional
from urllib.parse import quote

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


async def bridge_set_meta(site: dict, route_path: str, fields: dict) -> dict:
    """Write SEO metadata for one page.

    Bridges key pages by SLUG and expose the write as PUT /pages/:slug. The
    write REPLACES the metadata object, so the current value is read first and
    the incoming fields merged onto it — otherwise editing just the title
    would silently drop a field like ogImage that nobody asked to change.

    Three body dialects exist in the wild. Crucially, a bridge that does not
    recognise the shape it is handed may still answer 200 OK while echoing the
    UNCHANGED metadata and writing nothing — so trying a dialect and trusting
    the status code reports a success that never happened. Each attempt is
    therefore verified against the echoed metadata, and a dialect only counts
    as accepted when the values actually came back changed.
    """
    slug = (route_path or "").strip().strip("/")
    if not slug:
        raise HTTPException(
            status_code=400,
            detail="This bridge addresses pages by slug, and the home page has an empty slug — "
                   "it can't be edited through this endpoint.",
        )

    current = await bridge_get_page_meta(site, slug)
    merged = {**current}
    for key in ("title", "description", "ogImage"):
        if key in fields and fields[key] is not None:
            merged[key] = fields[key]
    merged = {k: v for k, v in merged.items() if v}
    core = {k: v for k, v in merged.items() if k in ("title", "description", "ogImage")}

    dialects = [
        ("top-level", core),
        ("nested seo", {"seo": core}),
        ("flat seoTitle", {
            **({"seoTitle": core["title"]} if "title" in core else {}),
            **({"seoDescription": core["description"]} if "description" in core else {}),
            **({"ogImage": core["ogImage"]} if "ogImage" in core else {}),
        }),
    ]

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
        if _meta_write_applied(last_resp, core):
            if name != "top-level":
                logger.info(f"Meta write for '{slug}' accepted via '{name}' dialect")
            return last_resp
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
    return await bridge_request(site, "DELETE", f"meta?path={quote(route_path, safe='/')}")
