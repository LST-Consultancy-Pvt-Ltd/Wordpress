"""Activity Logs, Dashboard Stats, and User Management (list users, change role).
"""
from typing import List, Optional

from fastapi import Depends, HTTPException
from pydantic import BaseModel

from core.activity import ActivityLog
from core.db import db
from core.router import api_router
from core.security import ROLE_ORDER, get_current_user, require_admin, require_user

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
async def get_dashboard_stats(current_user: dict = Depends(require_user)):
    sites = await db.sites.find({}, {"_id": 0, "connection.secret_enc": 0}).to_list(500)
    site_ids = [s["id"] for s in sites]
    in_sites = {"site_id": {"$in": site_ids}}
    return {
        "total_sites": len(sites),
        "connected_sites": sum(1 for s in sites if (s.get("connection") or {}).get("status") == "connected"),
        "write_enabled_sites": sum(1 for s in sites if s.get("writes_enabled")),
        "content_items": await db.content_items.count_documents(in_sites) if site_ids else 0,
        "changesets_pending_approval": await db.changesets.count_documents({**in_sites, "status": "pending_approval"}),
        "changesets_failed": await db.changesets.count_documents({**in_sites, "status": "apply_failed"}),
        "ai_commands_executed": await db.ai_commands.count_documents(in_sites) if site_ids else 0,
        "scheduled_jobs": await db.scheduled_jobs.count_documents({"user_id": current_user["id"]}),
        "recent_activity": await db.activity_logs.find(in_sites if site_ids else {}, {"_id": 0})
                                              .sort("created_at", -1).to_list(10),
        "sites": sites[:10],
    }

# ========================
# Routes: User Management
# ========================

class RoleUpdate(BaseModel):
    role: str  # one of core.security.ROLE_ORDER

@api_router.get("/users")
async def list_users(_: dict = Depends(require_admin)):
    """Return all users (admin only). Passwords excluded."""
    users = await db.users.find({}, {"_id": 0, "password_hash": 0}).to_list(500)
    return users

@api_router.patch("/users/{user_id}/role")
async def update_user_role(user_id: str, body: RoleUpdate, _: dict = Depends(require_admin)):
    """Change a user's role (admin only)."""
    if body.role not in ROLE_ORDER:
        raise HTTPException(status_code=400, detail=f"role must be one of {', '.join(ROLE_ORDER)}")
    result = await db.users.update_one({"id": user_id}, {"$set": {"role": body.role}})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    return {"message": f"Role updated to {body.role}"}
