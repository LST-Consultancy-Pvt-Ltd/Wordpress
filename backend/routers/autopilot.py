"""Daily Crawl + Recommendations (scan synced content for common SEO issues,
AI-prioritised fixes) and the Autopilot Engine: a 4-stage pipeline (pick
keyword → write post → optimize SEO → propose) that runs on a schedule or on
demand, streamed to the UI over SSE.

The last stage creates a content change set and submits it for approval. It
never writes to the site itself: the change set is applied only after a
deployer approves it, or when the site's auto-apply policy explicitly covers
it (and automatic writes are not frozen).

`_daily_crawl_all_sites` and `_restore_autopilot_schedules` are called from
server.py's `lifespan()` at startup — imported back there for that reason.
"""
import asyncio
import json
import logging
import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Optional

from apscheduler.triggers.cron import CronTrigger
from bs4 import BeautifulSoup
from fastapi import BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from core.activity import log_activity
from core.automation_policy import skip_if_frozen
from core.ai import get_ai_response
from core.db import db
from core.prompts import HUMANIZE_DIRECTIVE
from core.router import api_router
from core.scheduler import scheduler
from core.security import get_current_user, require_editor
from core.tasks import (
    autopilot_sse_queues, create_task_queue, finish_task, make_task_id, push_event,
)
from core import changesets
from core.content_proposals import propose_content
from core.security import verify_stream_token

logger = logging.getLogger(__name__)

# ========================
# FEATURE 10: Daily Crawl + Recommendations
# ========================

@api_router.post("/crawl/{site_id}")
async def trigger_crawl(site_id: str, background_tasks: BackgroundTasks, _: dict = Depends(require_editor)):
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_run_site_crawl, task_id, site_id)
    return {"task_id": task_id}

@api_router.get("/crawl/{site_id}/latest")
async def get_latest_crawl(site_id: str, _: dict = Depends(require_editor)):
    doc = await db.crawl_reports.find_one({"site_id": site_id}, {"_id": 0}, sort=[("crawled_at", -1)])
    if not doc:
        return {"site_id": site_id, "issues": [], "crawled_at": None, "summary": None}
    return doc

async def _run_site_crawl(task_id: str, site_id: str):
    """Scan the site's synced content (db.content_items, filled by
    POST /sites/{id}/content/sync) for common on-page issues."""
    try:
        await push_event(task_id, "status", {"message": "Reading synced content…", "step": 1, "total": 4})
        items = await db.content_items.find({"site_id": site_id, "status": {"": "draft"}},
                                            {"_id": 0}).to_list(500)
        await push_event(task_id, "status", {"message": f"Analysing {len(items)} items for issues…", "step": 2, "total": 4})
        issues: list = []
        seen_titles: dict = {}
        for item in items:
            content_id = item.get("content_id")
            item_url = item.get("url", "")
            title = item.get("title", "")
            body = item.get("body", "")
            soup = BeautifulSoup(body, "html.parser")
            content_text = soup.get_text()
            if title:
                if title in seen_titles:
                    issues.append({"id": str(uuid.uuid4()), "url": item_url, "issue_type": "duplicate_title",
                                   "severity": "high", "description": f"Title duplicates {seen_titles[title]}",
                                   "recommended_fix": "Rewrite titles to be unique.", "content_id": content_id,
                                   "fixed": False})
                else:
                    seen_titles[title] = item_url
            if not (item.get("frontmatter") or {}).get("description"):
                issues.append({"id": str(uuid.uuid4()), "url": item_url, "issue_type": "missing_meta",
                               "severity": "medium", "description": "No meta description in the front matter.",
                               "recommended_fix": "Add a compelling description under 160 chars.",
                               "content_id": content_id, "fixed": False})
            if len(content_text.split()) < 300:
                issues.append({"id": str(uuid.uuid4()), "url": item_url, "issue_type": "thin_content",
                               "severity": "medium", "description": f"Only {len(content_text.split())} words (recommended ≥300).",
                               "recommended_fix": "Expand it in the content editor.", "content_id": content_id,
                               "fixed": False})
            md_images_without_alt = body.count("![](")
            if md_images_without_alt or any(not img.get("alt") for img in soup.find_all("img")):
                issues.append({"id": str(uuid.uuid4()), "url": item_url, "issue_type": "no_alt_text",
                               "severity": "low", "description": "One or more images missing alt text.",
                               "recommended_fix": "Add alt text in the content editor.", "content_id": content_id,
                               "fixed": False})
        await push_event(task_id, "status", {"message": "Generating AI recommendations…", "step": 3, "total": 4})
        recommendations: list = []
        if issues:
            type_summary = ", ".join(f"{v}× {k}" for k, v in Counter(i["issue_type"] for i in issues).items())
            ai_raw = await get_ai_response([{"role": "user", "content": (
                f"Website has these SEO issues: {type_summary} (total {len(issues)}).\n"
                f"Give 5 prioritised fix recommendations.\n"
                f'Respond as JSON: {{"recommendations": ["Fix 1", "Fix 2", "Fix 3", "Fix 4", "Fix 5"]}}'
            )}], max_tokens=400, temperature=0.4)
            for fence in ["```json", "```"]:
                if fence in ai_raw:
                    ai_raw = ai_raw.split(fence)[1].split("```")[0]
                    break
            recommendations = json.loads(ai_raw.strip()).get("recommendations", [])
        type_counts = dict(Counter(i["issue_type"] for i in issues))
        report = {
            "id": str(uuid.uuid4()), "site_id": site_id, "issues": issues,
            "total_urls": len(items), "crawled_at": datetime.now(timezone.utc).isoformat(),
            "recommendations": recommendations,
            "summary": {"total_issues": len(issues), "by_type": type_counts,
                        "critical": sum(1 for i in issues if i.get("severity") == "critical"),
                        "high": sum(1 for i in issues if i.get("severity") == "high")},
            "note": None if items else "No synced content — run a content sync for this site first.",
        }
        await db.crawl_reports.replace_one({"site_id": site_id}, report, upsert=True)
        await push_event(task_id, "status", {"message": f"Crawl complete — {len(issues)} issues found", "step": 4, "total": 4})
        await finish_task(task_id)
    except Exception as e:
        await push_event(task_id, "error", {"message": str(e)})
        await finish_task(task_id)


async def _daily_crawl_all_sites():
    """APScheduler job: crawl all connected sites once per day."""
    try:
        sites = await db.sites.find({"connection.status": "connected"}, {"_id": 0, "id": 1}).to_list(100)
        for s in sites:
            task_id = make_task_id()
            await create_task_queue(task_id)
            asyncio.create_task(_run_site_crawl(task_id, s["id"]))
    except Exception as e:
        logger.error(f"Daily crawl failed: {e}")


# ============================================================
# AUTOPILOT ENGINE
# ============================================================

# ---------- helpers ----------

async def _autopilot_emit(site_id: str, stage: str, ev_status: str, data: dict = None):
    """Push one SSE event to all listeners for a site."""
    payload = {
        "stage": stage,
        "status": ev_status,
        "data": data or {},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    msg = f"data: {json.dumps(payload)}\n\n"
    dead = []
    for q in autopilot_sse_queues.get(site_id, []):
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        try:
            autopilot_sse_queues[site_id].remove(q)
        except ValueError:
            pass


async def _autopilot_get_settings(site_id: str) -> dict:
    doc = await db.autopilot_settings.find_one({"site_id": site_id}, {"_id": 0})
    if not doc:
        return {
            "site_id": site_id,
            "enabled": False,
            "posting_frequency": "weekly",
            "tone": "professional",
            "word_count_target": 1200,
            "auto_publish": False,
            "next_run_at": None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
    return doc


async def _autopilot_upsert_settings(site_id: str, updates: dict):
    updates["site_id"] = site_id
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.autopilot_settings.update_one(
        {"site_id": site_id}, {"$set": updates}, upsert=True
    )


def _compute_next_run(frequency: str) -> str:
    """Return the next ISO UTC run time given a frequency string."""
    now = datetime.now(timezone.utc)
    if frequency == "daily":
        candidate = now.replace(hour=8, minute=0, second=0, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=1)
        return candidate.isoformat()
    if frequency == "3x_week":
        # Mon/Wed/Fri = 0/2/4
        days_map = [0, 2, 4]
        for offset in range(1, 8):
            nxt = now + timedelta(days=offset)
            if nxt.weekday() in days_map:
                return nxt.replace(hour=8, minute=0, second=0, microsecond=0).isoformat()
    # weekly → next Monday
    days_until_monday = (7 - now.weekday()) % 7 or 7
    return (now + timedelta(days=days_until_monday)).replace(
        hour=8, minute=0, second=0, microsecond=0
    ).isoformat()


def _schedule_autopilot_job(site_id: str, frequency: str):
    """Add/replace APScheduler job for this site's autopilot pipeline."""
    job_id = f"autopilot_{site_id}"
    try:
        scheduler.remove_job(job_id)
    except Exception:
        pass
    if skip_if_frozen(f"registering autopilot schedule for site {site_id}"):
        return
    if frequency == "daily":
        trigger = CronTrigger(hour=8, minute=0, timezone="UTC")
    elif frequency == "3x_week":
        trigger = CronTrigger(day_of_week="mon,wed,fri", hour=8, minute=0, timezone="UTC")
    else:  # weekly
        trigger = CronTrigger(day_of_week="mon", hour=8, minute=0, timezone="UTC")
    scheduler.add_job(
        _scheduled_autopilot_run,
        trigger=trigger,
        id=job_id,
        args=[site_id],
        replace_existing=True,
        misfire_grace_time=3600,
    )


async def _scheduled_autopilot_run(site_id: str):
    """Cron entry point: unattended runs publish, so they honour the freeze."""
    if skip_if_frozen(f"scheduled autopilot run for site {site_id}"):
        return
    await _autopilot_run_pipeline_bg(site_id)


async def _restore_autopilot_schedules():
    """Called at startup: re-register all enabled autopilot sites with APScheduler."""
    try:
        docs = await db.autopilot_settings.find({"enabled": True}, {"_id": 0}).to_list(500)
        for doc in docs:
            _schedule_autopilot_job(doc["site_id"], doc.get("posting_frequency", "weekly"))
        logger.info(f"Restored {len(docs)} autopilot schedules")
    except Exception as e:
        logger.error(f"Restore autopilot schedules failed: {e}")


# ---------- SEO check helper ----------

def _run_seo_checks(html: str, keyword: str, meta_desc: str, word_count_target: int) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(separator=" ").lower()
    words = text.split()
    kw_lower = keyword.lower()

    title_tag = soup.find(["h1", "title"])
    title_text = (title_tag.get_text() if title_tag else "").lower()

    first_100 = " ".join(words[:100])
    total_words = len(words)
    kw_count = text.count(kw_lower)
    density = round(kw_count / max(total_words, 1) * 100, 2)
    h2_count = len(soup.find_all("h2"))
    has_internal = bool(soup.find("a", href=lambda h: h and h.startswith("/")))
    has_images = bool(soup.find("img"))
    imgs_with_alt = soup.find_all("img", alt=lambda a: a and a.strip())
    img_alt_ok = (not has_images) or (len(imgs_with_alt) > 0)
    faq_present = "frequently asked questions" in text or bool(soup.find("details"))
    cta_present = any(p in text for p in ["contact us", "get started", "try", "learn more", "sign up", "buy", "order"])

    checks = {
        "keyword_in_title": kw_lower in title_text,
        "keyword_in_first_100": kw_lower in first_100,
        "keyword_density_ok": 0.5 <= density <= 3.0,
        "meta_desc_length_ok": 0 < len(meta_desc) <= 155,
        "h2_count_ok": h2_count >= 3,
        "internal_links": has_internal,
        "image_alt_ok": img_alt_ok,
        "word_count_ok": total_words >= word_count_target * 0.8,
        "faq_present": faq_present,
        "cta_present": cta_present,
    }
    score = sum(10 for v in checks.values() if v)
    return {"checks": checks, "score": score, "word_count": total_words, "keyword_density": density}


# ---------- Stage 1 ----------

async def _autopilot_pick_keyword(site_id: str, job_id: str) -> dict:
    site = await db.sites.find_one({"id": site_id}, {"_id": 0})
    if not site:
        raise ValueError("Site not found")
    onboarding = site.get("onboarding") or {}
    topics = onboarding.get("content_topics") or site.get("content_topics") or []
    description = onboarding.get("description") or site.get("description") or ""
    audience = onboarding.get("target_audience") or site.get("target_audience") or ""

    used_kws = await db.autopilot_history.distinct("keyword", {"site_id": site_id})
    used_str = ", ".join(used_kws[-50:]) if used_kws else "none yet"

    prompt = (
        "You are an expert SEO strategist. Your job is to pick the single best long-tail keyword "
        "(3–5 words) for the next blog post on this site.\n\n"
        f"Site description: {description}\n"
        f"Target audience: {audience}\n"
        f"Content topics: {', '.join(topics)}\n"
        f"Already used keywords (DO NOT repeat): {used_str}\n\n"
        "Rules:\n"
        "- Pick a 3–5 word long-tail keyword\n"
        "- Must have informational or transactional search intent\n"
        "- Must not be in the 'already used' list\n"
        "- Must be realistically rankable (low or medium difficulty)\n"
        "- Must be closely related to the site's niche\n\n"
        "Return ONLY a valid JSON object (no markdown, no code fences) with these fields:\n"
        '{"keyword": "...", "rationale": "...", "estimated_difficulty": "low|medium|high", '
        '"search_intent": "informational|transactional|navigational", '
        '"suggested_title": "...", "suggested_h2s": ["...", "...", "...", "..."]}'
    )
    raw = await get_ai_response(
        [{"role": "user", "content": prompt}], max_tokens=600, temperature=0.7
    )
    # Strip markdown fences if present
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    kw_data = json.loads(raw.strip())
    await db.autopilot_jobs.update_one(
        {"id": job_id},
        {"$set": {"keyword": kw_data["keyword"], "keyword_data": kw_data, "status": "keyword_picked"}},
    )
    return kw_data


# ---------- Stage 2 ----------

async def _autopilot_write_post(site_id: str, job_id: str) -> dict:
    job = await db.autopilot_jobs.find_one({"id": job_id}, {"_id": 0})
    if not job:
        raise ValueError("Job not found")
    settings = await _autopilot_get_settings(site_id)
    site = await db.sites.find_one({"id": site_id}, {"_id": 0})
    if not site:
        raise ValueError("Site not found")
    onboarding = site.get("onboarding") or {}
    description = onboarding.get("description") or site.get("description") or "a professional blog"
    audience = onboarding.get("target_audience") or site.get("target_audience") or "general readers"

    kw_data = job.get("keyword_data", {})
    keyword = job.get("keyword", kw_data.get("keyword", ""))
    title = kw_data.get("suggested_title", f"The Complete Guide to {keyword.title()}")
    h2s = kw_data.get("suggested_h2s", [])
    h2_str = "\n".join(f"- {h}" for h in h2s)
    tone = settings.get("tone", "professional")
    wc = settings.get("word_count_target", 1200)

    prompt = (
        f"You are an expert blog writer. Write a complete, publish-ready blog post in HTML format.\n\n"
        f"{HUMANIZE_DIRECTIVE}\n\n"
        f"Target keyword: {keyword}\n"
        f"Title: {title}\n"
        f"H2 structure to use:\n{h2_str}\n"
        f"Site description: {description}\n"
        f"Target audience: {audience}\n"
        f"Tone: {tone}\n"
        f"Target word count: {wc} words\n\n"
        "Requirements:\n"
        f"1. Write ~{wc} words of high-quality HTML content (use <h2>, <p>, <ul>, <strong> tags — NOT markdown)\n"
        f"2. Include the keyword '{keyword}' naturally in: the first <h1> or title, within the first 100 words, at least 2 H2 headings, and the conclusion\n"
        "3. Use exactly the H2 structure provided above\n"
        "4. Add an FAQ section at the end using <h2>Frequently Asked Questions</h2> with 3–5 questions using <details><summary> tags\n"
        "5. Include a compelling call-to-action paragraph at the end referencing the site's product/service\n"
        "6. Do NOT include <html>, <head>, or <body> tags — only the post body HTML\n\n"
        "Return ONLY a valid JSON object (no markdown, no code fences) with these fields:\n"
        '{"title": "...", "html_content": "...(full HTML)...", "meta_description": "...(max 155 chars)...", '
        '"focus_keyword": "...", "estimated_word_count": 0, "excerpt": "...(1-2 sentences)..."}'
    )
    raw = await get_ai_response(
        [{"role": "user", "content": prompt}], max_tokens=4000, temperature=0.75
    )
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    content = json.loads(raw.strip())
    await db.autopilot_jobs.update_one(
        {"id": job_id},
        {"$set": {"written_content": content, "status": "content_written"}},
    )
    return content


# ---------- Stage 3 ----------

async def _autopilot_optimize_seo(site_id: str, job_id: str) -> dict:
    job = await db.autopilot_jobs.find_one({"id": job_id}, {"_id": 0})
    if not job:
        raise ValueError("Job not found")
    settings = await _autopilot_get_settings(site_id)
    wc_target = settings.get("word_count_target", 1200)
    content = job.get("written_content", {})
    html = content.get("html_content", "")
    keyword = job.get("keyword", "")
    meta_desc = content.get("meta_description", "")

    result = _run_seo_checks(html, keyword, meta_desc, wc_target)
    score = result["score"]

    if score < 80:
        failed = [k for k, v in result["checks"].items() if not v]
        fix_prompt = (
            f"The following blog post has SEO issues. Fix ONLY the failing SEO checks and return the improved HTML.\n\n"
            f"Failing checks: {', '.join(failed)}\n"
            f"Target keyword: {keyword}\n"
            f"Meta description must be ≤155 chars\n"
            f"Need at least 3 H2 headings\n"
            f"Keyword must appear in first 100 words\n\n"
            f"Original HTML:\n{html[:8000]}\n\n"
            "Return ONLY a JSON object with field: {\"improved_html\": \"...\"}"
        )
        raw2 = await get_ai_response(
            [{"role": "user", "content": fix_prompt}], max_tokens=4000, temperature=0.3
        )
        raw2 = raw2.strip()
        if raw2.startswith("```"):
            raw2 = raw2.split("```")[1]
            if raw2.startswith("json"):
                raw2 = raw2[4:]
        try:
            improved = json.loads(raw2.strip())
            html = improved.get("improved_html", html)
            result = _run_seo_checks(html, keyword, meta_desc, wc_target)
            score = result["score"]
        except Exception:
            pass  # keep original if parse fails

    await db.autopilot_jobs.update_one(
        {"id": job_id},
        {
            "$set": {
                "seo_checks": result["checks"],
                "seo_score": score,
                "optimized_html_content": html,
                "status": "seo_optimized",
            }
        },
    )
    return {"seo_score": score, "seo_checks": result["checks"]}


# ---------- Stage 4 ----------

# ---------- Stage 4 ----------

AUTOPILOT_ACTOR = {"id": "autopilot", "email": "autopilot", "role": "editor"}


async def _autopilot_propose(site_id: str, job_id: str) -> dict:
    """Create the content change set and submit it for approval."""
    job = await db.autopilot_jobs.find_one({"id": job_id}, {"_id": 0})
    if not job:
        raise ValueError("Job not found")
    settings = await _autopilot_get_settings(site_id)
    content = job.get("written_content", {})
    html = job.get("optimized_html_content") or content.get("html_content", "")
    title = content.get("title", job.get("keyword", "New Post"))
    keyword = job.get("keyword", "")
    status = "published" if settings.get("auto_publish", False) else "draft"
    cs = await propose_content(
        site_id, actor=AUTOPILOT_ACTOR, source="autopilot", title=f"Autopilot: {title}"[:200],
        description=f"Keyword '{keyword}', SEO score {job.get('seo_score', 0)} (job {job_id})",
        items=[{"title": title, "body": html, "status": status, "frontmatter": {
            "description": content.get("meta_description", ""), "excerpt": content.get("excerpt", ""),
            "keywords": [keyword] if keyword else [], "content_format": "html",
            "date": datetime.now(timezone.utc).date().isoformat()}}],
    )
    if cs["status"] == "planned":
        cs = await changesets.submit(cs["id"], actor=AUTOPILOT_ACTOR)
    await db.autopilot_jobs.update_one({"id": job_id}, {"": {
        "changeset_id": cs["id"], "changeset_status": cs["status"], "proposed_status": status,
        "status": "proposed", "proposed_at": datetime.now(timezone.utc).isoformat()}})
    await log_activity(site_id, "autopilot_proposed",
                       f"Proposed '{title}' (keyword: {keyword}) as change set {cs['id']} ({cs['status']})")
    return {"changeset_id": cs["id"], "changeset_status": cs["status"], "status": status}


# ---------- Pipeline orchestrator ----------

async def _autopilot_run_pipeline_bg(site_id: str, job_id: str = None):
    """Full 4-stage pipeline. Runs as background task."""
    # Create a fresh job if not provided
    if not job_id:
        job_id = str(uuid.uuid4())
        now_str = datetime.now(timezone.utc).isoformat()
        await db.autopilot_jobs.insert_one({
            "id": job_id,
            "site_id": site_id,
            "status": "running",
            "keyword": None,
            "created_at": now_str,
            "token_usage": {"total_input": 0, "total_output": 0, "estimated_cost_usd": 0.0, "by_stage": {}},
        })

    async def emit(stage, ev_status, data=None):
        await _autopilot_emit(site_id, stage, ev_status, data)

    stages = [
        ("keyword_picking", "keyword_picked", _autopilot_pick_keyword),
        ("content_writing", "content_written", _autopilot_write_post),
        ("seo_optimizing", "seo_optimized", _autopilot_optimize_seo),
        ("proposing", "completed", _autopilot_propose),
    ]

    cumulative_usage = {"total_input": 0, "total_output": 0, "estimated_cost_usd": 0.0, "by_stage": {}}

    for run_stage_name, done_stage_name, fn in stages:
        await emit(run_stage_name, "running")
        try:
            result = await fn(site_id, job_id)
            # Collect token usage if stage returned it
            if isinstance(result, dict) and "_token_usage" in result:
                stage_usage = result.pop("_token_usage")
                cumulative_usage["total_input"] += stage_usage.get("input_tokens", 0)
                cumulative_usage["total_output"] += stage_usage.get("output_tokens", 0)
                cumulative_usage["estimated_cost_usd"] += stage_usage.get("estimated_cost_usd", 0.0)
                cumulative_usage["by_stage"][run_stage_name] = stage_usage
            await emit(done_stage_name, "done", result)
        except Exception as e:
            logger.error(f"Autopilot stage {run_stage_name} failed for {site_id}: {e}")
            await emit(run_stage_name, "failed", {"error": str(e)})
            # Mark remaining stages as skipped (dependency chain gating)
            current_idx = [s[0] for s in stages].index(run_stage_name)
            skipped_stages = [s[0] for s in stages[current_idx + 1:]]
            for skipped in skipped_stages:
                await emit(skipped, "skipped", {"reason": f"Aborted due to {run_stage_name} failure"})
            await db.autopilot_jobs.update_one(
                {"id": job_id}, {"$set": {
                    "status": "failed",
                    "error": str(e),
                    "failed_stage": run_stage_name,
                    "skipped_stages": skipped_stages,
                    "token_usage": cumulative_usage,
                }}
            )
            await log_activity(site_id, "autopilot_error", f"Stage {run_stage_name} failed: {e}. Skipped: {', '.join(skipped_stages)}", "error")
            return

    # Update token usage
    cumulative_usage["estimated_cost_usd"] = round(cumulative_usage["estimated_cost_usd"], 6)
    await db.autopilot_jobs.update_one(
        {"id": job_id}, {"$set": {"token_usage": cumulative_usage}}
    )

    # Emit pipeline_complete
    final_job = await db.autopilot_jobs.find_one({"id": job_id}, {"_id": 0})
    await emit("pipeline_complete", "done", {
        "changeset_id": final_job.get("changeset_id"),
        "changeset_status": final_job.get("changeset_status"),
        "seo_score": final_job.get("seo_score", 0),
        "keyword": final_job.get("keyword", ""),
        "title": (final_job.get("written_content") or {}).get("title", ""),
        "job_id": job_id,
    })
    # Update next_run_at
    ap_settings = await _autopilot_get_settings(site_id)
    next_run = _compute_next_run(ap_settings.get("posting_frequency", "weekly"))
    await _autopilot_upsert_settings(site_id, {"next_run_at": next_run})


# ---------- Pydantic models for autopilot ----------

class AutopilotSettingsUpdate(BaseModel):
    enabled: Optional[bool] = None
    posting_frequency: Optional[str] = None  # daily | 3x_week | weekly
    tone: Optional[str] = None               # professional | conversational | technical | persuasive
    word_count_target: Optional[int] = None  # 800 | 1000 | 1200 | 1500 | 2000
    auto_publish: Optional[bool] = None


# ---------- Autopilot API endpoints ----------

@api_router.get("/autopilot/{site_id}/stream")
async def autopilot_stream(site_id: str, token: str = ""):
    """SSE endpoint — stream pipeline events for a site. Authenticated with a
    stream token for id 'autopilot:{site_id}' (POST /stream-token)."""
    if not verify_stream_token(token, f"autopilot:{site_id}"):
        raise HTTPException(status_code=401, detail="Stream token missing, expired or not for this stream")
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    if site_id not in autopilot_sse_queues:
        autopilot_sse_queues[site_id] = []
    autopilot_sse_queues[site_id].append(q)

    async def event_gen():
        try:
            # Send heartbeat immediately so browser doesn't time out
            yield "data: {\"stage\":\"connected\",\"status\":\"ok\"}\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=30)
                    yield msg
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            try:
                autopilot_sse_queues[site_id].remove(q)
            except ValueError:
                pass

    return StreamingResponse(event_gen(), media_type="text/event-stream")


@api_router.get("/autopilot/{site_id}/settings")
async def autopilot_get_settings_ep(site_id: str, current_user: dict = Depends(get_current_user)):
    return await _autopilot_get_settings(site_id)


@api_router.post("/autopilot/{site_id}/settings")
async def autopilot_save_settings(
    site_id: str, data: AutopilotSettingsUpdate, current_user: dict = Depends(get_current_user)
):
    updates = {k: v for k, v in data.model_dump().items() if v is not None}
    current = await _autopilot_get_settings(site_id)
    merged = {**current, **updates}

    # If toggling enabled or changing frequency, update scheduler
    if "enabled" in updates or "posting_frequency" in updates:
        if merged.get("enabled"):
            freq = merged.get("posting_frequency", "weekly")
            _schedule_autopilot_job(site_id, freq)
            merged["next_run_at"] = _compute_next_run(freq)
        else:
            job_id = f"autopilot_{site_id}"
            try:
                scheduler.remove_job(job_id)
            except Exception:
                pass
            merged["next_run_at"] = None

    await _autopilot_upsert_settings(site_id, merged)
    return await _autopilot_get_settings(site_id)


@api_router.post("/autopilot/{site_id}/update-schedule")
async def autopilot_update_schedule(site_id: str, current_user: dict = Depends(get_current_user)):
    """Re-sync APScheduler with current DB settings (call after manual edits)."""
    settings = await _autopilot_get_settings(site_id)
    if settings.get("enabled"):
        freq = settings.get("posting_frequency", "weekly")
        _schedule_autopilot_job(site_id, freq)
        next_run = _compute_next_run(freq)
        await _autopilot_upsert_settings(site_id, {"next_run_at": next_run})
        return {"scheduled": True, "next_run_at": next_run}
    else:
        job_id = f"autopilot_{site_id}"
        try:
            scheduler.remove_job(job_id)
        except Exception:
            pass
        return {"scheduled": False}


@api_router.post("/autopilot/{site_id}/run-pipeline")
async def autopilot_run_pipeline(
    site_id: str, background_tasks: BackgroundTasks, current_user: dict = Depends(get_current_user)
):
    """Trigger a full pipeline run immediately (background task)."""
    job_id = str(uuid.uuid4())
    now_str = datetime.now(timezone.utc).isoformat()
    await db.autopilot_jobs.insert_one({
        "id": job_id,
        "site_id": site_id,
        "status": "running",
        "keyword": None,
        "created_at": now_str,
    })
    background_tasks.add_task(_autopilot_run_pipeline_bg, site_id, job_id)
    return {"job_id": job_id, "status": "started"}


@api_router.post("/autopilot/{site_id}/pick-keyword")
async def autopilot_pick_keyword_ep(site_id: str, current_user: dict = Depends(get_current_user)):
    """Run Stage 1 independently (debug/manual re-run)."""
    job_id = str(uuid.uuid4())
    await db.autopilot_jobs.insert_one({
        "id": job_id, "site_id": site_id, "status": "keyword_picking",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    result = await _autopilot_pick_keyword(site_id, job_id)
    return {"job_id": job_id, "keyword_data": result}


@api_router.post("/autopilot/{site_id}/write-post/{job_id}")
async def autopilot_write_post_ep(
    site_id: str, job_id: str, current_user: dict = Depends(get_current_user)
):
    result = await _autopilot_write_post(site_id, job_id)
    return result


@api_router.post("/autopilot/{site_id}/optimize-seo/{job_id}")
async def autopilot_optimize_seo_ep(
    site_id: str, job_id: str, current_user: dict = Depends(get_current_user)
):
    return await _autopilot_optimize_seo(site_id, job_id)


@api_router.get("/autopilot/{site_id}/history")
async def autopilot_history(
    site_id: str,
    page: int = Query(1, ge=1),
    per_page: int = Query(10, ge=1, le=50),
    current_user: dict = Depends(get_current_user),
):
    skip = (page - 1) * per_page
    total = await db.autopilot_history.count_documents({"site_id": site_id})
    docs = (
        await db.autopilot_history.find({"site_id": site_id}, {"_id": 0})
        .sort("published_at", -1)
        .skip(skip)
        .limit(per_page)
        .to_list(per_page)
    )
    return {"items": docs, "total": total, "page": page, "per_page": per_page}


@api_router.get("/autopilot/{site_id}/jobs")
async def autopilot_jobs(site_id: str, current_user: dict = Depends(get_current_user)):
    """Return the latest running/recent job for the pipeline status board."""
    docs = (
        await db.autopilot_jobs.find({"site_id": site_id}, {"_id": 0})
        .sort("created_at", -1)
        .limit(5)
        .to_list(5)
    )
    return docs
