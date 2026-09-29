"""Site lookup and bridge-client construction — the only place that
decrypts a bridge credential."""
from typing import Optional

from fastapi import HTTPException

from core.db import db
from core.secrets import SecretStoreError, decrypt_secret
from providers.bridge_client import BridgeClient

# Never read the encrypted secret unless a client is being built.
PUBLIC_PROJECTION = {"_id": 0, "connection.secret_enc": 0}

# Test hook: tests install an httpx transport that routes to a fake bridge.
_transport_override = None


def set_transport_override(transport) -> None:
    global _transport_override
    _transport_override = transport


def public_site(doc: dict) -> dict:
    doc = dict(doc)
    doc.pop("_id", None)
    conn = dict(doc.get("connection") or {})
    conn.pop("secret_enc", None)
    doc["connection"] = conn
    return doc


async def get_site(site_id: str) -> dict:
    doc = await db.sites.find_one({"id": site_id}, PUBLIC_PROJECTION)
    if not doc:
        raise HTTPException(status_code=404, detail="Site not found")
    return doc


async def get_site_optional(site_id: str) -> Optional[dict]:
    return await db.sites.find_one({"id": site_id}, PUBLIC_PROJECTION)


def build_client(site: dict, secret: str, key_id: Optional[str] = None) -> BridgeClient:
    conn = site.get("connection") or {}
    return BridgeClient(
        site["bridge_url"], key_id or conn.get("key_id", ""), secret,
        allow_private_http=bool(conn.get("private_network_http")),
        transport=_transport_override,
    )


async def get_site_and_client(site_id: str) -> tuple[dict, BridgeClient]:
    doc = await db.sites.find_one({"id": site_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Site not found")
    conn = doc.get("connection") or {}
    if conn.get("status") == "revoked":
        raise HTTPException(status_code=409, detail={
            "code": "CREDENTIAL_REVOKED",
            "message": "This site's bridge credential was revoked. An admin must supply a new key."})
    try:
        secret = decrypt_secret(conn.get("secret_enc", ""))
    except SecretStoreError as e:
        raise HTTPException(status_code=500, detail={"code": "CREDENTIAL_UNAVAILABLE", "message": str(e)})
    return public_site(doc), build_client(doc, secret)
