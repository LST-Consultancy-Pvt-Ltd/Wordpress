"""APScheduler job functions for the user-configurable "Scheduled Jobs" feature
(content freshness scans, daily SEO health checks). Both are read-only: no
scheduled job writes to a site — site changes go through change sets.
Also `_schedule_job`/`restore_scheduled_jobs` which (re)register them with the
shared scheduler. `restore_scheduled_jobs` is called once from server.py's
`lifespan()` at startup; `_schedule_job` is called from the jobs CRUD routes
whenever a job is created/updated.
"""
from datetime import datetime, timezone

from apscheduler.triggers.interval import IntervalTrigger

from core.activity import log_activity
from core.db import db
from core.scheduler import scheduler


async def run_content_freshness_scan(job_id: str, site_id: str, user_id: str):
    """Weekly: scan content for staleness."""
    try:
        all_content = await db.content_items.find({"site_id": site_id}, {"_id": 0, "body": 0}).to_list(1000)
        stale = []
        for content in all_content:
            modified = content.get("updated_at") or ""
            if modified:
                try:
                    modified_date = datetime.fromisoformat(modified.replace("Z", "+00:00"))
                    age_days = (datetime.now(timezone.utc) - modified_date).days
                    if age_days > 90:
                        stale.append(content.get("title", "Unknown"))
                except Exception:
                    pass
        details = f"Freshness scan: {len(stale)} stale items found (age >90d)"
        await log_activity(site_id, "scheduled_freshness_scan", details, "success", user_id)
        await db.scheduled_jobs.update_one(
            {"id": job_id},
            {"$set": {"last_run": datetime.now(timezone.utc).isoformat(), "last_run_status": "success"}}
        )
    except Exception as e:
        await db.scheduled_jobs.update_one(
            {"id": job_id},
            {"$set": {"last_run": datetime.now(timezone.utc).isoformat(), "last_run_status": f"error: {e}"}}
        )

async def run_seo_health_check(job_id: str, site_id: str, user_id: str):
    """Daily: SEO health check + self-heal."""
    try:
        metrics = await db.seo_metrics.find({"site_id": site_id}, {"_id": 0}).to_list(100)
        issues = [m for m in metrics if m.get("ctr", 100) < 2 or m.get("ranking", 0) > 20]
        details = f"Daily SEO check: {len(metrics)} pages checked, {len(issues)} issues found"
        await log_activity(site_id, "scheduled_seo_check", details, "success", user_id)
        await db.scheduled_jobs.update_one(
            {"id": job_id},
            {"$set": {"last_run": datetime.now(timezone.utc).isoformat(), "last_run_status": "success"}}
        )
    except Exception as e:
        await db.scheduled_jobs.update_one(
            {"id": job_id},
            {"$set": {"last_run": datetime.now(timezone.utc).isoformat(), "last_run_status": f"error: {e}"}}
        )

async def restore_scheduled_jobs():
    """On startup, re-register all enabled jobs from MongoDB."""
    jobs = await db.scheduled_jobs.find({"enabled": True}, {"_id": 0}).to_list(500)
    for job in jobs:
        _schedule_job(job)

def _schedule_job(job: dict):
    job_id = job["id"]
    site_id = job["site_id"]
    user_id = job.get("user_id", "global")
    job_type = job["job_type"]

    # Remove existing job if any
    try:
        scheduler.remove_job(job_id)
    except Exception:
        pass

    if not job.get("enabled", True):
        return

    if job_type == "content_freshness":
        scheduler.add_job(
            run_content_freshness_scan,
            trigger=IntervalTrigger(weeks=1),
            id=job_id,
            args=[job_id, site_id, user_id],
            replace_existing=True,
            misfire_grace_time=3600,
        )
    elif job_type == "seo_health":
        scheduler.add_job(
            run_seo_health_check,
            trigger=IntervalTrigger(hours=24),
            id=job_id,
            args=[job_id, site_id, user_id],
            replace_existing=True,
            misfire_grace_time=3600,
        )
