"""Content Calendar (merge future WP posts + scheduled_publish jobs into one
timeline, schedule a new post/page for future publish) and Competitor Analysis
(Google Custom Search + AI summary of where a keyword's competitors stand).
"""
import json
import logging
import os
import re as _re
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse

import httpx
from fastapi import Depends, HTTPException
from pydantic import BaseModel

from core.activity import log_activity
from core.ai import get_ai_response
from core.crypto import get_decrypted_settings
from core.db import db
from core.router import api_router
from core.security import get_current_user, require_editor
from models.legacy import CompetitorAnalysis, CompetitorAnalyzeRequest, CompetitorInfo
from providers.wordpress import get_wp_credentials, wp_api_request

logger = logging.getLogger(__name__)

# ========================
# Routes: Content Calendar
# ========================

class CalendarScheduleCreate(BaseModel):
    title: str
    content: str = ""
    scheduled_date: str  # ISO string
    post_type: str = "post"  # "post" | "page"


@api_router.get("/calendar/{site_id}")
async def get_calendar_events(site_id: str, current_user: Optional[dict] = Depends(get_current_user)):
    site = await get_wp_credentials(site_id)
    events = []

    # Fetch future posts from WordPress REST API
    try:
        response = await wp_api_request(site, "GET", "posts?status=future&per_page=100")
        if response.status_code == 200:
            for p in response.json():
                raw_title = p.get("title", "")
                title_str = raw_title["rendered"] if isinstance(raw_title, dict) else str(raw_title)
                events.append({
                    "id": str(p["id"]),
                    "title": title_str,
                    "type": "post",
                    "scheduled_date": p.get("date", ""),
                    "status": "scheduled",
                    "source": "wordpress",
                    "link": p.get("link", ""),
                })
    except Exception as exc:
        logger.warning(f"Failed to fetch future WP posts for calendar (site {site_id}): {exc}")

    # Fetch scheduled_publish jobs from MongoDB
    jobs = await db.jobs.find(
        {"site_id": site_id, "job_type": "scheduled_publish", "enabled": True},
        {"_id": 0},
    ).to_list(100)

    for job in jobs:
        if not job.get("publish_at"):
            continue
        post_title = ""
        if job.get("publish_post_id"):
            try:
                cached = await db.posts.find_one(
                    {"site_id": site_id, "wp_id": int(job["publish_post_id"])},
                    {"_id": 0, "title": 1},
                )
                if cached:
                    post_title = cached.get("title", "")
            except Exception:
                pass
        events.append({
            "id": job["id"],
            "title": post_title or f"Scheduled Job #{job['id'][:8]}",
            "type": "post",
            "scheduled_date": job["publish_at"],
            "status": "draft",
            "source": "job",
            "link": "",
        })

    events.sort(key=lambda e: e.get("scheduled_date") or "")
    return events


@api_router.post("/calendar/{site_id}/schedule")
async def schedule_calendar_post(
    site_id: str,
    data: CalendarScheduleCreate,
    current_user: Optional[dict] = Depends(get_current_user),
):
    site = await get_wp_credentials(site_id)
    user_id = current_user.get("id") if current_user else "global"

    # Normalise the ISO date → WordPress UTC format (no timezone suffix)
    # Always use date_gmt so WordPress treats the value unambiguously as UTC,
    # avoiding rejection when the site's local timezone makes the date appear past.
    try:
        # Handle JS .toISOString() format: "2026-03-27T10:00:00.000Z"
        clean = data.scheduled_date.replace("Z", "+00:00")
        # Python <3.11 fromisoformat can't handle fractional seconds with offset; strip them
        clean = _re.sub(r'\.\d+(?=[+-])', '', clean)
        dt = datetime.fromisoformat(clean)
        wp_date_gmt = dt.strftime("%Y-%m-%dT%H:%M:%S")
    except (ValueError, Exception):
        wp_date_gmt = data.scheduled_date[:19]

    endpoint = "pages" if data.post_type == "page" else "posts"
    wp_payload = {
        "title": data.title,
        "content": data.content,
        "status": "future",
        "date_gmt": wp_date_gmt,   # explicit UTC → avoids site-timezone ambiguity
    }

    response = await wp_api_request(site, "POST", endpoint, wp_payload)
    if response.status_code in [200, 201]:
        wp_post = response.json()
        await log_activity(
            site_id, "calendar_post_scheduled",
            f"Scheduled {data.post_type}: {data.title} at {wp_date_gmt} UTC",
            "success", user_id,
        )
        return {
            "id": str(wp_post["id"]),
            "title": data.title,
            "type": data.post_type,
            "scheduled_date": wp_date_gmt,
            "status": "scheduled",
            "source": "wordpress",
            "link": wp_post.get("link", ""),
        }

    # Bubble the exact WP error back as 422 so the frontend toast shows the real reason
    try:
        wp_error = response.json()
        detail = wp_error.get("message") or wp_error.get("detail") or response.text[:300]
    except Exception:
        detail = response.text[:300]
    logger.error(f"WordPress schedule error {response.status_code} for site {site_id}: {detail}")
    raise HTTPException(
        status_code=422,
        detail=f"WordPress rejected the request ({response.status_code}): {detail}",
    )


# ========================
# Routes: Competitor Analysis
# ========================

@api_router.post("/competitor/{site_id}/analyze")
async def analyze_competitor(
    site_id: str,
    body: CompetitorAnalyzeRequest,
    _: dict = Depends(require_editor),
):
    site = await get_wp_credentials(site_id)
    settings = await get_decrypted_settings()
    keyword = body.keyword.strip()
    if not keyword:
        raise HTTPException(status_code=400, detail="keyword is required")

    api_key = settings.get("google_search_api_key") or os.environ.get("GOOGLE_SEARCH_API_KEY", "")
    cx = settings.get("google_search_cx") or os.environ.get("GOOGLE_SEARCH_CX", "")

    search_results = []
    if api_key and cx:
        try:
            async with httpx.AsyncClient(timeout=15.0) as hc:
                resp = await hc.get(
                    "https://www.googleapis.com/customsearch/v1",
                    params={"key": api_key, "cx": cx, "q": keyword, "num": 10},
                )
            if resp.status_code == 200:
                items = resp.json().get("items", [])
                for i, item in enumerate(items):
                    search_results.append({
                        "position": i + 1,
                        "title": item.get("title", ""),
                        "url": item.get("link", ""),
                        "snippet": item.get("snippet", ""),
                    })
        except Exception as exc:
            logger.warning(f"Google Custom Search failed: {exc}")

    if not search_results:
        # Fallback: generate mock data so AI still works without CSE credentials
        search_results = [
            {"position": i + 1, "title": f"Result #{i+1} for '{keyword}'", "url": f"https://example{i+1}.com", "snippet": ""}
            for i in range(5)
        ]

    our_domain = site.get("url", "").replace("https://", "").replace("http://", "").rstrip("/").split("/")[0]
    results_text = "\n".join(
        f"{r['position']}. {r['title']} — {r['url']}\n   {r['snippet']}" for r in search_results
    )

    ai_prompt = f"""You are an SEO strategist. Analyze the following Google search results for the keyword: "{keyword}"

Our domain: {our_domain}

Search results:
{results_text}

Respond with valid JSON only:
{{
  "our_position": <integer rank of our domain, or null if not found>,
  "competitor_summary": "<2-3 sentence overview of what top competitors are doing well>",
  "recommendations": ["recommendation 1", "recommendation 2", "recommendation 3", "recommendation 4", "recommendation 5"]
}}"""

    raw = await get_ai_response(
        [{"role": "system", "content": "You are an expert SEO analyst. Respond only with valid JSON."},
         {"role": "user", "content": ai_prompt}],
        max_tokens=1000,
        temperature=0.3,
    )
    try:
        if "```json" in raw:
            raw = raw.split("```json")[1].split("```")[0]
        elif "```" in raw:
            raw = raw.split("```")[1].split("```")[0]
        ai_data = json.loads(raw.strip())
    except Exception:
        ai_data = {"our_position": None, "competitor_summary": raw[:500], "recommendations": []}

    competitors = []
    for r in search_results:
        domain = urlparse(r["url"]).netloc
        competitors.append(CompetitorInfo(
            domain=domain,
            title=r["title"],
            url=r["url"],
            estimated_position=r["position"],
            meta_description=r["snippet"],
        ))

    doc = CompetitorAnalysis(
        site_id=site_id,
        target_keyword=keyword,
        competitors=competitors,
        our_position=ai_data.get("our_position"),
        analysis_text=ai_data.get("competitor_summary", ""),
        recommendations=ai_data.get("recommendations", []),
    )
    await db.competitor_analysis.insert_one(doc.model_dump())
    await log_activity(site_id, "competitor_analysis", f"Analyzed keyword: {keyword}")
    return doc.model_dump()


@api_router.get("/competitor/{site_id}")
async def get_competitor_analyses(site_id: str, limit: int = 20):
    docs = await db.competitor_analysis.find({"site_id": site_id}, {"_id": 0}).sort("created_at", -1).to_list(limit)
    return docs
