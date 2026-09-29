"""Control-plane API integration tests against the in-process fake bridge.

Covers: bridge request signing (reference vectors), URL/SSRF policy, secret
redaction, site onboarding + encrypted credentials, the baseline access
policy (anonymous / viewer), every change-set transition and permission
boundary, write verification + enablement, production confirmation, diff-
bound approvals, validation gating for code changes, verify failure and
conflict recovery, rollback, credential rotation/revocation, deployments
with automatic rollback, backups/restores, stream tokens and auto-apply.
Uses the real MongoDB (MONGO_URL) with per-test unique ids.
"""
import asyncio
import json
import os
import uuid
from pathlib import Path

import httpx
import pytest
from cryptography.fernet import Fernet

os.environ.setdefault("ENCRYPTION_KEY", Fernet.generate_key().decode())

from core.db import db  # noqa: E402
from core.security import create_access_token, create_stream_token  # noqa: E402
from providers import bridge_client as bc  # noqa: E402
from providers.sites import set_transport_override  # noqa: E402
from server import app  # noqa: E402
from tests.fake_bridge import FakeBridge  # noqa: E402

from tests.loop import LOOP as _loop  # noqa: E402
BRIDGE_URL = "http://bridge/api/automation-bridge/v1"


def _run(coro):
    return _loop.run_until_complete(coro)


# ---- unit: signing, URL policy, redaction -----------------------------------

def test_signing_reproduces_the_protocol_reference_vectors():
    vectors = json.loads((Path(__file__).resolve().parents[2] / "protocol" / "signing-test-vectors.json").read_text())
    for case in vectors["cases"]:
        body = case["body_utf8"].encode()
        assert bc.canonical_string(case["method"], case["path_with_query"], case["timestamp"], case["nonce"],
                                   body) == case["canonical"]
        assert bc.sign(vectors["secret_b64url"], case["method"], case["path_with_query"], case["timestamp"],
                       case["nonce"], body) == case["signature"]


@pytest.mark.parametrize("url,allow_http,ok", [
    ("https://site.example.com/api/automation-bridge/v1", False, None),   # resolution checked separately
    ("http://bridge/api/automation-bridge/v1", True, True),
    ("http://bridge/api/automation-bridge/v1", False, False),
    ("http://site.example.com/api/automation-bridge/v1", True, False),     # public host over http
    ("https://user:pw@bridge/api/automation-bridge/v1", False, False),     # credentials in URL
    ("https://bridge/api/automation-bridge/v1?x=1", False, False),
    ("https://bridge/some/other/path", False, False),
    ("ftp://bridge/api/automation-bridge/v1", False, False),
    ("http://10.0.0.5:8080/api/automation-bridge/v1", True, True),
    ("http://169.254.169.254/api/automation-bridge/v1", True, True),        # private, but only with the toggle
])
def test_bridge_url_policy(url, allow_http, ok):
    from core.url_policy import UrlPolicyError, validate_bridge_url
    if ok is None:
        return
    if ok:
        assert validate_bridge_url(url, allow_private_http=allow_http, resolve=False)
    else:
        with pytest.raises(UrlPolicyError):
            validate_bridge_url(url, allow_private_http=allow_http, resolve=False)


def test_public_https_bridge_must_not_resolve_to_a_private_address(monkeypatch):
    from core import url_policy
    monkeypatch.setattr(url_policy, "resolves_public_only", lambda host: False)
    with pytest.raises(url_policy.UrlPolicyError):
        url_policy.validate_bridge_url("https://evil.example.com/api/automation-bridge/v1", allow_private_http=False)


def test_base_url_must_be_public_https(monkeypatch):
    from core import url_policy
    from core.url_policy import UrlPolicyError, validate_base_url
    assert validate_base_url("https://Example.com/", resolve=False) == "https://example.com"
    for bad in ("http://example.com", "https://localhost", "https://10.1.2.3", "https://intranet"):
        with pytest.raises(UrlPolicyError):
            validate_base_url(bad, resolve=False)
    monkeypatch.setattr(url_policy, "resolves_public_only", lambda host: False)
    with pytest.raises(UrlPolicyError):
        validate_base_url("https://rebinding.example.com")


def test_oversized_request_bodies_are_rejected():
    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://cp") as c:
            r = await c.post("/api/auth/login", content=b"x" * (4 * 1024 * 1024 + 1),
                             headers={"Content-Type": "application/json"})
            assert r.status_code == 413
    _run(go())


def test_redaction_masks_secrets_in_nested_structures_and_text():
    from core.redact import REDACTED, redact
    out = redact({"secret": "abc", "nested": {"api_key": "k", "ok": "fine"},
                  "msg": "Authorization: Bearer abcdefghijklmnop token=xyz"})
    assert out["secret"] == REDACTED and out["nested"]["api_key"] == REDACTED and out["nested"]["ok"] == "fine"
    assert "abcdefghijklmnop" not in out["msg"] and "xyz" not in out["msg"]


def test_bridge_auth_failures_are_not_surfaced_as_user_auth_failures():
    exc = bc.BridgeError(401, "AUTH_REPLAY", "nonce reused").to_http()
    assert exc.status_code == 502 and exc.detail["code"] == "BRIDGE_AUTH_REPLAY"
    assert bc.BridgeError(409, "CONFLICT_REVISION", "x").to_http().status_code == 409


def test_secret_store_refuses_plaintext_and_wrong_keys(monkeypatch):
    from core.secrets import SecretStoreError, decrypt_secret, encrypt_secret
    stored = encrypt_secret("s3cret")
    assert stored.startswith("enc1:") and "s3cret" not in stored
    assert decrypt_secret(stored) == "s3cret"
    with pytest.raises(SecretStoreError):
        decrypt_secret("s3cret")
    monkeypatch.setenv("ENCRYPTION_KEY", Fernet.generate_key().decode())
    with pytest.raises(SecretStoreError):
        decrypt_secret(stored)
    monkeypatch.delenv("ENCRYPTION_KEY")
    with pytest.raises(SecretStoreError):
        encrypt_secret("x")


# ---- integration harness -------------------------------------------------------

class Harness:
    def __init__(self, **bridge_kwargs):
        self.bridge = FakeBridge(**bridge_kwargs)
        self.key_id, self.secret = self.bridge.issue_key()
        set_transport_override(httpx.ASGITransport(app=self.bridge.app))
        self.users = {}
        self.site_ids = []
        self.tag = uuid.uuid4().hex[:8]

    async def user(self, role):
        if role not in self.users:
            uid = f"u_{role}_{self.tag}"
            await db.users.insert_one({"id": uid, "email": f"{role}-{self.tag}@example.com", "role": role,
                                       "created_at": "2026-01-01T00:00:00Z", "password_hash": "x"})
            self.users[role] = uid
        return {"Authorization": f"Bearer {create_access_token({'sub': self.users[role]})}"}

    def client(self):
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://cp")

    async def create_site(self, c, environment="production", **overrides):
        body = {"name": f"Site {self.tag}", "base_url": "https://example.com", "bridge_url": BRIDGE_URL,
                "environment": environment, "site_key": self.bridge.site_id, "install_mode": "sidecar",
                "key_id": self.key_id, "secret": self.secret, "allow_private_http": True, **overrides}
        await db.sites.delete_many({"site_key": body["site_key"], "environment": environment})
        r = await c.post("/api/sites", json=body, headers=await self.user("admin"))
        assert r.status_code == 201, r.text
        self.site_ids.append(r.json()["id"])
        return r.json()

    async def enable_writes(self, c, site):
        admin = await self.user("admin")
        r = await c.post(f"/api/sites/{site['id']}/verify-write", headers=admin)
        assert r.json()["ok"], r.text
        r = await c.post(f"/api/sites/{site['id']}/writes", json={"enabled": True, "confirm": site["name"]},
                         headers=admin)
        assert r.status_code == 200 and r.json()["writes_enabled"], r.text

    async def wait(self, c, cs_id, not_in=("applying", "validating")):
        for _ in range(100):
            cs = (await c.get(f"/api/changesets/{cs_id}", headers=await self.user("viewer"))).json()
            if cs["status"] not in not_in:
                return cs
            await asyncio.sleep(0.02)
        raise AssertionError(f"change set stuck in {cs['status']}")

    async def cleanup(self):
        set_transport_override(None)
        await db.users.delete_many({"id": {"$in": list(self.users.values())}})
        for sid in self.site_ids:
            for coll in ("sites",):
                await db[coll].delete_many({"id": sid})
            for coll in ("changesets", "revisions", "deployments", "backups", "site_policies", "audit_events",
                         "activity_logs", "content_items"):
                await db[coll].delete_many({"site_id": sid})


def scenario(fn):
    """Run an async scenario with a fresh harness and always clean up."""
    def wrapper(**kwargs):
        async def go():
            h = Harness(**kwargs)
            try:
                async with h.client() as c:
                    await fn(h, c)
            finally:
                await h.cleanup()
        _run(go())
    wrapper.__name__ = fn.__name__
    return wrapper


META_OP = [{"op": "metadata.set", "route": "/about", "fields": {"title": "About us", "description": "Who we are"}}]


# ---- access policy -------------------------------------------------------------

@scenario
async def _anonymous_and_viewer_boundaries(h, c):
    assert (await c.get("/api/sites")).status_code == 401
    assert (await c.get("/api/health")).status_code == 200
    viewer = await h.user("viewer")
    assert (await c.get("/api/sites", headers=viewer)).status_code == 200
    # Baseline policy: a viewer cannot mutate, even on routes with no explicit role check.
    r = await c.post("/api/keywords/x", json={"keyword": "k"}, headers=viewer)
    assert r.status_code == 403
    site = await h.create_site(c)
    r = await c.post(f"/api/sites/{site['id']}/changesets", json={"title": "t", "operations": META_OP},
                     headers=viewer)
    assert r.status_code == 403
    # Editors cannot register sites or touch credentials.
    editor = await h.user("editor")
    assert (await c.post(f"/api/sites/{site['id']}/credential/rotate", headers=editor)).status_code == 403
    assert (await c.post(f"/api/sites/{site['id']}/verify-write", headers=editor)).status_code == 403


def test_anonymous_and_viewer_boundaries():
    _anonymous_and_viewer_boundaries()


@scenario
async def _site_onboarding_stores_only_encrypted_secret(h, c):
    site = await h.create_site(c)
    assert site["connection"]["status"] == "connected"
    assert site["capabilities"]["protocol_version"] == "1"
    assert "secret_enc" not in json.dumps(site) and h.secret not in json.dumps(site)
    raw = await db.sites.find_one({"id": site["id"]})
    assert raw["connection"]["secret_enc"].startswith("enc1:") and h.secret not in json.dumps(raw, default=str)
    listed = (await c.get("/api/sites", headers=await h.user("viewer"))).json()
    assert h.secret not in json.dumps(listed) and "secret_enc" not in json.dumps(listed)
    assert site["writes_enabled"] is False
    audit = await db.audit_events.find_one({"site_id": site["id"], "action": "site.create"})
    assert audit and h.secret not in json.dumps(audit, default=str)


def test_site_onboarding_stores_only_encrypted_secret():
    _site_onboarding_stores_only_encrypted_secret()


@scenario
async def _wrong_site_key_and_bad_protocol_are_flagged(h, c):
    h.bridge.site_id = "some-other-site"
    site = await h.create_site(c, site_key="marketing-site")
    assert site["connection"]["status"] == "degraded" and "site id" in site["connection"]["last_error"]


def test_wrong_site_key_is_flagged():
    _wrong_site_key_and_bad_protocol_are_flagged()


@scenario
async def _unsupported_protocol_major_is_refused(h, c):
    h.bridge.protocol_version = "2"
    site = await h.create_site(c)
    assert site["connection"]["status"] == "unreachable"
    assert "PROTOCOL_UNSUPPORTED" in site["connection"]["last_error"]


def test_unsupported_protocol_major_is_refused():
    _unsupported_protocol_major_is_refused()


# ---- change sets -----------------------------------------------------------------

@scenario
async def _full_changeset_lifecycle_with_rollback(h, c):
    site = await h.create_site(c)
    editor, deployer, admin = await h.user("editor"), await h.user("deployer"), await h.user("admin")
    r = await c.post(f"/api/sites/{site['id']}/changesets", json={"title": "About meta", "operations": META_OP},
                     headers=editor)
    assert r.status_code == 201, r.text
    cs = r.json()
    assert cs["status"] == "planned" and "About us" in cs["plan"]["diff"] and cs["plan"]["diff_sha256"]
    assert (await c.post(f"/api/changesets/{cs['id']}/approve", json={}, headers=editor)).status_code == 403
    assert (await c.post(f"/api/changesets/{cs['id']}/submit", headers=editor)).json()["status"] == "pending_approval"
    assert (await c.post(f"/api/changesets/{cs['id']}/approve", json={"comment": "lgtm"},
                         headers=deployer)).json()["status"] == "approved"

    # Writes not enabled yet -> apply refused, nothing reaches the bridge.
    r = await c.post(f"/api/changesets/{cs['id']}/apply", json={"confirm": site["name"]}, headers=deployer)
    assert r.status_code == 409 and "writes are disabled" in r.json()["detail"]["message"]
    assert not any(q["path"] == "changesets/apply" for q in h.bridge.requests)

    await h.enable_writes(c, site)
    # Production requires the typed site name.
    r = await c.post(f"/api/changesets/{cs['id']}/apply", json={"confirm": "wrong"}, headers=deployer)
    assert r.status_code == 400 and r.json()["detail"]["code"] == "CONFIRMATION_REQUIRED"
    assert (await c.post(f"/api/changesets/{cs['id']}/apply", json={"confirm": site["name"]},
                         headers=editor)).status_code == 403
    r = await c.post(f"/api/changesets/{cs['id']}/apply", json={"confirm": site["name"]}, headers=deployer)
    assert r.status_code == 200 and r.json()["task_id"]
    cs = await h.wait(c, cs["id"])
    assert cs["status"] == "applied", cs
    rev = cs["apply"]["revision_id"]
    assert json.loads(h.bridge.files["overrides/metadata.json"])["/about"]["title"] == "About us"
    assert await db.revisions.find_one({"revision_id": rev})
    idem = [q["idempotency_key"] for q in h.bridge.requests
            if q["path"] == "changesets/apply" and not (q["idempotency_key"] or "").startswith("probe")]
    assert idem and all(k and k.startswith(f"apply_{cs['id']}_") for k in idem)

    # Rollback requires deployer + confirmation, restores the previous state.
    assert (await c.post(f"/api/changesets/{cs['id']}/rollback", json={"confirm": site["name"], "reason": "x"},
                         headers=editor)).status_code == 403
    r = await c.post(f"/api/changesets/{cs['id']}/rollback", json={"confirm": site["name"], "reason": "revert"},
                     headers=admin)
    assert r.status_code == 200
    cs = await h.wait(c, cs["id"], not_in=("applied",))
    assert cs["status"] == "rolled_back" and cs["rollback"]["reverted_revision"] == rev
    assert "/about" not in json.loads(h.bridge.files.get("overrides/metadata.json", "{}"))
    actions = [a["action"] for a in await db.audit_events.find({"change_id": cs["id"]}).to_list(50)]
    for expected in ("changeset.create", "changeset.submit", "changeset.approve", "changeset.apply",
                     "changeset.rollback"):
        assert expected in actions, actions
    assert "changeset.apply" in [a["action"] for a in await db.audit_events.find(
        {"change_id": cs["id"], "outcome": "denied"}).to_list(10)]


def test_full_changeset_lifecycle_with_rollback():
    _full_changeset_lifecycle_with_rollback()


@scenario
async def _self_approval_is_refused_on_production(h, c):
    site = await h.create_site(c)
    deployer = await h.user("deployer")
    cs = (await c.post(f"/api/sites/{site['id']}/changesets", json={"title": "t", "operations": META_OP},
                       headers=deployer)).json()
    await c.post(f"/api/changesets/{cs['id']}/submit", headers=deployer)
    r = await c.post(f"/api/changesets/{cs['id']}/approve", json={}, headers=deployer)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "SELF_APPROVAL"


def test_self_approval_is_refused_on_production():
    _self_approval_is_refused_on_production()


@scenario
async def _editing_after_approval_discards_the_approval(h, c):
    site = await h.create_site(c)
    await h.enable_writes(c, site)
    editor, deployer = await h.user("editor"), await h.user("deployer")
    cs = (await c.post(f"/api/sites/{site['id']}/changesets", json={"title": "t", "operations": META_OP},
                       headers=editor)).json()
    await c.post(f"/api/changesets/{cs['id']}/submit", headers=editor)
    await c.post(f"/api/changesets/{cs['id']}/reject", json={"comment": "wrong title"}, headers=deployer)
    changed = [{**META_OP[0], "fields": {"title": "About the team"}}]
    cs = (await c.put(f"/api/changesets/{cs['id']}", json={"operations": changed}, headers=editor)).json()
    assert cs["status"] == "planned" and cs["approvals"] == []
    r = await c.post(f"/api/changesets/{cs['id']}/apply", json={"confirm": site["name"]}, headers=deployer)
    assert r.status_code == 409


def test_editing_after_rejection_requires_a_new_approval():
    _editing_after_approval_discards_the_approval()


@scenario
async def _reject_requires_a_comment_and_viewer_cannot_cancel(h, c):
    site = await h.create_site(c)
    editor, deployer = await h.user("editor"), await h.user("deployer")
    cs = (await c.post(f"/api/sites/{site['id']}/changesets", json={"title": "t", "operations": META_OP},
                       headers=editor)).json()
    await c.post(f"/api/changesets/{cs['id']}/submit", headers=editor)
    assert (await c.post(f"/api/changesets/{cs['id']}/reject", json={"comment": " "},
                         headers=deployer)).status_code == 400
    assert (await c.post(f"/api/changesets/{cs['id']}/cancel", headers=await h.user("viewer"))).status_code == 403
    assert (await c.post(f"/api/changesets/{cs['id']}/cancel", headers=editor)).json()["status"] == "cancelled"
    assert (await c.post(f"/api/changesets/{cs['id']}/submit", headers=editor)).status_code == 409


def test_reject_requires_a_comment_and_cancel_is_editor_only():
    _reject_requires_a_comment_and_viewer_cannot_cancel()


@scenario
async def _code_changes_require_passing_validation(h, c):
    site = await h.create_site(c)
    editor = await h.user("editor")
    op = [{"op": "file.write", "root": "code", "path": "styles/tokens.css", "content": ":root{--brand:#123}",
           "base_sha256": None}]
    cs = (await c.post(f"/api/sites/{site['id']}/changesets", json={"title": "tokens", "operations": op},
                       headers=editor)).json()
    assert cs["plan"]["risk"]["level"] == "high"
    r = await c.post(f"/api/changesets/{cs['id']}/submit", headers=editor)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "POLICY_CHECKS_FAILED"
    r = await c.post(f"/api/changesets/{cs['id']}/validate", json={"steps": ["typecheck", "build"]}, headers=editor)
    assert r.status_code == 200
    cs = await h.wait(c, cs["id"])
    assert cs["status"] == "validated" and cs["validation"]["status"] == "succeeded"
    assert (await c.post(f"/api/changesets/{cs['id']}/submit", headers=editor)).json()["status"] == "pending_approval"


def test_code_changes_require_passing_validation():
    _code_changes_require_passing_validation()


@scenario
async def _failed_validation_blocks_submission(h, c):
    h.bridge.validation_outcome = "failed"
    site = await h.create_site(c)
    editor = await h.user("editor")
    op = [{"op": "file.write", "root": "code", "path": "app/page.tsx", "content": "x", "base_sha256": None}]
    cs = (await c.post(f"/api/sites/{site['id']}/changesets", json={"title": "t", "operations": op},
                       headers=editor)).json()
    await c.post(f"/api/changesets/{cs['id']}/validate", json={}, headers=editor)
    cs = await h.wait(c, cs["id"])
    assert cs["status"] == "validation_failed"
    assert (await c.post(f"/api/changesets/{cs['id']}/submit", headers=editor)).status_code == 409


def test_failed_validation_blocks_submission():
    _failed_validation_blocks_submission()


@scenario
async def _path_traversal_is_a_plan_error_not_an_apply(h, c):
    site = await h.create_site(c)
    op = [{"op": "file.write", "root": "code", "path": "../../etc/passwd", "content": "x", "base_sha256": None}]
    cs = (await c.post(f"/api/sites/{site['id']}/changesets", json={"title": "t", "operations": op},
                       headers=await h.user("editor"))).json()
    assert cs["status"] == "plan_failed" and cs["plan"]["errors"][0]["code"] == "PATH_OUTSIDE_ROOT"
    unknown = [{"op": "shell.exec", "command": "rm -rf /"}]
    r = await c.post(f"/api/sites/{site['id']}/changesets", json={"title": "t", "operations": unknown},
                     headers=await h.user("editor"))
    assert r.status_code == 400 and r.json()["detail"]["code"] == "OPERATION_NOT_ALLOWED"


def test_path_traversal_and_unknown_operations_never_reach_apply():
    _path_traversal_is_a_plan_error_not_an_apply()


async def _approved(h, c, site, ops=META_OP):
    editor, deployer = await h.user("editor"), await h.user("deployer")
    cs = (await c.post(f"/api/sites/{site['id']}/changesets", json={"title": "t", "operations": ops},
                       headers=editor)).json()
    await c.post(f"/api/changesets/{cs['id']}/submit", headers=editor)
    await c.post(f"/api/changesets/{cs['id']}/approve", json={}, headers=deployer)
    return cs


@scenario
async def _verify_failure_is_reported_with_recovery(h, c):
    site = await h.create_site(c)
    await h.enable_writes(c, site)
    cs = await _approved(h, c, site)
    h.bridge.fail_verify = True
    await c.post(f"/api/changesets/{cs['id']}/apply", json={"confirm": site["name"]}, headers=await h.user("deployer"))
    cs = await h.wait(c, cs["id"])
    assert cs["status"] == "apply_failed"
    assert cs["apply"]["error"]["code"] == "VERIFY_FAILED" and "restored" in cs["apply"]["error"]["recovery"]


def test_verify_failure_is_reported_with_recovery():
    _verify_failure_is_reported_with_recovery()


@scenario
async def _stale_plan_conflicts_instead_of_overwriting(h, c):
    site = await h.create_site(c)
    await h.enable_writes(c, site)
    first = await _approved(h, c, site)
    second = await _approved(h, c, site, ops=[{"op": "metadata.set", "route": "/", "fields": {"title": "Home"}}])
    deployer = await h.user("deployer")
    await c.post(f"/api/changesets/{first['id']}/apply", json={"confirm": site["name"]}, headers=deployer)
    assert (await h.wait(c, first["id"]))["status"] == "applied"
    await c.post(f"/api/changesets/{second['id']}/apply", json={"confirm": site["name"]}, headers=deployer)
    second = await h.wait(c, second["id"])
    assert second["status"] == "apply_failed" and second["apply"]["error"]["code"] == "CONFLICT_REVISION"
    assert "Re-plan" in second["apply"]["error"]["recovery"]


def test_stale_plan_conflicts_instead_of_overwriting():
    _stale_plan_conflicts_instead_of_overwriting()


@scenario
async def _unsupported_capability_is_reported_not_faked(h, c):
    h.bridge.caps["metadata.write"] = False
    site = await h.create_site(c)
    r = await c.post(f"/api/sites/{site['id']}/changesets", json={"title": "t", "operations": META_OP},
                     headers=await h.user("editor"))
    assert r.status_code == 422 and r.json()["detail"]["capability"] == "metadata.write"
    r = await c.put(f"/api/onpage/{site['id']}/meta", json={"path": "/about", "title": "x"},
                    headers=await h.user("editor"))
    assert r.status_code == 422


def test_unsupported_capability_is_reported_not_faked():
    _unsupported_capability_is_reported_not_faked()


@scenario
async def _not_opted_in_route_is_marked_not_effective(h, c):
    site = await h.create_site(c)
    await h.enable_writes(c, site)
    ops = [{"op": "metadata.set", "route": "/pricing", "fields": {"title": "Pricing"}}]
    cs = await _approved(h, c, site, ops)
    assert cs["plan"]["warnings"][0]["code"] == "METADATA_NOT_OPTED_IN"
    await c.post(f"/api/changesets/{cs['id']}/apply", json={"confirm": site["name"]}, headers=await h.user("deployer"))
    cs = await h.wait(c, cs["id"])
    assert cs["status"] == "applied" and cs["apply"]["not_effective"] == [{"index": 0, "effective": False}]


def test_not_opted_in_route_is_marked_not_effective():
    _not_opted_in_route_is_marked_not_effective()


@scenario
async def _onpage_meta_edit_creates_a_changeset_not_a_write(h, c):
    site = await h.create_site(c)
    r = await c.put(f"/api/onpage/{site['id']}/meta", json={"url": "https://example.com/about/", "title": "New",
                                                            "noindex": True}, headers=await h.user("editor"))
    assert r.status_code == 200, r.text
    cs = r.json()["changeset"]
    assert cs["source"] == "onpage-seo" and cs["operations"][0]["route"] == "/about"
    assert cs["operations"][0]["fields"]["robots"] == {"index": False, "follow": True}
    assert not any(q["path"] == "changesets/apply" for q in h.bridge.requests)


def test_onpage_meta_edit_creates_a_changeset_not_a_write():
    _onpage_meta_edit_creates_a_changeset_not_a_write()


@scenario
async def _auto_apply_policy_on_staging(h, c, monkeypatch=None):
    os.environ["AUTOMATION_WRITES_FROZEN"] = "0"
    try:
        site = await h.create_site(c, environment="staging")
        await h.enable_writes(c, site)
        admin, editor = await h.user("admin"), await h.user("editor")
        r = await c.put(f"/api/sites/{site['id']}/policy", headers=admin, json={
            "auto_apply": {"enabled": True, "environments": ["staging"], "ops": ["metadata.set"], "max_risk": "low"}})
        assert r.status_code == 200
        bad = await c.put(f"/api/sites/{site['id']}/policy", headers=admin,
                          json={"auto_apply": {"enabled": True, "ops": ["file.write"]}})
        assert bad.status_code == 422
        cs = (await c.post(f"/api/sites/{site['id']}/changesets", json={"title": "t", "operations": META_OP},
                           headers=editor)).json()
        cs = (await c.post(f"/api/changesets/{cs['id']}/submit", headers=editor)).json()
        cs = await h.wait(c, cs["id"], not_in=("approved", "applying"))
        assert cs["status"] == "applied" and cs["approvals"][0]["user_id"] == "policy"
    finally:
        os.environ.pop("AUTOMATION_WRITES_FROZEN", None)


def test_auto_apply_policy_on_staging():
    _auto_apply_policy_on_staging()


# ---- credentials ---------------------------------------------------------------

@scenario
async def _rotate_and_revoke_credentials(h, c):
    site = await h.create_site(c)
    admin = await h.user("admin")
    old_key = h.key_id
    r = await c.post(f"/api/sites/{site['id']}/credential/rotate", headers=admin)
    assert r.status_code == 200 and r.json()["key_id"] != old_key
    assert h.bridge.keys[old_key]["not_after"] is not None      # old key has a grace expiry
    assert (await c.post(f"/api/sites/{site['id']}/handshake", headers=admin)).json()["connection"]["status"] == "connected"
    stored = await db.sites.find_one({"id": site["id"]})
    assert stored["connection"]["key_id"] == r.json()["key_id"]

    r = await c.post(f"/api/sites/{site['id']}/credential/revoke", json={"confirm": "nope"}, headers=admin)
    assert r.status_code == 400
    r = await c.post(f"/api/sites/{site['id']}/credential/revoke", json={"confirm": site["name"]}, headers=admin)
    assert r.json()["revoked_on_bridge"] is True and r.json()["site"]["connection"]["status"] == "revoked"
    stored = await db.sites.find_one({"id": site["id"]})
    assert "secret_enc" not in stored["connection"] and stored["writes_enabled"] is False
    r = await c.post(f"/api/sites/{site['id']}/handshake", headers=admin)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "CREDENTIAL_REVOKED"


def test_rotate_and_revoke_credentials():
    _rotate_and_revoke_credentials()


@scenario
async def _replace_credential_is_verified_before_storing(h, c):
    site = await h.create_site(c)
    admin = await h.user("admin")
    r = await c.post(f"/api/sites/{site['id']}/credential/replace", headers=admin,
                     json={"key_id": "k_bogus1", "secret": "A" * 43})
    assert r.status_code == 502 and r.json()["detail"]["code"].startswith("BRIDGE_AUTH")
    assert (await db.sites.find_one({"id": site["id"]}))["connection"]["key_id"] == h.key_id
    new_id, new_secret = h.bridge.issue_key()
    r = await c.post(f"/api/sites/{site['id']}/credential/replace", headers=admin,
                     json={"key_id": new_id, "secret": new_secret})
    assert r.status_code == 200 and r.json()["connection"]["key_id"] == new_id


def test_replace_credential_is_verified_before_storing():
    _replace_credential_is_verified_before_storing()


# ---- operations ---------------------------------------------------------------------

@scenario
async def _deployments_are_role_and_confirmation_gated(h, c):
    site = await h.create_site(c)
    body = {"profile": "web", "reason": "release"}
    assert (await c.post(f"/api/sites/{site['id']}/deployments", json=body,
                         headers=await h.user("editor"))).status_code == 403
    deployer = await h.user("deployer")
    r = await c.post(f"/api/sites/{site['id']}/deployments", json=body, headers=deployer)
    assert r.status_code == 400
    r = await c.post(f"/api/sites/{site['id']}/deployments", json={**body, "profile": "rm -rf"}, headers=deployer)
    assert r.status_code == 422      # profile name validation, never reaches the bridge
    r = await c.post(f"/api/sites/{site['id']}/deployments", json={**body, "confirm": site["name"]}, headers=deployer)
    assert r.status_code == 200
    dep_id = r.json()["deployment_id"]
    for _ in range(100):
        dep = (await c.get(f"/api/deployments/{dep_id}", headers=deployer)).json()
        if dep["status"] not in ("running", "queued"):
            break
        await asyncio.sleep(0.05)
    assert dep["status"] == "succeeded" and dep["previous_image_id"] == "sha256:old"


def test_deployments_are_role_and_confirmation_gated():
    _deployments_are_role_and_confirmation_gated()


@scenario
async def _failed_deployment_surfaces_automatic_rollback(h, c):
    h.bridge.deploy_outcome = "rolled_back"
    site = await h.create_site(c, environment="staging")
    deployer = await h.user("deployer")
    r = await c.post(f"/api/sites/{site['id']}/deployments", json={"profile": "web", "reason": "x"}, headers=deployer)
    dep_id = r.json()["deployment_id"]
    for _ in range(200):
        dep = (await c.get(f"/api/deployments/{dep_id}", headers=deployer)).json()
        if dep["status"] not in ("running", "queued", "failed") or dep.get("finished_at"):
            break
        await asyncio.sleep(0.05)
    assert dep["status"] == "rolled_back" and "previous image" in dep["recovery"]


def test_failed_deployment_surfaces_automatic_rollback():
    _failed_deployment_surfaces_automatic_rollback()


@scenario
async def _backup_restore_requires_double_confirmation(h, c):
    site = await h.create_site(c)
    deployer = await h.user("deployer")
    backup = (await c.post(f"/api/sites/{site['id']}/backups", json={"kind": "overrides"}, headers=deployer)).json()
    bid = backup["backup_id"]
    dry = await c.post(f"/api/sites/{site['id']}/backups/{bid}/restore", json={"dry_run": True}, headers=deployer)
    assert dry.status_code == 200 and dry.json()["dry_run"] is True
    r = await c.post(f"/api/sites/{site['id']}/backups/{bid}/restore",
                     json={"dry_run": False, "confirm": bid}, headers=deployer)
    assert r.status_code == 400
    r = await c.post(f"/api/sites/{site['id']}/backups/{bid}/restore",
                     json={"dry_run": False, "confirm": bid, "confirm_site": site["name"]}, headers=deployer)
    assert r.status_code == 200 and r.json()["post_restore_health"]["status"] == "ok"
    assert (await c.post(f"/api/sites/{site['id']}/backups/{bid}/restore", json={"dry_run": True},
                         headers=await h.user("editor"))).status_code == 403


def test_backup_restore_requires_double_confirmation():
    _backup_restore_requires_double_confirmation()


# ---- streams -----------------------------------------------------------------------

@scenario
async def _stream_tokens_are_task_bound(h, c):
    viewer = await h.user("viewer")
    assert (await c.get("/api/stream/abc")).status_code == 401
    token = create_stream_token(h.users["viewer"], "other-task")
    assert (await c.get(f"/api/stream/abc?token={token}")).status_code == 401
    # A stream token is not a session token.
    assert (await c.get("/api/sites", headers={"Authorization": f"Bearer {token}"})).status_code == 401
    assert (await c.post("/api/stream-token", json={"task_id": "missing"}, headers=viewer)).status_code == 404


def test_stream_tokens_are_task_bound():
    _stream_tokens_are_task_bound()
