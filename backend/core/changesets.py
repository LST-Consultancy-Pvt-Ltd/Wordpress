"""Change-set pipeline: propose → plan (diff) → validate/preview → submit →
approve → apply → verify → revision → rollback.

Invariants enforced here (not in the routers, so every producer — UI,
autopilot, AI agent, SEO tools — goes through them):

- Nothing reaches a site except via `apply_changeset` / `rollback_changeset`.
- An approval is bound to the plan's diff hash; re-planning with a different
  diff discards approvals.
- Apply requires: status `approved`, a valid plan, site writes enabled, and
  (for file operations, when the policy says so) a passed validation of that
  same diff. The bridge re-checks the diff hash and base revision.
- Auto-apply only happens when the site policy explicitly matches the
  environment, source, every operation type and the risk level; it is
  recorded as an approval by `policy` and audited.
"""
import asyncio
import hashlib
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException

from core.audit import audit, new_correlation_id
from core.automation_policy import automatic_writes_frozen
from core.db import db
from core.security import has_role
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from models.sites import (
    EDITABLE_STATES,
    RISK_ORDER,
    TERMINAL_STATES,
    SitePolicy,
    now_iso,
)
from models.sites import (
    ChangeSetStatus as S,
)
from providers.bridge_client import BridgeError, capability_enabled
from providers.sites import get_site_and_client

logger = logging.getLogger(__name__)

OP_CAPABILITY = {
    "content.upsert": "content.write", "content.delete": "content.write",
    "metadata.set": "metadata.write", "metadata.clear": "metadata.write",
    "block.set": "blocks.write", "block.clear": "blocks.write",
    "image.alt.set": "images.alt.write", "image.alt.clear": "images.alt.write",
    "redirect.upsert": "redirects.write", "redirect.delete": "redirects.write",
    "file.write": "files.patch", "file.delete": "files.patch",
}
PRE_APPLY_CANCELLABLE = {S.draft, S.planned, S.plan_failed, S.validating, S.validated, S.validation_failed,
                         S.pending_approval, S.approved, S.rejected}

POLICY_ACTOR = {"id": "policy", "email": "auto-apply policy", "role": "system"}

# Background tasks must be referenced or asyncio may garbage-collect them.
_background: set = set()


def _spawn(coro) -> None:
    t = asyncio.create_task(coro)
    _background.add(t)
    t.add_done_callback(_background.discard)


def _sha256(text: str) -> str:
    return hashlib.sha256((text or "").encode()).hexdigest()


def approval_hash(plan: dict) -> str:
    """What an approval is bound to: the rendered diff AND every file's
    resulting content hash, so content that renders identically in a diff
    (binary files) cannot be swapped under an existing approval."""
    files = sorted((f.get("root", ""), f.get("path", ""), f.get("change", ""), f.get("after_sha256") or "")
                   for f in plan.get("files") or [])
    return _sha256((plan.get("diff") or "") + "\n" + repr(files))


def _bad(status: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message, **extra})


async def get_policy(site_id: str) -> SitePolicy:
    doc = await db.site_policies.find_one({"site_id": site_id}, {"_id": 0, "site_id": 0})
    return SitePolicy(**(doc or {}))


async def get_changeset(cs_id: str) -> dict:
    doc = await db.changesets.find_one({"id": cs_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Change set not found")
    return doc


def validate_operations_shape(operations: list) -> None:
    for i, op in enumerate(operations):
        if not isinstance(op, dict) or op.get("op") not in OP_CAPABILITY:
            raise _bad(400, "OPERATION_NOT_ALLOWED",
                       f"operation {i}: unknown or missing 'op' (allowed: {', '.join(sorted(OP_CAPABILITY))})")


def missing_capabilities(site: dict, operations: list) -> list[str]:
    needed = {OP_CAPABILITY[o["op"]] for o in operations if o.get("op") in OP_CAPABILITY}
    return sorted(c for c in needed if not capability_enabled(site, c))


def policy_checks(site: dict, cs: dict, policy: SitePolicy) -> list[dict]:
    ops = cs.get("operations") or []
    missing = missing_capabilities(site, ops)
    has_files = any(o.get("op", "").startswith("file.") for o in ops)
    plan = cs.get("plan") or {}
    validation = cs.get("validation") or {}
    checks = [
        {"name": "writes_enabled", "ok": bool(site.get("writes_enabled")),
         "message": "Writes are enabled for this site" if site.get("writes_enabled")
         else "Writes are disabled for this site; an admin must verify and enable them before anything can be applied"},
        {"name": "capabilities", "ok": not missing,
         "message": "The bridge supports every operation" if not missing
         else f"The bridge does not offer: {', '.join(missing)}"},
        {"name": "operation_limit", "ok": len(ops) <= policy.limits.max_operations_per_changeset,
         "message": f"{len(ops)} of max {policy.limits.max_operations_per_changeset} operations"},
        {"name": "plan_valid", "ok": bool(plan.get("valid")),
         "message": "Plan is valid" if plan.get("valid") else "No valid plan yet"},
    ]
    if has_files and policy.require_validation_for_file_ops:
        ok = validation.get("status") == "succeeded" and validation.get("diff_sha256") == plan.get("approval_sha256")
        checks.append({"name": "validation_for_file_ops", "ok": ok,
                       "message": "Validation passed for this exact diff" if ok
                       else "Code changes must pass validation (format/lint/typecheck/build/test) before approval; "
                            "a deployer runs it"})
    return checks


def auto_apply_allowed(site: dict, cs: dict, policy: SitePolicy) -> bool:
    ap = policy.auto_apply
    if automatic_writes_frozen():
        return False
    plan = cs.get("plan") or {}
    risk = (plan.get("risk") or {}).get("level", "high")
    return bool(
        ap.enabled
        and site.get("environment") in [e.value for e in ap.environments]
        and (not ap.sources or cs.get("source") in ap.sources)
        and all(o.get("op") in ap.ops for o in cs.get("operations") or [])
        and risk in RISK_ORDER and RISK_ORDER.index(risk) <= RISK_ORDER.index(ap.max_risk)
        and plan.get("valid") and not plan.get("warnings")
        and site.get("writes_enabled")
    )


async def _save(cs_id: str, update: dict, expect_status: Optional[set] = None) -> dict:
    """Update with optimistic status check so two concurrent transitions
    cannot both succeed (e.g. double apply)."""
    update = {**update, "updated_at": now_iso()}
    query: dict = {"id": cs_id}
    if expect_status is not None:
        query["status"] = {"$in": [s.value if hasattr(s, "value") else s for s in expect_status]}
    res = await db.changesets.update_one(query, {"$set": update})
    if res.matched_count == 0:
        current = await get_changeset(cs_id)
        raise _bad(409, "INVALID_STATE", f"change set is '{current['status']}'; this action is not allowed now")
    return await get_changeset(cs_id)


async def _plan(site: dict, client, cs: dict) -> dict:
    try:
        result = await client.plan(cs["id"], cs["operations"], None)
    except BridgeError as e:
        if e.status in (400, 422):
            return {"valid": False, "errors": [{"index": None, "code": e.code, "message": e.message,
                                                "details": e.details}], "warnings": [], "diff": "",
                    "diff_sha256": _sha256(""), "approval_sha256": _sha256(""), "files": [], "impacted_routes": [],
                    "risk": {"level": "high", "flags": []}, "planned_at": now_iso(), "base_revision": None}
        raise e.to_http()
    result["diff_sha256"] = _sha256(result.get("diff", ""))
    result["approval_sha256"] = approval_hash(result)
    result["planned_at"] = now_iso()
    result["base_revision"] = result.get("current_revision")
    return result


async def enforce_rate_limit(site_id: str, policy: SitePolicy) -> None:
    since = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    count = await db.changesets.count_documents({"site_id": site_id, "created_at": {"$gte": since}})
    if count >= policy.limits.max_changesets_per_day:
        raise _bad(429, "CHANGESET_LIMIT",
                   f"This site already has {count} change sets in the last 24 hours "
                   f"(policy limit {policy.limits.max_changesets_per_day}).")


async def create_changeset(site_id: str, *, title: str, operations: list, actor: dict, source: str = "manual",
                           description: str = "", require_capabilities: bool = True) -> dict:
    validate_operations_shape(operations)
    site, client = await get_site_and_client(site_id)
    policy = await get_policy(site_id)
    if len(operations) > policy.limits.max_operations_per_changeset:
        raise _bad(400, "TOO_MANY_OPERATIONS",
                   f"{len(operations)} operations exceeds the site policy limit of "
                   f"{policy.limits.max_operations_per_changeset}")
    missing = missing_capabilities(site, operations)
    if missing and require_capabilities:
        raise HTTPException(status_code=422, detail={
            "code": "CAPABILITY_UNSUPPORTED", "capability": missing[0],
            "message": f"This site's bridge does not offer: {', '.join(missing)}"})
    await enforce_rate_limit(site_id, policy)

    cid = new_correlation_id()
    cs = {
        "id": "cs_" + uuid.uuid4().hex[:20], "site_id": site_id, "title": title, "description": description,
        "source": source, "status": S.draft.value, "operations": operations, "plan": None, "validation": None,
        "preview": None, "policy_checks": [], "approvals": [], "apply": None, "rollback": None,
        "created_by": actor.get("id"), "created_by_email": actor.get("email"), "authors": [actor.get("id")],
        "created_at": now_iso(), "updated_at": now_iso(), "correlation_id": cid,
        "environment": site.get("environment"),
    }
    await db.changesets.insert_one(dict(cs))
    plan = await _plan(site, client, cs)
    cs["plan"] = plan
    status = S.planned if plan.get("valid") else S.plan_failed
    cs = await _save(cs["id"], {"plan": plan, "status": status.value,
                                "policy_checks": policy_checks(site, cs, policy)})
    await audit("changeset.create", actor=actor, site=site, change_id=cs["id"], correlation_id=cid,
                target_type="changeset", target_id=cs["id"],
                detail={"source": source, "operations": len(operations), "status": cs["status"],
                        "risk": (plan.get("risk") or {}).get("level")})
    return cs


async def update_changeset(cs_id: str, *, actor: dict, title=None, description=None, operations=None) -> dict:
    cs = await get_changeset(cs_id)
    if S(cs["status"]) not in EDITABLE_STATES:
        raise _bad(409, "INVALID_STATE", f"a '{cs['status']}' change set cannot be edited")
    update: dict = {}
    if title is not None:
        update["title"] = title
    if description is not None:
        update["description"] = description
    if operations is not None:
        validate_operations_shape(operations)
        update["operations"] = operations
    authors = sorted(set(cs.get("authors") or [cs.get("created_by")]) | {actor.get("id")})
    update["authors"] = authors
    cs = await _save(cs_id, update, EDITABLE_STATES)
    return await replan(cs_id, actor=actor)


async def replan(cs_id: str, *, actor: dict) -> dict:
    cs = await get_changeset(cs_id)
    replannable = EDITABLE_STATES | {S.validated, S.pending_approval, S.approved, S.apply_failed}
    if S(cs["status"]) not in replannable:
        raise _bad(409, "INVALID_STATE", f"a '{cs['status']}' change set cannot be re-planned")
    site, client = await get_site_and_client(cs["site_id"])
    policy = await get_policy(cs["site_id"])
    plan = await _plan(site, client, cs)
    update = {"plan": plan, "status": (S.planned if plan.get("valid") else S.plan_failed).value}
    old_sha = (cs.get("plan") or {}).get("approval_sha256")
    if old_sha != plan["approval_sha256"]:
        update["approvals"] = []  # approvals were for a different change
        update["validation"] = None
        update["preview"] = None
    # CAS on the status we checked: a concurrent apply must not be overwritten.
    cs = await _save(cs_id, update, {S(cs["status"])})
    cs = await _save(cs_id, {"policy_checks": policy_checks(site, cs, policy)}, {S(cs["status"])})
    await audit("changeset.plan", actor=actor, site=site, change_id=cs_id,
                detail={"valid": plan.get("valid"), "diff_changed": old_sha != plan["approval_sha256"]})
    return cs


async def _run_job(cs_id: str, kind: str, task_id: str, start, actor: dict) -> None:
    """Shared runner for validation/preview jobs on the bridge."""
    cs = await get_changeset(cs_id)
    site, client = await get_site_and_client(cs["site_id"])
    diff_sha = (cs.get("plan") or {}).get("approval_sha256")
    try:
        started = await start(client, cs)
        job_id = started["job_id"]
        await push_event(task_id, "progress", {"stage": kind, "job_id": job_id, "status": "queued"})

        async def on_update(job):
            await push_event(task_id, "progress", {"stage": kind, "job": job})

        job = await client.wait_job(job_id, on_update=on_update)
        record = {"job_id": job_id, "status": job.get("status"), "steps": job.get("steps", []),
                  "result": job.get("result"), "diff_sha256": diff_sha, "finished_at": now_iso()}
        if kind == "validation":
            ok = job.get("status") == "succeeded"
            await _save(cs_id, {"validation": record,
                                "status": (S.validated if ok else S.validation_failed).value}, {S.validating})
        else:
            record["url"] = (job.get("result") or {}).get("preview_url")
            await _save(cs_id, {"preview": record})
        policy = await get_policy(cs["site_id"])
        cs = await get_changeset(cs_id)
        await _save(cs_id, {"policy_checks": policy_checks(site, cs, policy)})
        await audit(f"changeset.{kind}", actor=actor, site=site, change_id=cs_id,
                    outcome="ok" if job.get("status") == "succeeded" else "error",
                    detail={"job_id": job_id, "status": job.get("status")})
        await push_event(task_id, "done" if job.get("status") == "succeeded" else "error",
                         {"stage": kind, "status": job.get("status"), "message": job.get("error") or ""})
    except (BridgeError, HTTPException) as e:
        msg = e.message if isinstance(e, BridgeError) else str(e.detail)
        if kind == "validation":
            await db.changesets.update_one({"id": cs_id, "status": S.validating.value},
                                           {"$set": {"status": S.validation_failed.value, "updated_at": now_iso(),
                                                     "validation": {"status": "failed", "error": msg,
                                                                    "diff_sha256": diff_sha}}})
        await audit(f"changeset.{kind}", actor=actor, site=site, change_id=cs_id, outcome="error",
                    detail={"error": msg})
        await push_event(task_id, "error", {"stage": kind, "message": msg})
    finally:
        await finish_task(task_id)


async def start_validation(cs_id: str, *, actor: dict, steps: Optional[list]) -> dict:
    cs = await get_changeset(cs_id)
    site, _ = await get_site_and_client(cs["site_id"])
    if not capability_enabled(site, "validate"):
        raise HTTPException(status_code=422, detail={"code": "CAPABILITY_UNSUPPORTED", "capability": "validate",
                                                     "message": "This bridge has no validation profile configured."})
    if not (cs.get("plan") or {}).get("valid"):
        raise _bad(409, "PLAN_INVALID", "Fix the plan errors before validating")
    await _save(cs_id, {"status": S.validating.value},
                {S.planned, S.validated, S.validation_failed, S.pending_approval})
    task_id = make_task_id()
    await create_task_queue(task_id, "changeset_validation", cs["site_id"])
    body_steps = steps or (site.get("capabilities") or {}).get("validation_steps") or []

    async def start(client, c):
        return await client.request("POST", "/validations", body={"operations": c["operations"], "steps": body_steps})

    _spawn(_run_job(cs_id, "validation", task_id, start, actor))
    return {"task_id": task_id}


async def start_preview(cs_id: str, *, actor: dict) -> dict:
    cs = await get_changeset(cs_id)
    site, _ = await get_site_and_client(cs["site_id"])
    if not capability_enabled(site, "preview"):
        raise HTTPException(status_code=422, detail={"code": "CAPABILITY_UNSUPPORTED", "capability": "preview",
                                                     "message": "This bridge has no preview environment configured."})
    task_id = make_task_id()
    await create_task_queue(task_id, "changeset_preview", cs["site_id"])

    async def start(client, c):
        return await client.request("POST", "/previews", body={"operations": c["operations"]})

    _spawn(_run_job(cs_id, "preview", task_id, start, actor))
    return {"task_id": task_id}


async def submit(cs_id: str, *, actor: dict) -> dict:
    cs = await get_changeset(cs_id)
    site, _ = await get_site_and_client(cs["site_id"])
    policy = await get_policy(cs["site_id"])
    checks = policy_checks(site, cs, policy)
    blocking = [c for c in checks if not c["ok"] and c["name"] in ("plan_valid", "capabilities", "operation_limit")]
    if blocking:
        raise _bad(409, "POLICY_CHECKS_FAILED", "; ".join(c["message"] for c in blocking), checks=checks)
    authors = sorted(set(cs.get("authors") or [cs.get("created_by")]) | {actor.get("id")})
    cs = await _save(cs_id, {"status": S.pending_approval.value, "policy_checks": checks, "authors": authors,
                             "submitted_by": actor.get("id"), "submitted_at": now_iso()},
                     {S.planned, S.validated})
    await audit("changeset.submit", actor=actor, site=site, change_id=cs_id)
    if auto_apply_allowed(site, cs, policy):
        approval = {"user_id": "policy", "user_email": "auto-apply policy", "decision": "approved",
                    "comment": "matched the site's auto-apply policy", "at": now_iso(),
                    "diff_sha256": cs["plan"]["approval_sha256"]}
        cs = await _save(cs_id, {"status": S.approved.value, "approvals": [approval]}, {S.pending_approval})
        await audit("changeset.auto_approve", actor=POLICY_ACTOR, site=site, change_id=cs_id,
                    detail={"policy": policy.auto_apply.model_dump(mode="json")})
        result = await start_apply(cs_id, actor=POLICY_ACTOR, confirm=site["name"], _policy=True)
        cs = await get_changeset(cs_id)
        cs["auto_apply_task_id"] = result["task_id"]
    return cs


async def review(cs_id: str, *, actor: dict, decision: str, comment: str) -> dict:
    cs = await get_changeset(cs_id)
    site, _ = await get_site_and_client(cs["site_id"])
    policy = await get_policy(cs["site_id"])
    authors = set(cs.get("authors") or [cs.get("created_by")]) | {cs.get("submitted_by")}
    if decision == "approved":
        pending_validation = [c for c in policy_checks(site, cs, policy)
                              if c["name"] == "validation_for_file_ops" and not c["ok"]]
        if pending_validation:
            raise _bad(409, "VALIDATION_REQUIRED", pending_validation[0]["message"])
    if decision == "approved" and actor.get("id") in authors:
        self_ok = site.get("environment") != "production" and policy.allow_self_approval_nonprod
        if not self_ok:
            await audit("changeset.approve", actor=actor, site=site, change_id=cs_id, outcome="denied",
                        detail={"reason": "self-approval not allowed"})
            raise _bad(403, "SELF_APPROVAL", "You cannot approve your own change set on this site; ask another deployer.")
    if decision == "rejected" and not comment.strip():
        raise _bad(400, "COMMENT_REQUIRED", "Explain why the change set is rejected")
    entry = {"user_id": actor.get("id"), "user_email": actor.get("email"), "decision": decision,
             "comment": comment, "at": now_iso(), "diff_sha256": (cs.get("plan") or {}).get("approval_sha256")}
    new_status = S.approved if decision == "approved" else S.rejected
    cs = await _save(cs_id, {"status": new_status.value, "approvals": (cs.get("approvals") or []) + [entry]},
                     {S.pending_approval})
    await audit(f"changeset.{'approve' if decision == 'approved' else 'reject'}", actor=actor, site=site,
                change_id=cs_id, detail={"comment": comment})
    return cs


async def start_apply(cs_id: str, *, actor: dict, confirm: str, _policy: bool = False) -> dict:
    from core.confirm import require_production_confirmation
    cs = await get_changeset(cs_id)
    site, _ = await get_site_and_client(cs["site_id"])
    if not _policy:
        require_production_confirmation(site, confirm, "apply this change set to production")
    plan = cs.get("plan") or {}
    approvals = [a for a in cs.get("approvals") or []
                 if a["decision"] == "approved" and a.get("diff_sha256") == plan.get("approval_sha256")]
    problems = []
    if cs["status"] != S.approved.value:
        problems.append(f"status is '{cs['status']}', not 'approved'")
    if not approvals:
        problems.append("no approval for the current diff")
    if not site.get("writes_enabled"):
        problems.append("writes are disabled for this site")
    if not plan.get("valid"):
        problems.append("plan is not valid")
    if problems:
        await audit("changeset.apply", actor=actor, site=site, change_id=cs_id, outcome="denied",
                    detail={"problems": problems})
        raise _bad(409, "APPLY_NOT_ALLOWED", "; ".join(problems))
    cs = await _save(cs_id, {"status": S.applying.value}, {S.approved})
    task_id = make_task_id()
    await create_task_queue(task_id, "changeset_apply", cs["site_id"])
    _spawn(_apply(cs, site, task_id, actor))
    return {"task_id": task_id}


async def _apply(cs: dict, site: dict, task_id: str, actor: dict) -> None:
    cs_id = cs["id"]
    plan = cs["plan"]
    idem = f"apply_{cs_id}_{plan['diff_sha256'][:16]}"
    try:
        _, client = await get_site_and_client(cs["site_id"])
        await push_event(task_id, "progress", {"stage": "apply", "message": "Applying on the bridge"})
        result = await client.apply(cs_id, cs["operations"], plan.get("base_revision"), plan["diff_sha256"], idem)
        not_effective = [o for o in result.get("operations", []) if o.get("effective") is False]
        record = {"job_id": task_id, "revision_id": result.get("revision_id"), "result": result, "error": None,
                  "applied_by": actor.get("id"), "applied_by_email": actor.get("email"), "applied_at": now_iso(),
                  "not_effective": not_effective}
        # Record the immutable revision before the status flips, so an
        # "applied" change set always has its revision on file.
        await db.revisions.insert_one({
            "revision_id": result.get("revision_id"), "site_id": cs["site_id"], "change_id": cs_id,
            "kind": "apply", "files": result.get("files", []), "verification": result.get("verification"),
            "created_by": actor.get("id"), "created_at": now_iso(), "status": "applied"})
        await _save(cs_id, {"status": S.applied.value, "apply": record}, {S.applying})
        await audit("changeset.apply", actor=actor, site=site, change_id=cs_id,
                    revision_id=result.get("revision_id"),
                    detail={"revalidated": result.get("revalidated"), "not_effective": len(not_effective),
                            "verification": result.get("verification")})
        await push_event(task_id, "done", {"stage": "apply", "revision_id": result.get("revision_id"),
                                           "not_effective": not_effective})
    except BridgeError as e:
        recovery = {
            "VERIFY_FAILED": "The bridge could not verify the change and restored the previous files automatically.",
            "CONFLICT_REVISION": "The site changed since this plan was made. Re-plan, review the new diff and approve again.",
            "LOCKED": "Another change is being applied to this site. Retry in a moment.",
        }.get(e.code, "Nothing was confirmed as applied. Check the bridge audit log using the correlation id.")
        err = {"code": e.code, "message": e.message, "correlation_id": e.correlation_id,
               "details": e.details, "recovery": recovery}
        await _save(cs_id, {"status": S.apply_failed.value,
                            "apply": {"job_id": task_id, "error": err, "applied_by": actor.get("id"),
                                      "attempted_at": now_iso()}}, {S.applying})
        await audit("changeset.apply", actor=actor, site=site, change_id=cs_id, outcome="error",
                    correlation_id=e.correlation_id, detail=err)
        await push_event(task_id, "error", {"stage": "apply", "message": f"{e.code}: {e.message}", **err})
    except Exception as e:  # never leave a change set stuck in 'applying'
        logger.exception("apply crashed for %s", cs_id)
        await db.changesets.update_one({"id": cs_id, "status": S.applying.value}, {"$set": {
            "status": S.apply_failed.value, "updated_at": now_iso(),
            "apply": {"job_id": task_id, "error": {"code": "INTERNAL", "message": type(e).__name__,
                      "recovery": "State on the site is unknown; check its revisions before retrying."}}}})
        await push_event(task_id, "error", {"stage": "apply", "message": "internal error"})
    finally:
        await finish_task(task_id)


async def start_rollback(cs_id: str, *, actor: dict, confirm: str, reason: str) -> dict:
    from core.confirm import require_production_confirmation
    cs = await get_changeset(cs_id)
    site, _ = await get_site_and_client(cs["site_id"])
    require_production_confirmation(site, confirm, "roll back this change on production")
    if cs["status"] != S.applied.value or not (cs.get("apply") or {}).get("revision_id"):
        raise _bad(409, "INVALID_STATE", "only an applied change set with a recorded revision can be rolled back")
    task_id = make_task_id()
    await create_task_queue(task_id, "changeset_rollback", cs["site_id"])

    async def run():
        try:
            _, client = await get_site_and_client(cs["site_id"])
            rev = cs["apply"]["revision_id"]
            result = await client.rollback(rev, reason, f"rollback_{cs_id}_{rev}")
            await db.revisions.update_one({"revision_id": rev}, {"$set": {"status": "reverted"}})
            await db.revisions.insert_one({"revision_id": result.get("revision_id"), "site_id": cs["site_id"],
                                           "change_id": cs_id, "kind": "rollback", "reverts": rev,
                                           "created_by": actor.get("id"), "created_at": now_iso(),
                                           "status": "applied"})
            await _save(cs_id, {"status": S.rolled_back.value, "rollback": {
                "revision_id": result.get("revision_id"), "reverted_revision": rev, "by": actor.get("id"),
                "by_email": actor.get("email"), "at": now_iso(), "reason": reason}}, {S.applied})
            await audit("changeset.rollback", actor=actor, site=site, change_id=cs_id,
                        revision_id=result.get("revision_id"), detail={"reverted": rev, "reason": reason})
            await push_event(task_id, "done", {"stage": "rollback", "revision_id": result.get("revision_id")})
        except BridgeError as e:
            await audit("changeset.rollback", actor=actor, site=site, change_id=cs_id, outcome="error",
                        correlation_id=e.correlation_id, detail={"code": e.code, "message": e.message,
                                                                 "details": e.details})
            await push_event(task_id, "error", {"stage": "rollback", "code": e.code, "message": e.message,
                                                "details": e.details})
        finally:
            await finish_task(task_id)

    _spawn(run())
    return {"task_id": task_id}


async def cancel(cs_id: str, *, actor: dict) -> dict:
    cs = await get_changeset(cs_id)
    site, _ = await get_site_and_client(cs["site_id"])
    cs = await _save(cs_id, {"status": S.cancelled.value}, PRE_APPLY_CANCELLABLE)
    await audit("changeset.cancel", actor=actor, site=site, change_id=cs_id)
    return cs


def can_view(user: dict) -> bool:
    return has_role(user, "viewer")


__all__ = [
    "create_changeset", "update_changeset", "replan", "start_validation", "start_preview", "submit", "review",
    "start_apply", "start_rollback", "cancel", "get_changeset", "get_policy", "OP_CAPABILITY", "TERMINAL_STATES",
]
