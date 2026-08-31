import base64
import hashlib as _hashlib
import json
import os
from datetime import datetime, timezone

import httpx
from fastapi import HTTPException

from core.crypto import _fernet, decrypt_field
from core.db import db

DATAFORSEO_LOGIN = os.environ.get("DATAFORSEO_LOGIN", "")
DATAFORSEO_PASSWORD = os.environ.get("DATAFORSEO_PASSWORD", "")
GOOGLE_TRENDS_CACHE_TTL = int(os.environ.get("GOOGLE_TRENDS_CACHE_TTL", "3600"))
DATAFORSEO_CACHE_TTL = int(os.environ.get("DATAFORSEO_CACHE_TTL", "86400"))

# Cache TTLs by data type (seconds)
DFS_TTL = {
    "search_volume": 86400,
    "keyword_ideas": 86400,
    "serp": 21600,
    "backlink_summary": 86400,
    "backlink_list": 43200,
    "rank_check": 14400,
    "competitor_gap": 86400,
    "google_trends": 3600,
}


async def _get_dfs_credentials() -> tuple:
    """Return DataForSEO login/password from DB settings, falling back to env vars."""
    settings = await db.settings.find_one({"id": "global_settings"}, {"_id": 0})
    login = DATAFORSEO_LOGIN
    password = DATAFORSEO_PASSWORD
    if settings:
        from_db_login = settings.get("dataforseo_login", "")
        from_db_password = settings.get("dataforseo_password", "")
        if from_db_login:
            login = decrypt_field(from_db_login) if _fernet else from_db_login
        if from_db_password:
            password = decrypt_field(from_db_password) if _fernet else from_db_password
    return login, password


def _dfs_auth_header(login: str, password: str) -> dict:
    """Return Basic Auth header for DataForSEO."""
    token = base64.b64encode(f"{login}:{password}".encode()).decode()
    return {"Authorization": f"Basic {token}", "Content-Type": "application/json"}


async def dataforseo_post(endpoint: str, payload: list) -> dict:
    """POST to DataForSEO API and return the tasks[0].result."""
    login, password = await _get_dfs_credentials()
    if not login or not password:
        raise HTTPException(status_code=400, detail="DataForSEO credentials not configured")
    url = f"https://api.dataforseo.com{endpoint}"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, headers=_dfs_auth_header(login, password), json=payload)
        resp.raise_for_status()
        data = resp.json()
        if data.get("status_code") != 20000:
            raise HTTPException(status_code=502, detail=f"DataForSEO error: {data.get('status_message')}")
        tasks = data.get("tasks", [])
        if not tasks or tasks[0].get("status_code") != 20000:
            raise HTTPException(
                status_code=502,
                detail=f"DataForSEO task error: {tasks[0].get('status_message') if tasks else 'No tasks'}"
            )
        return tasks[0].get("result", [])


async def dataforseo_get(endpoint: str) -> dict:
    """GET from DataForSEO API."""
    login, password = await _get_dfs_credentials()
    if not login or not password:
        raise HTTPException(status_code=400, detail="DataForSEO credentials not configured")
    url = f"https://api.dataforseo.com{endpoint}"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, headers=_dfs_auth_header(login, password))
        resp.raise_for_status()
        data = resp.json()
        tasks = data.get("tasks", [])
        return tasks[0].get("result", []) if tasks else []


async def _dfs_available() -> bool:
    """Check whether DataForSEO credentials are configured."""
    login, password = await _get_dfs_credentials()
    return bool(login and password)


# ─── DataForSEO Daily Spend Guard ────────────────────────────
DFS_DAILY_LIMIT = float(os.environ.get("DATAFORSEO_DAILY_LIMIT", "5.0"))


async def _dfs_check_spend(site_id: str, estimated_cost: float) -> bool:
    """Return True if the spend is under limit, else raise 429."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    doc = await db.dfs_daily_spend.find_one({"date": today, "site_id": site_id})
    current = doc["total_cost"] if doc else 0.0
    if current + estimated_cost > DFS_DAILY_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=f"Daily DataForSEO budget limit reached (${DFS_DAILY_LIMIT:.2f}). Resets at midnight UTC."
        )
    await db.dfs_daily_spend.update_one(
        {"date": today, "site_id": site_id},
        {"$inc": {"total_cost": estimated_cost}, "$setOnInsert": {"date": today, "site_id": site_id}},
        upsert=True,
    )
    return True


# ─── DataForSEO Persistent + In-Memory Cache ─────────────────
_dfs_mem_cache: dict = {}


def _cache_key(*args) -> str:
    return _hashlib.md5(json.dumps(args, sort_keys=True).encode()).hexdigest()


async def _cache_get(key: str, ttl: int = 86400):
    """Check memory cache then MongoDB cache."""
    # Memory cache
    entry = _dfs_mem_cache.get(key)
    if entry and (datetime.now(timezone.utc).timestamp() - entry["ts"]) < ttl:
        return entry["data"]
    # MongoDB cache
    doc = await db.dfs_cache.find_one({"key": key}, {"_id": 0})
    if doc:
        cached_at = doc.get("cached_at")
        if isinstance(cached_at, str):
            cached_at = datetime.fromisoformat(cached_at)
        if cached_at.tzinfo is None:
            # Motor/PyMongo returns BSON datetimes as naive (UTC-valued but
            # no tzinfo) since this client isn't configured with
            # tz_aware=True — even though _cache_set wrote an aware UTC
            # datetime. Re-attach it before comparing against an aware "now".
            cached_at = cached_at.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - cached_at).total_seconds()
        if age < ttl:
            _dfs_mem_cache[key] = {"data": doc["data"], "ts": datetime.now(timezone.utc).timestamp()}
            return doc["data"]
    return None


async def _cache_set(key: str, data):
    """Store in both memory and MongoDB."""
    now = datetime.now(timezone.utc)
    _dfs_mem_cache[key] = {"data": data, "ts": now.timestamp()}
    await db.dfs_cache.replace_one(
        {"key": key},
        {"key": key, "data": data, "cached_at": now},
        upsert=True,
    )


def _data_meta(source: str, freshness: datetime = None, is_estimated: bool = False) -> dict:
    """Standard data source metadata to attach to every response."""
    return {
        "data_source": source,
        "data_freshness": (freshness or datetime.now(timezone.utc)).isoformat(),
        "is_estimated": is_estimated,
    }
