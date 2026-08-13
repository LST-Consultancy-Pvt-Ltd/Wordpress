"""Admin Migration (one-time encryption migration) plus a grab-bag of smaller
"Feature N" tools that were bundled under the same server.py section: Writing
Style Profiles, AI Content Brief Generator, WordPress Plugin Health Audit, AI
Image Alt Text Bulk Generator (Claude vision), SEO Keyword Rank Tracker (GSC-
backed snapshots), and Readability Score & AI Suggestions.
"""
import asyncio
import base64
import json
import logging
import os
from datetime import datetime, timezone
from typing import Dict, List, Optional

import anthropic
import httpx
from bs4 import BeautifulSoup
from fastapi import BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel

from core.activity import log_activity
from core.ai import get_ai_response
from core.content_analysis import compute_readability
from core.crypto import (
    _SENSITIVE_SETTINGS_FIELDS, _fernet, decrypt_field, encrypt_field,
    get_decrypted_settings,
)
from core.db import db
from core.prompts import HUMANIZE_DIRECTIVE
from core.router import api_router
from core.security import require_admin, require_editor, require_user
from core.seo_impact import estimate_seo_impact
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from models.legacy import (
    BriefRequest, ContentBrief, PluginAuditResult, PostGenerate, RankTrackRequest,
    WritingStyle,
)
from providers.google_analytics import fetch_gsc_metrics
from providers.wordpress import get_wp_credentials, wp_api_request

logger = logging.getLogger(__name__)

# ========================
# Routes: Admin Migration
# ========================

@api_router.post("/admin/migrate-encrypt")
async def migrate_encrypt(_: dict = Depends(require_admin)):
    """One-time migration: encrypt unencrypted sensitive fields in existing sites and settings.
    Run once after deploying encryption support. Safe to call repeatedly (idempotent)."""
    migrated_sites = 0
    migrated_settings = False

    # Migrate sites: encrypt app_password if not already encrypted
    async for site in db.sites.find({}, {"_id": 0}):
        raw_pw = site.get("app_password", "")
        if raw_pw:
            try:
                # Attempt to decrypt — if it succeeds, already encrypted
                decrypt_field(raw_pw)
                # If decrypt returns the same value, it was plaintext (decrypt is a no-op for plaintext)
                # We check: if _fernet is set and the value doesn't look like Fernet token (base64 ~100+ chars)
                if _fernet and len(raw_pw) < 80:
                    encrypted = encrypt_field(raw_pw)
                    await db.sites.update_one({"id": site["id"]}, {"$set": {"app_password": encrypted}})
                    migrated_sites += 1
            except Exception:
                pass

    # Migrate settings: encrypt api keys if not already encrypted
    settings = await db.settings.find_one({"id": "global_settings"}, {"_id": 0})
    if settings and _fernet:
        updates = {}
        for key in _SENSITIVE_SETTINGS_FIELDS:
            val = settings.get(key, "")
            if val and len(val) < 200:  # Fernet tokens are ~100+ chars
                updates[key] = encrypt_field(val)
        if updates:
            await db.settings.update_one({"id": "global_settings"}, {"$set": updates})
            migrated_settings = True

    return {
        "sites_migrated": migrated_sites,
        "settings_migrated": migrated_settings,
        "message": "Migration complete. Remove this endpoint after use."
    }


# ─────────────────────────────────────────────────────────────────
# Feature 1: Writing Style Profiles
# ─────────────────────────────────────────────────────────────────

@api_router.get("/writing-styles")
async def list_writing_styles(_: dict = Depends(require_user)):
    docs = await db.writing_styles.find({}, {"_id": 0}).sort("created_at", 1).to_list(200)
    return docs


@api_router.post("/writing-styles")
async def create_writing_style(data: WritingStyle, _: dict = Depends(require_editor)):
    await db.writing_styles.insert_one(data.model_dump())
    return data.model_dump()


@api_router.put("/writing-styles/{style_id}")
async def update_writing_style(style_id: str, data: dict, _: dict = Depends(require_editor)):
    allowed = {"name", "tone", "instructions", "example_opening"}
    update = {k: v for k, v in data.items() if k in allowed}
    if not update:
        raise HTTPException(status_code=400, detail="No valid fields to update")
    result = await db.writing_styles.update_one({"id": style_id}, {"$set": update})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Writing style not found")
    return {"updated": True}


@api_router.delete("/writing-styles/{style_id}")
async def delete_writing_style(style_id: str, _: dict = Depends(require_admin)):
    result = await db.writing_styles.delete_one({"id": style_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Writing style not found")
    return {"deleted": True}


# ─────────────────────────────────────────────────────────────────
# Feature 2: AI Content Brief Generator
# ─────────────────────────────────────────────────────────────────

@api_router.post("/brief/{site_id}/generate")
async def generate_content_brief(site_id: str, data: BriefRequest, _: dict = Depends(require_editor)):
    await get_wp_credentials(site_id)  # validates site exists & accessible
    prompt = f"""Create a detailed SEO content brief for:
Topic: {data.topic}
Primary Keyword: {data.target_keyword}

Return JSON with this structure:
{{
    "target_audience": "brief audience description",
    "recommended_word_count": 1500,
    "tone_recommendation": "professional/casual/etc",
    "competitor_angle": "what unique angle to take vs competitors",
    "cta_suggestion": "recommended call-to-action",
    "lsi_keywords": ["keyword1","keyword2","keyword3","keyword4","keyword5"],
    "outline": [
        {{"heading": "H1 Title","level": 1}},
        {{"heading": "H2 Section","level": 2}},
        {{"heading": "H3 Subsection","level": 3}}
    ]
}}"""
    try:
        raw = await get_ai_response(
            [
                {"role": "system", "content": "You are an expert SEO strategist. Always respond with valid JSON."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.5,
            max_tokens=1200,
        )
        if "```json" in raw:
            raw = raw.split("```json")[1].split("```")[0]
        elif "```" in raw:
            raw = raw.split("```")[1].split("```")[0]
        ai_data = json.loads(raw.strip())
    except Exception:
        ai_data = {}

    brief = ContentBrief(
        site_id=site_id,
        topic=data.topic,
        target_keyword=data.target_keyword,
        target_audience=ai_data.get("target_audience", ""),
        recommended_word_count=ai_data.get("recommended_word_count", 1200),
        outline=ai_data.get("outline", []),
        lsi_keywords=ai_data.get("lsi_keywords", []),
        competitor_angle=ai_data.get("competitor_angle", ""),
        cta_suggestion=ai_data.get("cta_suggestion", ""),
        tone_recommendation=ai_data.get("tone_recommendation", ""),
    )
    await db.content_briefs.insert_one(brief.model_dump())
    return brief.model_dump()


@api_router.get("/brief/{site_id}")
async def get_content_briefs(site_id: str, _: dict = Depends(require_user)):
    docs = await db.content_briefs.find({"site_id": site_id}, {"_id": 0}).sort("created_at", -1).to_list(100)
    return docs


@api_router.post("/brief/{site_id}/{brief_id}/generate-post")
async def generate_post_from_brief_endpoint(site_id: str, brief_id: str, _: dict = Depends(require_editor)):
    brief = await db.content_briefs.find_one({"id": brief_id, "site_id": site_id}, {"_id": 0})
    if not brief:
        raise HTTPException(status_code=404, detail="Brief not found")
    outline_text = "\n".join(
        f"{'#' * h.get('level', 2)} {h.get('heading', '')}" for h in brief.get("outline", [])
    )
    keywords_str = ", ".join(brief.get("lsi_keywords", []))
    post_data = PostGenerate(
        site_id=site_id,
        topic=brief["topic"],
        keywords=[brief["target_keyword"]] + brief.get("lsi_keywords", [])[:4],
    )
    # Augment prompt via system — inject outline into the user call directly
    keyword_str = ", ".join(post_data.keywords)
    prompt = f"""Write a comprehensive, SEO-optimized blog post about: {brief['topic']}
Primary keyword: {brief['target_keyword']}
LSI keywords: {keywords_str}
Tone: {brief.get('tone_recommendation', 'professional')}
Target audience: {brief.get('target_audience', 'general')}
CTA: {brief.get('cta_suggestion', '')}

Use this outline:
{outline_text}

Format as JSON:
{{
    "title": "Blog post title",
    "content": "Full HTML content with proper headings",
    "meta_description": "SEO meta description",
    "suggested_categories": ["cat1"],
    "suggested_tags": ["tag1","tag2"]
}}"""
    try:
        raw = await get_ai_response(
            [
                {"role": "system", "content": f"You are an expert SEO content writer. Always respond with valid JSON.\n\n{HUMANIZE_DIRECTIVE}"},
                {"role": "user", "content": prompt},
            ],
            temperature=0.7,
            max_tokens=3000,
        )
        if "```json" in raw:
            raw = raw.split("```json")[1].split("```")[0]
        elif "```" in raw:
            raw = raw.split("```")[1].split("```")[0]
        blog_data = json.loads(raw.strip())
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    await log_activity(site_id, "blog_generated", f"Post from brief: {brief['topic']}")
    return blog_data


# ─────────────────────────────────────────────────────────────────
# Feature 3: WordPress Plugin Health Audit
# ─────────────────────────────────────────────────────────────────

@api_router.post("/plugins/{site_id}/audit")
async def audit_site_plugins(site_id: str, _: dict = Depends(require_user)):
    site = await get_wp_credentials(site_id)
    try:
        resp = await wp_api_request(site, "GET", "plugins?per_page=100&context=edit")
        if resp.status_code == 200:
            plugins = resp.json()
        elif resp.status_code == 403:
            raise HTTPException(status_code=403, detail="WP user needs 'activate_plugins' capability to list plugins")
        else:
            plugins = []
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Build plugin summaries for AI
    plugin_summaries = []
    for p in plugins:
        plugin_summaries.append({
            "name": p.get("name", ""),
            "slug": p.get("plugin", ""),
            "status": p.get("status", "inactive"),
            "version": p.get("version", ""),
            "author": p.get("author_uri", "") or p.get("author", ""),
            "requires_wp": p.get("requires_wp", ""),
            "requires_php": p.get("requires_php", ""),
            "update_available": bool(p.get("update", {}) and p["update"] != "none"),
        })

    issues = []
    # Rule 1: Inactive plugins
    for p in plugin_summaries:
        if p["status"] == "inactive":
            issues.append({
                "plugin": p["name"],
                "severity": "low",
                "issue": "Plugin is installed but inactive — consider removing if unused.",
            })
    # Rule 2: Updates available
    for p in plugin_summaries:
        if p["update_available"]:
            issues.append({
                "plugin": p["name"],
                "severity": "high",
                "issue": "Update available — keeping plugins up-to-date is critical for security.",
            })

    # AI security/incompatibility analysis
    try:
        ai_prompt = f"""Analyze these WordPress plugins and identify any:
1. Known security concerns or vulnerabilities (based on plugin name/type)
2. Potential conflicts between plugins
3. Performance-heavy plugins that might slow the site
4. Duplicate functionality (two plugins doing the same thing)

Plugins: {json.dumps([{"name": p["name"], "slug": p["slug"], "status": p["status"]} for p in plugin_summaries], indent=2)}

Return a JSON array of issues. Each issue: {{"plugin": "Plugin Name", "severity": "high|medium|low", "issue": "description"}}
Return ONLY the JSON array, no markdown."""
        raw = await get_ai_response(
            [{"role": "system", "content": "You are a WordPress security expert. Respond with a JSON array only."},
             {"role": "user", "content": ai_prompt}],
            temperature=0.3,
            max_tokens=1500,
        )
        if "```json" in raw:
            raw = raw.split("```json")[1].split("```")[0]
        elif "```" in raw:
            raw = raw.split("```")[1].split("```")[0]
        ai_issues = json.loads(raw.strip())
        if isinstance(ai_issues, list):
            issues.extend(ai_issues)
    except Exception:
        pass

    high = sum(1 for i in issues if i.get("severity") == "high")
    medium = sum(1 for i in issues if i.get("severity") == "medium")

    audit = PluginAuditResult(
        site_id=site_id,
        plugins=plugin_summaries,
        issues=issues,
        total_plugins=len(plugins),
        high_issues=high,
        medium_issues=medium,
    )
    await db.plugin_audits.replace_one({"site_id": site_id}, audit.model_dump(), upsert=True)
    await log_activity(site_id, "plugin_audit", f"Plugin audit: {len(plugins)} plugins, {high} high issues")
    return audit.model_dump()


@api_router.get("/plugins/{site_id}")
async def get_plugin_audit(site_id: str, _: dict = Depends(require_user)):
    doc = await db.plugin_audits.find_one({"site_id": site_id}, {"_id": 0})
    if not doc:
        return {"site_id": site_id, "plugins": [], "scanned_at": None, "summary": None}
    return doc


# ─────────────────────────────────────────────────────────────────
# Feature 4: AI Image Alt Text Bulk Generator
# ─────────────────────────────────────────────────────────────────

@api_router.get("/images/{site_id}/audit")
async def get_image_audit(site_id: str, _: dict = Depends(require_user)):
    doc = await db.image_audits.find_one({"site_id": site_id}, {"_id": 0}, sort=[("scanned_at", -1)])
    if not doc:
        return {"site_id": site_id, "images": [], "scanned_at": None, "summary": None}
    return doc


@api_router.post("/images/{site_id}/audit")
async def audit_site_images(site_id: str, _: dict = Depends(require_user)):
    site = await get_wp_credentials(site_id)
    images = []
    page = 1
    while len(images) < 500:
        resp = await wp_api_request(site, "GET", f"media?media_type=image&per_page=100&page={page}")
        if resp.status_code != 200:
            break
        batch = resp.json()
        if not batch:
            break
        images.extend(batch)
        if len(batch) < 100:
            break
        page += 1

    result = []
    for img in images:
        result.append({
            "id": img.get("id"),
            "url": img.get("source_url", ""),
            "title": img.get("title", {}).get("rendered", "") if isinstance(img.get("title"), dict) else str(img.get("title", "")),
            "alt_text": img.get("alt_text", ""),
            "missing_alt": not img.get("alt_text", "").strip(),
            "filename": img.get("media_details", {}).get("file", ""),
        })

    missing_count = sum(1 for i in result if i["missing_alt"])
    scanned_at = datetime.now(timezone.utc).isoformat()
    audit_doc = {
        "site_id": site_id,
        "total_images": len(result),
        "missing_alt": missing_count,
        "images": result,
        "scanned_at": scanned_at,
    }
    await db.image_audits.replace_one({"site_id": site_id}, audit_doc, upsert=True)
    return audit_doc


@api_router.post("/images/{site_id}/generate-alt/{media_id}")
async def generate_alt_text_for_image(site_id: str, media_id: int, _: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id)
    resp = await wp_api_request(site, "GET", f"media/{media_id}")
    if resp.status_code != 200:
        raise HTTPException(status_code=404, detail="Media not found")
    media = resp.json()
    image_url = media.get("source_url", "")
    title = media.get("title", {}).get("rendered", "") if isinstance(media.get("title"), dict) else str(media.get("title", ""))
    filename = media.get("media_details", {}).get("file", image_url.split("/")[-1])

    # Fetch image bytes for Claude vision
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            img_resp = await client.get(image_url)
            img_resp.raise_for_status()
            img_b64 = base64.b64encode(img_resp.content).decode()
            content_type = img_resp.headers.get("content-type", "image/jpeg").split(";")[0]
    except Exception:
        img_b64 = None
        content_type = "image/jpeg"

    if img_b64:
        try:
            _anthropic = anthropic.AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
            msg = await _anthropic.messages.create(
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
            alt_text = msg.content[0].text.strip().strip('"')
        except Exception:
            alt_text = f"Image: {title or filename}"
    else:
        alt_text = f"Image: {title or filename}"

    # Update WordPress media alt text
    update_resp = await wp_api_request(site, "POST", f"media/{media_id}", {"alt_text": alt_text})
    if update_resp.status_code in (401, 403):
        # Host strips Auth header — retry with explicit Basic auth header built outside f-string
        try:
            wp_url = f"{site['url'].rstrip('/')}/wp-json/wp/v2/media/{media_id}"
            app_password = site["app_password"].replace(" ", "")
            raw_creds = site["username"] + ":" + app_password
            b64_creds = base64.b64encode(raw_creds.encode()).decode()
            async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as hc:
                fallback = await hc.post(
                    wp_url,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": "Basic " + b64_creds,
                    },
                    json={"alt_text": alt_text},
                )
                if fallback.status_code in (200, 201):
                    update_resp = fallback
        except Exception as fb_err:
            logger.warning(f"Alt text fallback failed: {fb_err}")

    if update_resp.status_code not in (200, 201):
        try:
            wp_detail = update_resp.json().get("message") or update_resp.json().get("code") or update_resp.text[:200]
        except Exception:
            wp_detail = update_resp.text[:200]
        raise HTTPException(
            status_code=500,
            detail=f"WordPress rejected alt text update (HTTP {update_resp.status_code}): {wp_detail}"
        )

    await log_activity(site_id, "alt_text_generated", f"Alt text set for media {media_id}")
    return {"media_id": media_id, "alt_text": alt_text, "impact_estimate": estimate_seo_impact("alt_text")}


async def _bulk_alt_text_task(task_id: str, site_id: str, site: dict):
    """Background task: generate alt text for all images missing it."""
    try:
        images = []
        page = 1
        while len(images) < 500:
            resp = await wp_api_request(site, "GET", f"media?media_type=image&per_page=100&page={page}")
            if resp.status_code != 200:
                break
            batch = resp.json()
            if not batch:
                break
            images.extend([img for img in batch if not img.get("alt_text", "").strip()])
            if len(batch) < 100:
                break
            page += 1

        total = len(images)
        push_event(task_id, {"type": "start", "total": total})

        _anthropic = anthropic.AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
        done = 0
        for img in images:
            media_id = img.get("id")
            image_url = img.get("source_url", "")
            title = img.get("title", {}).get("rendered", "") if isinstance(img.get("title"), dict) else str(img.get("title", ""))
            try:
                async with httpx.AsyncClient(timeout=15) as client:
                    img_resp = await client.get(image_url)
                    img_b64 = base64.b64encode(img_resp.content).decode()
                    content_type = img_resp.headers.get("content-type", "image/jpeg").split(";")[0]
                msg = await _anthropic.messages.create(
                    model="claude-opus-4-5",
                    max_tokens=200,
                    messages=[{
                        "role": "user",
                        "content": [
                            {"type": "image", "source": {"type": "base64", "media_type": content_type, "data": img_b64}},
                            {"type": "text", "text": "Write a concise, descriptive SEO alt text for this image in under 125 characters. Return only the alt text, no quotes."},
                        ],
                    }],
                )
                alt_text = msg.content[0].text.strip().strip('"')
                await wp_api_request(site, "POST", f"media/{media_id}", {"alt_text": alt_text})
                done += 1
                push_event(task_id, {"type": "progress", "done": done, "total": total, "media_id": media_id, "alt_text": alt_text})
            except Exception as e:
                push_event(task_id, {"type": "error", "media_id": media_id, "error": str(e)})
            await asyncio.sleep(0.5)  # rate-limit

        await log_activity(site_id, "bulk_alt_text", f"Generated alt text for {done}/{total} images")
        finish_task(task_id, {"done": done, "total": total})
    except Exception as e:
        finish_task(task_id, {"error": str(e)})


@api_router.post("/images/{site_id}/generate-all-alts")
async def generate_all_alt_texts(site_id: str, background_tasks: BackgroundTasks, _: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id)
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_bulk_alt_text_task, task_id, site_id, site)
    return {"task_id": task_id}


# ─────────────────────────────────────────────────────────────────
# Feature 5: SEO Keyword Rank Tracker
# ─────────────────────────────────────────────────────────────────

@api_router.post("/rank-tracker/{site_id}/track")
async def save_tracked_keywords(site_id: str, data: RankTrackRequest, _: dict = Depends(require_user)):
    await get_wp_credentials(site_id)
    await db.tracked_keywords.replace_one(
        {"site_id": site_id},
        {"site_id": site_id, "keywords": data.keywords, "updated_at": datetime.now(timezone.utc).isoformat()},
        upsert=True,
    )
    return {"saved": True, "keywords": data.keywords}


@api_router.get("/rank-tracker/{site_id}/tracked")
async def get_tracked_keywords_for_site(site_id: str, _: dict = Depends(require_user)):
    doc = await db.tracked_keywords.find_one({"site_id": site_id}, {"_id": 0})
    return doc or {"site_id": site_id, "keywords": []}


@api_router.get("/rank-tracker/{site_id}")
async def get_rank_tracker_data(
    site_id: str,
    keywords: Optional[str] = Query(None, description="Comma-separated keywords"),
    _: dict = Depends(require_user),
):
    await get_wp_credentials(site_id)
    keyword_list: List[str] = []
    if keywords:
        keyword_list = [k.strip() for k in keywords.split(",") if k.strip()]
    if not keyword_list:
        tracked = await db.tracked_keywords.find_one({"site_id": site_id}, {"_id": 0})
        keyword_list = tracked.get("keywords", []) if tracked else []
    if not keyword_list:
        return {"site_id": site_id, "series": [], "message": "No keywords tracked yet"}

    # Fetch current GSC data and store a snapshot
    try:
        settings = await get_decrypted_settings()
        site_doc = await db.sites.find_one({"id": site_id}, {"_id": 0})
        site_url = settings.get("gsc_site_url") or (site_doc.get("url", "") if site_doc else "")
        gsc_rows = await fetch_gsc_metrics(settings, site_url)
    except Exception as e:
        gsc_rows = []

    today = datetime.now(timezone.utc).date().isoformat()
    snapshot: Dict[str, dict] = {}
    for row in gsc_rows:
        kw = row.get("keyword", "").lower()
        for tracked_kw in keyword_list:
            if tracked_kw.lower() in kw:
                if tracked_kw not in snapshot:
                    snapshot[tracked_kw] = {"impressions": 0, "clicks": 0, "positions": []}
                snapshot[tracked_kw]["impressions"] += row.get("impressions", 0)
                snapshot[tracked_kw]["clicks"] += row.get("clicks", 0)
                snapshot[tracked_kw]["positions"].append(row.get("ranking", 0))

    if snapshot:
        snap_doc = {
            "site_id": site_id,
            "date": today,
            "data": {
                kw: {
                    "impressions": v["impressions"],
                    "clicks": v["clicks"],
                    "avg_position": round(sum(v["positions"]) / len(v["positions"]), 1) if v["positions"] else None,
                }
                for kw, v in snapshot.items()
            },
        }
        await db.rank_snapshots.replace_one(
            {"site_id": site_id, "date": today},
            snap_doc,
            upsert=True,
        )

    # Load all historical snapshots and build series
    all_snaps = await db.rank_snapshots.find({"site_id": site_id}, {"_id": 0}).sort("date", 1).to_list(200)

    series_map: Dict[str, list] = {kw: [] for kw in keyword_list}
    for snap in all_snaps:
        for kw in keyword_list:
            kw_data = snap.get("data", {}).get(kw)
            if kw_data:
                series_map[kw].append({"date": snap["date"], **kw_data})

    series = [{"keyword": kw, "data": pts} for kw, pts in series_map.items()]
    return {"site_id": site_id, "series": series}


# ─────────────────────────────────────────────────────────────────
# Feature 7: Readability Score & AI Suggestions
# ─────────────────────────────────────────────────────────────────

@api_router.post("/readability/{site_id}/{wp_id}")
async def analyze_readability(
    site_id: str,
    wp_id: int,
    content_type: str = Query("post", regex="^(post|page)$"),
    _: dict = Depends(require_user),
):
    site = await get_wp_credentials(site_id)
    endpoint = f"posts/{wp_id}" if content_type == "post" else f"pages/{wp_id}"
    resp = await wp_api_request(site, "GET", endpoint)
    if resp.status_code != 200:
        raise HTTPException(status_code=404, detail=f"{content_type.capitalize()} not found")
    item = resp.json()
    raw_content = item.get("content", {}).get("rendered", "") if isinstance(item.get("content"), dict) else str(item.get("content", ""))

    metrics = await asyncio.to_thread(compute_readability, raw_content)
    if "error" in metrics:
        raise HTTPException(status_code=400, detail=metrics["error"])

    ease = metrics["flesch_reading_ease"]
    if ease >= 90:
        grade = "Very Easy"
    elif ease >= 70:
        grade = "Easy"
    elif ease >= 50:
        grade = "Standard"
    elif ease >= 30:
        grade = "Difficult"
    else:
        grade = "Very Difficult"

    # AI suggestions
    suggestions = []
    try:
        soup = BeautifulSoup(raw_content, "html.parser")
        excerpt = soup.get_text(separator=" ")[:2000]
        ai_prompt = f"""A WordPress {content_type} has these readability scores:
- Flesch Reading Ease: {metrics['flesch_reading_ease']} ({grade})
- Flesch-Kincaid Grade: {metrics['flesch_kincaid_grade']}
- Gunning Fog: {metrics['gunning_fog']}
- Avg sentence length: {metrics['avg_sentence_length']} words
- Word count: {metrics['word_count']}

Content excerpt (first 2000 chars):
{excerpt}

Give 3-5 specific, actionable suggestions to improve readability.
Return a JSON array of strings. Each string is one suggestion. Return ONLY the JSON array."""
        raw = await get_ai_response(
            [{"role": "system", "content": "You are a writing coach. Respond with a JSON array of suggestion strings only."},
             {"role": "user", "content": ai_prompt}],
            temperature=0.4,
            max_tokens=600,
        )
        if "```json" in raw:
            raw = raw.split("```json")[1].split("```")[0]
        elif "```" in raw:
            raw = raw.split("```")[1].split("```")[0]
        suggestions = json.loads(raw.strip())
        if not isinstance(suggestions, list):
            suggestions = []
    except Exception:
        pass

    result = {
        "site_id": site_id,
        "wp_id": wp_id,
        "content_type": content_type,
        "grade_label": grade,
        "suggestions": suggestions,
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        **metrics,
    }
    await db.readability_scores.replace_one(
        {"site_id": site_id, "wp_id": wp_id, "content_type": content_type},
        result,
        upsert=True,
    )
    return result
