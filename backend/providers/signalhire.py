"""SignalHire client — fallback contact-email finder for backlink prospects
when Hunter.io (providers/hunter.py) doesn't have anything for a domain.

Credentials come from Settings.signalhire_api_key, falling back to the
SIGNALHIRE_API_KEY env var.

Unlike Hunter's Domain Search, SignalHire has no direct "search by domain"
endpoint (confirmed against https://docs.signalhire.com as of this writing —
Person API takes a known identifier: LinkedIn URL, email, phone, or UID;
Search API filters by `currentCompany`, a free-text/boolean company-NAME
query, not a domain). So this is a two-step, best-effort lookup:

1. POST /candidate/searchByQuery with `currentCompany` set to a guess at the
   company name derived from the domain (strip scheme/www/TLD) — this is a
   real search against SignalHire's own database, not an AI guess, but the
   domain->company-name mapping itself is approximate (e.g. "acme.com" ->
   "acme"), so it can legitimately return zero results for a real company
   whose registered name doesn't match its domain root.
2. POST /candidate/search (withoutWaterfall=true, synchronous) on the first
   few candidate UIDs from step 1 to reveal a real contact email.

Never raises — returns None on "not configured", "no matching company", or
"no email in the revealed contacts", so callers can safely fall through
without a suggestion, same contract as hunter_domain_search.
"""
import logging
import os
import re

import httpx

from core.crypto import get_decrypted_settings

logger = logging.getLogger(__name__)

_BASE_URL = "https://www.signalhire.com/api/v1"
_SEARCH_CANDIDATES = 3  # how many search hits to try revealing before giving up


async def _signalhire_credentials() -> str:
    settings = await get_decrypted_settings()
    return settings.get("signalhire_api_key") or os.environ.get("SIGNALHIRE_API_KEY", "")


async def signalhire_available() -> bool:
    return bool(await _signalhire_credentials())


def _company_name_guess(domain: str) -> str:
    """Best-effort company-name query from a bare domain, e.g.
    'www.acme-corp.co.uk' -> 'acme-corp'. Approximate by design — see
    module docstring."""
    host = re.sub(r"^https?://", "", domain).split("/")[0]
    host = re.sub(r"^www\.", "", host)
    return host.split(".")[0] if host else ""


def _pick_best_contact(contacts: list) -> dict | None:
    """Highest `rating` wins; a `work` email breaks a tie over `personal`/
    unset, since we're reaching out for a business purpose. Returns None on
    an empty list or one with no email-type contact."""
    emails = [c for c in contacts if c.get("type") == "email" and c.get("value")]
    if not emails:
        return None
    ranked = sorted(
        emails,
        key=lambda c: (c.get("rating", 0) or 0, c.get("subType") == "work"),
        reverse=True,
    )
    return ranked[0]


async def signalhire_domain_search(domain: str) -> dict | None:
    """Real contact-email suggestion for `domain` via SignalHire, or None if
    not configured, no matching company found, or no email was revealed.
    Never raises."""
    api_key = await _signalhire_credentials()
    if not api_key or not domain:
        return None
    company = _company_name_guess(domain)
    if not company:
        return None

    headers = {"apikey": api_key}
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            search_resp = await client.post(
                f"{_BASE_URL}/candidate/searchByQuery",
                headers=headers,
                json={"currentCompany": company, "size": _SEARCH_CANDIDATES},
            )
            if search_resp.status_code != 200:
                return None
            profiles = search_resp.json().get("profiles", [])
            uids = [p.get("uid") for p in profiles if p.get("uid")][:_SEARCH_CANDIDATES]
            if not uids:
                return None

            reveal_resp = await client.post(
                f"{_BASE_URL}/candidate/search",
                headers=headers,
                json={"items": uids, "withoutWaterfall": True},
            )
            if reveal_resp.status_code not in (200, 201):
                return None
            results = reveal_resp.json()
    except Exception as e:
        logger.warning(f"SignalHire lookup failed for {domain} (company guess '{company}'): {e}")
        return None

    if not isinstance(results, list):
        return None
    for entry in results:
        if entry.get("status") != "success":
            continue
        candidate = entry.get("candidate") or {}
        best = _pick_best_contact(candidate.get("contacts") or [])
        if not best:
            continue
        full_name = candidate.get("fullName") or ""
        first_name, _, last_name = full_name.partition(" ")
        experience = candidate.get("experience") or []
        position = experience[0].get("title") if experience and isinstance(experience[0], dict) else None
        return {
            "email": best["value"],
            "confidence": best.get("rating", 0),
            "type": best.get("subType") or "generic",
            "first_name": first_name or None,
            "last_name": last_name or None,
            "position": position,
        }
    return None
