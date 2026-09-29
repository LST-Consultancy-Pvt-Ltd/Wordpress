"""Content tools: Writing Style Profiles, AI Content Brief Generator, SEO
Keyword Rank Tracker (GSC-backed snapshots), and Readability Score & AI
Suggestions for synced content items.
"""
import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional

from bs4 import BeautifulSoup
from fastapi import Depends, HTTPException, Query

from core.activity import log_activity
from core.ai import get_ai_response
from core.content_analysis import compute_readability
from core.crypto import (
    get_decrypted_settings,
)
from core.db import db
from core.prompts import HUMANIZE_DIRECTIVE
from core.router import api_router
from core.security import require_admin, require_editor, require_user
from models.legacy import (
    BriefRequest, ContentBrief, PostGenerate, RankTrackRequest,
    WritingStyle,
)
from providers.google_analytics import fetch_gsc_metrics
from providers.sites import get_site

logger = logging.getLogger(__name__)


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
    await get_site(site_id)  # validates the site exists
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
# Feature 5: SEO Keyword Rank Tracker
# ─────────────────────────────────────────────────────────────────

@api_router.post("/rank-tracker/{site_id}/track")
async def save_tracked_keywords(site_id: str, data: RankTrackRequest, _: dict = Depends(require_user)):
    await get_site(site_id)
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
    await get_site(site_id)
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
        site_url = settings.get("gsc_site_url") or (site_doc.get("base_url", "") if site_doc else "")
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

@api_router.post("/readability/{site_id}/{collection}/{slug}")
async def analyze_readability(site_id: str, collection: str, slug: str, _: dict = Depends(require_user)):
    item = await db.content_items.find_one({"site_id": site_id, "collection": collection, "slug": slug}, {"_id": 0})
    if not item:
        raise HTTPException(status_code=404, detail="Content item not found; sync the site's content first")
    raw_content = item.get("body", "")
    content_type = collection

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
        ai_prompt = f"""A piece of website content ({content_type}) has these readability scores:
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
        "collection": collection,
        "slug": slug,
        "content_id": item.get("content_id"),
        "grade_label": grade,
        "suggestions": suggestions,
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        **metrics,
    }
    await db.readability_scores.replace_one(
        {"site_id": site_id, "collection": collection, "slug": slug},
        result,
        upsert=True,
    )
    return result
