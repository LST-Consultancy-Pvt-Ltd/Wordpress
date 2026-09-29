"""Managed Next.js sites: connection onboarding, handshake, write
verification/enablement, credential rotation/replacement/revocation, policy.

Contract: protocol/control-plane-api.md ("Sites and connections").
"""
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException

from core.activity import log_activity
from core.audit import audit, new_correlation_id
from core.confirm import require_site_confirmation
from core.db import db
from core.router import api_router
from core.secrets import SecretStoreError, encrypt_secret
from core.security import require_admin, require_editor, require_user
from core.url_policy import UrlPolicyError, validate_base_url, validate_bridge_url
from models.sites import (
    Confirm,
    ConnectionStatus,
    CredentialReplace,
    ManagedSite,
    SiteConnection,
    SiteCreate,
    SitePolicy,
    SiteUpdate,
    WritesToggle,
    now_iso,
)
from providers.bridge_client import BridgeError, new_idempotency_key
from providers.sites import build_client, get_site, get_site_and_client, public_site

WRITE_VERIFY_MAX_AGE = timedelta(hours=24)
PROBE_ROUTE = "/__automation-write-probe"


def _url_error(e: UrlPolicyError) -> HTTPException:
    return HTTPException(status_code=400, detail={"code": "URL_POLICY", "message": str(e)})


async def _run_handshake(site: dict, client) -> dict:
    """Handshake and persist the outcome. Never raises for bridge failures:
    the failure is recorded on the site so the UI can show it."""
    update: dict = {"updated_at": now_iso(), "connection.last_handshake_at": now_iso()}
    try:
        result = await client.handshake()
        caps, health = result["capabilities"], result["health"]
        ready = bool(health.get("ready")) and health.get("status") == "ok"
        update.update({
            "capabilities": caps,
            "health": health,
            "connection.status": (ConnectionStatus.connected if ready else ConnectionStatus.degraded).value,
            "connection.last_error": None if ready else f"bridge health: {health.get('status', 'unknown')}",
        })
        mismatch = (caps.get("site") or {}).get("site_id")
        if mismatch and mismatch != site.get("site_key"):
            update["connection.status"] = ConnectionStatus.degraded.value
            update["connection.last_error"] = (f"bridge reports site id '{mismatch}' but this site is registered as "
                                               f"'{site.get('site_key')}' — check you connected the right bridge")
            update["writes_enabled"] = False
    except BridgeError as e:
        update.update({
            "connection.status": ConnectionStatus.unreachable.value,
            "connection.last_error": f"{e.code}: {e.message}"[:500],
        })
        if e.code == "PROTOCOL_UNSUPPORTED" or e.status in (401, 403):
            update["writes_enabled"] = False
    await db.sites.update_one({"id": site["id"]}, {"$set": update})
    return await get_site(site["id"])


@api_router.get("/sites")
async def list_sites(_: dict = Depends(require_user)):
    docs = await db.sites.find({}, {"_id": 0, "connection.secret_enc": 0}).sort("created_at", 1).to_list(500)
    return [public_site(d) for d in docs]


@api_router.post("/sites", status_code=201)
async def create_site(body: SiteCreate, user: dict = Depends(require_admin)):
    cid = new_correlation_id()
    try:
        base_url = validate_base_url(body.base_url)
        bridge_url = validate_bridge_url(body.bridge_url, allow_private_http=body.allow_private_http)
    except UrlPolicyError as e:
        await audit("site.create", actor=user, outcome="denied", correlation_id=cid,
                    detail={"reason": str(e), "name": body.name})
        raise _url_error(e)
    if await db.sites.find_one({"site_key": body.site_key, "environment": body.environment.value}):
        raise HTTPException(status_code=409, detail="A site with this site key and environment is already registered")
    try:
        secret_enc = encrypt_secret(body.secret)
    except SecretStoreError as e:
        raise HTTPException(status_code=500, detail={"code": "SECRET_STORE", "message": str(e)})

    site = ManagedSite(
        name=body.name, base_url=base_url, bridge_url=bridge_url, environment=body.environment,
        site_key=body.site_key, install_mode=body.install_mode, user_id=user["id"],
        connection=SiteConnection(key_id=body.key_id, credential_rotated_at=now_iso(),
                                  private_network_http=body.allow_private_http),
    )
    doc = site.model_dump(mode="json")
    doc["connection"]["secret_enc"] = secret_enc
    await db.sites.insert_one(dict(doc))
    await db.site_policies.update_one({"site_id": site.id},
                                      {"$setOnInsert": {"site_id": site.id, **SitePolicy().model_dump(mode="json")}},
                                      upsert=True)
    result = await _run_handshake(doc, build_client(doc, body.secret))
    await audit("site.create", actor=user, site=result, correlation_id=cid,
                detail={"bridge_url": bridge_url, "key_id": body.key_id,
                        "connection": result["connection"]["status"]})
    await log_activity(site.id, "site_connected", f"Registered {body.name} ({result['connection']['status']})",
                       user_id=user["id"])
    return result


@api_router.get("/sites/{site_id}")
async def get_site_route(site_id: str, _: dict = Depends(require_user)):
    return await get_site(site_id)


@api_router.patch("/sites/{site_id}")
async def update_site(site_id: str, body: SiteUpdate, user: dict = Depends(require_admin)):
    site = await get_site(site_id)
    update: dict = {"updated_at": now_iso()}
    allow_http = body.allow_private_http if body.allow_private_http is not None else \
        site["connection"].get("private_network_http", False)
    try:
        if body.base_url is not None:
            update["base_url"] = validate_base_url(body.base_url)
        if body.bridge_url is not None or body.allow_private_http is not None:
            update["bridge_url"] = validate_bridge_url(body.bridge_url or site["bridge_url"],
                                                       allow_private_http=allow_http)
            update["connection.private_network_http"] = allow_http
    except UrlPolicyError as e:
        raise _url_error(e)
    if body.name is not None:
        update["name"] = body.name
    if body.environment is not None:
        update["environment"] = body.environment.value
    endpoint_changed = any(update.get(k) not in (None, site.get(k)) for k in ("base_url", "bridge_url", "environment"))
    if endpoint_changed:
        # A different endpoint or environment is a different trust decision.
        update.update({"writes_enabled": False, "write_verified_at": None,
                       "connection.status": ConnectionStatus.unverified.value})
    await db.sites.update_one({"id": site_id}, {"$set": update})
    await audit("site.update", actor=user, site=site, detail={k: v for k, v in update.items() if k != "updated_at"})
    return await get_site(site_id)


@api_router.delete("/sites/{site_id}")
async def delete_site(site_id: str, body: Confirm, user: dict = Depends(require_admin)):
    site = await get_site(site_id)
    require_site_confirmation(site, body.confirm, "remove this site")
    await db.sites.delete_one({"id": site_id})
    for coll in ("content_items", "site_policies", "onpage_keywords"):
        await db[coll].delete_many({"site_id": site_id})
    await audit("site.delete", actor=user, site=site,
                detail={"note": "bridge key not revoked automatically; revoke it on the bridge if it is still active"})
    return {"deleted": True}


@api_router.post("/sites/{site_id}/handshake")
async def handshake(site_id: str, user: dict = Depends(require_editor)):
    site, client = await get_site_and_client(site_id)
    result = await _run_handshake(site, client)
    await audit("site.handshake", actor=user, site=result,
                outcome="ok" if result["connection"]["status"] == "connected" else "error",
                detail={"status": result["connection"]["status"], "error": result["connection"].get("last_error")})
    return result


@api_router.get("/sites/{site_id}/health")
async def site_health(site_id: str, _: dict = Depends(require_user)):
    _, client = await get_site_and_client(site_id)
    try:
        return await client.health()
    except BridgeError as e:
        raise e.to_http()


async def _probe_write(site: dict, client, cid: str) -> dict:
    caps = (site.get("capabilities") or {}).get("capabilities") or {}
    if caps.get("metadata.write"):
        ops = [{"op": "metadata.set", "route": PROBE_ROUTE,
                "fields": {"title": "write probe", "robots": {"index": False, "follow": False}}}]
    elif caps.get("content.write"):
        adapters = (site.get("capabilities") or {}).get("content_adapters") or []
        writable = [a for a in adapters if "create" in (a.get("operations") or [])]
        if not writable:
            return {"ok": False, "details": "no writable content collection reported by the bridge"}
        ops = [{"op": "content.upsert", "collection": writable[0]["id"], "slug": "automation-write-probe",
                "status": "draft", "frontmatter": {"title": "write probe"}, "body": "", "base_sha256": None}]
    else:
        return {"ok": False, "details": "the bridge reports no write capability (metadata.write or content.write)"}
    change_id = "probe_" + cid
    plan = await client.plan(change_id, ops)
    if not plan.get("valid"):
        return {"ok": False, "details": {"plan_errors": plan.get("errors")}}
    import hashlib
    applied = await client.apply(change_id, ops, plan.get("current_revision"),
                                 hashlib.sha256((plan.get("diff") or "").encode()).hexdigest(),
                                 new_idempotency_key("probe"))
    rollback = await client.rollback(applied["revision_id"], "write verification probe",
                                     new_idempotency_key("probe-rb"))
    return {"ok": True, "details": {"probe_revision": applied["revision_id"],
                                    "rollback_revision": rollback.get("revision_id"),
                                    "hashes_ok": (applied.get("verification") or {}).get("hashes_ok")}}


@api_router.post("/sites/{site_id}/verify-write")
async def verify_write(site_id: str, user: dict = Depends(require_admin)):
    site, client = await get_site_and_client(site_id)
    cid = new_correlation_id()
    try:
        result = await _probe_write(site, client, cid)
    except BridgeError as e:
        result = {"ok": False, "details": {"code": e.code, "message": e.message, "correlation_id": e.correlation_id}}
    if result["ok"]:
        await db.sites.update_one({"id": site_id}, {"$set": {"write_verified_at": now_iso(), "updated_at": now_iso()}})
    await audit("site.verify_write", actor=user, site=site, outcome="ok" if result["ok"] else "error",
                correlation_id=cid, detail=result)
    return result


@api_router.post("/sites/{site_id}/writes")
async def set_writes(site_id: str, body: WritesToggle, user: dict = Depends(require_admin)):
    site = await get_site(site_id)
    if body.enabled:
        require_site_confirmation(site, body.confirm, "enable writes")
        verified = site.get("write_verified_at")
        fresh = verified and datetime.fromisoformat(verified) > datetime.now(timezone.utc) - WRITE_VERIFY_MAX_AGE
        if not fresh:
            await audit("site.writes_enable", actor=user, site=site, outcome="denied",
                        detail={"reason": "write verification missing or older than 24h"})
            raise HTTPException(status_code=409, detail={
                "code": "WRITE_NOT_VERIFIED",
                "message": "Run 'Verify write access' successfully (within the last 24 hours) before enabling writes."})
        if site["connection"]["status"] != "connected":
            raise HTTPException(status_code=409, detail={
                "code": "NOT_CONNECTED", "message": "The bridge connection is not healthy; refresh it first."})
    await db.sites.update_one({"id": site_id}, {"$set": {"writes_enabled": body.enabled, "updated_at": now_iso()}})
    await audit("site.writes_enable" if body.enabled else "site.writes_disable", actor=user, site=site)
    return await get_site(site_id)


@api_router.post("/sites/{site_id}/credential/rotate")
async def rotate_credential(site_id: str, user: dict = Depends(require_admin)):
    site, client = await get_site_and_client(site_id)
    cid = new_correlation_id()
    try:
        issued = await client.request("POST", "/auth/rotate", body={"grace_seconds": 300},
                                      idempotency_key=new_idempotency_key("rotate"), correlation_id=cid)
        secret_enc = encrypt_secret(issued["secret"])
    except BridgeError as e:
        await audit("site.credential_rotate", actor=user, site=site, outcome="error", correlation_id=cid,
                    detail={"code": e.code})
        raise e.to_http()
    except (KeyError, SecretStoreError) as e:
        await audit("site.credential_rotate", actor=user, site=site, outcome="error", correlation_id=cid,
                    detail={"reason": type(e).__name__})
        raise HTTPException(status_code=502, detail={
            "code": "ROTATION_INCOMPLETE",
            "message": "The bridge issued a new key but it could not be stored. The previous key stays valid for 5 "
                       "minutes; retry, or revoke the new key on the bridge."})
    rotated_at = now_iso()
    await db.sites.update_one({"id": site_id}, {"$set": {
        "connection.key_id": issued["key_id"], "connection.secret_enc": secret_enc,
        "connection.credential_rotated_at": rotated_at, "updated_at": rotated_at}})
    new_site, new_client = await get_site_and_client(site_id)
    await _run_handshake(new_site, new_client)
    await audit("site.credential_rotate", actor=user, site=site, correlation_id=cid,
                detail={"old_key_id": site["connection"].get("key_id"), "new_key_id": issued["key_id"]})
    return {"key_id": issued["key_id"], "rotated_at": rotated_at}


@api_router.post("/sites/{site_id}/credential/replace")
async def replace_credential(site_id: str, body: CredentialReplace, user: dict = Depends(require_admin)):
    site = await get_site(site_id)
    candidate = build_client(site, body.secret, key_id=body.key_id)
    try:
        await candidate.handshake()
    except BridgeError as e:
        await audit("site.credential_replace", actor=user, site=site, outcome="denied", detail={"code": e.code})
        raise e.to_http()
    try:
        secret_enc = encrypt_secret(body.secret)
    except SecretStoreError as e:
        raise HTTPException(status_code=500, detail={"code": "SECRET_STORE", "message": str(e)})
    await db.sites.update_one({"id": site_id}, {"$set": {
        "connection.key_id": body.key_id, "connection.secret_enc": secret_enc,
        "connection.credential_rotated_at": now_iso(), "connection.status": ConnectionStatus.unverified.value,
        "updated_at": now_iso()}})
    new_site, client = await get_site_and_client(site_id)
    result = await _run_handshake(new_site, client)
    await audit("site.credential_replace", actor=user, site=site,
                detail={"old_key_id": site["connection"].get("key_id"), "new_key_id": body.key_id})
    return result


@api_router.post("/sites/{site_id}/credential/revoke")
async def revoke_credential(site_id: str, body: Confirm, user: dict = Depends(require_admin)):
    site, client = await get_site_and_client(site_id)
    require_site_confirmation(site, body.confirm, "revoke this site's bridge credential")
    key_id = site["connection"].get("key_id")
    bridge_result = {"revoked_on_bridge": False}
    try:
        await client.request("POST", "/auth/revoke", body={"key_id": key_id, "confirm": "REVOKE-LAST-KEY"},
                             idempotency_key=new_idempotency_key("revoke"))
        bridge_result["revoked_on_bridge"] = True
    except BridgeError as e:
        bridge_result["bridge_error"] = f"{e.code}: {e.message}"
        bridge_result["recovery"] = ("The platform has discarded its copy of the key, but the bridge did not confirm "
                                     "revocation. Remove the key from the bridge key store manually.")
    await db.sites.update_one({"id": site_id}, {
        "$set": {"connection.status": ConnectionStatus.revoked.value, "writes_enabled": False,
                 "write_verified_at": None, "updated_at": now_iso()},
        "$unset": {"connection.secret_enc": ""}})
    await audit("site.credential_revoke", actor=user, site=site,
                outcome="ok" if bridge_result["revoked_on_bridge"] else "error",
                detail={"key_id": key_id, **bridge_result})
    return {**bridge_result, "site": await get_site(site_id)}


@api_router.get("/sites/{site_id}/policy")
async def get_policy(site_id: str, _: dict = Depends(require_user)):
    await get_site(site_id)
    doc = await db.site_policies.find_one({"site_id": site_id}, {"_id": 0, "site_id": 0})
    return SitePolicy(**(doc or {})).model_dump(mode="json")


@api_router.put("/sites/{site_id}/policy")
async def put_policy(site_id: str, body: SitePolicy, user: dict = Depends(require_admin)):
    site = await get_site(site_id)
    data = body.model_dump(mode="json")
    await db.site_policies.update_one({"site_id": site_id}, {"$set": {"site_id": site_id, **data}}, upsert=True)
    await audit("site.policy_update", actor=user, site=site, detail=data)
    return data
