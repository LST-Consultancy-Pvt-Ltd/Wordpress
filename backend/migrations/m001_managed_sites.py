"""Migration 001: legacy site records -> ManagedSite schema.

Usage (from backend/, with MONGO_URL / DB_NAME set):

  python -m migrations.m001_managed_sites plan                 # dry run (default): prints what would change
  python -m migrations.m001_managed_sites apply --backup-manifest PATH
  python -m migrations.m001_managed_sites rollback             # restore originals from the archive
  python -m migrations.m001_managed_sites finalize --confirm-finalize   # drop archive + legacy caches (irreversible)

What `apply` does, per site document that is not yet migrated:
  1. copies the ORIGINAL document into `sites_premigration_archive` (reversible
     until `finalize`);
  2. keeps only useful, non-sensitive data: id, name, public URL (-> base_url),
     user_id, timestamps, onboarding/business fields;
  3. REMOVES every legacy credential field (usernames, passwords,
     JWTs, the old permanent bridge bearer token, platform/auth type) — none is
     migrated;
  4. sets connection.status = "unverified", writes_enabled = false, and a
     placeholder bridge_url/site_key: an admin must reconnect the site with a
     new bridge key (the new protocol uses signed requests, not bearer tokens).

Activity logs, SEO data, keywords, audits etc. are keyed by site id and are
untouched. `apply` refuses to run without a backup manifest (the JSON written
next to the pre-migration backup) so credentials are never purged without a
restorable copy. Every run is logged to `migration_runs`. Re-running `apply`
skips already-migrated documents (idempotent).
"""
import argparse
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

MIGRATION_ID = "m001_managed_sites"
ARCHIVE = "sites_premigration_archive"
# Old caches superseded by content_items; dropped only at finalize.
LEGACY_COLLECTIONS = ("posts", "pages", "navigation", "backups")
KEEP_FIELDS = {
    "id", "name", "user_id", "created_at", "updated_at", "business_description", "target_audience",
    "industry", "onboarding", "onboarding_completed", "topics", "health_check_interval_minutes",
}
# Anything that looks like a secret or a legacy connection detail is dropped.
SENSITIVE = re.compile(r"(?i)(pass|token|secret|jwt|key|auth|user(name)?$|consumer|credential|bridge_)")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def site_key_from(name: str, doc_id: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:40] or "site"
    if not base[0].isalpha():
        base = "s-" + base
    return f"{base}-{doc_id[:6]}".strip("-")


def transform(doc: dict) -> tuple[dict, list[str]]:
    """Return (new document, dropped field names). Pure function — unit tested."""
    dropped = sorted(k for k in doc if k not in KEEP_FIELDS and k not in ("_id", "url"))
    new = {k: v for k, v in doc.items() if k in KEEP_FIELDS}
    url = (doc.get("url") or doc.get("base_url") or "").strip().rstrip("/")
    if url.startswith("http://"):
        url = "https://" + url[len("http://"):]
    new.update({
        "base_url": url,
        "bridge_url": "",  # must be supplied when reconnecting
        "environment": "production",
        "site_key": site_key_from(doc.get("name", ""), doc.get("id", "")),
        "install_mode": "sidecar",
        "connection": {"status": "unverified", "key_id": "", "credential_rotated_at": None,
                       "last_handshake_at": None, "private_network_http": False,
                       "last_error": "Migrated from the previous platform: reconnect this site with a bridge key."},
        "writes_enabled": False,
        "write_verified_at": None,
        "capabilities": None,
        "health": None,
        "migrated": {"id": MIGRATION_ID, "at": now()},
        "updated_at": now(),
    })
    carried = {k for k in new if k in doc and k in KEEP_FIELDS}
    if any(SENSITIVE.search(k) for k in carried):
        raise ValueError(f"refusing to carry a sensitive-looking field: {sorted(carried)}")
    return new, dropped


async def _db():
    from motor.motor_asyncio import AsyncIOMotorClient
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    return client, client[os.environ["DB_NAME"]]


async def plan(db) -> dict:
    todo, done = [], 0
    async for doc in db.sites.find({}):
        if (doc.get("migrated") or {}).get("id") == MIGRATION_ID:
            done += 1
            continue
        new, dropped = transform(doc)
        todo.append({"id": doc.get("id"), "name": doc.get("name"), "base_url": new["base_url"],
                     "dropped_fields": dropped})
    counts = {c: await db[c].count_documents({}) for c in LEGACY_COLLECTIONS}
    return {"to_migrate": todo, "already_migrated": done, "legacy_collections": counts}


def _check_manifest(path: str) -> dict:
    p = Path(path)
    if not p.is_file():
        raise SystemExit(f"backup manifest not found: {path}")
    try:
        manifest = json.loads(p.read_text())
    except ValueError:
        raise SystemExit("backup manifest is not valid JSON")
    if not manifest.get("created_utc") and not manifest.get("created_at"):
        raise SystemExit("backup manifest has no creation timestamp")
    return manifest


async def apply(db, manifest_path: str) -> dict:
    manifest = _check_manifest(manifest_path)
    migrated = []
    async for doc in db.sites.find({}):
        if (doc.get("migrated") or {}).get("id") == MIGRATION_ID:
            continue
        new, dropped = transform(doc)
        await db[ARCHIVE].replace_one({"_id": doc["_id"]}, doc, upsert=True)
        await db.sites.replace_one({"_id": doc["_id"]}, new)
        migrated.append({"id": doc.get("id"), "dropped_fields": dropped})
    run = {"migration": MIGRATION_ID, "action": "apply", "at": now(), "migrated": migrated,
           "backup_manifest": {k: manifest.get(k) for k in ("db_name", "created_utc", "created_at", "archive")}}
    await db.migration_runs.insert_one(dict(run))
    return run


async def rollback(db) -> dict:
    restored = 0
    async for original in db[ARCHIVE].find({}):
        await db.sites.replace_one({"_id": original["_id"]}, original, upsert=True)
        restored += 1
    run = {"migration": MIGRATION_ID, "action": "rollback", "at": now(), "restored": restored}
    await db.migration_runs.insert_one(dict(run))
    return run


async def finalize(db) -> dict:
    remaining = await db.sites.count_documents({"migrated.id": {"$ne": MIGRATION_ID}})
    if remaining:
        raise SystemExit(f"{remaining} site(s) are not migrated; run apply first")
    dropped = []
    for coll in (ARCHIVE, *LEGACY_COLLECTIONS):
        if coll in await db.list_collection_names():
            await db[coll].drop()
            dropped.append(coll)
    run = {"migration": MIGRATION_ID, "action": "finalize", "at": now(), "dropped": dropped}
    await db.migration_runs.insert_one(dict(run))
    return run


async def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", nargs="?", default="plan", choices=["plan", "apply", "rollback", "finalize"])
    ap.add_argument("--backup-manifest")
    ap.add_argument("--confirm-finalize", action="store_true")
    args = ap.parse_args(argv)
    client, db = await _db()
    try:
        if args.action == "plan":
            result = await plan(db)
        elif args.action == "apply":
            if not args.backup_manifest:
                raise SystemExit("apply requires --backup-manifest (see migration/README.md for the backup procedure)")
            result = await apply(db, args.backup_manifest)
        elif args.action == "rollback":
            result = await rollback(db)
        else:
            if not args.confirm_finalize:
                raise SystemExit("finalize is irreversible; pass --confirm-finalize")
            result = await finalize(db)
        print(json.dumps(result, indent=1, default=str))
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
