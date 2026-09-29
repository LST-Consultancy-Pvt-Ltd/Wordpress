"""Deployments and backups through the bridge's configured profiles only.

The browser can name a deployment *profile*; it can never supply service
names, images or commands. Production deploy/rollback/restore require the
typed site-name confirmation, and every attempt is audited.
"""
import asyncio
import uuid
from urllib.parse import quote

from fastapi import Depends, HTTPException

from core.audit import audit, new_correlation_id
from core.confirm import require_production_confirmation, require_site_confirmation
from core.db import db
from core.router import api_router
from core.security import require_deployer, require_user
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from models.sites import BackupRequest, DeploymentRequest, DeploymentRollbackRequest, RestoreRequest, now_iso
from providers.bridge_client import BridgeError, new_idempotency_key, require_capability
from providers.sites import get_site, get_site_and_client

_background: set = set()


def _spawn(coro) -> None:
    t = asyncio.create_task(coro)
    _background.add(t)
    t.add_done_callback(_background.discard)


@api_router.get("/sites/{site_id}/deployments/profiles")
async def deployment_profiles(site_id: str, _: dict = Depends(require_user)):
    site, client = await get_site_and_client(site_id)
    require_capability(site, "deploy")
    try:
        return await client.request("GET", "/deployments/profiles")
    except BridgeError as e:
        raise e.to_http()


@api_router.get("/sites/{site_id}/deployments")
async def list_deployments(site_id: str, _: dict = Depends(require_user)):
    await get_site(site_id)
    return await db.deployments.find({"site_id": site_id}, {"_id": 0}).sort("started_at", -1).to_list(100)


@api_router.get("/deployments/{deployment_id}")
async def get_deployment(deployment_id: str, _: dict = Depends(require_user)):
    doc = await db.deployments.find_one({"id": deployment_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Deployment not found")
    return doc


async def _follow_deployment(dep: dict, site: dict, actor: dict, task_id: str, bridge_job_id: str):
    try:
        _, client = await get_site_and_client(site["id"])

        async def on_update(job):
            await push_event(task_id, "progress", {"stage": "deploy", "job": job})
            # Progress only; `status` changes once, from the final bridge record.
            await db.deployments.update_one({"id": dep["id"]}, {"$set": {"steps": job.get("steps", []),
                                                                        "job_status": job.get("status")}})

        job = await client.wait_job(bridge_job_id, on_update=on_update, poll=2.0)
        record = {}
        try:
            record = await client.request("GET", f"/deployments/{quote(dep['bridge_deployment_id'], safe='')}")
        except BridgeError:
            pass
        status = record.get("status") or ("succeeded" if job.get("status") == "succeeded" else "failed")
        update = {"status": status, "steps": record.get("steps") or job.get("steps", []),
                  "previous_image_id": record.get("previous_image_id"), "new_image_id": record.get("new_image_id"),
                  "finished_at": now_iso(), "error": job.get("error")}
        if status == "rolled_back":
            update["recovery"] = ("Verification failed; the bridge restored the previous image automatically. "
                                  "The site is running the previous version. Inspect the failed step's log.")
        elif status == "failed":
            update["recovery"] = ("The deployment failed and automatic rollback did not complete. Check the service "
                                  "status and redeploy the previous image from the deployment history.")
        await db.deployments.update_one({"id": dep["id"]}, {"$set": update})
        await audit("deployment.finish", actor=actor, site=site, target_type="deployment", target_id=dep["id"],
                    outcome="ok" if status == "succeeded" else "error", detail={"status": status})
        await push_event(task_id, "done" if status == "succeeded" else "error",
                         {"stage": "deploy", "status": status, "message": update.get("recovery", "")})
    except BridgeError as e:
        await db.deployments.update_one({"id": dep["id"]}, {"$set": {
            "status": "unknown", "error": f"{e.code}: {e.message}", "finished_at": now_iso(),
            "recovery": "Lost contact with the bridge while deploying; check ops status before retrying."}})
        await push_event(task_id, "error", {"stage": "deploy", "message": e.message})
    finally:
        await finish_task(task_id)


async def _start_deploy(site_id: str, actor: dict, *, body: dict, kind: str, reason: str, path: str) -> dict:
    site, client = await get_site_and_client(site_id)
    require_capability(site, "deploy")
    cid = new_correlation_id()
    try:
        started = await client.request("POST", path, body=body, idempotency_key=new_idempotency_key(kind),
                                       correlation_id=cid)
    except BridgeError as e:
        await audit(f"deployment.{kind}", actor=actor, site=site, outcome="error", correlation_id=cid,
                    detail={"code": e.code, **body})
        raise e.to_http()
    dep = {"id": "dep_" + uuid.uuid4().hex[:16], "site_id": site_id, "kind": kind,
           "profile": body.get("profile"), "reason": reason, "bridge_deployment_id": started.get("deployment_id"),
           "bridge_job_id": started.get("job_id"), "status": "running", "steps": [],
           "requested_by": actor.get("id"), "requested_by_email": actor.get("email"),
           "started_at": now_iso(), "correlation_id": cid}
    await db.deployments.insert_one(dict(dep))
    await audit(f"deployment.{kind}", actor=actor, site=site, target_type="deployment", target_id=dep["id"],
                correlation_id=cid, detail={"reason": reason, **body})
    task_id = make_task_id()
    await create_task_queue(task_id, f"deployment_{kind}", site_id)
    _spawn(_follow_deployment(dep, site, actor, task_id, started.get("job_id")))
    return {"deployment_id": dep["id"], "task_id": task_id}


@api_router.post("/sites/{site_id}/deployments")
async def deploy(site_id: str, body: DeploymentRequest, user: dict = Depends(require_deployer)):
    site = await get_site(site_id)
    require_production_confirmation(site, body.confirm, "deploy to production")
    return await _start_deploy(site_id, user, body={"profile": body.profile, "reason": body.reason},
                               kind="deploy", reason=body.reason, path="/deployments")


@api_router.post("/deployments/{deployment_id}/rollback")
async def rollback_deployment(deployment_id: str, body: DeploymentRollbackRequest,
                              user: dict = Depends(require_deployer)):
    dep = await db.deployments.find_one({"id": deployment_id}, {"_id": 0})
    if not dep or not dep.get("bridge_deployment_id"):
        raise HTTPException(status_code=404, detail="Deployment not found")
    site = await get_site(dep["site_id"])
    require_production_confirmation(site, body.confirm, "roll back a production deployment")
    return await _start_deploy(dep["site_id"], user, body={"reason": body.reason}, kind="rollback",
                               reason=body.reason,
                               path=f"/deployments/{quote(dep['bridge_deployment_id'], safe='')}/rollback")


# ---- Backups -----------------------------------------------------------------

@api_router.get("/sites/{site_id}/backups")
async def list_backups(site_id: str, _: dict = Depends(require_user)):
    site, client = await get_site_and_client(site_id)
    require_capability(site, "backups")
    try:
        return await client.request("GET", "/backups")
    except BridgeError as e:
        raise e.to_http()


@api_router.post("/sites/{site_id}/backups")
async def create_backup(site_id: str, body: BackupRequest, user: dict = Depends(require_deployer)):
    site, client = await get_site_and_client(site_id)
    require_capability(site, "backups")
    try:
        result = await client.request("POST", "/backups", body={"kind": body.kind},
                                      idempotency_key=new_idempotency_key("backup"))
    except BridgeError as e:
        await audit("backup.create", actor=user, site=site, outcome="error", detail={"code": e.code})
        raise e.to_http()
    await db.backups.insert_one({"site_id": site_id, "backup_id": result.get("backup_id"), "kind": body.kind,
                                 "created_by": user.get("id"), "created_at": now_iso()})
    await audit("backup.create", actor=user, site=site, target_type="backup", target_id=result.get("backup_id"),
                detail={"kind": body.kind})
    return result


@api_router.post("/sites/{site_id}/backups/{backup_id}/restore")
async def restore_backup(site_id: str, backup_id: str, body: RestoreRequest, user: dict = Depends(require_deployer)):
    site, client = await get_site_and_client(site_id)
    require_capability(site, "backups")
    if not body.dry_run:
        if body.confirm != backup_id:
            raise HTTPException(status_code=400, detail={"code": "CONFIRMATION_REQUIRED",
                                                         "message": "Type the backup id to confirm the restore"})
        require_site_confirmation(site, body.confirm_site, "restore a backup")
    try:
        result = await client.request("POST", f"/backups/{quote(backup_id, safe='')}/restore",
                                      body={"confirm": backup_id, "dry_run": body.dry_run},
                                      idempotency_key=new_idempotency_key("restore"))
    except BridgeError as e:
        await audit("backup.restore", actor=user, site=site, outcome="error", target_id=backup_id,
                    detail={"code": e.code, "dry_run": body.dry_run})
        raise e.to_http()
    health = None
    if not body.dry_run:
        try:
            health = await client.health()
        except BridgeError as e:
            health = {"status": "down", "error": e.code}
        result["post_restore_health"] = health
    await audit("backup.restore", actor=user, site=site, target_type="backup", target_id=backup_id,
                revision_id=result.get("revision_id"),
                outcome="ok" if body.dry_run or (health or {}).get("status") == "ok" else "error",
                detail={"dry_run": body.dry_run, "health": (health or {}).get("status")})
    return result
