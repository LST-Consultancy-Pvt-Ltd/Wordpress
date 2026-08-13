"""Auto-SEO: AI-scored + AI-generated meta title/description, Open Graph tags,
and schema.org JSON-LD, applied to WordPress through a layered fallback chain
(WP Manager Bridge plugin → Yoast meta → RankMath meta → XML-RPC custom_fields
→ direct content injection for schema), individually or in bulk.
"""
import base64
import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

import httpx
from fastapi import Depends, HTTPException
from pydantic import BaseModel

from core.activity import log_activity
from core.ai import get_ai_response
from core.db import db
from core.router import api_router
from core.security import require_editor, require_user
from providers.wordpress import get_wp_credentials, wp_api_request, wp_xmlrpc_edit

logger = logging.getLogger(__name__)

async def _wp_post_fallback(site: dict, endpoint: str, payload: dict) -> "httpx.Response":
    """POST to WordPress REST API. For Application Passwords, also retries with explicit
    Authorization header for hosts (e.g. Hostinger/LiteSpeed) that strip httpx.BasicAuth.
    JWT sites skip the retry — the Bearer header is already explicit."""
    resp = await wp_api_request(site, "POST", endpoint, payload)
    if resp.status_code not in (401, 403):
        return resp
    # JWT sites: a 401/403 is a real auth failure, not a stripped-header issue
    if site.get("auth_type") == "jwt":
        return resp
    # Application Password: host may have stripped httpx.BasicAuth — retry with explicit header
    wp_url = site["url"].rstrip("/") + "/wp-json/wp/v2/" + endpoint
    app_password = site["app_password"].replace(" ", "")
    raw_creds = site["username"] + ":" + app_password
    b64_creds = base64.b64encode(raw_creds.encode()).decode()
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as hc:
            return await hc.post(
                wp_url,
                headers={"Content-Type": "application/json", "Authorization": "Basic " + b64_creds},
                json=payload,
            )
    except httpx.ConnectError as e:
        raise HTTPException(status_code=502, detail=f"Cannot connect to WordPress site at {site['url']}: {e}")
    except httpx.TimeoutException as e:
        raise HTTPException(status_code=504, detail=f"WordPress site at {site['url']} timed out: {e}")


async def _wpmb_bridge_post(site: dict, bridge_endpoint: str, payload: dict) -> Optional["httpx.Response"]:
    """POST to the WP Manager Bridge plugin endpoint using X-WPMB-Auth header.
    This header survives CDN stripping (Hostinger 'hcdn', Cloudflare, etc.) where
    the standard Authorization header is removed before reaching WordPress.
    Returns None if the plugin is not installed or the call cannot be made.
    """
    if site.get("auth_type") == "jwt":
        return None  # bridge plugin uses Basic header path; JWT users have a different working path
    if not site.get("app_password") or not site.get("username"):
        return None
    wp_url = site["url"].rstrip("/") + "/wp-json/wp-manager/v1/" + bridge_endpoint.lstrip("/")
    app_password = site["app_password"].replace(" ", "")
    raw_creds = site["username"] + ":" + app_password
    b64_creds = base64.b64encode(raw_creds.encode()).decode()
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as hc:
            return await hc.post(
                wp_url,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": "Basic " + b64_creds,   # try standard header first
                    "X-WPMB-Auth": "Basic " + b64_creds,     # CDN-resistant fallback
                },
                json=payload,
            )
    except (httpx.ConnectError, httpx.TimeoutException):
        return None
    except Exception:
        return None

class AutoSEOApplyMetaRequest(BaseModel):
    content_type: str  # "post" or "page"
    ai_title: str
    ai_desc: str

class AutoSEOApplyOGRequest(BaseModel):
    content_type: str
    og_title: str
    og_desc: str
    og_image: str = ""
    og_type: str = "article"

class AutoSEOApplySchemaRequest(BaseModel):
    content_type: str
    schema_markup: str  # JSON-LD string

class AutoSEOBulkApplyRequest(BaseModel):
    wp_ids: List[int]
    apply_type: str  # "meta" | "og" | "schema" | "all"


def _score_title(title: str) -> int:
    if not title:
        return 0
    length = len(title)
    if 50 <= length <= 60:
        return 100
    if 40 <= length <= 70:
        return 70
    if 30 <= length <= 80:
        return 40
    return 20


def _score_desc(desc: str) -> int:
    if not desc:
        return 0
    length = len(desc)
    if 150 <= length <= 160:
        return 100
    if 130 <= length <= 180:
        return 70
    if 100 <= length <= 200:
        return 40
    return 20


@api_router.post("/seo/auto-scan/{site_id}")
async def auto_seo_scan(site_id: str, _: dict = Depends(require_editor)):
    """Fetch all WP posts/pages, score their meta, batch-generate AI suggestions, store in seo_suggestions."""
    site = await get_wp_credentials(site_id)

    # Fetch posts and pages (with meta + Yoast head)
    # wp_api_request doesn't support a params kwarg — encode query string directly
    items = []
    for ct in ("posts", "pages"):
        qs = "per_page=100&status=publish&context=edit&_fields=id,slug,link,title,meta,yoast_head_json"
        resp = await wp_api_request(site, "GET", f"{ct}?{qs}")
        if resp.status_code == 200:
            for item in resp.json():
                items.append((ct.rstrip("s"), item))  # "post" / "page"

    # Score and collect low-scoring entries for AI
    entries = []
    low_scoring = []
    for content_type, item in items:
        wp_id = item.get("id")
        url = item.get("link", "")
        slug = item.get("slug", "")
        title_obj = item.get("title", {})
        title_rendered = title_obj.get("rendered", "") if isinstance(title_obj, dict) else str(title_obj)
        meta = item.get("meta") or {}

        current_title = (
            meta.get("_yoast_wpseo_title") or
            meta.get("rank_math_title") or
            title_rendered or ""
        )
        current_desc = (
            meta.get("_yoast_wpseo_metadesc") or
            meta.get("rank_math_description") or ""
        )

        yoast_head = item.get("yoast_head_json") or {}
        og_image = ""
        og_imgs = yoast_head.get("og_image")
        if isinstance(og_imgs, list) and og_imgs:
            og_image = og_imgs[0].get("url", "")

        title_score = _score_title(current_title)
        desc_score = _score_desc(current_desc)

        entry = {
            "wp_id": wp_id,
            "content_type": content_type,
            "url": url,
            "slug": slug,
            "current_title": current_title,
            "current_desc": current_desc,
            "title_score": title_score,
            "desc_score": desc_score,
            "og_image": og_image,
        }
        entries.append(entry)
        if title_score < 80 or desc_score < 80:
            low_scoring.append(entry)

    # Batch AI call for all low-scoring items
    ai_results: dict = {}
    if low_scoring:
        pages_json = json.dumps(
            [{"wp_id": e["wp_id"], "url": e["url"], "slug": e["slug"],
              "current_title": e["current_title"], "current_desc": e["current_desc"]}
             for e in low_scoring],
            ensure_ascii=False
        )
        prompt = (
            "You are an SEO expert. For each WordPress page/post below, generate:\n"
            "- ai_title: improved meta title (max 60 chars, keyword-rich)\n"
            "- ai_desc: improved meta description (max 160 chars, compelling)\n"
            "- og_title: Open Graph title (max 60 chars)\n"
            "- og_desc: Open Graph description (max 160 chars)\n"
            "- og_type: best og:type (website/article/product)\n"
            "- schema_type: best schema.org @type "
            "(Article/Service/ContactPage/HowTo/FAQPage/Product/LocalBusiness)\n"
            "- schema_json: complete schema.org JSON-LD object as a JSON string\n\n"
            f"Pages:\n{pages_json}\n\n"
            'Return a JSON array with one object per page using the exact wp_id from input:\n'
            '[{"wp_id": 1, "ai_title": "...", "ai_desc": "...", "og_title": "...", '
            '"og_desc": "...", "og_type": "article", "schema_type": "Article", '
            '"schema_json": "{\\"@context\\":\\"https://schema.org\\"}"}]\n'
            "Return ONLY the JSON array, no markdown."
        )
        try:
            raw = await get_ai_response(
                [
                    {"role": "system", "content": "You are an expert SEO strategist. Always respond with valid JSON only."},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.3,
                max_tokens=4000,
            )
            if "```json" in raw:
                raw = raw.split("```json")[1].split("```")[0]
            elif "```" in raw:
                raw = raw.split("```")[1].split("```")[0]
            ai_list = json.loads(raw.strip())
            for ai_item in ai_list:
                try:
                    ai_results[int(ai_item["wp_id"])] = ai_item
                except Exception:
                    pass
        except Exception as e:
            logger.warning(f"Auto-SEO AI batch failed: {e}")

    # Upsert all entries into MongoDB, preserving existing "applied" status
    now = datetime.now(timezone.utc).isoformat()
    final_docs = []
    for entry in entries:
        wp_id = entry["wp_id"]
        ai = ai_results.get(wp_id, {})
        ai_title = ai.get("ai_title") or entry["current_title"] or ""
        ai_desc = ai.get("ai_desc") or entry["current_desc"] or ""
        doc_core = {
            "site_id": site_id,
            "wp_id": wp_id,
            "content_type": entry["content_type"],
            "url": entry["url"],
            "current_title": entry["current_title"],
            "current_desc": entry["current_desc"],
            "ai_title": ai_title,
            "ai_title_len": len(ai_title),
            "ai_desc": ai_desc,
            "ai_desc_len": len(ai_desc),
            "title_score": entry["title_score"],
            "desc_score": entry["desc_score"],
            "og_title": ai.get("og_title") or ai_title,
            "og_desc": ai.get("og_desc") or ai_desc,
            "og_image": entry["og_image"],
            "og_type": ai.get("og_type") or "article",
            "schema_json": ai.get("schema_json") or "",
            "created_at": now,
        }
        # $setOnInsert keeps existing status="applied" on re-scan; new docs get "pending"
        await db.seo_suggestions.update_one(
            {"site_id": site_id, "wp_id": wp_id},
            {"$set": doc_core, "$setOnInsert": {"status": "pending"}},
            upsert=True,
        )
        final = await db.seo_suggestions.find_one({"site_id": site_id, "wp_id": wp_id}, {"_id": 0})
        if final:
            final_docs.append(final)

    await log_activity(site_id, "auto_seo_scan",
                       f"Auto-SEO scan: {len(final_docs)} pages, {len(low_scoring)} improved by AI")
    return final_docs


@api_router.get("/seo/auto-scan/{site_id}")
async def get_auto_seo_suggestions(site_id: str, _: dict = Depends(require_user)):
    """Return cached Auto-SEO suggestions for a site."""
    docs = await db.seo_suggestions.find({"site_id": site_id}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return docs


@api_router.post("/seo/apply-meta/{site_id}/{wp_id}")
async def apply_meta_tags(
    site_id: str,
    wp_id: int,
    data: AutoSEOApplyMetaRequest,
    _: dict = Depends(require_editor),
):
    """Apply AI-generated meta title + description to WordPress (Yoast first, RankMath fallback)."""
    site = await get_wp_credentials(site_id)
    ep = f"{'pages' if data.content_type == 'page' else 'posts'}/{wp_id}"

    updated_fields: list = []
    warning: Optional[str] = None

    # PRIMARY PATH: WP Manager Bridge plugin (uses X-WPMB-Auth header, CDN-resistant)
    # Writes meta directly via PHP update_post_meta() — bypasses REST meta whitelist.
    bridge_resp = await _wpmb_bridge_post(
        site,
        f"seo/apply-meta/{wp_id}",
        {"meta_title": data.ai_title, "meta_description": data.ai_desc},
    )
    if bridge_resp is not None and bridge_resp.status_code in (200, 201):
        try:
            body = bridge_resp.json()
        except Exception:
            body = {}
        if body.get("success"):
            await db.seo_suggestions.update_one(
                {"site_id": site_id, "wp_id": wp_id},
                {"$set": {"status": "applied"}}
            )
            await log_activity(site_id, "auto_seo_meta_applied",
                               f"Meta tags applied to {data.content_type} {wp_id} via bridge plugin")
            return {
                "success": True,
                "wp_id": wp_id,
                "updated_fields": ["meta_title (bridge)", "meta_description (bridge)"],
            }

    # Try Yoast fields first (with 401 auth fallback for Hostinger/LiteSpeed)
    yoast_resp = await _wp_post_fallback(site, ep, {
        "meta": {
            "_yoast_wpseo_title": data.ai_title,
            "_yoast_wpseo_metadesc": data.ai_desc,
        }
    })
    if yoast_resp.status_code in (200, 201):
        # Check if the POST response itself contains the written meta
        yoast_resp_data = yoast_resp.json() if yoast_resp.status_code in (200, 201) else {}
        resp_meta = yoast_resp_data.get("meta") or {}
        title_in_resp = resp_meta.get("_yoast_wpseo_title", "")
        desc_in_resp = resp_meta.get("_yoast_wpseo_metadesc", "")

        if title_in_resp == data.ai_title or desc_in_resp == data.ai_desc:
            # Meta was written and confirmed in POST response
            updated_fields = ["_yoast_wpseo_title", "_yoast_wpseo_metadesc"]
        else:
            # POST response didn't include meta — verify with GET (try context=edit, fall back to plain)
            verify_resp = await wp_api_request(site, "GET", f"{ep}?context=edit&_fields=meta")
            if verify_resp.status_code != 200:
                # context=edit may require higher permissions — try without it
                verify_resp = await wp_api_request(site, "GET", f"{ep}?_fields=meta")
            written_meta = (verify_resp.json().get("meta") or {}) if verify_resp.status_code == 200 else {}
            title_written = written_meta.get("_yoast_wpseo_title", "")
            desc_written = written_meta.get("_yoast_wpseo_metadesc", "")
            # Compare to intended values — an existing old value is not confirmation the write succeeded
            if title_written == data.ai_title or desc_written == data.ai_desc:
                updated_fields = ["_yoast_wpseo_title", "_yoast_wpseo_metadesc"]
            else:
                # Yoast fields were silently ignored — try RankMath
                rm_resp = await _wp_post_fallback(site, ep, {
                    "meta": {
                        "rank_math_title": data.ai_title,
                        "rank_math_description": data.ai_desc,
                    }
                })
                if rm_resp.status_code in (200, 201):
                    # Verify RankMath too
                    vr2 = await wp_api_request(site, "GET", f"{ep}?context=edit&_fields=meta")
                    rm_meta = (vr2.json().get("meta") or {}) if vr2.status_code == 200 else {}
                    if rm_meta.get("rank_math_title") == data.ai_title or rm_meta.get("rank_math_description") == data.ai_desc:
                        updated_fields = ["rank_math_title", "rank_math_description"]
                    else:
                        # REST meta failed for both plugins — try XML-RPC custom_fields (writes directly to wp_postmeta)
                        # Try Yoast fields via XML-RPC first, then RankMath fields
                        xmlrpc_ok = False
                        try:
                            xmlrpc_ok = await wp_xmlrpc_edit(site, wp_id, {
                                "custom_fields": [
                                    {"key": "_yoast_wpseo_title", "value": data.ai_title},
                                    {"key": "_yoast_wpseo_metadesc", "value": data.ai_desc},
                                    {"key": "rank_math_title", "value": data.ai_title},
                                    {"key": "rank_math_description", "value": data.ai_desc},
                                ]
                            }, verify_keys=["_yoast_wpseo_title", "_yoast_wpseo_metadesc", "rank_math_title"])
                        except Exception:
                            xmlrpc_ok = False

                        if xmlrpc_ok:
                            updated_fields = ["_yoast_wpseo_title (xmlrpc)", "_yoast_wpseo_metadesc (xmlrpc)"]
                            warning = (
                                "Yoast/RankMath REST API meta fields were not writable via REST. "
                                "SEO title and description were written via XML-RPC fallback and are now active in WordPress."
                            )
                        else:
                            # All automated paths failed — show plugin install instructions
                            updated_fields = []
                            warning = (
                                "SEO meta fields could not be written. WordPress blocked the write via both "
                                "REST API and XML-RPC (protected meta key restriction). "
                                "Install the WP Manager Bridge Plugin to fix this permanently."
                            )
                else:
                    updated_fields = []
                    warning = (
                        "SEO meta fields could not be written. WordPress blocked the write via both "
                        "REST API and XML-RPC (protected meta key restriction). "
                        "Install the WP Manager Bridge Plugin to fix this permanently."
                    )
    else:
        # Fallback: RankMath (Yoast POST itself failed with non-200)
        rm_resp = await _wp_post_fallback(site, ep, {
            "meta": {
                "rank_math_title": data.ai_title,
                "rank_math_description": data.ai_desc,
            }
        })
        if rm_resp.status_code in (200, 201):
            vr_rm = await wp_api_request(site, "GET", f"{ep}?context=edit&_fields=meta")
            vr_rm_meta = (vr_rm.json().get("meta") or {}) if vr_rm.status_code == 200 else {}
            if vr_rm_meta.get("rank_math_title") == data.ai_title or vr_rm_meta.get("rank_math_description") == data.ai_desc:
                updated_fields = ["rank_math_title", "rank_math_description"]
            else:
                warning = "SEO meta fields may not have been saved. Ensure Yoast SEO or RankMath is active and the LST Meta Fixer plugin is installed."
        else:
            raise HTTPException(
                status_code=502,
                detail=f"WordPress returned {rm_resp.status_code}: {rm_resp.text[:200]}"
            )

    db_status = "applied" if updated_fields else "pending"
    await db.seo_suggestions.update_one(
        {"site_id": site_id, "wp_id": wp_id},
        {"$set": {"status": db_status}}
    )
    await log_activity(site_id, "auto_seo_meta_applied",
                       f"Meta tags applied to {data.content_type} {wp_id}")
    result: dict = {"success": True, "wp_id": wp_id, "updated_fields": updated_fields}
    if warning:
        result["warning"] = warning
    return result


@api_router.post("/seo/apply-og/{site_id}/{wp_id}")
async def apply_og_tags(
    site_id: str,
    wp_id: int,
    data: AutoSEOApplyOGRequest,
    _: dict = Depends(require_editor),
):
    """Apply Open Graph meta fields to WordPress via Yoast SEO meta fields with RankMath fallback."""
    site = await get_wp_credentials(site_id)
    ep = f"{'pages' if data.content_type == 'page' else 'posts'}/{wp_id}"

    updated_fields: list = []
    warning: Optional[str] = None

    # PRIMARY PATH: WP Manager Bridge plugin (CDN-resistant)
    bridge_resp = await _wpmb_bridge_post(
        site,
        f"seo/apply-og/{wp_id}",
        {
            "og_title": data.og_title,
            "og_description": data.og_desc,
            "og_image": data.og_image,
        },
    )
    if bridge_resp is not None and bridge_resp.status_code in (200, 201):
        try:
            body = bridge_resp.json()
        except Exception:
            body = {}
        if body.get("success"):
            await db.seo_suggestions.update_one(
                {"site_id": site_id, "wp_id": wp_id},
                {"$set": {"status": "applied"}}
            )
            await log_activity(site_id, "auto_seo_og_applied",
                               f"OG tags applied to {data.content_type} {wp_id} via bridge plugin")
            return {
                "success": True,
                "wp_id": wp_id,
                "updated_fields": ["og_title (bridge)", "og_description (bridge)", "og_image (bridge)"],
            }

    # Try Yoast OG fields first
    resp = await _wp_post_fallback(site, ep, {
        "meta": {
            "_yoast_wpseo_opengraph-title": data.og_title,
            "_yoast_wpseo_opengraph-description": data.og_desc,
            "_yoast_wpseo_opengraph-image": data.og_image,
        }
    })
    if resp.status_code in (200, 201):
        # Verify the meta was actually written
        verify = await wp_api_request(site, "GET", f"{ep}?context=edit&_fields=meta")
        if verify.status_code == 200:
            vm = verify.json().get("meta") or {}
            if vm.get("_yoast_wpseo_opengraph-title") == data.og_title or vm.get("_yoast_wpseo_opengraph-description") == data.og_desc:
                updated_fields = ["og_title", "og_desc", "og_image"]
            else:
                # Yoast OG fields silently ignored — try RankMath equivalents
                rm_resp = await _wp_post_fallback(site, ep, {
                    "meta": {
                        "rank_math_facebook_title": data.og_title,
                        "rank_math_facebook_description": data.og_desc,
                    }
                })
                if rm_resp.status_code in (200, 201):
                    vr2 = await wp_api_request(site, "GET", f"{ep}?context=edit&_fields=meta")
                    rm_meta = (vr2.json().get("meta") or {}) if vr2.status_code == 200 else {}
                    if rm_meta.get("rank_math_facebook_title") == data.og_title or rm_meta.get("rank_math_facebook_description") == data.og_desc:
                        updated_fields = ["rank_math_facebook_title", "rank_math_facebook_description"]
                    else:
                        # REST OG fields failed — try XML-RPC custom_fields as fallback
                        xmlrpc_og_ok = False
                        try:
                            xmlrpc_og_ok = await wp_xmlrpc_edit(site, wp_id, {
                                "custom_fields": [
                                    {"key": "_yoast_wpseo_opengraph-title", "value": data.og_title},
                                    {"key": "_yoast_wpseo_opengraph-description", "value": data.og_desc},
                                    {"key": "_yoast_wpseo_opengraph-image", "value": data.og_image},
                                    {"key": "rank_math_facebook_title", "value": data.og_title},
                                    {"key": "rank_math_facebook_description", "value": data.og_desc},
                                ]
                            }, verify_keys=["_yoast_wpseo_opengraph-title", "_yoast_wpseo_opengraph-description", "rank_math_facebook_title"])
                        except Exception:
                            xmlrpc_og_ok = False

                        if xmlrpc_og_ok:
                            updated_fields = ["og_title (xmlrpc)", "og_desc (xmlrpc)"]
                        else:
                            warning = (
                                "OG meta fields are not writable via REST API or XML-RPC on this site. "
                                "Ensure Yoast SEO or RankMath is installed and active, "
                                "and XML-RPC is not blocked by a security plugin."
                            )
                            updated_fields = []
                else:
                    warning = "OG fields could not be written — Yoast SEO or RankMath plugin required."
        else:
            # Verification GET failed — assume write worked
            updated_fields = ["og_title", "og_desc", "og_image"]
    else:
        raise HTTPException(
            status_code=502,
            detail=f"WordPress returned {resp.status_code}: {resp.text[:200]}"
        )

    og_db_status = "applied" if updated_fields else "pending"
    await db.seo_suggestions.update_one(
        {"site_id": site_id, "wp_id": wp_id},
        {"$set": {"status": og_db_status}}
    )
    await log_activity(site_id, "auto_seo_og_applied",
                       f"OG tags applied to {data.content_type} {wp_id}")
    result: dict = {"success": True, "wp_id": wp_id, "updated_fields": updated_fields}
    if warning:
        result["warning"] = warning
    return result


@api_router.post("/seo/apply-schema/{site_id}/{wp_id}")
async def apply_schema_markup(
    site_id: str,
    wp_id: int,
    data: AutoSEOApplySchemaRequest,
    _: dict = Depends(require_editor),
):
    """Store schema JSON-LD in a custom meta field; always verify and fall back to injecting a <script> tag into content."""
    site = await get_wp_credentials(site_id)
    ep = f"{'pages' if data.content_type == 'page' else 'posts'}/{wp_id}"
    ep_edit = f"{ep}?context=edit&_fields=id,content,meta"

    # PRIMARY PATH: WP Manager Bridge plugin (CDN-resistant)
    bridge_resp = await _wpmb_bridge_post(
        site,
        f"seo/apply-schema/{wp_id}",
        {"schema": data.schema_markup},
    )
    if bridge_resp is not None and bridge_resp.status_code in (200, 201):
        try:
            body = bridge_resp.json()
        except Exception:
            body = {}
        if body.get("success"):
            await db.seo_suggestions.update_one(
                {"site_id": site_id, "wp_id": wp_id},
                {"$set": {"status": "applied"}}
            )
            await log_activity(site_id, "auto_seo_schema_applied",
                               f"Schema applied to {data.content_type} {wp_id} via bridge plugin")
            return {
                "success": True,
                "wp_id": wp_id,
                "schema_meta_written": True,
                "schema_in_content": False,
                "method": "bridge_plugin",
            }

    import re as _re
    injected_via_content = False

    # Try custom meta field first
    meta_resp = await _wp_post_fallback(site, ep, {
        "meta": {"_auto_seo_schema_json": data.schema_markup}
    })
    logger.info(f"Schema meta POST for {wp_id}: {meta_resp.status_code}")

    # Always verify — WP returns 200 even when it silently ignores unregistered meta fields
    meta_written = False
    if meta_resp.status_code in (200, 201):
        verify = await wp_api_request(site, "GET", ep_edit)
        if verify.status_code == 200:
            written_meta = verify.json().get("meta") or {}
            if written_meta.get("_auto_seo_schema_json"):
                meta_written = True

    if not meta_written:
        # Meta field silently ignored (not registered) — inject directly into post content
        get_resp = await wp_api_request(site, "GET", ep_edit)
        if get_resp.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail="Schema injection failed: could not fetch post content"
            )
        content_obj = get_resp.json().get("content") or {}
        existing_content = (
            content_obj.get("raw") or content_obj.get("rendered") or ""
            if isinstance(content_obj, dict) else str(content_obj)
        )
        # Remove any previously injected auto-SEO schema block
        existing_content = _re.sub(
            r'\n?<script type="application/ld\+json">\n[\s\S]*?\n</script>',
            '',
            existing_content
        )
        # Inject schema as HTML comment-wrapped block to avoid WAF/ModSecurity blocking <script> tags
        schema_comment = f'\n<!-- wp:html -->\n<script type="application/ld+json">\n{data.schema_markup}\n</script>\n<!-- /wp:html -->'
        new_content = existing_content + schema_comment
        patch_resp = await _wp_post_fallback(site, ep, {"content": new_content})
        logger.info(f"Schema content injection POST for {wp_id}: {patch_resp.status_code} — {patch_resp.text[:300]}")
        if patch_resp.status_code not in (200, 201):
            raise HTTPException(
                status_code=502,
                detail=f"Schema injection failed (WP returned {patch_resp.status_code}): {patch_resp.text[:300]}"
            )
        injected_via_content = True

    await db.seo_suggestions.update_one(
        {"site_id": site_id, "wp_id": wp_id},
        {"$set": {"status": "applied"}}
    )
    await log_activity(site_id, "auto_seo_schema_applied",
                       f"Schema JSON-LD injected for {data.content_type} {wp_id}")
    return {"success": True, "wp_id": wp_id, "injected_via_content": injected_via_content}


@api_router.post("/seo/apply-bulk/{site_id}")
async def apply_bulk_seo(
    site_id: str,
    data: AutoSEOBulkApplyRequest,
    _: dict = Depends(require_editor),
):
    """Apply meta/og/schema (or all) to multiple posts/pages in one call."""
    site = await get_wp_credentials(site_id)
    applied = 0
    failed = 0
    errors: list = []

    for wp_id in data.wp_ids:
        suggestion = await db.seo_suggestions.find_one(
            {"site_id": site_id, "wp_id": wp_id}, {"_id": 0}
        )
        if not suggestion:
            failed += 1
            errors.append({"wp_id": wp_id, "error": "No suggestion found"})
            continue

        content_type = suggestion.get("content_type", "post")
        ep = f"{'pages' if content_type == 'page' else 'posts'}/{wp_id}"

        try:
            if data.apply_type in ("meta", "all"):
                resp = await _wp_post_fallback(site, ep, {
                    "meta": {
                        "_yoast_wpseo_title": suggestion.get("ai_title", ""),
                        "_yoast_wpseo_metadesc": suggestion.get("ai_desc", ""),
                    }
                })
                if resp.status_code not in (200, 201):
                    # Try RankMath fallback
                    await _wp_post_fallback(site, ep, {
                        "meta": {
                            "rank_math_title": suggestion.get("ai_title", ""),
                            "rank_math_description": suggestion.get("ai_desc", ""),
                        }
                    })

            if data.apply_type in ("og", "all"):
                await _wp_post_fallback(site, ep, {
                    "meta": {
                        "_yoast_wpseo_opengraph-title": suggestion.get("og_title", ""),
                        "_yoast_wpseo_opengraph-description": suggestion.get("og_desc", ""),
                        "_yoast_wpseo_opengraph-image": suggestion.get("og_image", ""),
                    }
                })

            if data.apply_type in ("schema", "all"):
                schema_json = suggestion.get("schema_json", "")
                if schema_json:
                    schema_resp = await _wp_post_fallback(site, ep, {
                        "meta": {"_auto_seo_schema_json": schema_json}
                    })
                    if schema_resp.status_code not in (200, 201):
                        get_resp = await wp_api_request(site, "GET", ep)
                        if get_resp.status_code == 200:
                            import re as _re
                            content_obj = get_resp.json().get("content") or {}
                            existing = (
                                content_obj.get("raw") or content_obj.get("rendered") or ""
                                if isinstance(content_obj, dict) else str(content_obj)
                            )
                            existing = _re.sub(
                                r'\n?<script type="application/ld\+json">\n[\s\S]*?\n</script>',
                                '', existing
                            )
                            await _wp_post_fallback(site, ep, {
                                "content": existing + f'\n<script type="application/ld+json">\n{schema_json}\n</script>'
                            })

            await db.seo_suggestions.update_one(
                {"site_id": site_id, "wp_id": wp_id},
                {"$set": {"status": "applied"}}
            )
            applied += 1
        except Exception as e:
            failed += 1
            errors.append({"wp_id": wp_id, "error": str(e)})

    await log_activity(site_id, "auto_seo_bulk_applied",
                       f"Bulk SEO apply ({data.apply_type}): {applied} applied, {failed} failed")
    return {"applied": applied, "failed": failed, "errors": errors}
