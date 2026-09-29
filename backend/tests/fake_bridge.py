"""In-process fake of the Automation Bridge protocol v1, for control-plane
tests. It enforces the parts of the contract the control plane relies on:
HMAC signatures, timestamp skew, nonce replay, scopes, Idempotency-Key on
mutations, typed operations, diff-hash checks on apply, revisions and
rollback, jobs, deployments and backups. State lives in memory.
"""
import base64
import difflib
import hashlib
import hmac
import json
import secrets
import time
import uuid
from typing import Optional

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

BASE = "/api/automation-bridge/v1"


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class FakeBridge:
    def __init__(self, *, site_id="marketing-site", environment="production", capabilities=None,
                 validation_outcome="succeeded", deploy_outcome="succeeded"):
        self.keys = {}
        self.site_id = site_id
        self.environment = environment
        self.caps = {"inventory": True, "content.read": True, "content.write": True, "metadata.write": True,
                     "blocks.write": True, "images.alt.write": True, "redirects.write": True, "files.read": True,
                     "files.patch": True, "validate": True, "preview": False, "revalidate": True,
                     "deploy": True, "ops.logs": True, "backups": True}
        if capabilities:
            self.caps.update(capabilities)
        self.protocol_version = "1"
        self.files: dict[str, str] = {}          # "<root>/<path>" -> content
        self.revisions: list[dict] = []
        self.nonces: set = set()
        self.idem: dict = {}
        self.jobs: dict = {}
        self.deployments: dict = {}
        self.backups: dict = {}
        self.audit: list[dict] = []
        self.requests: list[dict] = []
        self.validation_outcome = validation_outcome
        self.deploy_outcome = deploy_outcome
        self.fail_verify = False
        self.opted_in = {"/", "/about"}
        self.blocks = {"home.hero.title": "/"}
        self.app = Starlette(routes=[Route(BASE + "/{path:path}", self.handle, methods=["GET", "POST"])])

    # ---- credentials -------------------------------------------------------

    def issue_key(self, scopes=("read", "write", "deploy", "admin")) -> tuple[str, str]:
        key_id = "k_" + secrets.token_hex(6)
        secret = b64(secrets.token_bytes(32))
        self.keys[key_id] = {"secret": secret, "scopes": set(scopes), "revoked": False, "not_after": None}
        return key_id, secret

    # ---- helpers -------------------------------------------------------------

    @staticmethod
    def err(status, code, message="", details=None):
        body = {"error": {"code": code, "message": message or code, "correlation_id": "c_fake"}}
        if details:
            body["error"]["details"] = details
        return JSONResponse(body, status_code=status)

    def _auth(self, request: Request, body: bytes):
        h = request.headers
        key_id, ts, nonce, sig = (h.get("x-bridge-key-id"), h.get("x-bridge-timestamp"),
                                  h.get("x-bridge-nonce"), h.get("x-bridge-signature"))
        if not all([key_id, ts, nonce, sig]):
            return None, self.err(401, "AUTH_MISSING")
        key = self.keys.get(key_id)
        if not key:
            return None, self.err(401, "AUTH_INVALID")
        if key["revoked"] or (key["not_after"] and time.time() > key["not_after"]):
            return None, self.err(401, "AUTH_REVOKED")
        if abs(time.time() - int(ts)) > 300:
            return None, self.err(401, "AUTH_EXPIRED")
        path = request.url.path + (("?" + request.url.query) if request.url.query else "")
        canonical = f"{request.method}\n{path}\n{ts}\n{nonce}\n{hashlib.sha256(body).hexdigest()}"
        expected = hmac.new(unb64(key["secret"]), canonical.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, sig):
            return None, self.err(401, "AUTH_INVALID")
        if nonce in self.nonces:
            return None, self.err(401, "AUTH_REPLAY")
        self.nonces.add(nonce)
        return key_id, None

    def _current_revision(self) -> Optional[str]:
        applied = [r for r in self.revisions if r["status"] in ("applied", "reverted")]
        return applied[-1]["revision_id"] if applied else None

    def _meta_store(self) -> dict:
        return json.loads(self.files.get("overrides/metadata.json", "{}"))

    def _apply_ops(self, files: dict, operations: list) -> tuple[list, list, list, set]:
        errors, warnings, effective, routes = [], [], [], set()
        meta = json.loads(files.get("overrides/metadata.json", "{}"))
        redirects = json.loads(files.get("overrides/redirects.json", "{}"))
        blocks = json.loads(files.get("overrides/blocks.json", "{}"))
        for i, op in enumerate(operations):
            kind = op.get("op")
            eff = True
            if kind == "metadata.set":
                route = op.get("route", "")
                if not route.startswith("/") or ".." in route:
                    errors.append({"index": i, "code": "PATH_INVALID", "message": "bad route"})
                    continue
                meta[route] = op.get("fields") or {}
                routes.add(route)
                if route not in self.opted_in:
                    warnings.append({"index": i, "code": "METADATA_NOT_OPTED_IN", "message": route})
                    eff = False
            elif kind == "metadata.clear":
                meta.pop(op.get("route"), None)
                routes.add(op.get("route"))
            elif kind == "redirect.upsert":
                redirects[op["source"]] = {"destination": op["destination"], "permanent": op.get("permanent", True)}
                routes.add(op["source"])
            elif kind == "redirect.delete":
                redirects.pop(op.get("source"), None)
            elif kind in ("block.set", "image.alt.set"):
                bid = op.get("block_id") or op.get("image_id")
                if bid not in self.blocks:
                    errors.append({"index": i, "code": "UNREGISTERED_BLOCK", "message": bid})
                    continue
                blocks[bid] = op.get("value") or op.get("alt")
                routes.add(self.blocks[bid])
            elif kind == "content.upsert":
                path = f"content/{op['collection']}/{op['slug']}.mdx"
                current = files.get(path)
                if op.get("base_sha256") is not None and (
                        current is None or hashlib.sha256(current.encode()).hexdigest() != op["base_sha256"]):
                    errors.append({"index": i, "code": "CONFLICT_REVISION", "message": "item changed"})
                    continue
                files[path] = json.dumps(op.get("frontmatter") or {}) + "\n---\n" + (op.get("body") or "")
                routes.add(f"/{op['collection']}/{op['slug']}")
            elif kind == "content.delete":
                files.pop(f"content/{op['collection']}/{op['slug']}.mdx", None)
            elif kind == "file.write":
                path = op.get("path", "")
                if ".." in path.split("/") or path.startswith("/") or path.startswith(".env"):
                    errors.append({"index": i, "code": "PATH_OUTSIDE_ROOT", "message": path})
                    continue
                files[f"{op['root']}/{path}"] = op.get("content", "")
            else:
                errors.append({"index": i, "code": "OPERATION_NOT_ALLOWED", "message": str(kind)})
                continue
            effective.append({"index": i, "effective": eff})
        files["overrides/metadata.json"] = json.dumps(meta, sort_keys=True, indent=1)
        files["overrides/redirects.json"] = json.dumps(redirects, sort_keys=True, indent=1)
        files["overrides/blocks.json"] = json.dumps(blocks, sort_keys=True, indent=1)
        return errors, warnings, effective, routes

    def _plan(self, operations: list) -> dict:
        proposed = dict(self.files)
        errors, warnings, effective, routes = self._apply_ops(proposed, operations)
        diff_parts, changed = [], []
        for path in sorted(set(self.files) | set(proposed)):
            before, after = self.files.get(path), proposed.get(path)
            if before == after:
                continue
            changed.append({"root": path.split("/")[0], "path": path.split("/", 1)[1],
                            "change": "create" if before is None else ("delete" if after is None else "modify"),
                            "before_sha256": before and hashlib.sha256(before.encode()).hexdigest(),
                            "after_sha256": after and hashlib.sha256(after.encode()).hexdigest()})
            diff_parts += difflib.unified_diff((before or "").splitlines(True), (after or "").splitlines(True),
                                               f"a/{path}", f"b/{path}")
        flags = sorted({"code-change" for o in operations if o.get("op", "").startswith("file.")}
                       | {"redirect" for o in operations if o.get("op", "").startswith("redirect.")})
        level = "high" if "code-change" in flags else ("medium" if flags else "low")
        return {"valid": not errors, "errors": errors, "warnings": warnings, "diff": "".join(diff_parts),
                "files": changed, "impacted_routes": sorted(routes), "risk": {"level": level, "flags": flags},
                "current_revision": self._current_revision(), "_proposed": proposed, "_effective": effective}

    # ---- request handler ---------------------------------------------------

    async def handle(self, request: Request):
        body = await request.body()
        key_id, error = self._auth(request, body)
        path = request.path_params["path"]
        self.requests.append({"method": request.method, "path": path, "key_id": key_id,
                              "idempotency_key": request.headers.get("idempotency-key")})
        if error:
            self.audit.append({"path": path, "outcome": "denied"})
            return error
        data = json.loads(body) if body else {}
        mutating = request.method == "POST" and path not in ("changesets/plan", "validations", "previews")
        if mutating:
            ik = request.headers.get("idempotency-key")
            if not ik:
                return self.err(400, "IDEMPOTENCY_KEY_REQUIRED")
            cache_key = (key_id, ik)
            digest = hashlib.sha256(body).hexdigest()
            if cache_key in self.idem:
                stored_digest, response = self.idem[cache_key]
                if stored_digest != digest:
                    return self.err(409, "IDEMPOTENCY_MISMATCH")
                resp = JSONResponse(response[1], status_code=response[0])
                resp.headers["Idempotent-Replay"] = "true"
                return resp
        status, payload = self.route(request.method, path, data, key_id, dict(request.query_params))
        if mutating:
            self.idem[(key_id, request.headers["idempotency-key"])] = (hashlib.sha256(body).hexdigest(),
                                                                      (status, payload))
        self.audit.append({"path": path, "outcome": "ok" if status < 400 else "error"})
        return JSONResponse(payload, status_code=status)

    def _scope(self, key_id, scope):
        return scope in self.keys[key_id]["scopes"]

    def route(self, method, path, data, key_id, query):
        def e(status, code, message="", details=None):
            body = {"error": {"code": code, "message": message or code, "correlation_id": "c_fake"}}
            if details:
                body["error"]["details"] = details
            return status, body

        if method == "GET" and path == "capabilities":
            return 200, {
                "protocol_version": self.protocol_version, "agent_version": "1.0.0-fake", "mode": "sidecar",
                "site": {"site_id": self.site_id, "environment": self.environment,
                         "public_base_url": "https://example.com"},
                "nextjs": {"version": "15.1.0", "router": "app"}, "package_manager": "npm",
                "repository": {"available": True, "commit": "abc1234", "branch": "main", "dirty": False},
                "deployment": {"hostname": "bridge", "container_id": "0123456789ab", "image": "site:latest",
                               "compose_project": "site", "service": "web", "profiles": ["web"]},
                "writable_roots": [{"id": "content", "kind": "content", "writable": True},
                                   {"id": "overrides", "kind": "overrides", "writable": True}],
                "content_adapters": [{"id": "posts", "kind": "mdx", "root": "content", "route_pattern": "/blog/[slug]",
                                      "operations": ["read", "create", "update", "delete"],
                                      "frontmatter_schema": None}],
                "capabilities": self.caps, "validation_steps": ["typecheck", "lint", "build"],
                "preview": {"url": None, "status": "unavailable"},
                "limits": {"max_body_bytes": 1048576, "max_file_bytes": 524288, "rate_per_minute": 120},
            }
        if method == "GET" and path == "health":
            return 200, {"status": "ok", "ready": True, "checks": [{"name": "state_dir_writable", "ok": True,
                                                                   "detail": None}],
                         "current_revision": self._current_revision(), "time": "now"}
        if method == "GET" and path == "inventory/metadata":
            return 200, {"items": [{"route": r, "fields": f} for r, f in self._meta_store().items()]}
        if method == "GET" and path == "inventory/routes":
            return 200, {"items": [{"route": r, "metadata": "generateMetadata-optin" if r in self.opted_in else "static"}
                                   for r in ("/", "/about", "/pricing")], "unsupported": []}
        if method == "GET" and path.startswith("inventory/"):
            return 200, {"items": []}
        if method == "GET" and path == "content/collections":
            return 200, {"items": [{"id": "posts", "kind": "mdx", "route_pattern": "/blog/[slug]",
                                    "operations": ["read", "create", "update", "delete"]}]}
        if method == "GET" and path == "content/posts/items":
            items = [{"slug": p.split("/")[-1][:-4], "title": p, "status": "published", "updated_at": "2026-01-01",
                      "sha256": hashlib.sha256(c.encode()).hexdigest()}
                     for p, c in self.files.items() if p.startswith("content/posts/")]
            return 200, {"items": items, "next_cursor": None}
        if method == "GET" and path.startswith("content/posts/items/"):
            slug = path.rsplit("/", 1)[-1]
            content = self.files.get(f"content/posts/{slug}.mdx")
            if content is None:
                return e(404, "NOT_FOUND")
            fm, _, bodytext = content.partition("\n---\n")
            return 200, {"slug": slug, "status": "published", "frontmatter": json.loads(fm), "body": bodytext,
                         "sha256": hashlib.sha256(content.encode()).hexdigest(),
                         "path": {"root": "content", "path": f"posts/{slug}.mdx"}}
        if method == "POST" and path == "changesets/plan":
            plan = self._plan(data.get("operations") or [])
            return 200, {k: v for k, v in plan.items() if not k.startswith("_")}
        if method == "POST" and path == "changesets/apply":
            if not self._scope(key_id, "write"):
                return e(403, "AUTH_SCOPE")
            plan = self._plan(data.get("operations") or [])
            if not plan["valid"]:
                return e(400, "VALIDATION_FAILED", details={"issues": plan["errors"]})
            if hashlib.sha256(plan["diff"].encode()).hexdigest() != data.get("expected_plan_sha256") or (
                    data.get("base_revision") and data["base_revision"] != self._current_revision()):
                return e(409, "CONFLICT_REVISION", "site changed since the plan")
            rev = {"revision_id": "r_" + uuid.uuid4().hex[:12], "change_id": data.get("change_id"),
                   "before": dict(self.files), "status": "applied", "files": plan["files"], "diff": plan["diff"]}
            if self.fail_verify:
                rev["status"] = "rolled_back"
                self.revisions.append(rev)
                return e(502, "VERIFY_FAILED", "route check failed; restored", {"revision_id": rev["revision_id"]})
            self.files = plan["_proposed"]
            self.revisions.append(rev)
            return 200, {"revision_id": rev["revision_id"], "change_id": data.get("change_id"), "status": "applied",
                         "operations": plan["_effective"], "files": plan["files"],
                         "revalidated": plan["impacted_routes"],
                         "verification": {"hashes_ok": True, "routes": []}, "applied_at": "now"}
        if method == "GET" and path == "revisions":
            return 200, {"items": [{k: v for k, v in r.items() if k not in ("before", "diff")} for r in self.revisions],
                         "next_cursor": None}
        if method == "POST" and path.startswith("revisions/") and path.endswith("/rollback"):
            rid = path.split("/")[1]
            rev = next((r for r in self.revisions if r["revision_id"] == rid), None)
            if not rev:
                return e(404, "NOT_FOUND")
            new = {"revision_id": "r_" + uuid.uuid4().hex[:12], "change_id": None, "before": dict(self.files),
                   "status": "applied", "files": rev["files"], "diff": ""}
            self.files = dict(rev["before"])
            rev["status"] = "reverted"
            self.revisions.append(new)
            return 200, {"revision_id": new["revision_id"], "status": "applied"}
        if method == "POST" and path == "validations":
            if not self.caps.get("validate"):
                return e(422, "CAPABILITY_UNSUPPORTED", details={"capability": "validate"})
            job_id = "j_" + uuid.uuid4().hex[:10]
            self.jobs[job_id] = {"job_id": job_id, "kind": "validation", "status": self.validation_outcome,
                                 "steps": [{"name": s, "status": self.validation_outcome, "exit_code": 0 if
                                            self.validation_outcome == "succeeded" else 1, "output_tail": "ok"}
                                           for s in data.get("steps") or []],
                                 "result": None, "error": None if self.validation_outcome == "succeeded" else "typecheck failed"}
            return 202, {"job_id": job_id}
        if method == "GET" and path.startswith("jobs/"):
            job = self.jobs.get(path.split("/")[1])
            return (200, job) if job else e(404, "NOT_FOUND")
        if method == "GET" and path == "deployments/profiles":
            return 200, [{"name": "web", "strategy": "compose-recreate", "services": ["web"], "smoke_paths": ["/"]}]
        if method == "POST" and path == "deployments":
            if not self._scope(key_id, "deploy"):
                return e(403, "AUTH_SCOPE")
            if data.get("profile") != "web":
                return e(400, "OPERATION_NOT_ALLOWED", "unknown profile")
            dep_id, job_id = "d_" + uuid.uuid4().hex[:8], "j_" + uuid.uuid4().hex[:8]
            status = {"succeeded": "succeeded", "rolled_back": "rolled_back"}.get(self.deploy_outcome, "failed")
            self.deployments[dep_id] = {"deployment_id": dep_id, "profile": "web", "status": status,
                                        "previous_image_id": "sha256:old", "new_image_id": "sha256:new",
                                        "steps": [{"name": "smoke", "status": "ok" if status == "succeeded" else "failed"}]}
            self.jobs[job_id] = {"job_id": job_id, "kind": "deployment",
                                 "status": "succeeded" if status == "succeeded" else "failed", "steps": [],
                                 "error": None if status == "succeeded" else "smoke check failed"}
            return 202, {"deployment_id": dep_id, "job_id": job_id}
        if method == "GET" and path.startswith("deployments/"):
            dep = self.deployments.get(path.split("/")[1])
            return (200, dep) if dep else e(404, "NOT_FOUND")
        if method == "GET" and path == "backups":
            return 200, {"items": list(self.backups.values())}
        if method == "POST" and path == "backups":
            bid = "b_" + uuid.uuid4().hex[:8]
            self.backups[bid] = {"backup_id": bid, "kind": data.get("kind"), "files": dict(self.files)}
            return 200, {"backup_id": bid, "kind": data.get("kind")}
        if method == "POST" and path.startswith("backups/") and path.endswith("/restore"):
            if not self._scope(key_id, "deploy"):
                return e(403, "AUTH_SCOPE")
            bid = path.split("/")[1]
            backup = self.backups.get(bid)
            if not backup or data.get("confirm") != bid:
                return e(404, "NOT_FOUND")
            if data.get("dry_run"):
                return 200, {"dry_run": True, "diff": "restore diff"}
            self.files = dict(backup["files"])
            rid = "r_" + uuid.uuid4().hex[:12]
            self.revisions.append({"revision_id": rid, "status": "applied", "before": {}, "files": [], "diff": ""})
            return 200, {"dry_run": False, "revision_id": rid}
        if method == "POST" and path == "auth/rotate":
            if not self._scope(key_id, "admin"):
                return e(403, "AUTH_SCOPE")
            new_id, new_secret = self.issue_key(tuple(self.keys[key_id]["scopes"]))
            self.keys[key_id]["not_after"] = time.time() + int(data.get("grace_seconds", 300))
            return 200, {"key_id": new_id, "secret": new_secret, "scopes": sorted(self.keys[new_id]["scopes"])}
        if method == "POST" and path == "auth/revoke":
            if not self._scope(key_id, "admin"):
                return e(403, "AUTH_SCOPE")
            target = self.keys.get(data.get("key_id"))
            if not target:
                return e(404, "NOT_FOUND")
            target["revoked"] = True
            return 200, {"revoked": True}
        if method == "GET" and path == "audit":
            return 200, {"items": self.audit[-50:], "next_cursor": None}
        return e(404, "NOT_FOUND", f"{method} {path}")
