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
        raise HTTPException(
            status_code=400,
            detail=f"No SEO Bridge found at {url}. Confirm the route is deployed at that path "
                   f"(app/api/seo-bridge/[[...path]]/route.ts).",
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
