"""Direct-posting directory listings (B2B / IT-services focus).

These are directories you get listed on by signing up and submitting a
profile yourself — no outreach email, no editor to convince. That makes them
a fundamentally different workflow from routers/opportunities.py's backlink
outreach, which is why they live on their own tab rather than mixed into the
opportunity list.

WHAT IS AND ISN'T AUTOMATED (deliberate):
Self-serve directories publish no submission API, so "fully automatic" would
mean a bot creating accounts and filling forms. That breaks essentially every
directory's terms of service, runs headlong into CAPTCHAs and email
verification, and automated mass directory submission is specifically what
Google's link-spam policy penalises — it can cost you rankings rather than
win them. So everything around the submission is automated instead:

  * listing copy generated for you at each directory's required lengths,
    strictly from the VERIFIED company profile (never invented facts),
  * a deep link straight to that directory's submission form,
  * per-site status tracking so you always know what's outstanding,
  * automatic verification, via a real Google search, that a listing you
    marked submitted actually went live.

The human does the final click on the directory's own form. That's the one
step that must stay manual, and it's ~1 click per directory.
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from core.activity import log_activity
from core.ai import get_ai_response
from core.db import db
from core.router import api_router
from core.security import require_editor, require_user
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from providers.dataforseo import _data_meta
from providers.google_cse import cse_available, google_custom_search

logger = logging.getLogger(__name__)

# Curated catalogue of directories that accept a free, self-serve listing and
# are relevant to a B2B / IT-services company (ERP, CRM, software consulting).
#
# `approx_da` is an INDICATIVE authority figure for prioritisation only — it is
# a static editorial estimate, not a live-fetched metric, and is labelled that
# way in the API response so it's never mistaken for measured data.
#
# Local-business directories (Yelp, Angi, HomeAdvisor, Houzz, ...) are
# deliberately absent: those are already covered by the Local Citations
# feature in routers/opportunities.py, and duplicating them here would mean
# two features tracking the same listings out of sync.
B2B_DIRECTORIES = [
    {"id": "clutch", "name": "Clutch", "domain": "clutch.co",
     "submission_url": "https://clutch.co/get-listed", "approx_da": 91,
     "category": "B2B services & reviews",
     "notes": "The highest-signal listing for a consultancy. Profile is free; client reviews are collected separately and are what actually drive ranking on the site."},
    {"id": "goodfirms", "name": "GoodFirms", "domain": "goodfirms.co",
     "submission_url": "https://www.goodfirms.co/get-listed", "approx_da": 78,
     "category": "B2B services & reviews",
     "notes": "Free listing, straightforward form. Asks for service-line percentages — have your split ready."},
    {"id": "themanifest", "name": "The Manifest", "domain": "themanifest.com",
     "submission_url": "https://themanifest.com/get-listed", "approx_da": 76,
     "category": "B2B services",
     "notes": "Sister site to Clutch — listing there often feeds this one, so do Clutch first."},
    {"id": "designrush", "name": "DesignRush", "domain": "designrush.com",
     "submission_url": "https://www.designrush.com/agency/signup", "approx_da": 77,
     "category": "Agency directory",
     "notes": "Free tier exists alongside paid placement; the free listing is enough for the link."},
    {"id": "sortlist", "name": "Sortlist", "domain": "sortlist.com",
     "submission_url": "https://www.sortlist.com/join-us", "approx_da": 74,
     "category": "Agency directory",
     "notes": "Free profile; strongest in EU markets."},
    {"id": "upcity", "name": "UpCity", "domain": "upcity.com",
     "submission_url": "https://upcity.com/get-listed/", "approx_da": 72,
     "category": "B2B services",
     "notes": "Free basic listing available."},
    {"id": "techbehemoths", "name": "TechBehemoths", "domain": "techbehemoths.com",
     "submission_url": "https://techbehemoths.com/register", "approx_da": 62,
     "category": "IT companies",
     "notes": "Free, IT-services specific, quick approval."},
    {"id": "appfutura", "name": "AppFutura", "domain": "appfutura.com",
     "submission_url": "https://www.appfutura.com/companies/new", "approx_da": 60,
     "category": "Development companies",
     "notes": "Free company profile."},
    {"id": "g2", "name": "G2", "domain": "g2.com",
     "submission_url": "https://sell.g2.com/claim", "approx_da": 92,
     "category": "Software & services reviews",
     "notes": "Claim or create a profile free. Service providers list under G2's services category."},
    {"id": "capterra", "name": "Capterra", "domain": "capterra.com",
     "submission_url": "https://www.capterra.com/vendors", "approx_da": 91,
     "category": "Software reviews",
     "notes": "Free vendor listing. Most relevant if you publish your own product or packaged offering."},
    {"id": "getapp", "name": "GetApp", "domain": "getapp.com",
     "submission_url": "https://www.getapp.com/vendors", "approx_da": 86,
     "category": "Software reviews",
     "notes": "Same Gartner network as Capterra — one submission often covers both."},
    {"id": "softwareadvice", "name": "Software Advice", "domain": "softwareadvice.com",
     "submission_url": "https://www.softwareadvice.com/vendors", "approx_da": 85,
     "category": "Software reviews",
     "notes": "Also Gartner-owned; strong for ERP/CRM search intent specifically."},
    {"id": "trustradius", "name": "TrustRadius", "domain": "trustradius.com",
     "submission_url": "https://www.trustradius.com/vendors", "approx_da": 80,
     "category": "Software reviews",
     "notes": "Free vendor profile; review-led."},
    {"id": "crunchbase", "name": "Crunchbase", "domain": "crunchbase.com",
     "submission_url": "https://www.crunchbase.com/register", "approx_da": 92,
     "category": "Company profiles",
     "notes": "Free company profile. High authority and widely scraped by other databases, so it propagates."},
    {"id": "linkedin", "name": "LinkedIn Company Page", "domain": "linkedin.com",
     "submission_url": "https://www.linkedin.com/company/setup/new/", "approx_da": 99,
     "category": "Company profiles",
     "notes": "Nofollow link, so no direct link equity — still worth it for brand entity signals and referral traffic."},
    {"id": "producthunt", "name": "Product Hunt", "domain": "producthunt.com",
     "submission_url": "https://www.producthunt.com/posts/new", "approx_da": 90,
     "category": "Product launches",
     "notes": "Only relevant if you have an actual product or tool to launch — not for a services-only profile."},
    {"id": "appexchange", "name": "Salesforce AppExchange (Consulting)", "domain": "appexchange.salesforce.com",
     "submission_url": "https://appexchange.salesforce.com/consulting", "approx_da": 91,
     "category": "Vendor partner directory",
     "notes": "Requires Salesforce Consulting Partner status — not open self-serve. Highest-intent listing available to a Salesforce practice if you qualify."},
    {"id": "oracle_netsuite_partners", "name": "Oracle NetSuite Partner Directory", "domain": "netsuite.com",
     "submission_url": "https://www.netsuite.com/portal/partners/directory.shtml", "approx_da": 90,
     "category": "Vendor partner directory",
     "notes": "Requires an active NetSuite partner agreement — not open self-serve. Highest-intent listing for a NetSuite practice if you qualify."},
]

_DIRECTORY_BY_ID = {d["id"]: d for d in B2B_DIRECTORIES}

SUBMISSION_STATUSES = ("not_started", "prepared", "submitted", "live", "rejected")

# The real steps for working a directory listing, independent of which
# directory it is. Deterministic — no AI call, nothing invented.
DIRECTORY_STEPS = [
    "Fill in your Company Profile first (Local SEO → Company Profile) and mark it verified — every listing below is generated from those facts, and nothing here will invent details you haven't confirmed.",
    "Click Prepare on a directory to generate its listing copy at the lengths that directory asks for (tagline, short, medium, long) plus categories and tags.",
    "Click Open submission page, create the account or sign in, and paste the prepared fields across. Keep the business name, address and phone character-for-character identical everywhere — inconsistent NAP is the single most common reason listings don't get credited.",
    "Submit the form, then click Mark submitted here so the status is tracked.",
    "Click Verify (or Verify all) once approval has had time to land — usually a few days. That runs a real Google site: search for your business on that domain and flips the status to Live only when it actually finds the listing.",
    "For review-led directories (Clutch, G2, TrustRadius), the listing alone does little — ask 2–3 recent clients for a review once the profile is live.",
]


class SubmissionUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    status: Optional[str] = None
    listing_url: Optional[str] = None
    notes: Optional[str] = None


async def _profile_for(site_id: str) -> dict:
    """The site's VERIFIED company profile, or {} if none is verified. Listing
    copy is only ever generated from confirmed facts — an unverified or
    missing profile is refused rather than filled in with guesses."""
    return await db.company_profiles.find_one({"site_id": site_id, "verified": True}, {"_id": 0}) or {}


async def _submissions_for(site_id: str) -> dict:
    docs = await db.directory_submissions.find({"site_id": site_id}, {"_id": 0}).to_list(500)
    return {d["directory_id"]: d for d in docs}


@api_router.get("/directories/{site_id}")
async def list_directories(site_id: str, user=Depends(require_user)):
    """The catalogue joined with this site's submission state."""
    submissions = await _submissions_for(site_id)
    profile = await _profile_for(site_id)
    entries = []
    for d in B2B_DIRECTORIES:
        sub = submissions.get(d["id"], {})
        entries.append({
            **d,
            "da_is_estimate": True,  # static editorial estimate, never a measured metric
            "status": sub.get("status", "not_started"),
            "listing_url": sub.get("listing_url"),
            "notes_user": sub.get("notes"),
            "listing_content": sub.get("listing_content"),
            "prepared_at": sub.get("prepared_at"),
            "submitted_at": sub.get("submitted_at"),
            "verified_at": sub.get("verified_at"),
            "last_verify_result": sub.get("last_verify_result"),
        })
    counts = {s: 0 for s in SUBMISSION_STATUSES}
    for e in entries:
        counts[e["status"]] = counts.get(e["status"], 0) + 1
    return {
        "directories": entries,
        "counts": counts,
        "steps": DIRECTORY_STEPS,
        "profile_ready": bool(profile.get("business_name")),
        "verification_available": await cse_available(),
    }


@api_router.post("/directories/{site_id}/prepare/{directory_id}")
async def prepare_directory_listing(site_id: str, directory_id: str, user=Depends(require_editor)):
    """Generate listing copy for one directory from the verified company
    profile. Refuses outright when no verified profile exists rather than
    inventing a business description."""
    directory = _DIRECTORY_BY_ID.get(directory_id)
    if not directory:
        raise HTTPException(status_code=404, detail=f"Unknown directory '{directory_id}'")

    profile = await _profile_for(site_id)
    if not profile.get("business_name"):
        raise HTTPException(
            status_code=400,
            detail="No verified company profile for this site. Fill in and verify the Company Profile first — "
                   "listing copy is generated only from confirmed facts, never invented.",
        )

    facts = {
        "business_name": profile.get("business_name", ""),
        "website": profile.get("website", ""),
        "address": profile.get("address", ""),
        "phone": profile.get("phone", ""),
        "description": profile.get("description", ""),
        "categories": profile.get("categories", []),
    }
    prompt = [
        {"role": "system", "content": "You write directory listing copy. You may ONLY use facts explicitly given to you. "
                                       "Never invent services, clients, awards, years in business, team sizes, locations or numbers. "
                                       "If a fact isn't supplied, leave it out. Return JSON only."},
        {"role": "user", "content": f"""Write directory listing copy for this company's profile on {directory['name']} ({directory['category']}).

VERIFIED FACTS (the only information you may use):
{facts}

Return JSON exactly:
{{
  "tagline": "<=80 characters, no company name repetition",
  "short_description": "<=160 characters",
  "medium_description": "<=300 characters",
  "long_description": "<=600 characters",
  "categories": ["3-6 directory category labels that fit the facts"],
  "tags": ["6-10 short keyword tags"]
}}"""},
    ]
    try:
        raw = await get_ai_response(prompt, max_tokens=900, temperature=0.4)
        import json as _json
        content = _json.loads(raw[raw.find("{"):raw.rfind("}") + 1])
    except Exception as e:
        logger.warning(f"Directory listing copy generation failed for {directory_id}: {e}")
        raise HTTPException(status_code=502, detail=f"Could not generate listing copy: {e}")

    # The literal profile fields go through verbatim — only the prose is
    # AI-written, and only from the facts above.
    content["business_name"] = facts["business_name"]
    content["website"] = facts["website"]
    content["address"] = facts["address"]
    content["phone"] = facts["phone"]

    now = datetime.now(timezone.utc).isoformat()
    existing = await db.directory_submissions.find_one({"site_id": site_id, "directory_id": directory_id})
    update = {"listing_content": content, "prepared_at": now, "updated_at": now}
    # Preparing copy must never walk back real progress on an already-submitted listing.
    if not existing or existing.get("status", "not_started") == "not_started":
        update["status"] = "prepared"
    await db.directory_submissions.update_one(
        {"site_id": site_id, "directory_id": directory_id},
        {"$set": update, "$setOnInsert": {"id": str(uuid.uuid4()), "site_id": site_id, "directory_id": directory_id}},
        upsert=True,
    )
    await log_activity(site_id, "directory_prepared", f"Prepared listing copy for {directory['name']}")
    return {"directory_id": directory_id, "listing_content": content,
            "status": update.get("status", (existing or {}).get("status", "prepared"))}


@api_router.patch("/directories/{site_id}/submission/{directory_id}")
async def update_directory_submission(site_id: str, directory_id: str, body: SubmissionUpdate, user=Depends(require_editor)):
    if directory_id not in _DIRECTORY_BY_ID:
        raise HTTPException(status_code=404, detail=f"Unknown directory '{directory_id}'")
    update = {k: v for k, v in body.model_dump().items() if v is not None}
    if "status" in update and update["status"] not in SUBMISSION_STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {list(SUBMISSION_STATUSES)}")
    if not update:
        raise HTTPException(status_code=400, detail="Nothing to update")
    now = datetime.now(timezone.utc).isoformat()
    update["updated_at"] = now
    if update.get("status") == "submitted":
        update["submitted_at"] = now
    await db.directory_submissions.update_one(
        {"site_id": site_id, "directory_id": directory_id},
        {"$set": update, "$setOnInsert": {"id": str(uuid.uuid4()), "site_id": site_id, "directory_id": directory_id}},
        upsert=True,
    )
    if update.get("status"):
        await log_activity(site_id, "directory_status",
                           f"{_DIRECTORY_BY_ID[directory_id]['name']} listing marked {update['status']}")
    return {"ok": True, **update}


async def _verify_one(site_id: str, directory_id: str, business_name: str) -> dict:
    """Real check: does a Google site: search actually find this business on
    the directory's domain? Returns a result dict; `found` is None (unknown)
    rather than False when the search itself couldn't run, so a missing
    Google CSE key never gets reported as 'not listed'."""
    directory = _DIRECTORY_BY_ID[directory_id]
    if not await cse_available():
        return {"found": None, "listing_url": None,
                "note": "Google Custom Search isn't configured, so the listing couldn't be verified either way."}
    try:
        results = await google_custom_search(f'site:{directory["domain"]} "{business_name}"', num=1)
    except Exception as e:
        logger.warning(f"Directory verification failed for {directory_id}: {e}")
        return {"found": None, "listing_url": None, "note": f"Verification lookup failed: {e}"}
    if not results:
        return {"found": False, "listing_url": None,
                "note": "No listing found yet — directories often take a few days to approve and index."}
    return {"found": True, "listing_url": results[0]["url"], "note": "Listing found and confirmed live."}


@api_router.post("/directories/{site_id}/verify/{directory_id}")
async def verify_directory_listing(site_id: str, directory_id: str, user=Depends(require_editor)):
    if directory_id not in _DIRECTORY_BY_ID:
        raise HTTPException(status_code=404, detail=f"Unknown directory '{directory_id}'")
    profile = await _profile_for(site_id)
    business_name = profile.get("business_name", "")
    if not business_name:
        raise HTTPException(status_code=400, detail="No verified company profile — nothing to search for.")

    result = await _verify_one(site_id, directory_id, business_name)
    now = datetime.now(timezone.utc).isoformat()
    update = {"last_verify_result": result, "verified_at": now, "updated_at": now,
              **_data_meta("google_cse", is_estimated=False)}
    if result["found"] is True:
        update["status"] = "live"
        if result.get("listing_url"):
            update["listing_url"] = result["listing_url"]
    await db.directory_submissions.update_one(
        {"site_id": site_id, "directory_id": directory_id},
        {"$set": update, "$setOnInsert": {"id": str(uuid.uuid4()), "site_id": site_id, "directory_id": directory_id}},
        upsert=True,
    )
    return {"directory_id": directory_id, **result, "status": update.get("status")}


@api_router.post("/directories/{site_id}/verify-all")
async def verify_all_directory_listings(site_id: str, background_tasks: BackgroundTasks, user=Depends(require_editor)):
    """Background-verify every directory this site has marked submitted (or
    already live, to catch a listing that later disappeared)."""
    task_id = make_task_id()
    await create_task_queue(task_id)

    async def run(tid):
        try:
            profile = await _profile_for(site_id)
            business_name = profile.get("business_name", "")
            if not business_name:
                await push_event(tid, "error", {"message": "No verified company profile — nothing to search for."})
                return
            submissions = await _submissions_for(site_id)
            targets = [d for d in B2B_DIRECTORIES
                       if submissions.get(d["id"], {}).get("status") in ("submitted", "live")]
            if not targets:
                await push_event(tid, "complete", {"message": "Nothing marked submitted yet — nothing to verify.",
                                                   "checked": 0, "live": 0})
                return
            live = 0
            for idx, d in enumerate(targets, start=1):
                await push_event(tid, "progress", {
                    "message": f"Checking {d['name']} ({idx}/{len(targets)})…",
                    "current": idx, "total": len(targets),
                })
                result = await _verify_one(site_id, d["id"], business_name)
                now = datetime.now(timezone.utc).isoformat()
                update = {"last_verify_result": result, "verified_at": now, "updated_at": now}
                if result["found"] is True:
                    update["status"] = "live"
                    live += 1
                    if result.get("listing_url"):
                        update["listing_url"] = result["listing_url"]
                await db.directory_submissions.update_one(
                    {"site_id": site_id, "directory_id": d["id"]}, {"$set": update}, upsert=True,
                )
            await log_activity(site_id, "directory_verify", f"Verified {len(targets)} directory listing(s): {live} live")
            await push_event(tid, "complete", {
                "message": f"Checked {len(targets)} listing(s) — {live} confirmed live.",
                "checked": len(targets), "live": live,
            })
        except Exception as e:
            await push_event(tid, "error", {"message": str(e)})
        finally:
            await finish_task(tid)

    background_tasks.add_task(run, task_id)
    return {"task_id": task_id}
