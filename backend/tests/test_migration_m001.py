"""Migration 001 (legacy site records -> ManagedSite): transform purity,
credential purge, backup-manifest gate, idempotency, rollback, finalize.
Runs against the test MongoDB in an isolated database."""
import json
import uuid

import pytest
from motor.motor_asyncio import AsyncIOMotorClient

from migrations import m001_managed_sites as m

from tests.loop import LOOP as _loop  # noqa: E402


def _run(coro):
    return _loop.run_until_complete(coro)


LEGACY = {
    "id": "0f3c2a9e-1111-2222-3333-444455556666", "name": "Acme Marketing", "url": "http://acme.example/",
    "user_id": "u1", "created_at": "2025-01-01T00:00:00Z", "platform": "old-cms", "username": "admin",
    "auth_type": "basic", "jwt_token": "enc:abc", "bridge_token": "enc:def", "bridge_url": "https://x/api/b",
    "consumer_secret": "zzz", "status": "connected", "business_description": "We sell widgets",
}


def test_transform_keeps_only_safe_fields_and_drops_every_credential():
    new, dropped = m.transform(dict(LEGACY))
    assert new["base_url"] == "https://acme.example"
    assert new["name"] == "Acme Marketing" and new["id"] == LEGACY["id"]
    assert new["business_description"] == "We sell widgets"
    for secret_field in ("username", "auth_type", "jwt_token", "bridge_token", "consumer_secret", "platform"):
        assert secret_field not in new
        assert secret_field in dropped
    assert new["writes_enabled"] is False
    assert new["connection"]["status"] == "unverified" and new["connection"]["key_id"] == ""
    assert "enc:" not in json.dumps(new)


def test_site_key_is_valid_for_the_new_schema():
    from models.sites import SITE_KEY_RE
    assert SITE_KEY_RE.match(m.site_key_from("Acme Marketing!", "0f3c2a9e"))
    assert SITE_KEY_RE.match(m.site_key_from("123 Numbers", "abcdef12"))
    assert SITE_KEY_RE.match(m.site_key_from("", "abcdef12"))


@pytest.fixture
def db():
    import os
    client = AsyncIOMotorClient(os.environ["MONGO_URL"], io_loop=_loop)
    name = "m001_test_" + uuid.uuid4().hex[:8]
    yield client[name]
    _run(client.drop_database(name))
    client.close()


def test_apply_requires_a_backup_manifest(db, tmp_path):
    with pytest.raises(SystemExit):
        _run(m.apply(db, str(tmp_path / "missing.json")))
    bad = tmp_path / "bad.json"
    bad.write_text("{}")
    with pytest.raises(SystemExit):
        _run(m.apply(db, str(bad)))


def test_apply_is_idempotent_reversible_and_finalize_is_gated(db, tmp_path):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"db_name": "x", "created_utc": "20260928T000000Z"}))

    async def go():
        await db.sites.insert_one(dict(LEGACY))
        await db.posts.insert_one({"site_id": LEGACY["id"], "title": "cached"})

        plan = await m.plan(db)
        assert len(plan["to_migrate"]) == 1 and plan["legacy_collections"]["posts"] == 1
        assert await db.sites.count_documents({"jwt_token": {"$exists": True}}) == 1  # plan changed nothing

        first = await m.apply(db, str(manifest))
        second = await m.apply(db, str(manifest))
        assert len(first["migrated"]) == 1 and second["migrated"] == []
        doc = await db.sites.find_one({"id": LEGACY["id"]})
        assert "jwt_token" not in doc and doc["migrated"]["id"] == m.MIGRATION_ID
        assert await db[m.ARCHIVE].count_documents({}) == 1

        await m.rollback(db)
        restored = await db.sites.find_one({"id": LEGACY["id"]})
        assert restored["jwt_token"] == "enc:abc"

        await m.apply(db, str(manifest))
        result = await m.finalize(db)
        assert set(result["dropped"]) >= {m.ARCHIVE, "posts"}
        assert m.ARCHIVE not in await db.list_collection_names()
        runs = await db.migration_runs.find({}, {"_id": 0, "action": 1}).to_list(10)
        assert [r["action"] for r in runs] == ["apply", "apply", "rollback", "apply", "finalize"]

    _run(go())


def test_finalize_refuses_when_sites_are_unmigrated(db):
    async def go():
        await db.sites.insert_one(dict(LEGACY))
        with pytest.raises(SystemExit):
            await m.finalize(db)
    _run(go())


def test_migrated_internal_urls_are_not_carried_into_base_url():
    new, _ = m.transform({**LEGACY, "url": "http://10.0.0.5"})
    assert new["base_url"] == "" and new["legacy_url"] == "https://10.0.0.5"
    assert "Public URL rejected" in new["connection"]["last_error"]
