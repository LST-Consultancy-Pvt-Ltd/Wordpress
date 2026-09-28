"""Root health endpoint, Authentication (register/login/me), global Settings
get/update, SSE task streaming + polling, and Scheduled Jobs CRUD.
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.responses import StreamingResponse

from core.activity import log_activity
from core.crypto import _SENSITIVE_SETTINGS_FIELDS, decrypt_field, encrypt_field
from core.automation_policy import automatic_writes_frozen
from core.db import db, mongo_client
from core.router import api_router
from core.scheduled_jobs import _schedule_job
from core.scheduler import scheduler
from core.security import (
    create_access_token, get_current_user, hash_password, require_admin,
    require_user, verify_password,
)
from core.tasks import get_durable_task_status, sse_generator
from models.legacy import (
    ScheduledJob, ScheduledJobCreate, Settings, SettingsUpdate, Token,
    UserCreate, UserLogin, UserResponse,
)

logger = logging.getLogger(__name__)

# ========================
# Routes: Root
# ========================

@api_router.get("/")
async def root():
    return {"message": "AI WordPress Management Platform API", "version": "2.0.0"}


@api_router.get("/health")
async def health_check():
    """Real health check (§15 monitoring) — no auth required, safe for a
    load balancer / uptime monitor. Pings MongoDB and reports scheduler
    state and whether the optional real-data providers (DataForSEO, Google
    Custom Search) are configured, so a degraded-but-up state is visible
    instead of every route just silently falling back to AI estimates."""
    checks = {}
    healthy = True

    try:
        await mongo_client.admin.command("ping")
        checks["mongodb"] = "ok"
    except Exception as e:
        checks["mongodb"] = f"error: {e}"
        healthy = False

    checks["scheduler"] = "running" if scheduler.running else "stopped"
    checks["automatic_site_writes"] = "frozen" if automatic_writes_frozen() else "enabled"

    try:
        from providers.dataforseo import _dfs_available
        checks["dataforseo_configured"] = await _dfs_available()
    except Exception:
        checks["dataforseo_configured"] = None
    try:
        from providers.google_cse import cse_available
        checks["google_cse_configured"] = await cse_available()
    except Exception:
        checks["google_cse_configured"] = None

    try:
        from core.ai import AI_DAILY_BUDGET_USD
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        spend_doc = await db.ai_daily_spend.find_one({"date": today})
        checks["ai_spend_today_usd"] = round((spend_doc or {}).get("total_cost", 0.0), 4)
        checks["ai_daily_budget_usd"] = AI_DAILY_BUDGET_USD
    except Exception:
        pass

    return {
        "status": "ok" if healthy else "degraded",
        "checks": checks,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

# ========================
# Routes: Authentication
# ========================

@api_router.post("/auth/register", response_model=Token)
async def register(user_data: UserCreate, current_user: Optional[dict] = Depends(get_current_user)):
    existing = await db.users.find_one({"email": user_data.email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    # First user becomes admin; subsequent registrations require admin auth (invite flow)
    user_count = await db.users.count_documents({})
    if user_count > 0:
        if not current_user or current_user.get("role") != "admin":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required to invite users")
    role = "admin" if user_count == 0 else user_data.role
    user_id = str(uuid.uuid4())
    user_doc = {
        "id": user_id,
        "email": user_data.email,
        "full_name": user_data.full_name or "",
        "password_hash": hash_password(user_data.password),
        "role": role,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.users.insert_one(user_doc)
    token = create_access_token({"sub": user_id})
    return Token(
        access_token=token,
        user=UserResponse(id=user_id, email=user_data.email, full_name=user_data.full_name, role=role, created_at=user_doc["created_at"])
    )

@api_router.post("/auth/login", response_model=Token)
async def login(user_data: UserLogin):
    user = await db.users.find_one({"email": user_data.email})
    if not user or not verify_password(user_data.password, user.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_access_token({"sub": user["id"]})
    return Token(
        access_token=token,
        user=UserResponse(id=user["id"], email=user["email"], full_name=user.get("full_name"), role=user.get("role", "admin"), created_at=user["created_at"])
    )

@api_router.get("/auth/me", response_model=UserResponse)
async def get_me(current_user: dict = Depends(require_user)):
    return UserResponse(**current_user)

# ========================
# Routes: Settings
# ========================

@api_router.get("/settings", response_model=Settings)
async def get_settings(_: dict = Depends(require_user)):
    """NOTE (§16 security): this used to have NO auth dependency at all — any
    unauthenticated client could read it. Several fields (google_search_api_key,
    pagespeed_api_key) also weren't masked like the others. Both are fixed here."""
    settings = await db.settings.find_one({"id": "global_settings"}, {"_id": 0})
    if not settings:
        return Settings()
    # Decrypt sensitive fields before masking for display
    for key in _SENSITIVE_SETTINGS_FIELDS:
        if settings.get(key):
            settings[key] = decrypt_field(settings[key])
    # Mask API keys for security
    if settings.get("openai_api_key"):
        settings["openai_api_key"] = "***" + settings["openai_api_key"][-4:] if len(settings["openai_api_key"]) > 4 else "****"
    if settings.get("anthropic_api_key"):
        settings["anthropic_api_key"] = "***" + settings["anthropic_api_key"][-4:] if len(settings["anthropic_api_key"]) > 4 else "****"
    if settings.get("google_analytics_credentials"):
        settings["google_analytics_credentials"] = "***configured***"
    if settings.get("google_search_console_credentials"):
        settings["google_search_console_credentials"] = "***configured***"
    if settings.get("dataforseo_login"):
        settings["dataforseo_login"] = "***" + settings["dataforseo_login"][-4:] if len(settings["dataforseo_login"]) > 4 else "****"
    if settings.get("dataforseo_password"):
        settings["dataforseo_password"] = "***" + settings["dataforseo_password"][-4:] if len(settings["dataforseo_password"]) > 4 else "****"
    if settings.get("pagespeed_api_key"):
        settings["pagespeed_api_key"] = "***" + settings["pagespeed_api_key"][-4:] if len(settings["pagespeed_api_key"]) > 4 else "****"
    if settings.get("google_search_api_key"):
        settings["google_search_api_key"] = "***" + settings["google_search_api_key"][-4:] if len(settings["google_search_api_key"]) > 4 else "****"
    if settings.get("smtp_username"):
        settings["smtp_username"] = "***" + settings["smtp_username"][-4:] if len(settings["smtp_username"]) > 4 else "****"
    if settings.get("smtp_password"):
        settings["smtp_password"] = "***configured***"
    if settings.get("hunter_api_key"):
        settings["hunter_api_key"] = "***" + settings["hunter_api_key"][-4:] if len(settings["hunter_api_key"]) > 4 else "****"
    if settings.get("signalhire_api_key"):
        settings["signalhire_api_key"] = "***" + settings["signalhire_api_key"][-4:] if len(settings["signalhire_api_key"]) > 4 else "****"
    if settings.get("semrush_api_key"):
        settings["semrush_api_key"] = "***" + settings["semrush_api_key"][-4:] if len(settings["semrush_api_key"]) > 4 else "****"
    return Settings(**settings)

@api_router.post("/settings", response_model=Settings)
async def update_settings(update: SettingsUpdate, _: dict = Depends(require_admin)):
    existing = await db.settings.find_one({"id": "global_settings"}, {"_id": 0})
    if not existing:
        existing = {"id": "global_settings"}

    update_data = update.model_dump(exclude_none=True)
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()

    for key, value in update_data.items():
        if isinstance(value, str) and value.startswith("***"):
            continue  # Skip masked/unchanged sensitive values
        if key in _SENSITIVE_SETTINGS_FIELDS and value:
            existing[key] = encrypt_field(value)
        else:
            existing[key] = value

    await db.settings.replace_one(
        {"id": "global_settings"},
        existing,
        upsert=True
    )

    # Return masked version (decrypt first for proper masking)
    response = existing.copy()
    for k in _SENSITIVE_SETTINGS_FIELDS:
        if response.get(k) and not str(response[k]).startswith("***"):
            response[k] = decrypt_field(str(response[k]))
    if response.get("openai_api_key"):
        response["openai_api_key"] = "***" + response["openai_api_key"][-4:] if len(response["openai_api_key"]) > 4 else "****"
    if response.get("anthropic_api_key"):
        response["anthropic_api_key"] = "***" + response["anthropic_api_key"][-4:] if len(response["anthropic_api_key"]) > 4 else "****"
    if response.get("google_analytics_credentials"):
        response["google_analytics_credentials"] = "***configured***"
    if response.get("google_search_console_credentials"):
        response["google_search_console_credentials"] = "***configured***"
    if response.get("dataforseo_login"):
        response["dataforseo_login"] = "***" + response["dataforseo_login"][-4:] if len(response["dataforseo_login"]) > 4 else "****"
    if response.get("dataforseo_password"):
        response["dataforseo_password"] = "***" + response["dataforseo_password"][-4:] if len(response["dataforseo_password"]) > 4 else "****"
    # These four were missing from this block (GET /settings masked them
    # correctly, but this separate POST-response block never did — found
    # while adding hunter_api_key; fixed for all of them here, not just the
    # new field).
    if response.get("google_search_api_key"):
        response["google_search_api_key"] = "***" + response["google_search_api_key"][-4:] if len(response["google_search_api_key"]) > 4 else "****"
    if response.get("pagespeed_api_key"):
        response["pagespeed_api_key"] = "***" + response["pagespeed_api_key"][-4:] if len(response["pagespeed_api_key"]) > 4 else "****"
    if response.get("smtp_username"):
        response["smtp_username"] = "***" + response["smtp_username"][-4:] if len(response["smtp_username"]) > 4 else "****"
    if response.get("smtp_password"):
        response["smtp_password"] = "***configured***"
    if response.get("hunter_api_key"):
        response["hunter_api_key"] = "***" + response["hunter_api_key"][-4:] if len(response["hunter_api_key"]) > 4 else "****"
    if response.get("signalhire_api_key"):
        response["signalhire_api_key"] = "***" + response["signalhire_api_key"][-4:] if len(response["signalhire_api_key"]) > 4 else "****"
    if response.get("semrush_api_key"):
        response["semrush_api_key"] = "***" + response["semrush_api_key"][-4:] if len(response["semrush_api_key"]) > 4 else "****"

    return Settings(**response)

# ========================
# Routes: SSE Streaming
# ========================

@api_router.get("/stream/{task_id}")
async def stream_task(task_id: str):
    return StreamingResponse(
        sse_generator(task_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )

@api_router.get("/tasks/{task_id}")
async def get_task_status(task_id: str):
    """REST polling endpoint for task status (used by subscribeToTask).

    Falls back to the durable `db.task_runs` record (core.tasks.create_task_queue/
    push_event/finish_task now persist there) if the in-memory store doesn't have
    it — e.g. because the process restarted after the task ran (§9)."""
    status_doc = await get_durable_task_status(task_id)
    if status_doc is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return status_doc

# ========================
# Routes: Scheduled Jobs
# ========================

@api_router.get("/jobs/{site_id}")
async def get_jobs(site_id: str, current_user: Optional[dict] = Depends(get_current_user)):
    user_id = current_user["id"] if current_user else "global"
    jobs = await db.scheduled_jobs.find({"site_id": site_id, "user_id": user_id}, {"_id": 0}).to_list(50)
    return jobs

@api_router.post("/jobs")
async def create_job(job_data: ScheduledJobCreate, current_user: Optional[dict] = Depends(get_current_user)):
    user_id = current_user["id"] if current_user else "global"
    job = ScheduledJob(**job_data.model_dump(), user_id=user_id)
    await db.scheduled_jobs.insert_one(job.model_dump())
    _schedule_job(job.model_dump())
    await log_activity(job_data.site_id, "job_created", f"Scheduled job created: {job_data.job_type}", user_id=user_id)
    return job.model_dump()

@api_router.put("/jobs/{job_id}")
async def update_job(job_id: str, job_data: ScheduledJobCreate, current_user: Optional[dict] = Depends(get_current_user)):
    user_id = current_user["id"] if current_user else "global"
    update = job_data.model_dump()
    update["user_id"] = user_id
    result = await db.scheduled_jobs.update_one({"id": job_id}, {"$set": update})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Job not found")
    job = await db.scheduled_jobs.find_one({"id": job_id}, {"_id": 0})
    _schedule_job(job)
    return job

@api_router.delete("/jobs/{job_id}")
async def delete_job(job_id: str, current_user: Optional[dict] = Depends(get_current_user)):
    result = await db.scheduled_jobs.delete_one({"id": job_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Job not found")
    try:
        scheduler.remove_job(job_id)
    except Exception:
        pass
    return {"message": "Job deleted"}
