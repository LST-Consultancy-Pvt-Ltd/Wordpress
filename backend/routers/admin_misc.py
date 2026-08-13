"""Activity Logs, Dashboard Stats, and User Management (list users, change role).
"""
from typing import List, Optional

from fastapi import Depends, HTTPException
from pydantic import BaseModel

from core.activity import ActivityLog
from core.db import db
from core.router import api_router
from core.security import get_current_user, require_admin

# ========================
# Routes: Activity Logs
# ========================

@api_router.get("/activity/{site_id}", response_model=List[ActivityLog])
async def get_activity_logs(site_id: str, limit: int = 50):
    logs = await db.activity_logs.find(
        {"site_id": site_id},
        {"_id": 0}
    ).sort("created_at", -1).to_list(limit)
    return logs

@api_router.get("/activity")
async def get_all_activity_logs(limit: int = 100, current_user: Optional[dict] = Depends(get_current_user)):
    query = {}
    if current_user:
        query["user_id"] = current_user["id"]
    logs = await db.activity_logs.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit)
    return logs

# ========================
# Routes: Dashboard Stats
# ========================

@api_router.get("/dashboard/stats")
async def get_dashboard_stats(current_user: Optional[dict] = Depends(get_current_user)):
    query = {}
    if current_user:
        query["user_id"] = current_user["id"]
    sites_count = await db.sites.count_documents(query)
    site_ids = [s["id"] async for s in db.sites.find(query, {"id": 1, "_id": 0})]
    pages_count = await db.pages.count_documents({"site_id": {"$in": site_ids}}) if site_ids else 0
    posts_count = await db.posts.count_documents({"site_id": {"$in": site_ids}}) if site_ids else 0
    ai_commands_count = await db.ai_commands.count_documents({"site_id": {"$in": site_ids}}) if site_ids else 0
    scheduled_jobs_count = await db.scheduled_jobs.count_documents({"user_id": current_user["id"] if current_user else "global"})

    activity_query = {"site_id": {"$in": site_ids}} if site_ids else {}
    recent_activity = await db.activity_logs.find(activity_query, {"_id": 0}).sort("created_at", -1).to_list(10)
    sites = await db.sites.find(query, {"_id": 0, "app_password": 0}).to_list(10)

    return {
        "total_sites": sites_count,
        "total_pages": pages_count,
        "total_posts": posts_count,
        "ai_commands_executed": ai_commands_count,
        "scheduled_jobs": scheduled_jobs_count,
        "recent_activity": recent_activity,
        "sites": sites
    }

# ========================
# Routes: User Management
# ========================

class RoleUpdate(BaseModel):
    role: str  # "admin" | "editor" | "viewer"

@api_router.get("/users")
async def list_users(_: dict = Depends(require_admin)):
    """Return all users (admin only). Passwords excluded."""
    users = await db.users.find({}, {"_id": 0, "password_hash": 0}).to_list(500)
    return users

@api_router.patch("/users/{user_id}/role")
async def update_user_role(user_id: str, body: RoleUpdate, _: dict = Depends(require_admin)):
    """Change a user's role (admin only)."""
    if body.role not in ("admin", "editor", "viewer"):
        raise HTTPException(status_code=400, detail="role must be one of admin, editor, viewer")
    result = await db.users.update_one({"id": user_id}, {"$set": {"role": body.role}})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    return {"message": f"Role updated to {body.role}"}
