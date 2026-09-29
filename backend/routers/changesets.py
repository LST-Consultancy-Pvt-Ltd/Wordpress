"""Change-set API (protocol/control-plane-api.md "Change sets").

Role boundaries: viewer reads; editor proposes/edits/plans/validates/
previews/submits/cancels; deployer approves/rejects/applies/rolls back.
"""
from typing import Optional

from fastapi import Depends, Query

from core import changesets as svc
from core.db import db
from core.router import api_router
from core.security import require_deployer, require_editor, require_user
from models.sites import (
    ApplyRequest,
    ChangeSetCreate,
    ChangeSetStatus,
    ChangeSetUpdate,
    ReviewDecision,
    RollbackRequest,
    ValidateRequest,
)
from providers.sites import get_site


@api_router.post("/sites/{site_id}/changesets", status_code=201)
async def create(site_id: str, body: ChangeSetCreate, user: dict = Depends(require_editor)):
    # `source` is decided by the server: auto-apply policies can target
    # sources, so a client must not be able to claim to be e.g. "autopilot".
    return await svc.create_changeset(site_id, title=body.title, description=body.description,
                                      operations=body.operations, source="manual", actor=user)


@api_router.get("/sites/{site_id}/changesets")
async def list_for_site(site_id: str, status: Optional[ChangeSetStatus] = None,
                        cursor: Optional[str] = None, limit: int = Query(50, ge=1, le=200),
                        _: dict = Depends(require_user)):
    await get_site(site_id)
    query: dict = {"site_id": site_id}
    if status:
        query["status"] = status.value
    if cursor:
        query["created_at"] = {"$lt": cursor}
    items = await db.changesets.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit + 1)
    next_cursor = items[limit - 1]["created_at"] if len(items) > limit else None
    return {"items": items[:limit], "next_cursor": next_cursor}


@api_router.get("/changesets")
async def list_all(status: Optional[ChangeSetStatus] = None, site_id: Optional[str] = None,
                   cursor: Optional[str] = None, limit: int = Query(50, ge=1, le=200),
                   _: dict = Depends(require_user)):
    query: dict = {}
    if status:
        query["status"] = status.value
    if site_id:
        query["site_id"] = site_id
    if cursor:
        query["created_at"] = {"$lt": cursor}
    items = await db.changesets.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit + 1)
    next_cursor = items[limit - 1]["created_at"] if len(items) > limit else None
    return {"items": items[:limit], "next_cursor": next_cursor}


@api_router.get("/changesets/{cs_id}")
async def get_one(cs_id: str, _: dict = Depends(require_user)):
    return await svc.get_changeset(cs_id)


@api_router.put("/changesets/{cs_id}")
async def update(cs_id: str, body: ChangeSetUpdate, user: dict = Depends(require_editor)):
    return await svc.update_changeset(cs_id, actor=user, title=body.title, description=body.description,
                                      operations=body.operations)


@api_router.post("/changesets/{cs_id}/plan")
async def plan(cs_id: str, user: dict = Depends(require_editor)):
    return await svc.replan(cs_id, actor=user)


@api_router.post("/changesets/{cs_id}/validate")
async def validate(cs_id: str, body: ValidateRequest, user: dict = Depends(require_deployer)):
    """Deployer only: validation builds and runs the proposed code on the site
    host, which is as powerful as applying it."""
    return await svc.start_validation(cs_id, actor=user, steps=body.steps)


@api_router.post("/changesets/{cs_id}/preview")
async def preview(cs_id: str, user: dict = Depends(require_deployer)):
    return await svc.start_preview(cs_id, actor=user)


@api_router.post("/changesets/{cs_id}/submit")
async def submit(cs_id: str, user: dict = Depends(require_editor)):
    return await svc.submit(cs_id, actor=user)


@api_router.post("/changesets/{cs_id}/approve")
async def approve(cs_id: str, body: ReviewDecision, user: dict = Depends(require_deployer)):
    return await svc.review(cs_id, actor=user, decision="approved", comment=body.comment)


@api_router.post("/changesets/{cs_id}/reject")
async def reject(cs_id: str, body: ReviewDecision, user: dict = Depends(require_deployer)):
    return await svc.review(cs_id, actor=user, decision="rejected", comment=body.comment)


@api_router.post("/changesets/{cs_id}/apply")
async def apply(cs_id: str, body: ApplyRequest, user: dict = Depends(require_deployer)):
    return await svc.start_apply(cs_id, actor=user, confirm=body.confirm)


@api_router.post("/changesets/{cs_id}/rollback")
async def rollback(cs_id: str, body: RollbackRequest, user: dict = Depends(require_deployer)):
    return await svc.start_rollback(cs_id, actor=user, confirm=body.confirm, reason=body.reason)


@api_router.post("/changesets/{cs_id}/cancel")
async def cancel(cs_id: str, user: dict = Depends(require_editor)):
    return await svc.cancel(cs_id, actor=user)
