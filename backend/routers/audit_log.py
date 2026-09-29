"""Control-plane audit trail and stream tokens."""
from typing import Optional

from fastapi import Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from core.db import db
from core.router import api_router
from core.security import create_stream_token, require_user
from core.tasks import get_durable_task_status


@api_router.get("/audit")
async def list_audit(site_id: Optional[str] = None, actor: Optional[str] = None, action: Optional[str] = None,
                     change_id: Optional[str] = None, cursor: Optional[str] = None,
                     limit: int = Query(50, ge=1, le=200), _: dict = Depends(require_user)):
    query: dict = {}
    if site_id:
        query["site_id"] = site_id
    if actor:
        query["actor_id"] = actor
    if action:
        query["action"] = {"$regex": "^" + "".join(c for c in action if c.isalnum() or c in "._-")}
    if change_id:
        query["change_id"] = change_id
    if cursor:
        query["at"] = {"$lt": cursor}
    items = await db.audit_events.find(query, {"_id": 0}).sort("at", -1).to_list(limit + 1)
    return {"items": items[:limit], "next_cursor": items[limit - 1]["at"] if len(items) > limit else None}


class StreamTokenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_id: str


@api_router.post("/stream-token")
async def stream_token(body: StreamTokenRequest, user: dict = Depends(require_user)):
    if body.task_id.startswith("autopilot:"):
        # Long-lived per-site autopilot event stream rather than a task.
        if not await db.sites.find_one({"id": body.task_id.split(":", 1)[1]}, {"_id": 1}):
            raise HTTPException(status_code=404, detail="Site not found")
    elif await get_durable_task_status(body.task_id) is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"token": create_stream_token(user["id"], body.task_id), "expires_in": 120}
