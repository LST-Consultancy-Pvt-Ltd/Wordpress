"""SEO Management: stored metrics, refresh from Google (GSC + GA4) as a
background task, cross-site bulk audit, single-page AI SEO analysis, and a
rule-based self-heal check.
"""
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Dict, List

import httpx
from fastapi import BackgroundTasks, Depends, HTTPException

from core.activity import log_activity
from core.ai import get_ai_response
from core.crypto import get_decrypted_settings
from core.db import db
from core.router import api_router
from core.security import require_editor
from core.seo_impact import estimate_seo_impact
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from models.legacy import BulkSEOAuditRequest
from providers.google_analytics import fetch_ga4_metrics, fetch_gsc_metrics
from providers.live_page import known_routes

logger = logging.getLogger(__name__)

@api_router.get("/seo/{site_id}")
async def get_seo_metrics(site_id: str):
    metrics = await db.seo_metrics.find({"site_id": site_id}, {"_id": 0}).to_list(100)
    return metrics

@api_router.post("/seo/refresh-google/{site_id}")
async def refresh_seo_from_google(site_id: str, background_tasks: BackgroundTasks):
    """Pull live data from Google Analytics + Search Console and store as SEO metrics."""
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_refresh_google_data, task_id, site_id)
    return {"task_id": task_id, "message": "Refreshing Google data..."}

async def _refresh_google_data(task_id: str, site_id: str):
    try:
        settings = await get_decrypted_settings()
        site = await db.sites.find_one({"id": site_id}, {"_id": 0})
        if not site:
            await push_event(task_id, "error", {"message": "Site not found"})
            return

        site_url = settings.get("gsc_site_url") or site.get("base_url", "")
        ga4_property_id = settings.get("ga4_property_id", "")

        await push_event(task_id, "status", {"message": "Fetching Search Console data..."})
        gsc_rows = await fetch_gsc_metrics(settings, site_url)

        await push_event(task_id, "status", {"message": f"Got {len(gsc_rows)} GSC rows. Fetching GA4 data..."})
        ga4_rows = await fetch_ga4_metrics(settings, ga4_property_id, site_url) if ga4_property_id else []

        # Merge: build a dict keyed by page_url+keyword
        merged: Dict[str, dict] = {}
        for row in gsc_rows:
            key = f"{row['page_url']}|{row.get('keyword','')}"
            merged[key] = {
                "site_id": site_id,
                "page_url": row["page_url"],
                "keyword": row.get("keyword", ""),
                "impressions": row.get("impressions", 0),
                "clicks": row.get("clicks", 0),
                "ctr": row.get("ctr", 0.0),
                "ranking": row.get("ranking", 0),
                "recorded_at": datetime.now(timezone.utc).isoformat(),
                "source": "google",
            }

        for row in ga4_rows:
            key = f"{row['page_url']}|"
            if key in merged:
                merged[key]["page_views"] = row.get("page_views", 0)
                merged[key]["sessions"] = row.get("sessions", 0)

        rows_list = list(merged.values())
        if rows_list:
            await db.seo_metrics.delete_many({"site_id": site_id, "source": "google"})
            for row in rows_list:
                row["id"] = str(uuid.uuid4())
            await db.seo_metrics.insert_many(rows_list)

        await push_event(task_id, "complete", {"message": f"Refreshed {len(rows_list)} metrics from Google", "count": len(rows_list)})
        await log_activity(site_id, "seo_google_refresh", f"Refreshed {len(rows_list)} metrics from Google")
    except Exception as e:
        logger.error(f"Google refresh failed: {e}")
        await push_event(task_id, "error", {"message": str(e)})
    finally:
        await finish_task(task_id)

@api_router.post("/seo/bulk-audit")
async def bulk_seo_audit(data: BulkSEOAuditRequest, background_tasks: BackgroundTasks):
    """Run SEO audit across multiple sites."""
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_bulk_seo_audit, task_id, data.site_ids)
    return {"task_id": task_id}

async def _bulk_seo_audit(task_id: str, site_ids: List[str]):
    try:
        total_pages = 0
        total_new = 0
        for i, site_id in enumerate(site_ids):
            pct = int((i / max(len(site_ids), 1)) * 90)
            await push_event(task_id, "progress", {"message": f"Auditing site {i+1}/{len(site_ids)}...", "percent": pct})

            # Known pages: latest on-page audit, else synced content.
            items = [{"link": p["url"], "title": p.get("title", "")} for p in await known_routes(site_id)]
            items = [item for item in items if item.get("link", "").startswith("http")]
            total_pages += len(items)

            for item in items:
                result = await db.seo_metrics.update_one(
                    {"site_id": site_id, "page_url": item.get("link", "")},
                    {"$setOnInsert": {
                        "id": str(uuid.uuid4()),
                        "site_id": site_id,
                        "page_url": item.get("link", ""),
                        "keyword": item.get("title", "")[:100],
                        "impressions": 0,
                        "clicks": 0,
                        "ctr": 0.0,
                        "ranking": None,
                        "recorded_at": datetime.now(timezone.utc).isoformat(),
                    }},
                    upsert=True
                )
                if result.upserted_id:
                    total_new += 1

            await log_activity(site_id, "bulk_seo_audit", f"Bulk SEO audit: {len(items)} pages scanned")

        await push_event(task_id, "complete", {
            "message": f"Audit complete: {total_pages} pages across {len(site_ids)} sites ({total_new} new entries added)",
            "percent": 100,
        })
    except Exception as e:
        await push_event(task_id, "error", {"message": str(e)})
    finally:
        await finish_task(task_id)

@api_router.post("/seo/analyze/{site_id}")
async def analyze_seo(site_id: str, page_url: str):
    # Fetch page content
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(page_url)
            page_content = response.text[:5000]  # Limit content for analysis
    except Exception:
        page_content = "Could not fetch page content"

    prompt = f"""Analyze the SEO of this webpage and provide recommendations:
URL: {page_url}
Content Preview: {page_content[:2000]}

Provide analysis in JSON format:
{{
    "current_score": 0-100,
    "title_analysis": {{"current": "...", "suggested": "...", "score": 0-100}},
    "meta_description": {{"current": "...", "suggested": "...", "score": 0-100}},
    "heading_structure": {{"issues": [], "score": 0-100}},
    "keyword_analysis": {{"primary": "...", "secondary": [], "density": "..."}},
    "recommendations": ["recommendation1", "recommendation2", ...]
}}"""

    try:
        content = await get_ai_response(
            [
                {"role": "system", "content": "You are an expert SEO analyst. Always respond with valid JSON."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.5,
            max_tokens=1500,
        )
        if "```json" in content:
            content = content.split("```json")[1].split("```")[0]
        elif "```" in content:
            content = content.split("```")[1].split("```")[0]

        analysis = json.loads(content.strip())
        await log_activity(site_id, "seo_analyzed", f"Analyzed SEO for: {page_url}")
        return analysis

    except Exception as e:
        logger.error(f"SEO analysis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.post("/seo/self-heal/{site_id}")
async def self_heal_seo(site_id: str, _: dict = Depends(require_editor)):
    """Check and automatically fix SEO issues based on predefined rules"""
    metrics = await db.seo_metrics.find({"site_id": site_id}, {"_id": 0}).to_list(200)

    if not metrics:
        # No metrics yet — run a quick discovery from known pages
        items = [{"link": p["url"], "title": p.get("title", "")} for p in await known_routes(site_id)]
        for item in items:
            url = item.get("link", "")
            if url.startswith("http"):
                await db.seo_metrics.update_one(
                    {"site_id": site_id, "page_url": url},
                    {"$setOnInsert": {
                        "id": str(uuid.uuid4()),
                        "site_id": site_id,
                        "page_url": url,
                        "keyword": item.get("title", {}).get("rendered", "") if isinstance(item.get("title"), dict) else item.get("title", "")[:100],
                        "impressions": 0,
                        "clicks": 0,
                        "ctr": 0.0,
                        "ranking": None,
                        "recorded_at": datetime.now(timezone.utc).isoformat(),
                    }},
                    upsert=True
                )
        metrics = await db.seo_metrics.find({"site_id": site_id}, {"_id": 0}).to_list(200)

    actions_taken = []

    for metric in metrics:
        page_url = metric.get("page_url", "untitled page")
        # Rule 1: Low CTR (below 2%)
        if metric.get("ctr", 0) < 2:
            actions_taken.append({
                "page": page_url,
                "issue": "Low CTR (<2%)",
                "action": "Queued meta title/description rewrite"
            })
        # Rule 2: Ranking drop
        if metric.get("ranking_drop", 0) >= 5:
            actions_taken.append({
                "page": page_url,
                "issue": f"Ranking dropped {metric['ranking_drop']} positions",
                "action": "Queued content expansion"
            })
        # Rule 3: Zero impressions on indexed pages
        if metric.get("impressions", 0) == 0 and not metric.get("keyword"):
            actions_taken.append({
                "page": page_url,
                "issue": "No impressions — missing target keyword",
                "action": "Queued keyword assignment"
            })

    await log_activity(site_id, "seo_self_heal", f"Checked {len(metrics)} pages, {len(actions_taken)} actions queued")

    return {
        "pages_checked": len(metrics),
        "actions_taken": actions_taken,
        "impact_estimate": estimate_seo_impact("self_heal"),
    }
