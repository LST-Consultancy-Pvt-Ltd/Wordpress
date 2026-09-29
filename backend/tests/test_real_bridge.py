"""End-to-end: control plane <-> the REAL automation bridge sidecar (TypeScript,
automation-bridge/dist) over HTTP with real HMAC signing.

Starts the sidecar against a temporary fixture repository, registers it as a
site, verifies write access, and drives a metadata change set through
plan -> approve -> apply (checking the override file on disk) -> rollback.

Skipped unless node is installed and automation-bridge has been built
(`cd automation-bridge && npm ci && npm run build`); CI builds it first.
"""
import base64
import json
import os
import secrets
import shutil
import socket
import subprocess
import time
from pathlib import Path

import httpx
import pytest

from tests.test_control_plane import Harness, _run  # reuses users/cleanup helpers
from providers.sites import set_transport_override

BRIDGE_DIR = Path(__file__).resolve().parents[2] / "automation-bridge"
MAIN = BRIDGE_DIR / "dist" / "sidecar" / "main.js"

pytestmark = pytest.mark.skipif(not (shutil.which("node") and MAIN.exists()),
                                reason="automation-bridge not built (npm ci && npm run build)")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def sidecar(tmp_path):
    repo, content, overrides, state = (tmp_path / d for d in ("repo", "content", "overrides", "state"))
    for d in (repo / "app" / "about", content / "posts", overrides, state):
        d.mkdir(parents=True)
    (repo / "app" / "page.tsx").write_text(
        'export async function generateMetadata(){ return withAutomationMetadata("/", {title:"Home"}); }\n'
        "export default function P(){return null}\n")
    (repo / "app" / "about" / "page.tsx").write_text(
        'export async function generateMetadata(){ return withAutomationMetadata("/about", {title:"About"}); }\n'
        "export default function A(){return null}\n")
    (repo / "automation.manifest.json").write_text(json.dumps({"blocks": []}))
    port = _free_port()
    config = {
        "mode": "sidecar",
        "site": {"site_id": "real-bridge-site", "environment": "production",
                 "public_base_url": "https://example.com", "internal_url": None},
        "state_dir": str(state),
        "roots": [
            {"id": "code", "kind": "code", "path": str(repo), "writable": False, "allow": ["app/**/*.tsx"], "deny": []},
            {"id": "content", "kind": "content", "path": str(content), "writable": True},
            {"id": "overrides", "kind": "overrides", "path": str(overrides), "writable": True},
        ],
        "overrides_root": "overrides", "code_root": "code",
        "manifest": {"root": "code", "path": "automation.manifest.json"},
        "content": {"collections": [{"id": "posts", "kind": "mdx", "root": "content", "dir": "posts",
                                     "route_pattern": "/blog/[slug]"}]},
        "revalidate": {"mode": "none"},
        "server": {"host": "127.0.0.1", "port": port},
    }
    cfg = tmp_path / "bridge.json"
    cfg.write_text(json.dumps(config))
    key_id = "k_" + secrets.token_hex(8)
    secret = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    env = {**os.environ, "BRIDGE_CONFIG": str(cfg), "BRIDGE_BOOTSTRAP_KEY_ID": key_id,
           "BRIDGE_BOOTSTRAP_SECRET": secret, "BRIDGE_REVALIDATE_SECRET": secrets.token_hex(16)}
    proc = subprocess.Popen(["node", str(MAIN)], cwd=BRIDGE_DIR, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            try:
                if httpx.get(f"http://127.0.0.1:{port}/healthz", timeout=0.5).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.1)
        else:
            raise RuntimeError("sidecar did not start: " + proc.stdout.read1(4000).decode(errors="replace"))
        yield {"url": f"http://127.0.0.1:{port}/api/automation-bridge/v1", "key_id": key_id, "secret": secret,
               "overrides": overrides, "proc": proc}
    finally:
        proc.terminate()
        try:
            out, _ = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, _ = proc.communicate()
        # The bridge must never log its secrets.
        assert secret not in out.decode(errors="replace")


def test_control_plane_drives_the_real_bridge_end_to_end(sidecar):
    async def go():
        h = Harness(site_id="real-bridge-site")
        set_transport_override(None)          # real HTTP to the sidecar
        h.key_id, h.secret = sidecar["key_id"], sidecar["secret"]
        try:
            async with h.client() as c:
                site = await h.create_site(c, bridge_url=sidecar["url"])
                assert site["connection"]["status"] in ("connected", "degraded"), site["connection"]
                caps = site["capabilities"]
                assert caps["protocol_version"] == "1" and caps["capabilities"]["metadata.write"] is True
                assert str(sidecar["overrides"]) not in json.dumps(caps)   # no absolute host paths

                routes = (await c.get(f"/api/sites/{site['id']}/inventory/routes",
                                      headers=await h.user("viewer"))).json()
                assert any(r["route"] == "/about" and r["metadata"] == "generateMetadata-optin"
                           for r in routes["items"])

                admin, editor, deployer = await h.user("admin"), await h.user("editor"), await h.user("deployer")
                verify = (await c.post(f"/api/sites/{site['id']}/verify-write", headers=admin)).json()
                assert verify["ok"], verify
                await db_set_connected(site["id"])
                r = await c.post(f"/api/sites/{site['id']}/writes", json={"enabled": True, "confirm": site["name"]},
                                 headers=admin)
                assert r.status_code == 200, r.text

                ops = [{"op": "metadata.set", "route": "/about",
                        "fields": {"title": "About the team", "description": "Who we are"}}]
                cs = (await c.post(f"/api/sites/{site['id']}/changesets", json={"title": "About", "operations": ops},
                                   headers=editor)).json()
                assert cs["status"] == "planned", cs.get("plan")
                assert "About the team" in cs["plan"]["diff"]
                await c.post(f"/api/changesets/{cs['id']}/submit", headers=editor)
                await c.post(f"/api/changesets/{cs['id']}/approve", json={}, headers=deployer)
                await c.post(f"/api/changesets/{cs['id']}/apply", json={"confirm": site["name"]}, headers=deployer)
                cs = await h.wait(c, cs["id"])
                assert cs["status"] == "applied", cs.get("apply")
                stored = "".join(p.read_text() for p in sidecar["overrides"].rglob("*.json"))
                assert "About the team" in stored

                await c.post(f"/api/changesets/{cs['id']}/rollback", json={"confirm": site["name"], "reason": "e2e"},
                             headers=deployer)
                cs = await h.wait(c, cs["id"], not_in=("applied",))
                assert cs["status"] == "rolled_back", cs
                stored = "".join(p.read_text() for p in sidecar["overrides"].rglob("*.json"))
                assert "About the team" not in stored

                revs = (await c.get(f"/api/sites/{site['id']}/revisions", headers=await h.user("viewer"))).json()
                assert len(revs["items"]) >= 4      # probe, probe rollback, apply, rollback
        finally:
            await h.cleanup()

    _run(go())


async def db_set_connected(site_id):
    """With no reachable site behind it the bridge reports 'degraded' health;
    enabling writes requires 'connected', which is a deployment property this
    fixture cannot provide, so mark it explicitly for the test."""
    from core.db import db
    await db.sites.update_one({"id": site_id}, {"$set": {"connection.status": "connected"}})


def test_file_reads_are_confined_by_the_real_bridge(sidecar):
    async def go():
        h = Harness(site_id="real-bridge-site")
        set_transport_override(None)
        h.key_id, h.secret = sidecar["key_id"], sidecar["secret"]
        try:
            async with h.client() as c:
                site = await h.create_site(c, bridge_url=sidecar["url"])
                viewer = await h.user("viewer")
                ok = await c.get(f"/api/sites/{site['id']}/files/code", params={"path": "app/about/page.tsx"},
                                 headers=viewer)
                assert ok.status_code == 200 and "withAutomationMetadata" in ok.json()["content"]
                for bad in ("../../etc/passwd", "/etc/passwd", "app/../../secret", "automation.manifest.json"):
                    r = await c.get(f"/api/sites/{site['id']}/files/code", params={"path": bad}, headers=viewer)
                    assert r.status_code in (400, 404), (bad, r.status_code, r.text)
        finally:
            await h.cleanup()
    _run(go())
