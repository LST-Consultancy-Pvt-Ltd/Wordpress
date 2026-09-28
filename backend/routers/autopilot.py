"""Daily Crawl + Recommendations (scan published posts for common SEO issues,
AI-prioritised fixes, apply a single fix) and the Autopilot Engine: a 5-stage
pipeline (pick keyword → write post → optimize SEO → publish → interlink) that
runs on a schedule or on demand, streamed to the UI over SSE.

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
from core.crypto import decrypt_field
from core.db import db
from core.prompts import HUMANIZE_DIRECTIVE
from core.router import api_router
from core.scheduler import scheduler
from core.security import get_current_user, require_editor
from core.tasks import (
    autopilot_sse_queues, create_task_queue, finish_task, make_task_id, push_event,
)
from providers.wordpress import get_wp_credentials, wp_api_request, wp_xmlrpc_write

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

@api_router.post("/crawl/{site_id}/fix/{issue_id}")
async def fix_crawl_issue(site_id: str, issue_id: str, dry_run: bool = False, _: dict = Depends(require_editor)):
    report = await db.crawl_reports.find_one({"site_id": site_id}, {"_id": 0}, sort=[("crawled_at", -1)])
    if not report:
        raise HTTPException(status_code=404, detail="No crawl report found")
    issue = next((i for i in report.get("issues", []) if i.get("id") == issue_id), None)
    if not issue:
        raise HTTPException(status_code=404, detail="Issue not found")
    site = await get_wp_credentials(site_id)
    post_id = issue.get("post_id")
    result_msg = ""
    new_meta = None
    new_title = None
    if post_id and issue.get("issue_type") == "missing_meta":
        post_resp = await wp_api_request(site, "GET", f"posts/{post_id}")
        if post_resp.status_code == 200:
            pd = post_resp.json()
            content_txt = BeautifulSoup(pd.get("content", {}).get("rendered", ""), "html.parser").get_text()[:400]
            title = pd.get("title", {}).get("rendered", "")
            meta = await get_ai_response([{"role": "user", "content": f"Write a 150-char SEO meta description for post titled '{title}'. Content: {content_txt[:300]}"}], max_tokens=80, temperature=0.3)
            new_meta = meta.strip()
            if dry_run:
                return {
                    "dry_run": True,
                    "issue_type": issue.get("issue_type"),
                    "url": issue.get("url", ""),
                    "recommendation": issue.get("recommended_fix", ""),
                    "new_meta": new_meta,
                    "wp_id": post_id,
                }
            try:
                await wp_api_request(site, "POST", f"posts/{post_id}", {"meta": {"_yoast_wpseo_metadesc": meta.strip()}})
            except Exception:
                pass
            result_msg = f"Generated meta description: {meta.strip()[:120]}"
    elif issue.get("issue_type") == "thin_content":
        result_msg = "Use Live Editor → Expand to add more content to this post."
    elif issue.get("issue_type") == "no_alt_text":
        result_msg = "Use Image Audit → Generate All Alt Texts to fix missing alt text."
    else:
        result_msg = issue.get("recommended_fix", "Manual review required.")
    if dry_run:
        return {
            "dry_run": True,
            "issue_type": issue.get("issue_type"),
            "url": issue.get("url", ""),
            "recommendation": result_msg or issue.get("recommended_fix", ""),
            "wp_id": post_id,
        }
    await db.crawl_reports.update_one(
        {"site_id": site_id, "issues.id": issue_id},
        {"$set": {"issues.$.fixed": True}}
    )
    return {"ok": True, "message": result_msg}

async def _run_site_crawl(task_id: str, site_id: str):
    try:
        await push_event(task_id, "status", {"message": "Fetching posts from WordPress…", "step": 1, "total": 4})
        site = await get_wp_credentials(site_id)
        site_url = site.get("url", "").rstrip("/")
        posts_resp = await wp_api_request(site, "GET", "posts?per_page=50&status=publish&_fields=id,title,content,meta,slug")
        wp_posts = posts_resp.json() if posts_resp.status_code == 200 else []
        await push_event(task_id, "status", {"message": f"Analysing {len(wp_posts)} posts for issues…", "step": 2, "total": 4})
        issues: list = []
        seen_titles: dict = {}
        for post in wp_posts:
            post_id = post.get("id")
            post_url = f"{site_url}/?p={post_id}"
            title_obj = post.get("title", {})
            title = title_obj.get("rendered", "") if isinstance(title_obj, dict) else str(title_obj)
            content_obj = post.get("content", {})
            content_html = content_obj.get("rendered", "") if isinstance(content_obj, dict) else ""
            content_text = BeautifulSoup(content_html, "html.parser").get_text()
            if title:
                if title in seen_titles:
                    issues.append({"id": str(uuid.uuid4()), "url": post_url, "issue_type": "duplicate_title",
                                   "severity": "high", "description": f"Title duplicates post #{seen_titles[title]}",
                                   "recommended_fix": "Rewrite titles to be unique.", "post_id": post_id, "fixed": False})
                else:
                    seen_titles[title] = post_id
            meta = post.get("meta", {})
            yoast_meta = meta.get("_yoast_wpseo_metadesc", "") if isinstance(meta, dict) else ""
            if not yoast_meta:
                issues.append({"id": str(uuid.uuid4()), "url": post_url, "issue_type": "missing_meta",
                               "severity": "medium", "description": "No SEO meta description.",
                               "recommended_fix": "Add a compelling meta description under 160 chars.", "post_id": post_id, "fixed": False})
            if len(content_text.split()) < 300:
                issues.append({"id": str(uuid.uuid4()), "url": post_url, "issue_type": "thin_content",
                               "severity": "medium", "description": f"Only {len(content_text.split())} words (recommended ≥300).",
                               "recommended_fix": "Expand with Live Editor AI.", "post_id": post_id, "fixed": False})
            imgs = BeautifulSoup(content_html, "html.parser").find_all("img")
            if any(not img.get("alt") for img in imgs):
                issues.append({"id": str(uuid.uuid4()), "url": post_url, "issue_type": "no_alt_text",
                               "severity": "low", "description": "One or more images missing alt text.",
                               "recommended_fix": "Use Image Audit to generate alt texts.", "post_id": post_id, "fixed": False})
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
            "total_urls": len(wp_posts), "crawled_at": datetime.now(timezone.utc).isoformat(),
            "recommendations": recommendations,
            "summary": {"total_issues": len(issues), "by_type": type_counts,
                        "critical": sum(1 for i in issues if i.get("severity") == "critical"),
                        "high": sum(1 for i in issues if i.get("severity") == "high")}
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
        sites = await db.sites.find({"status": "connected"}, {"_id": 0, "id": 1}).to_list(100)
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

async def _autopilot_publish(site_id: str, job_id: str) -> dict:
    job = await db.autopilot_jobs.find_one({"id": job_id}, {"_id": 0})
    if not job:
        raise ValueError("Job not found")
    settings = await _autopilot_get_settings(site_id)
    site = await db.sites.find_one({"id": site_id}, {"_id": 0})
    if not site:
        raise ValueError("Site not found")
    if site.get("app_password"):
        site["app_password"] = decrypt_field(site["app_password"])

    content = job.get("written_content", {})
    html = job.get("optimized_html_content") or content.get("html_content", "")
    title = content.get("title", job.get("keyword", "New Post"))
    meta_desc = content.get("meta_description", "")
    excerpt = content.get("excerpt", "")
    keyword = job.get("keyword", "")
    wp_status = "publish" if settings.get("auto_publish", False) else "draft"

    post_data = {
        "title": title,
        "content": html,
        "excerpt": excerpt,
        "status": wp_status,
        "meta": {
            "yoast_wpseo_title": title,
            "yoast_wpseo_metadesc": meta_desc,
            "_yoast_wpseo_focuskw": keyword,
            "rank_math_focus_keyword": keyword,
            "rank_math_description": meta_desc,
        },
    }

    resp = await wp_api_request(site, "POST", "posts", post_data)
    if resp.status_code not in (200, 201):
        # Fallback: some hosts (Hostinger/LiteSpeed) strip the Authorization header,
        # causing REST API to reject the request with 401/403. Try XML-RPC instead.
        logger.warning(
            f"Autopilot REST publish failed ({resp.status_code}) for site {site_id}, "
            f"trying XML-RPC fallback"
        )
        try:
            xmlrpc_result = await wp_xmlrpc_write(
                site, "post", title, html, wp_status
            )
            wp_post_id = xmlrpc_result.get("wp_id")
            wp_post_url = xmlrpc_result.get("link", "")
        except Exception as xe:
            raise ValueError(f"WP publish failed: {resp.status_code} {resp.text[:300]} | XML-RPC also failed: {xe}")
    else:
        wp_result = resp.json()
        wp_post_id = wp_result.get("id")
        wp_post_url = wp_result.get("link", "")
    published_at = datetime.now(timezone.utc).isoformat()

    await db.autopilot_jobs.update_one(
        {"id": job_id},
        {
            "$set": {
                "wp_post_id": wp_post_id,
                "wp_post_url": wp_post_url,
                "published_at": published_at,
                "wp_status": wp_status,
                "status": "published",
            }
        },
    )
    await log_activity(
        site_id, "autopilot_publish",
        f"Published '{title}' (keyword: {keyword}, SEO: {job.get('seo_score', 0)})",
        "success",
    )
    return {"wp_post_id": wp_post_id, "wp_post_url": wp_post_url, "status": wp_status}


# ---------- Stage 5 ----------

async def _autopilot_interlink(site_id: str, job_id: str) -> dict:
    job = await db.autopilot_jobs.find_one({"id": job_id}, {"_id": 0})
    if not job:
        raise ValueError("Job not found")
    site = await db.sites.find_one({"id": site_id}, {"_id": 0})
    if not site:
        raise ValueError("Site not found")
    if site.get("app_password"):
        site["app_password"] = decrypt_field(site["app_password"])

    new_wp_id = job.get("wp_post_id")
    new_title = job.get("written_content", {}).get("title", "")
    new_keyword = job.get("keyword", "")
    new_html = job.get("optimized_html_content") or job.get("written_content", {}).get("html_content", "")

    # Fetch published posts from WP
    posts_resp = await wp_api_request(site, "GET", "posts?per_page=50&status=publish&orderby=date")
    if posts_resp.status_code != 200:
        raise ValueError(f"Failed to fetch WP posts: {posts_resp.status_code}")
    all_posts = posts_resp.json()
    existing = [
        {
            "id": p["id"],
            "title": p.get("title", {}).get("rendered", ""),
            "link": p.get("link", ""),
            "excerpt": BeautifulSoup(p.get("excerpt", {}).get("rendered", ""), "html.parser").get_text()[:200],
        }
        for p in all_posts
        if p.get("id") != new_wp_id
    ]
    if not existing:
        await db.autopilot_jobs.update_one(
            {"id": job_id},
            {"$set": {"interlinks_added": 0, "status": "completed", "completed_at": datetime.now(timezone.utc).isoformat()}},
        )
        return {"interlinks_added": 0}

    posts_summary = "\n".join(
        f'- ID:{p["id"]} Title:"{p["title"]}" URL:{p["link"]} Excerpt:{p["excerpt"]}'
        for p in existing[:30]
    )
    interlink_prompt = (
        "You are an SEO expert. Suggest internal links to add to a newly published blog post.\n\n"
        f"New post title: {new_title}\n"
        f"New post keyword: {new_keyword}\n\n"
        f"Existing published posts:\n{posts_summary}\n\n"
        "Return a JSON array (max 5 suggestions) of internal link opportunities. "
        "For each suggestion, specify whether the link goes FROM the new post TO an existing one, "
        "or FROM an existing post TO the new post.\n"
        "Format:\n"
        '[{"direction": "from_new"|"to_new", "source_post_id": 0, "source_post_title": "...", '
        '"anchor_text": "...", "target_post_url": "...", "target_post_id": 0, "target_post_title": "...", '
        '"insertion_context": "...exact snippet of text where the link should be inserted..."}]\n\n'
        "Return ONLY the JSON array. No markdown, no explanation."
    )
    raw = await get_ai_response(
        [{"role": "user", "content": interlink_prompt}], max_tokens=1500, temperature=0.3
    )
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    try:
        suggestions = json.loads(raw.strip())
    except Exception:
        suggestions = []

    links_added = 0
    for sug in suggestions:
        try:
            direction = sug.get("direction", "from_new")
            anchor = sug.get("anchor_text", "")
            target_url = sug.get("target_post_url", "")
            context = sug.get("insertion_context", "")
            if not anchor or not target_url or not context:
                continue
            link_tag = f'<a href="{target_url}">{anchor}</a>'

            if direction == "from_new":
                # Modify the new post
                updated_html = new_html.replace(anchor, link_tag, 1)
                if updated_html == new_html:
                    continue
                new_html = updated_html
                patch_resp = await wp_api_request(site, "PUT", f"posts/{new_wp_id}", {"content": new_html})
                if patch_resp.status_code in (200, 201):
                    links_added += 1
            else:
                # Modify an existing post
                src_id = sug.get("source_post_id")
                if not src_id:
                    continue
                src_resp = await wp_api_request(site, "GET", f"posts/{src_id}")
                if src_resp.status_code != 200:
                    continue
                src_content = src_resp.json().get("content", {}).get("rendered", "")
                updated_src = src_content.replace(anchor, link_tag, 1)
                if updated_src == src_content:
                    continue
                patch_resp = await wp_api_request(site, "PUT", f"posts/{src_id}", {"content": updated_src})
                if patch_resp.status_code in (200, 201):
                    links_added += 1
        except Exception as e:
            logger.warning(f"Interlink suggestion failed: {e}")
            continue

    completed_at = datetime.now(timezone.utc).isoformat()
    await db.autopilot_jobs.update_one(
        {"id": job_id},
        {
            "$set": {
                "interlinks_added": links_added,
                "interlink_suggestions": suggestions,
                "status": "completed",
                "completed_at": completed_at,
            }
        },
    )
    # Write to history
    job_final = await db.autopilot_jobs.find_one({"id": job_id}, {"_id": 0})
    if job_final:
        history_doc = {
            "id": str(uuid.uuid4()),
            "site_id": site_id,
            "job_id": job_id,
            "keyword": job_final.get("keyword", ""),
            "title": job_final.get("written_content", {}).get("title", ""),
            "seo_score": job_final.get("seo_score", 0),
            "word_count": job_final.get("written_content", {}).get("estimated_word_count", 0),
            "wp_post_id": job_final.get("wp_post_id"),
            "wp_post_url": job_final.get("wp_post_url", ""),
            "interlinks_added": links_added,
            "wp_status": job_final.get("wp_status", "draft"),
            "published_at": job_final.get("published_at", completed_at),
        }
        await db.autopilot_history.insert_one(history_doc)
    return {"interlinks_added": links_added}


# ---------- Pipeline orchestrator ----------

async def _autopilot_run_pipeline_bg(site_id: str, job_id: str = None):
    """Full 5-stage pipeline. Runs as background task."""
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
        ("publishing", "published", _autopilot_publish),
        ("interlinking", "completed", _autopilot_interlink),
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
        "wp_post_url": final_job.get("wp_post_url", ""),
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
async def autopilot_stream(site_id: str, current_user: dict = Depends(get_current_user)):
    """SSE endpoint — stream pipeline events for a site."""
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


@api_router.post("/autopilot/{site_id}/publish/{job_id}")
async def autopilot_publish_ep(
    site_id: str, job_id: str, current_user: dict = Depends(get_current_user)
):
    return await _autopilot_publish(site_id, job_id)


@api_router.post("/autopilot/{site_id}/interlink/{job_id}")
async def autopilot_interlink_ep(
    site_id: str, job_id: str, current_user: dict = Depends(get_current_user)
):
    return await _autopilot_interlink(site_id, job_id)


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
