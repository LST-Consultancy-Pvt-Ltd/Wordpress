"""Hunter.io Domain Search client — suggests a real contact email for a
backlink prospect's domain instead of leaving `recipient_email` blank (the
§1 fix deliberately never invents one, since there's no real signal without
a provider like this).

Credentials come from Settings.hunter_api_key, falling back to the
HUNTER_API_KEY env var.

Quota note: Hunter's Domain Search deducts one search credit per email
*returned*, not per request — the free tier is 25/month. `hunter_domain_search`
defaults to `limit=1` to conserve that quota. This means `_pick_best_email`'s
personal-over-generic preference only ever sees a single candidate in
practice (whatever Hunter itself ranked first) — a deliberate quota-vs-
selection-quality tradeoff, not an oversight. Raise `limit` only if the
quota cost of doing so is an accepted tradeoff.
"""
import os

import httpx

from core.crypto import get_decrypted_settings


async def _hunter_credentials() -> str:
    settings = await get_decrypted_settings()
    return settings.get("hunter_api_key") or os.environ.get("HUNTER_API_KEY", "")


async def hunter_available() -> bool:
    return bool(await _hunter_credentials())


def _pick_best_email(emails: list) -> dict | None:
    """Personal-type candidates always outrank generic-type ones (e.g.
    info@/contact@) regardless of confidence gap; within a tier, highest
    confidence wins. Returns None on an empty list."""
    if not emails:
        return None
    ranked = sorted(
        emails,
        key=lambda e: (e.get("type") == "personal", e.get("confidence", 0) or 0),
        reverse=True,
    )
    return ranked[0]


async def hunter_domain_search(domain: str, limit: int = 1) -> dict | None:
    """Real contact-email suggestion for `domain`, or None if Hunter isn't
    configured or the lookup finds/returns nothing. Never raises — callers
    must treat None as "no suggestion available", never fabricate one."""
    api_key = await _hunter_credentials()
    if not api_key or not domain:
        return None
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                "https://api.hunter.io/v2/domain-search",
                params={"domain": domain, "api_key": api_key, "limit": limit},
            )
            if resp.status_code != 200:
                return None
            emails = resp.json().get("data", {}).get("emails", [])
    except Exception:
        return None

    best = _pick_best_email(emails)
    if not best:
        return None
    return {
        "email": best.get("value", ""),
        "confidence": best.get("confidence", 0),
        "type": best.get("type", "generic"),
        "first_name": best.get("first_name"),
        "last_name": best.get("last_name"),
        "position": best.get("position"),
    }
