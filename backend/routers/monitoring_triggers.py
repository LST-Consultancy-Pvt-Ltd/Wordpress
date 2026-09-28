"""
Event-Based Autopilot Triggers (Module 12) and Multi-Region Uptime Checks (Module 3).

`_check_rank_drop_triggers` and `_check_new_keyword_triggers` are imported back into
server.py's lifespan() startup function, where they are scheduled as cron jobs.
"""
from fastapi import Depends
from pydantic import BaseModel
from datetime import datetime, timezone, timedelta
import asyncio
import uuid
import httpx

from core.db import db
from core.security import get_current_user, require_editor
from core.activity import log_activity
from core.automation_policy import skip_if_frozen
from providers.wordpress import get_wp_credentials
from routers.autopilot import _autopilot_run_pipeline_bg
from core.router import api_router
from providers.content import get_site_any  # the shared APIRouter instance

# FEATURE: Event-Based Autopilot Triggers (Module 12)
# ========================

class AutopilotTriggerSettings(BaseModel):
    rank_drop_threshold: int = 5
    rank_drop_enabled: bool = False
    new_keyword_trigger: bool = False

@api_router.get("/autopilot/{site_id}/trigger-settings")
async def get_trigger_settings(site_id: str, _=Depends(get_current_user)):
    doc = await db.autopilot_triggers.find_one({"site_id": site_id}, {"_id": 0})
    return doc or {"site_id": site_id, "rank_drop_threshold": 5, "rank_drop_enabled": False, "new_keyword_trigger": False}

@api_router.post("/autopilot/{site_id}/trigger-settings")
async def save_trigger_settings(site_id: str, data: AutopilotTriggerSettings, _=Depends(require_editor)):
    await db.autopilot_triggers.replace_one({"site_id": site_id},
        {"site_id": site_id, **data.model_dump(), "updated_at": datetime.now(timezone.utc).isoformat()}, upsert=True)
    return {"ok": True}

async def _check_rank_drop_triggers():
    """Nightly watcher: check if tracked keywords dropped by >N positions → trigger content refresh."""
    triggers = await db.autopilot_triggers.find({"rank_drop_enabled": True}, {"_id": 0}).to_list(100)
    for trig in triggers:
        site_id = trig["site_id"]
        threshold = trig.get("rank_drop_threshold", 5)
        snapshots = await db.tracked_keywords.find({"site_id": site_id}, {"_id": 0}).sort("tracked_at", -1).limit(2).to_list(2)
        if len(snapshots) < 2:
            continue
        latest = {kw["keyword"]: kw.get("position", 0) for kw in snapshots[0].get("keywords", [])}
        previous = {kw["keyword"]: kw.get("position", 0) for kw in snapshots[1].get("keywords", [])}
        dropped = []
        for kw, pos in latest.items():
            prev_pos = previous.get(kw)
            if prev_pos and pos > 0 and prev_pos > 0 and (pos - prev_pos) >= threshold:
                dropped.append({"keyword": kw, "from": prev_pos, "to": pos, "drop": pos - prev_pos})
        if dropped:
            worst = max(dropped, key=lambda d: d["drop"])
            await log_activity(site_id, "rank_drop_trigger", f"Keyword '{worst['keyword']}' dropped from #{worst['from']} to #{worst['to']}")
            job_id = str(uuid.uuid4())
            frozen = skip_if_frozen(f"autopilot pipeline queued by trigger for site {site_id}")
            await db.autopilot_jobs.insert_one({"id": job_id, "site_id": site_id, "status": "skipped: automatic writes frozen" if frozen else "queued",
                "trigger": "rank_drop", "trigger_data": dropped, "created_at": datetime.now(timezone.utc).isoformat()})
            if not frozen:
                asyncio.create_task(_autopilot_run_pipeline_bg(site_id, job_id))

async def _check_new_keyword_triggers():
    """Check for newly added keywords → auto-queue pipeline run."""
    triggers = await db.autopilot_triggers.find({"new_keyword_trigger": True}, {"_id": 0}).to_list(100)
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    for trig in triggers:
        site_id = trig["site_id"]
        new_kws = await db.keyword_tracking.find({"site_id": site_id, "added_at": {"$gte": cutoff}}, {"_id": 0}).to_list(10)
        if new_kws:
            await log_activity(site_id, "new_keyword_trigger", f"{len(new_kws)} new keywords — queuing pipeline")
            job_id = str(uuid.uuid4())
            frozen = skip_if_frozen(f"autopilot pipeline queued by trigger for site {site_id}")
            await db.autopilot_jobs.insert_one({"id": job_id, "site_id": site_id, "status": "skipped: automatic writes frozen" if frozen else "queued",
                "trigger": "new_keyword", "trigger_data": [k.get("keyword", "") for k in new_kws],
                "created_at": datetime.now(timezone.utc).isoformat()})
            if not frozen:
                asyncio.create_task(_autopilot_run_pipeline_bg(site_id, job_id))


# ========================
# FEATURE: Multi-Region Uptime Checks (Module 3)
# ========================

@api_router.post("/uptime/{site_id}/multi-region")
async def multi_region_uptime_check(site_id: str, _=Depends(require_editor)):
    """Check site availability simulating multiple regions."""
    # Availability probe of the public URL — platform-agnostic.
    site = await get_site_any(site_id, _["id"])
    site_url = site["url"].rstrip("/")
    import time as _time

    regions = [{"name": "US-East"}, {"name": "EU-West"}, {"name": "Asia-Pacific"}]
    regions_results = []
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        for region in regions:
            try:
                t0 = _time.monotonic()
                resp = await client.get(site_url, headers={"X-Check-Region": region["name"]})
                latency = round((_time.monotonic() - t0) * 1000)
                regions_results.append({"region": region["name"], "status_code": resp.status_code,
                    "online": resp.status_code < 500, "latency_ms": latency})
            except Exception as e:
                regions_results.append({"region": region["name"], "status_code": 0, "online": False, "latency_ms": None, "error": str(e)})

    avg_latency = round(sum(r["latency_ms"] for r in regions_results if r.get("latency_ms")) /
                        max(sum(1 for r in regions_results if r.get("latency_ms")), 1))
    all_online = all(r["online"] for r in regions_results)
    result = {"site_id": site_id, "checked_at": datetime.now(timezone.utc).isoformat(),
              "all_online": all_online, "avg_latency_ms": avg_latency, "regions": regions_results}
    await db.uptime_checks.insert_one({**result, "id": str(uuid.uuid4()), "check_type": "multi_region"})
    await log_activity(site_id, "multi_region_uptime", f"Multi-region: {'all online' if all_online else 'issues'}, avg {avg_latency}ms")
    return result


# ========================
