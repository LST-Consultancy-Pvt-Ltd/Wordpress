"""Trust & Safety Gate (§10) + Outreach Sending (§11).

A generic approve/reject/send workflow layered on top of the drafted-email
documents that already exist across several `opportunities.py` collections
(backlink_outreach, guest_posts, digital_pr, influencer_outreach,
podcast_outreach, link_reclamation, brand_mentions). Every one of those
drafts an email/pitch via AI, but NONE of them ever sends anything — this
module is the only path that can turn a draft into a real outbound email,
and it enforces three things before that's allowed:

1. A `recipient_email` must be set on the document (nothing here invents a
   contact email — §1 already refused to fabricate those, so a human has to
   supply the real one they found).
2. An admin must explicitly approve it (`POST .../approve`) — drafting and
   sending are always separate steps, and approval is a distinct actor from
   whoever triggers the actual send if you want that discipline.
3. SMTP must be configured (`providers/email.py`) — if it isn't, `/send`
   fails loudly instead of silently no-op'ing.

Every state transition is logged via `log_activity` for an audit trail of
who approved/sent what and when.
"""
from datetime import datetime, timezone

from bson import ObjectId
from fastapi import Depends, HTTPException
from pydantic import BaseModel

from core.activity import log_activity
from core.db import db
from core.router import api_router
from core.security import require_admin, require_editor
from providers.email import send_email, smtp_available

# Maps an outreach collection name to the field holding its drafted
# {"subject", "body"} email content. Only collections that actually store an
# emailable draft belong here.
_OUTREACH_COLLECTIONS = {
    "backlink_outreach": "email_content",
    "guest_posts": "pitch",
    "link_reclamation": "outreach_email",
}


def _collection(name: str):
    if name not in _OUTREACH_COLLECTIONS:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown outreach collection '{name}'. Valid: {sorted(_OUTREACH_COLLECTIONS)}",
        )
    return getattr(db, name)


class RecipientUpdate(BaseModel):
    recipient_email: str


@api_router.patch("/outreach/{collection}/{item_id}/recipient")
async def set_outreach_recipient(collection: str, item_id: str, body: RecipientUpdate, user: dict = Depends(require_editor)):
    """Record the real contact email a human found for this draft. Required
    before the item can be approved — nothing in this app invents one."""
    coll = _collection(collection)
    doc = await coll.find_one({"_id": ObjectId(item_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Item not found")
    await coll.update_one(
        {"_id": ObjectId(item_id)},
        {"$set": {"recipient_email": body.recipient_email, "approval_status": "pending",
                   "updated_at": datetime.now(timezone.utc)}},
    )
    return {"ok": True, "recipient_email": body.recipient_email, "approval_status": "pending"}


@api_router.post("/outreach/{collection}/{item_id}/approve")
async def approve_outreach(collection: str, item_id: str, user: dict = Depends(require_admin)):
    coll = _collection(collection)
    doc = await coll.find_one({"_id": ObjectId(item_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Item not found")
    if not doc.get("recipient_email"):
        raise HTTPException(
            status_code=400,
            detail="Set a recipient_email first (PATCH /outreach/{collection}/{item_id}/recipient).",
        )
    now = datetime.now(timezone.utc)
    await coll.update_one(
        {"_id": ObjectId(item_id)},
        {"$set": {"approval_status": "approved", "approved_by": user.get("id"), "approved_at": now, "updated_at": now}},
    )
    await log_activity(doc.get("site_id", ""), "outreach_approved",
                        f"{collection}/{item_id} approved for sending by {user.get('email', user.get('id'))}")
    return {"ok": True, "approval_status": "approved"}


@api_router.post("/outreach/{collection}/{item_id}/reject")
async def reject_outreach(collection: str, item_id: str, user: dict = Depends(require_admin)):
    coll = _collection(collection)
    doc = await coll.find_one({"_id": ObjectId(item_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Item not found")
    now = datetime.now(timezone.utc)
    await coll.update_one(
        {"_id": ObjectId(item_id)},
        {"$set": {"approval_status": "rejected", "approved_by": user.get("id"), "approved_at": now, "updated_at": now}},
    )
    await log_activity(doc.get("site_id", ""), "outreach_rejected", f"{collection}/{item_id} rejected by {user.get('id')}")
    return {"ok": True, "approval_status": "rejected"}


@api_router.post("/outreach/{collection}/{item_id}/send")
async def send_outreach(collection: str, item_id: str, user: dict = Depends(require_admin)):
    """The only place in this codebase that sends a real email. Requires:
    approval_status == "approved", a recipient_email, and SMTP configured.
    Refuses (not a silent no-op) if any of those aren't true."""
    field = _OUTREACH_COLLECTIONS[collection]
    coll = _collection(collection)
    doc = await coll.find_one({"_id": ObjectId(item_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Item not found")
    if doc.get("approval_status") != "approved":
        raise HTTPException(status_code=409, detail=f"Item must be approved first (current: {doc.get('approval_status', 'draft')}).")
    recipient = doc.get("recipient_email")
    if not recipient:
        raise HTTPException(status_code=400, detail="No recipient_email set on this item.")
    email_content = doc.get(field) or {}
    subject, body = email_content.get("subject"), email_content.get("body")
    if not subject or not body:
        raise HTTPException(status_code=400, detail=f"No drafted email found in '{field}' — generate a draft first.")
    if not await smtp_available():
        raise HTTPException(status_code=400, detail="SMTP is not configured — add smtp_host/username/password/from_email in Settings.")

    try:
        await send_email(recipient, subject, body)
    except RuntimeError as e:
        # Not configured — shouldn't normally reach here since smtp_available()
        # was just checked above, but don't let a race surface as a 500.
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # A real send attempt failed (SMTP timeout, auth rejection, connection
        # refused, etc.) — surface the real reason rather than crashing with a
        # generic 500, and leave approval_status as "approved" (not "sent")
        # so the item is safe to retry.
        await log_activity(doc.get("site_id", ""), "outreach_send_failed",
                            f"{collection}/{item_id} send to {recipient} failed: {e}")
        raise HTTPException(status_code=502, detail=f"Failed to send email via SMTP: {e}")

    now = datetime.now(timezone.utc)
    await coll.update_one(
        {"_id": ObjectId(item_id)},
        {"$set": {"approval_status": "sent", "sent_at": now, "sent_by": user.get("id"), "updated_at": now}},
    )
    await log_activity(doc.get("site_id", ""), "outreach_sent",
                        f"{collection}/{item_id} sent to {recipient} by {user.get('email', user.get('id'))}")
    return {"ok": True, "sent_to": recipient, "sent_at": now.isoformat()}
