"""Control-plane audit trail.

One record per attempted sensitive action (site connection changes,
credential rotation, change-set transitions, apply/rollback, deployments,
backups/restores, policy edits), including denied and failed attempts.
Records are append-only from the application's point of view: nothing in
the codebase updates or deletes them.
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from core.db import db
from core.redact import redact

logger = logging.getLogger("audit")


def new_correlation_id() -> str:
    return "c_" + uuid.uuid4().hex[:20]


async def audit(
    action: str,
    *,
    actor: Optional[dict],
    outcome: str = "ok",
    site: Optional[dict] = None,
    site_id: Optional[str] = None,
    target_type: Optional[str] = None,
    target_id: Optional[str] = None,
    change_id: Optional[str] = None,
    revision_id: Optional[str] = None,
    correlation_id: Optional[str] = None,
    detail: Optional[dict] = None,
) -> dict:
    doc = {
        "id": uuid.uuid4().hex,
        "at": datetime.now(timezone.utc).isoformat(),
        "actor_id": (actor or {}).get("id"),
        "actor_email": (actor or {}).get("email"),
        "role": (actor or {}).get("role"),
        "site_id": site_id or (site or {}).get("id"),
        "environment": (site or {}).get("environment"),
        "action": action,
        "target_type": target_type,
        "target_id": target_id,
        "change_id": change_id,
        "revision_id": revision_id,
        "correlation_id": correlation_id or new_correlation_id(),
        "outcome": outcome,
        "detail": redact(detail or {}),
    }
    try:
        await db.audit_events.insert_one(dict(doc))
    except Exception:  # the audit write must never be the reason an action is lost silently
        logger.exception("audit write failed for %s", action)
    logger.info("audit %s outcome=%s site=%s actor=%s cid=%s", action, outcome, doc["site_id"],
                doc["actor_id"], doc["correlation_id"])
    return doc
