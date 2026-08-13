"""Verified Company Knowledge Base (§12): CRUD for the per-site `CompanyProfile`
— a single source of truth for real-world business facts (NAP, description,
categories, social profiles) that other features can pull from instead of
re-asking for the same facts on every call.
"""
from datetime import datetime, timezone

from fastapi import Depends, HTTPException

from core.activity import log_activity
from core.db import db
from core.router import api_router
from core.security import require_editor, require_user
from models.legacy import CompanyProfile, CompanyProfileUpdate


@api_router.get("/company-profile/{site_id}", response_model=CompanyProfile)
async def get_company_profile(site_id: str, _: dict = Depends(require_user)):
    doc = await db.company_profiles.find_one({"site_id": site_id}, {"_id": 0})
    if not doc:
        return CompanyProfile(site_id=site_id)
    return CompanyProfile(**doc)


@api_router.post("/company-profile/{site_id}", response_model=CompanyProfile)
async def update_company_profile(site_id: str, update: CompanyProfileUpdate, user: dict = Depends(require_editor)):
    existing = await db.company_profiles.find_one({"site_id": site_id}, {"_id": 0}) or {"site_id": site_id}
    update_data = update.model_dump(exclude_none=True)
    # Any edit to the underlying facts un-verifies the profile unless the
    # caller is explicitly (re-)confirming it in the same request.
    if update_data and "verified" not in update_data:
        update_data["verified"] = False
    existing.update(update_data)
    existing["updated_at"] = datetime.now(timezone.utc).isoformat()
    existing["updated_by"] = user.get("id")
    await db.company_profiles.replace_one({"site_id": site_id}, existing, upsert=True)
    await log_activity(site_id, "company_profile_updated",
                        f"Company profile updated by {user.get('email', user.get('id', 'unknown'))}"
                        + (" (verified)" if existing.get("verified") else ""))
    return CompanyProfile(**existing)


async def get_verified_nap(site_id: str) -> dict:
    """Helper for other routers: returns {"business_name","address","phone","website"}
    from the verified company profile, or {} if none is verified yet. Used to let
    §1-fixed routes (e.g. Local Citations audit) default to real stored facts
    instead of requiring the caller to re-type them, without ever fabricating
    a value when nothing has been verified."""
    doc = await db.company_profiles.find_one({"site_id": site_id, "verified": True}, {"_id": 0})
    if not doc:
        return {}
    return {k: doc.get(k, "") for k in ("business_name", "address", "phone", "website")}


@api_router.delete("/company-profile/{site_id}")
async def delete_company_profile(site_id: str, user: dict = Depends(require_editor)):
    result = await db.company_profiles.delete_one({"site_id": site_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="No company profile found for this site")
    await log_activity(site_id, "company_profile_deleted", f"Company profile deleted by {user.get('id')}")
    return {"ok": True}
