"""SEMrush client — an independent, authoritative cross-check for keyword
research, shown *alongside* DataForSEO's numbers, never silently replacing
them (the user explicitly asked for a cross-check, not a swap).

Credentials come from Settings.semrush_api_key, falling back to the
SEMRUSH_API_KEY env var.

SEMrush's Analytics v3 API (https://api.semrush.com/) is a GET-based REST
API that returns semicolon-delimited CSV (header row of column codes, e.g.
"Ph;Nq;Cp;Co") rather than JSON, and signals a no-data/error condition via a
plain-text body starting with "ERROR" (community-documented convention,
e.g. "ERROR 50 :: NOTHING FOUND") rather than a non-2xx HTTP status. Before
trusting this in production, do one live smoke-test call with a real key
and inspect the raw response body — the official docs only show column-code
tables, not a literal example body.

Report types used here (per developer.semrush.com/api/v3/analytics/keyword-reports/):
- phrase_kdi  (Keyword Difficulty)   — 50 API units/line
- phrase_this (Keyword Overview, one database) — 10 API units/line

Never raises — returns None on "not configured" or "lookup failed", same
contract as providers/hunter.py and providers/signalhire.py.
"""
import logging
import os
from datetime import datetime, timezone

import httpx

from core.crypto import get_decrypted_settings
from core.db import db

logger = logging.getLogger(__name__)

_BASE_URL = "https://api.semrush.com/"
_DEFAULT_DATABASE = "us"

# SEMrush bills in API units against a fixed monthly plan quota, not
# real-time dollars — a runaway integration would drain that quota rather
# than an open-ended bill, but it's still worth guarding the same way
# providers/dataforseo.py guards its daily $ spend.
SEMRUSH_DAILY_UNIT_LIMIT = int(os.environ.get("SEMRUSH_DAILY_UNIT_LIMIT", "2000"))


async def _semrush_credentials() -> str:
    settings = await get_decrypted_settings()
    return settings.get("semrush_api_key") or os.environ.get("SEMRUSH_API_KEY", "")


async def semrush_available() -> bool:
    return bool(await _semrush_credentials())


async def _semrush_check_spend(site_id: str, units: int) -> None:
    """Raises a plain Exception (not HTTPException — this call is always
    optional/best-effort) if today's SEMrush unit usage for this site would
    exceed SEMRUSH_DAILY_UNIT_LIMIT."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    doc = await db.semrush_daily_spend.find_one({"date": today, "site_id": site_id})
    spent = (doc or {}).get("units", 0)
    if spent + units > SEMRUSH_DAILY_UNIT_LIMIT:
        raise Exception(f"SEMrush daily unit budget exceeded for site {site_id} ({spent}+{units} > {SEMRUSH_DAILY_UNIT_LIMIT})")
    await db.semrush_daily_spend.update_one(
        {"date": today, "site_id": site_id},
        {"$inc": {"units": units}},
        upsert=True,
    )


def _parse_semrush_csv(text: str) -> list[dict]:
    """Parses SEMrush's semicolon-delimited CSV (header row + data rows) into
    a list of {column_code: value} dicts. Returns [] on an empty body, a
    documented "ERROR ..." response, or any unrecognized shape — never
    raises, logs a warning instead so a format-drift doesn't silently break
    callers."""
    if not text or not text.strip():
        return []
    stripped = text.strip()
    if stripped.upper().startswith("ERROR"):
        logger.warning(f"SEMrush returned an error body: {stripped[:200]}")
        return []
    lines = stripped.splitlines()
    if len(lines) < 2:
        return []
    header = lines[0].split(";")
    rows = []
    for line in lines[1:]:
        values = line.split(";")
        if len(values) != len(header):
            logger.warning(f"SEMrush CSV row/header length mismatch, skipping: {line[:200]}")
            continue
        rows.append(dict(zip(header, values)))
    return rows


async def semrush_keyword_difficulty(site_id: str, keyword: str, database: str = _DEFAULT_DATABASE) -> int | None:
    """Real, authoritative Keyword Difficulty Index for `keyword`, or None
    if not configured, over budget, or the lookup finds/returns nothing."""
    api_key = await _semrush_credentials()
    if not api_key or not keyword:
        return None
    try:
        await _semrush_check_spend(site_id, 50)
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(_BASE_URL, params={
                "type": "phrase_kdi", "key": api_key, "phrase": keyword,
                "database": database, "export_columns": "Ph,Kd",
            })
        if resp.status_code != 200:
            return None
        rows = _parse_semrush_csv(resp.text)
    except Exception as e:
        logger.warning(f"SEMrush keyword-difficulty lookup failed for '{keyword}': {e}")
        return None
    if not rows:
        return None
    try:
        return int(float(rows[0].get("Kd", "")))
    except (ValueError, TypeError):
        return None


async def semrush_keyword_overview(site_id: str, keyword: str, database: str = _DEFAULT_DATABASE) -> dict | None:
    """Real volume/CPC/competition for `keyword` from SEMrush's own
    database, or None if not configured, over budget, or nothing found."""
    api_key = await _semrush_credentials()
    if not api_key or not keyword:
        return None
    try:
        await _semrush_check_spend(site_id, 10)
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(_BASE_URL, params={
                "type": "phrase_this", "key": api_key, "phrase": keyword,
                "database": database, "export_columns": "Ph,Nq,Cp,Co,Nr",
            })
        if resp.status_code != 200:
            return None
        rows = _parse_semrush_csv(resp.text)
    except Exception as e:
        logger.warning(f"SEMrush keyword-overview lookup failed for '{keyword}': {e}")
        return None
    if not rows:
        return None
    row = rows[0]
    try:
        return {
            "volume": int(float(row.get("Nq", 0) or 0)),
            "cpc": float(row.get("Cp", 0) or 0),
            "competition": float(row.get("Co", 0) or 0),
        }
    except (ValueError, TypeError):
        return None
