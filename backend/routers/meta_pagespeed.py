"""Bulk Meta + Taxonomy (AI-fill blank meta title/description, native + Yoast
fields, bulk category/tag assignment as background tasks) and PageSpeed
Insights (Google PSI + AI recommendations, stored results).
"""
import asyncio
import json
import logging
import os
from typing import List

import httpx
from bs4 import BeautifulSoup
from fastapi import BackgroundTasks, Depends, HTTPException

from core.activity import log_activity
from core.ai import get_ai_response
from core.crypto import get_decrypted_settings
from core.db import db
from core.router import api_router
from core.security import require_editor, require_user
from core.seo_impact import estimate_seo_impact
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from models.legacy import (
    BulkMetaUpdate, BulkTaxonomyUpdate, PageSpeedAIRecommendation,
    PageSpeedAnalyzeRequest, PageSpeedDiagnostic, PageSpeedOpportunity,
    PageSpeedResult,
)
from providers.wordpress import get_wp_credentials, wp_api_request

logger = logging.getLogger(__name__)

# ========================
# Routes: Bulk Meta + Taxonomy
# ========================

@api_router.post("/bulk/meta-update")
async def bulk_meta_update(data: BulkMetaUpdate, background_tasks: BackgroundTasks,
                           _: dict = Depends(require_editor)):
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_bulk_meta_update, task_id, data)
    return {
        "task_id": task_id,
        "message": f"Bulk meta update started for {len(data.item_ids)} items",
        "impact_estimate": estimate_seo_impact("meta_title"),
    }


async def _bulk_meta_update(task_id: str, data: BulkMetaUpdate):
    try:
        site = await get_wp_credentials(data.site_id)
        endpoint_base = "pages" if data.content_type == "page" else "posts"
        total = len(data.item_ids)
        updated_count = 0

        for idx, item_id in enumerate(data.item_ids):
            await push_event(task_id, "status", {
                "message": f"Updating {data.content_type} #{item_id} ({idx+1}/{total})…",
                "step": idx, "total": total,
            })
            meta_title = data.meta_title
            meta_description = data.meta_description

            # AI-generate if fields are blank
            if not meta_title or not meta_description:
                try:
                    cached = await db.posts.find_one({"site_id": data.site_id, "wp_id": item_id}, {"_id": 0})
                    content_snippet = ""
                    title_hint = ""
                    if cached:
                        title_hint = cached.get("title", "")
                        raw_html = cached.get("content", "")
                        content_snippet = BeautifulSoup(raw_html, "html.parser").get_text()[:800]

                    ai_raw = await get_ai_response([{
                        "role": "user",
                        "content": (
                            f"Generate an SEO meta title (max 60 chars) and meta description (max 160 chars) "
                            f"for a {data.content_type} titled: \"{title_hint}\".\n"
                            f"Content excerpt: {content_snippet}\n"
                            f"Respond as JSON: {{\"meta_title\": \"...\", \"meta_description\": \"...\"}}"
                        ),
                    }], max_tokens=200, temperature=0.4)
                    if "```json" in ai_raw:
                        ai_raw = ai_raw.split("```json")[1].split("```")[0]
                    elif "```" in ai_raw:
                        ai_raw = ai_raw.split("```")[1].split("```")[0]
                    ai_meta = json.loads(ai_raw.strip())
                    meta_title = meta_title or ai_meta.get("meta_title", "")
                    meta_description = meta_description or ai_meta.get("meta_description", "")
                except Exception as ai_err:
                    logger.warning(f"AI meta generation failed for {item_id}: {ai_err}")

            # --- Step 1: Update native WP fields (title + excerpt) via POST to post ID ---
            # This always works for any editor-level Application Password.
            native_payload: dict = {}
            if meta_title:
                native_payload["title"] = meta_title
            if meta_description:
                native_payload["excerpt"] = meta_description

            if native_payload:
                try:
                    resp = await wp_api_request(site, "POST", f"{endpoint_base}/{item_id}", native_payload)
                    if resp.status_code in [200, 201]:
                        updated_count += 1
                    else:
                        try:
                            wp_err = resp.json()
                            wp_detail = wp_err.get("message") or wp_err.get("code") or resp.text[:200]
                        except Exception:
                            wp_detail = resp.text[:200]
                        logger.warning(f"WP {resp.status_code} on POST {endpoint_base}/{item_id}: {wp_detail}")
                        await push_event(task_id, "warning", {
                            "message": f"WP returned {resp.status_code} for #{item_id}: {wp_detail}"
                        })
                except Exception as exc:
                    await push_event(task_id, "warning", {"message": f"Failed #{item_id}: {exc}"})

            # --- Step 2: Attempt Yoast SEO meta fields (best-effort, silent if plugin absent) ---
            yoast_meta: dict = {}
            if meta_title:
                yoast_meta["_yoast_wpseo_title"] = meta_title
            if meta_description:
                yoast_meta["_yoast_wpseo_metadesc"] = meta_description
            if yoast_meta:
                try:
                    await wp_api_request(site, "POST", f"{endpoint_base}/{item_id}", {"meta": yoast_meta})
                except Exception:
                    pass  # Yoast not installed or meta not registered — not a fatal error

        await push_event(task_id, "status", {"message": f"Done — updated {updated_count}/{total} items", "step": total, "total": total})
        await finish_task(task_id)
    except Exception as e:
        await push_event(task_id, "error", {"message": str(e)})
        await finish_task(task_id)


@api_router.get("/taxonomies/{site_id}")
async def get_taxonomies(site_id: str):
    site = await get_wp_credentials(site_id)
    result: dict = {"categories": [], "tags": []}
    try:
        cats_resp = await wp_api_request(site, "GET", "categories?per_page=100")
        if cats_resp.status_code == 200:
            result["categories"] = [{"id": c["id"], "name": c["name"]} for c in cats_resp.json()]
    except Exception:
        pass
    try:
        tags_resp = await wp_api_request(site, "GET", "tags?per_page=100")
        if tags_resp.status_code == 200:
            result["tags"] = [{"id": t["id"], "name": t["name"]} for t in tags_resp.json()]
    except Exception:
        pass
    return result


@api_router.post("/bulk/taxonomy-update")
async def bulk_taxonomy_update(data: BulkTaxonomyUpdate, background_tasks: BackgroundTasks,
                               _: dict = Depends(require_editor)):
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_bulk_taxonomy_update, task_id, data)
    return {"task_id": task_id, "message": f"Bulk taxonomy update started for {len(data.item_ids)} items"}


async def _bulk_taxonomy_update(task_id: str, data: BulkTaxonomyUpdate):
    try:
        site = await get_wp_credentials(data.site_id)
        total = len(data.item_ids)

        # Ensure string tags exist in WordPress, collect their IDs
        tag_ids: List[int] = []
        if data.tags:
            for tag_name in data.tags:
                try:
                    resp = await wp_api_request(site, "GET", f"tags?search={tag_name}&per_page=5")
                    existing = [t for t in (resp.json() if resp.status_code == 200 else []) if t["name"].lower() == tag_name.lower()]
                    if existing:
                        tag_ids.append(existing[0]["id"])
                    else:
                        create_resp = await wp_api_request(site, "POST", "tags", {"name": tag_name})
                        if create_resp.status_code in [200, 201]:
                            tag_ids.append(create_resp.json()["id"])
                except Exception:
                    pass

        for idx, item_id in enumerate(data.item_ids):
            await push_event(task_id, "status", {
                "message": f"Updating post #{item_id} ({idx+1}/{total})…",
                "step": idx, "total": total,
            })
            wp_payload: dict = {}
            if data.categories is not None:
                wp_payload["categories"] = data.categories
            if tag_ids:
                wp_payload["tags"] = tag_ids
            if wp_payload:
                try:
                    resp = await wp_api_request(site, "PUT", f"posts/{item_id}", wp_payload)
                    if resp.status_code not in [200, 201]:
                        await push_event(task_id, "warning", {"message": f"WP returned {resp.status_code} for #{item_id}"})
                except Exception as exc:
                    await push_event(task_id, "warning", {"message": f"Failed #{item_id}: {exc}"})

        await push_event(task_id, "status", {"message": f"Done — updated {total} posts", "step": total, "total": total})
        await finish_task(task_id)
    except Exception as e:
        await push_event(task_id, "error", {"message": str(e)})
        await finish_task(task_id)


# ========================
# Routes: PageSpeed Insights
# ========================

@api_router.post("/pagespeed/{site_id}/analyze")
async def analyze_pagespeed(
    site_id: str,
    body: PageSpeedAnalyzeRequest,
    _: dict = Depends(require_editor),
):
    """Call Google PageSpeed Insights API, parse CWVs + opportunities, generate AI recommendations."""
    if not body.url or not body.url.startswith("http"):
        raise HTTPException(status_code=400, detail="A valid URL starting with http(s) is required")

    settings = await get_decrypted_settings()
    api_key = settings.get("pagespeed_api_key") or os.environ.get("PAGESPEED_API_KEY", "")

    # ── Fetch PageSpeed data ──
    psi_url = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
    params: dict = {"url": body.url, "strategy": "mobile"}
    if api_key:
        params["key"] = api_key

    psi_data = None
    psi_error = None
    try:
        async with httpx.AsyncClient(timeout=60.0) as hc:
            resp = await hc.get(psi_url, params=params)

        if resp.status_code == 429:
            # Rate limited — retry once after 3 seconds
            await asyncio.sleep(3)
            async with httpx.AsyncClient(timeout=60.0) as hc:
                resp = await hc.get(psi_url, params=params)

        if resp.status_code == 429:
            # Still rate limited — fall back to AI-only analysis
            psi_error = (
                "Google PageSpeed API rate limit reached. "
                "Add a free PageSpeed API key in Settings → API Configuration to avoid this. "
                "AI recommendations will still be generated based on the URL."
            )
        elif resp.status_code != 200:
            psi_error = f"PageSpeed API returned {resp.status_code}. AI analysis will still run."
        else:
            psi_data = resp.json()
    except httpx.HTTPError as e:
        psi_error = f"Could not reach PageSpeed API: {e}. AI analysis will still run."

    # ── Parse lighthouse results ──
    lhr = (psi_data or {}).get("lighthouseResult", {})
    categories = lhr.get("categories", {})
    audits = lhr.get("audits", {})

    performance_score = round((categories.get("performance", {}).get("score") or 0) * 100, 1)

    def _ms(audit_id: str) -> float:
        a = audits.get(audit_id, {})
        return round(a.get("numericValue", 0.0), 1)

    fcp = _ms("first-contentful-paint")
    lcp = _ms("largest-contentful-paint")
    tbt = _ms("total-blocking-time")
    cls = round(audits.get("cumulative-layout-shift", {}).get("numericValue", 0.0), 3)

    # Top-5 opportunities (auditRefs with mode=='opportunity' or positive overallSavingsMs)
    opportunities: list[PageSpeedOpportunity] = []
    opp_refs = lhr.get("categories", {}).get("performance", {}).get("auditRefs", [])
    for ref in opp_refs:
        if len(opportunities) >= 5:
            break
        audit = audits.get(ref.get("id", ""), {})
        details = audit.get("details", {})
        overallSavingsMs = details.get("overallSavingsMs", 0)
        if details.get("type") == "opportunity" and overallSavingsMs > 0:
            opportunities.append(PageSpeedOpportunity(
                title=audit.get("title", ""),
                description=audit.get("description", ""),
                savings_ms=round(overallSavingsMs, 0),
            ))

    # Top-3 diagnostics (failed audits not already in opportunities)
    diagnostics: list[PageSpeedDiagnostic] = []
    opp_ids = {o.title for o in opportunities}
    for ref in opp_refs:
        if len(diagnostics) >= 3:
            break
        audit = audits.get(ref.get("id", ""), {})
        if audit.get("score") is not None and (audit.get("score") or 1) < 1:
            title = audit.get("title", "")
            if title not in opp_ids:
                diagnostics.append(PageSpeedDiagnostic(
                    title=title,
                    description=audit.get("description", ""),
                ))

    # ── AI recommendations ──
    opp_summary = "\n".join([f"- {o.title}: {o.savings_ms:.0f}ms savings" for o in opportunities]) or "None identified"
    diag_summary = "\n".join([f"- {d.title}" for d in diagnostics]) or "None"

    if psi_data:
        metrics_context = f"""Performance score: {performance_score}/100
FCP: {fcp}ms | LCP: {lcp}ms | TBT: {tbt}ms | CLS: {cls}

Top opportunities:
{opp_summary}

Diagnostics:
{diag_summary}"""
    else:
        metrics_context = f"""Live metrics not available (PageSpeed API rate-limited).
Provide general WordPress performance best practice recommendations for: {body.url}"""

    ai_prompt = f"""Given these PageSpeed Insights metrics for {body.url}:

{metrics_context}

Provide 5 specific, actionable recommendations to improve this WordPress site's performance.
Respond ONLY with a JSON array (no markdown fences):
[{{"recommendation":"...", "priority":"high|medium|low", "implementation_steps":["step1","step2"]}}]"""

    ai_recs: list[PageSpeedAIRecommendation] = []
    try:
        raw = await get_ai_response(
            [{"role": "user", "content": ai_prompt}],
            max_tokens=1200,
            temperature=0.4,
        )
        # Strip markdown fences if present
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("```")[1]
            if cleaned.startswith("json"):
                cleaned = cleaned[4:]
        parsed = json.loads(cleaned.strip())
        for item in (parsed if isinstance(parsed, list) else []):
            ai_recs.append(PageSpeedAIRecommendation(
                recommendation=item.get("recommendation", ""),
                priority=item.get("priority", "medium"),
                implementation_steps=item.get("implementation_steps", []),
            ))
    except Exception as e:
        logger.warning(f"PageSpeed AI recommendations failed: {e}")

    result = PageSpeedResult(
        site_id=site_id,
        url=body.url,
        performance_score=performance_score,
        fcp=fcp,
        lcp=lcp,
        tbt=tbt,
        cls=cls,
        opportunities=opportunities,
        diagnostics=diagnostics,
        ai_recommendations=ai_recs,
    )
    result_dict = result.model_dump()
    # Attach any API warning so frontend can show it as an info banner
    if psi_error:
        result_dict["psi_warning"] = psi_error
    await db.pagespeed_results.insert_one(result_dict)
    result_dict.pop("_id", None)
    return result_dict


@api_router.get("/pagespeed/{site_id}")
async def get_pagespeed_results(site_id: str, _: dict = Depends(require_user)):
    """Return stored PageSpeed results for a site, newest first."""
    results = await db.pagespeed_results.find(
        {"site_id": site_id}, {"_id": 0}
    ).sort("fetched_at", -1).to_list(20)
    return results
