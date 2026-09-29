# Automation Bridge protocol — v1

The contract between the **control plane** (this platform) and the **bridge
agent** that runs beside each managed Next.js deployment. Both sides implement
exactly this document; the bridge also serves it as OpenAPI at
`GET {base}/openapi.json` (authenticated).

- Base path: `/api/automation-bridge/v1` in both installation modes
  (sidecar agent, or App Router route inside the site).
- Transport: HTTPS, or plain HTTP only on a private Docker network. The
  control plane refuses non-HTTPS bridge URLs unless the host is a private
  address/Docker service name AND the site's connection policy allows it.
- Encoding: JSON, UTF-8. Max request body: `limits.max_body_bytes`
  (default 1 MiB) → `413 PAYLOAD_TOO_LARGE`.
- Time: all timestamps are RFC 3339 UTC strings unless named `*_unix`.

## 1. Authentication (HMAC request signing)

A credential is `{key_id, secret}`; `secret` is 32 random bytes, base64url
(no padding). The bridge holds a **key store** (JSON file in its state dir,
mode 0600, seeded from `BRIDGE_BOOTSTRAP_KEY_ID`/`BRIDGE_BOOTSTRAP_SECRET` on
first start) of entries:

```json
{"key_id": "k_2f9c…", "secret": "…", "scopes": ["read","write","deploy","admin"],
 "created_at": "…", "not_after": null, "revoked_at": null}
```

Every request except `GET /healthz` carries:

| Header | Value |
|---|---|
| `X-Bridge-Key-Id` | key id |
| `X-Bridge-Timestamp` | unix seconds; rejected if \|now − ts\| > 300 → `AUTH_EXPIRED` |
| `X-Bridge-Nonce` | 16–64 chars `[A-Za-z0-9_-]`; reused within 600 s → `AUTH_REPLAY` |
| `X-Bridge-Signature` | lowercase hex `HMAC-SHA256(secret, canonical)` |
| `X-Correlation-Id` | optional; echoed back, generated if absent |
| `Idempotency-Key` | **required** on every mutating request (see §3) |

```
canonical = METHOD + "\n" + PATH_WITH_QUERY + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(sha256(body))
```

`PATH_WITH_QUERY` is the raw request target starting at `/api/automation-bridge/v1`
(query string exactly as sent). Empty body hashes the empty string.
Comparison is constant-time. Failures return `401` with codes
`AUTH_MISSING | AUTH_INVALID | AUTH_EXPIRED | AUTH_REPLAY | AUTH_REVOKED`
— the response never says whether the key id exists. A valid key lacking the
endpoint's scope gets `403 AUTH_SCOPE`. Every attempt, successful or not, is
written to the bridge audit log (without signature/secret).

Scopes: `read` (all GETs, plan, validate), `write` (apply/rollback content,
metadata, blocks, images, redirects, files; backups), `deploy`
(deployments, restarts, deployment rollback, backup restore), `admin`
(credential rotate/revoke).

### Rotation / revocation

- `POST /auth/rotate` (admin) `{grace_seconds?: 0..3600 = 300}` → `{key_id, secret, scopes, created_at}`.
  The new secret is returned **once**; the calling key gets `not_after = now + grace`.
- `POST /auth/revoke` (admin) `{key_id}` → `{revoked: true}`. Revoking the
  last admin key requires `{"confirm": "REVOKE-LAST-KEY"}`.
- `GET /auth/keys` (admin) → key ids, scopes, dates. Never secrets.
- Operators can also edit the key store file; the bridge reloads it on change.

## 2. Envelope, errors, pagination

Success: the resource object itself (no wrapper), plus header
`X-Correlation-Id`. Error:

```json
{"error": {"code": "PATH_OUTSIDE_ROOT", "message": "human readable, no secrets",
           "correlation_id": "c_…", "details": {…optional…}}}
```

| HTTP | code |
|---|---|
| 400 | `VALIDATION_FAILED` (details.issues = Zod-style `[{path, message}]`), `PATH_INVALID`, `PATH_OUTSIDE_ROOT`, `PATH_SYMLINK_ESCAPE`, `OPERATION_NOT_ALLOWED`, `IDEMPOTENCY_KEY_REQUIRED` |
| 401/403 | auth codes above, `AUTH_SCOPE` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT_REVISION` (base revision/hash moved), `IDEMPOTENCY_MISMATCH` (same key, different body), `LOCKED` (another mutation holds the site lock ≥ 10 s) |
| 413 | `PAYLOAD_TOO_LARGE` |
| 422 | `CAPABILITY_UNSUPPORTED` (details.capability), `UNREGISTERED_BLOCK` |
| 429 | `RATE_LIMITED` (header `Retry-After`) |
| 500 | `INTERNAL` (message is generic; detail only in bridge log) |
| 502/504 | `UPSTREAM_FAILED` (site revalidate/health check), `DEPLOY_FAILED`, `VERIFY_FAILED` |

Lists: `?limit=1..200 (default 50)&cursor=<opaque>` → `{items: [...], next_cursor: string|null}`.

Rate limit (default): 120 req/min per key, 20 mutations/min per key.

## 3. Idempotency

Mutations require `Idempotency-Key` (8–128 chars). The bridge stores
`(key_id, idempotency_key) → (sha256(body), status, response)` for 24 h. A
repeat with the same body returns the stored response with header
`Idempotent-Replay: true`; a different body → `409 IDEMPOTENCY_MISMATCH`.
Control-plane retries are allowed only for GETs and for mutations that carry
an idempotency key.

## 4. Health and capabilities

`GET /healthz` — **unauthenticated liveness only**: `{"ok": true}`. No
versions, paths or counts (safe for Docker `HEALTHCHECK`).

`GET /health` (read) →

```json
{"status": "ok|degraded|down", "ready": true,
 "checks": [{"name": "state_dir_writable", "ok": true, "detail": null},
            {"name": "root:content", "ok": true, "detail": null},
            {"name": "disk_free", "ok": true, "detail": "18.2 GiB"},
            {"name": "site_reachable", "ok": true, "detail": "200 in 84 ms"}],
 "current_revision": "r_…|null", "time": "…"}
```

`GET /capabilities` (read) →

```json
{
  "protocol_version": "1",
  "agent_version": "1.0.0",
  "mode": "sidecar|in-app",
  "site": {"site_id": "marketing-site", "environment": "production|staging|development",
           "public_base_url": "https://example.com"},
  "nextjs": {"version": "15.1.0|null", "router": "app|pages|mixed|unknown"},
  "package_manager": "npm|pnpm|yarn|bun|unknown",
  "repository": {"available": true, "commit": "abc123…|null", "branch": "main|null", "dirty": false},
  "deployment": {"hostname": "…", "container_id": "12-char|null", "image": "…|null",
                 "compose_project": "…|null", "service": "…|null", "profiles": ["web"]},
  "writable_roots": [{"id": "content", "kind": "content|overrides|code|assets", "writable": true}],
  "content_adapters": [{"id": "posts", "kind": "mdx|markdown|json|custom", "root": "content",
                        "operations": ["read","create","update","delete"],
                        "frontmatter_schema": {…JSON Schema…|null}}],
  "capabilities": {"inventory": true, "content.read": true, "content.write": true,
                   "metadata.write": true, "blocks.write": true, "images.alt.write": true,
                   "redirects.write": true, "files.read": true, "files.patch": false,
                   "validate": false, "preview": false, "revalidate": true,
                   "deploy": false, "ops.logs": false, "backups": true},
  "validation_steps": ["format","lint","typecheck","build","test"],
  "preview": {"url": "https://staging.example.com|null", "status": "available|unavailable"},
  "limits": {"max_body_bytes": 1048576, "max_file_bytes": 524288, "rate_per_minute": 120}
}
```

Rules: never absolute host paths (roots are ids, file paths are relative to
a root), never secrets or env values. A capability is `true` only if its
configuration is present **and** its self-check passes. The control plane
must gate every UI action and API call on these flags.

## 5. Read-only inventory (read)

| Endpoint | Returns |
|---|---|
| `GET /inventory/routes` | `{items: [{route: "/blog/[slug]", kind: "page|route-handler|layout", router: "app|pages", source: {root: "code", path: "app/blog/[slug]/page.tsx"}|null, dynamic: true, metadata: "generateMetadata-optin|static|none|unknown", blocks: ["hero.title"], adapter: "posts|null"}], unsupported: [{route, reason}]}` |
| `GET /inventory/metadata` | `{items: [{route, fields: {…MetadataFields}, updated_at, revision_id}]}` — runtime override store |
| `GET /inventory/blocks` | `{items: [{id: "home.hero.title", route: "/", kind: "text|rich-text|image", default?: string, value?: string, alt?: string}]}` — registered manifest merged with current values |
| `GET /inventory/assets` | paginated `{items: [{root: "assets", path: "images/x.png", bytes, sha256}]}` |
| `GET /inventory/redirects` | `{items: [{source, destination, permanent}]}` |
| `GET /inventory/unsupported` | `{items: [{feature, reason}]}` — e.g. "static metadata in app/about/page.tsx: not opted in" |

## 6. Content (read)

- `GET /content/collections` → `{items: [ContentAdapterDescriptor]}`
- `GET /content/{collection}/items?status=draft|published|all` → paginated `{items: [{slug, title, status, updated_at, sha256}]}`
- `GET /content/{collection}/items/{slug}` → `{slug, status, frontmatter: {}, body: "…", sha256, path: {root, path}}`

Slugs: `^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤ 120 chars. Collection ids: `^[a-z][a-z0-9-]{0,39}$`.
Drafts live in the adapter's draft location (MDX: `<root>/_drafts/<slug>.mdx`) and are never routed.

## 7. Metadata fields

```ts
MetadataFields = {
  title?: string (≤ 300), description?: string (≤ 1000),
  canonical?: absolute https URL or path starting "/",
  robots?: {index: boolean, follow: boolean},
  openGraph?: {title?: string, description?: string, image?: URL-or-path},
  jsonLd?: object[]  // each must have "@type"; ≤ 32 KiB serialized
}
```

The bridge writes these to its **runtime override store**. The site honours
them only on routes that opted in via the runtime helper
(`withAutomationMetadata`). `/inventory/routes` reports per route whether the
override will take effect; applying `metadata.set` to a route that has not
opted in returns a plan warning `METADATA_NOT_OPTED_IN`, and the apply result
marks that operation `effective: false` — never a silent success.

## 8. Operations (typed, allow-listed)

The only way anything changes. Every operation has `op` plus fields:

| op | fields | capability |
|---|---|---|
| `content.upsert` | `collection, slug, status: draft|published, frontmatter: object, body: string, base_sha256: string|null` | content.write |
| `content.delete` | `collection, slug, base_sha256` | content.write |
| `metadata.set` | `route, fields: MetadataFields` (replaces the route's override) | metadata.write |
| `metadata.clear` | `route` | metadata.write |
| `block.set` | `block_id, value: string, format: text|rich-text` (id must be registered) | blocks.write |
| `block.clear` | `block_id` | blocks.write |
| `image.alt.set` | `image_id, alt: string (≤ 250)` (registered image block) | images.alt.write |
| `image.alt.clear` | `image_id` | images.alt.write |
| `redirect.upsert` | `source: path, destination: path-or-https-URL, permanent: boolean` | redirects.write |
| `redirect.delete` | `source` | redirects.write |
| `file.write` | `root, path, content: string (utf-8), base_sha256: string|null` (null = must not exist) | files.patch |
| `file.delete` | `root, path, base_sha256` | files.patch |

`route` = path starting `/`, normalised (no trailing slash except `/`, no `..`,
no query/fragment). Rich text is sanitised on write (allow-list: `p, br, strong,
em, b, i, u, a[href|title|rel], ul, ol, li, h2, h3, h4, blockquote, code`; `href`
must be http(s), mailto, or relative) and again when rendered.

Path rules for any `{root, path}`: relative, POSIX separators, NFC-normalised,
no `..` segment, no leading `/`, no NUL, ≤ 240 bytes; resolved with `realpath`
and must stay under the root's realpath (symlinks pointing outside →
`PATH_SYMLINK_ESCAPE`); `file.*` additionally must match the root's
allow-list globs (e.g. `app/**/*.{ts,tsx,css}`, `components/**`,
`styles/**`, `public/**`) and never match its deny globs (`.env*`, `**/node_modules/**`,
`.git/**`, `Dockerfile*`, `docker-compose*`, lockfiles, the bridge's own files).

A change set is at most 200 operations and 2 MiB.

## 9. Change-set execution

`POST /changesets/plan` (read) — no side effects.

```json
// request
{"change_id": "cs_…", "operations": [ …Operation ], "base_revision": "r_…|null"}
// response
{"valid": true, "errors": [{"index": 3, "code": "UNREGISTERED_BLOCK", "message": "…"}],
 "warnings": [{"index": 0, "code": "METADATA_NOT_OPTED_IN", "message": "…"}],
 "diff": "unified diff of every affected file, paths shown as <root>/<path>",
 "files": [{"root": "overrides", "path": "metadata.json", "change": "modify|create|delete",
            "before_sha256": "…|null", "after_sha256": "…|null"}],
 "impacted_routes": ["/", "/blog/hello"],
 "risk": {"level": "low|medium|high", "flags": ["code-change", "deletes-content", "robots-noindex", "redirect"]},
 "current_revision": "r_…|null"}
```

`POST /changesets/apply` (write; `Idempotency-Key`) — same request plus
`"expected_plan_sha256"` (sha256 of the `diff` the approver saw). Steps, all
under a per-site lock:

1. Re-plan; if `current_revision ≠ base_revision` (when given) or the diff
   hash differs from `expected_plan_sha256` → `409 CONFLICT_REVISION`.
2. Snapshot every affected file (content + mode, or "absent") into
   `state/revisions/<revision_id>/before/`.
3. Write each file atomically (temp file in the same dir → fsync → rename,
   then fsync the dir).
4. Verify: re-read and compare sha256 with the plan.
5. Revalidate impacted routes (if `revalidate` capability) and, when the
   site is reachable, GET each impacted static route expecting < 500.
6. On any failure in 3–5: restore the snapshot, record the revision as
   `rolled_back`, return `502 VERIFY_FAILED` with `details.revision_id`.

Response `200`:

```json
{"revision_id": "r_…", "change_id": "cs_…", "status": "applied",
 "operations": [{"index": 0, "effective": true}],
 "files": [ …as plan… ], "revalidated": ["/"],
 "verification": {"hashes_ok": true, "routes": [{"route": "/", "status": 200}]},
 "applied_at": "…"}
```

Revisions (immutable, stored under the state dir, append-only index):

- `GET /revisions` → paginated `{items: [{revision_id, change_id, status: applied|rolled_back|reverted, parent_revision, files: n, created_at}]}`
- `GET /revisions/{id}` → full record including `diff`
- `POST /revisions/{id}/rollback` (write; `Idempotency-Key`) `{"reason": "…"}` →
  restores that revision's `before` state as a **new** revision (status of the
  original becomes `reverted`). If any file changed since the revision →
  `409 CONFLICT_REVISION` listing files, unless `{"force": true}` (deploy scope).

## 10. Validation and preview

`POST /validations` (read) `{"operations": [...], "steps": ["typecheck","lint","build"]}` →
`202 {"job_id": "j_…"}`. The bridge materialises the proposed files into a
scratch worktree of the repository (`git worktree add` at HEAD; node_modules
linked read-only), then runs **only** the commands configured in the project
profile for each step — command arrays executed without a shell, with a
per-step timeout, a clean env (PATH, HOME, NODE_ENV, CI=1) and output capped
at 1 MiB per step. Unknown step → `400 OPERATION_NOT_ALLOWED`.
`capabilities.validate=false` → `422 CAPABILITY_UNSUPPORTED`.

`POST /previews` (read) `{"operations": [...]}` → `202 {job_id}` when a preview
profile is configured; result carries `preview_url`. Otherwise `422`.

Jobs: `GET /jobs/{id}` → `{job_id, kind, status: queued|running|succeeded|failed|cancelled,
steps: [{name, status, exit_code, duration_ms, output_tail}], result, error, created_at, finished_at}`;
`GET /jobs/{id}/events` → Server-Sent Events: `event: log|step|status`, `data: JSON`.

## 11. Operations: Docker / VPS

Profiles live in the bridge config only; the API accepts **a profile name**
(`^[a-z][a-z0-9-]{0,39}$`) and nothing else — no service names, images, or
command strings from requests.

- `GET /ops/status` (read) → `{items: [{service, state, health, image, image_id, started_at}]}` for services in configured profiles.
- `GET /ops/logs?service=<configured service>&tail=1..2000` (read, capability `ops.logs`) → `{lines: [..]}` (secrets matching the redaction patterns are masked).
- `GET /deployments/profiles` (read) → `[{name, strategy: "compose-recreate|build-and-swap", services, smoke_paths}]`.
- `POST /deployments` (deploy; `Idempotency-Key`) `{"profile": "web", "reason": "…"}` → `202 {deployment_id, job_id}`.
  Strategy `compose-recreate`: record current image id → `docker compose build <svc>` → `up -d --no-deps <svc>` → wait for container health → GET each smoke path expecting 2xx/3xx → on failure re-tag the recorded image and `up -d` again (automatic rollback) → status `rolled_back` with the failing step.
- `GET /deployments` / `GET /deployments/{id}` → `{deployment_id, profile, status: running|succeeded|failed|rolled_back, previous_image_id, new_image_id, steps: […], started_at, finished_at}`.
- `POST /deployments/{id}/rollback` (deploy; `Idempotency-Key`) → redeploys `previous_image_id`.

Commands are built from fixed templates: `docker compose -f <configured file> -p <configured project> <verb> <configured service>`; executed with `execFile` (no shell).

## 12. Backups

- `GET /backups` → `{items: [{backup_id, kind: "overrides|content|full", bytes, sha256, encrypted, created_at, revision_id}]}`
- `POST /backups` (write; `Idempotency-Key`) `{"kind": "overrides|content|full"}` → tar.gz of the listed writable roots (never `code` unless kind=full), AES-256-GCM encrypted when `BRIDGE_BACKUP_KEY` is set, with a manifest (relative paths + sha256).
- `POST /backups/{id}/restore` (deploy; `Idempotency-Key`) `{"confirm": "<backup_id>", "dry_run": true|false}` → dry run returns the diff; a real restore is applied like a change set (new revision) and followed by a health check.
- Retention: keep the newest `BRIDGE_BACKUP_RETENTION` (default 30) per kind; revision snapshots older than `BRIDGE_REVISION_RETENTION_DAYS` (default 90) are pruned but their index entries remain.

## 13. Audit

`GET /audit?cursor&limit` (admin) → `{items: [{at, correlation_id, key_id|null, method, path (no query values), op?, outcome: ok|denied|error, code?, change_id?, revision_id?}]}`.
JSONL, rotated at 10 MiB, 10 files kept.

## 14. Versioning

Breaking changes create `/v2`. Within v1 fields may be added; clients must
ignore unknown fields. `protocol_version` in `/capabilities` is the major
version as a string. The control plane refuses a bridge whose major version it
does not support and shows the upgrade instruction.
