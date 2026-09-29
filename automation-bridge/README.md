# @lst/automation-bridge

The bridge agent that runs beside a managed Next.js deployment and implements
**Automation Bridge protocol v1** (`protocol/automation-bridge-v1.md` in the
platform repository). The control plane talks only to this agent; the agent
changes the site only through typed, allow-listed operations that are planned,
applied atomically, verified, revalidated and revertible.

- Two installation modes: **sidecar** (a separate container, recommended) or **in-app** (an App Router route inside the site).
- Base path `/api/automation-bridge/v1` in both modes; unauthenticated liveness at `/healthz`.
- OpenAPI 3.1 at `GET {base}/openapi.json` (authenticated) and in [`openapi.json`](./openapi.json).
- There is no shell, command or arbitrary-path endpoint. Commands run only from the bridge config, and Docker commands come from fixed templates.

Contents: [Quick start](#quick-start-sidecar) · [Sidecar step by step](#sidecar-mode-step-by-step) · [In-app mode](#in-app-mode) ·
[Site runtime helpers](#site-runtime-helpers) · [Configuration](#configuration-reference) · [Keys](#credentials-bootstrap-rotation-revocation) ·
[Security model](#security-model) · [Capabilities](#capability-matrix) · [Backups](#backups-restore-retention) ·
[Docker deployments](#docker-operations-and-deployments) · [Custom adapters](#custom-content-adapters) · [Development](#development) · [Troubleshooting](#troubleshooting)

---

## Quick start (sidecar)

```bash
cd automation-bridge/examples/sample-site
cp env.example .env
node -e "console.log('BRIDGE_BOOTSTRAP_KEY_ID=k_'+require('crypto').randomBytes(8).toString('hex'))" >> .env
node -e "console.log('BRIDGE_BOOTSTRAP_SECRET='+require('crypto').randomBytes(32).toString('base64url'))" >> .env
node -e "console.log('BRIDGE_REVALIDATE_SECRET='+require('crypto').randomBytes(32).toString('base64url'))" >> .env
# remove the empty placeholder lines from .env, then:
docker compose up -d --build
```

The site listens on `127.0.0.1:3000`. The bridge has no published port: it is
only on the internal `private` network. `npm run test:docker` (from
`automation-bridge/`) runs the same stack with a loopback-only port and checks
that `metadata.set` changes the rendered `<title>` and that a rollback restores it.

## Sidecar mode, step by step

1. **Build the image**: `docker build -t automation-bridge:1 automation-bridge/`.
   Add `--build-arg WITH_DOCKER_CLI=1` only if you want the deployment capability (see [Docker](#docker-operations-and-deployments)).
2. **Write the config**. Copy [`automation-bridge.config.example.json`](./automation-bridge.config.example.json) to the host,
   set `site`, the roots and the collections, and mount it at `/etc/automation-bridge/automation-bridge.config.json` (read-only).
3. **Move runtime state onto volumes** that both containers share:
   - `content` (e.g. MDX posts): bridge read-write, site read-only.
   - `overrides` (metadata, blocks, image alt, redirects): bridge read-write, site read-only.
   - `bridge-state` (`/var/lib/automation-bridge`: keys, revisions, idempotency, audit, backups): bridge only.
   - the site repository at `/repo`, **read-only** (route inventory, manifest, assets). Mark a code root `writable: true` only if you want `file.*` operations, and then only with a tight allow-list.
   Directories must be writable by uid **10001** (the bridge user). The site image in `examples/` creates them owned by 10001.
4. **Secrets from env or files**: `BRIDGE_BOOTSTRAP_KEY_ID`, `BRIDGE_BOOTSTRAP_SECRET`, `BRIDGE_REVALIDATE_SECRET`,
   optional `BRIDGE_BACKUP_KEY`. Each also accepts `*_FILE` (e.g. Docker secrets at `/run/secrets/...`).
   The bootstrap key only seeds `keys.json` on first start. Later changes go through rotation.
5. **Add the revalidate endpoint to the site** (`app/api/automation-revalidate/route.ts`, see below) and give the site the same `BRIDGE_REVALIDATE_SECRET`.
6. **Network**. Put site and bridge on a private network (`internal: true` in Compose). The bridge binds `0.0.0.0:8787` *inside the container*. Never publish that port on a public interface. The control plane reaches the bridge by one of these routes:
   - the same Docker network or host (control plane → `http://bridge:8787/api/automation-bridge/v1`; plain HTTP is accepted by the control plane only for private addresses / service names with `allow_private_http`),
   - a VPN / WireGuard / Tailscale address, or
   - a reverse proxy with **TLS** and a second authentication layer. Examples: Caddy with `basic_auth` or mTLS, Traefik with an IP allow-list plus `forwardAuth`, nginx with `allow`/`deny` and `ssl_client_certificate`. Route only `/api/automation-bridge/v1/` and `/healthz`. Do not strip or rewrite the path or query: the HMAC signature covers the exact request target.
7. **Hardening flags** (as in the sample compose file): `read_only: true`, `tmpfs: [/tmp]`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `user: 10001`.
8. **Verify**: `node scripts/sign-request.mjs --key-id $ID --secret-file ./bridge.secret http://bridge:8787/api/automation-bridge/v1/health`.

Healthcheck: the image has `HEALTHCHECK` on `/healthz`, which returns only `{"ok": true}`.

## In-app mode

Use this when a separate container is not possible. The write capability then
lives inside the public Next.js process, so prefer sidecar mode for production.

```ts
// app/api/automation-bridge/v1/[[...path]]/route.ts
import { revalidatePath } from "next/cache";
import { createRouteHandlers } from "@lst/automation-bridge/next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const { GET, POST } = createRouteHandlers({
  configPath: process.env.BRIDGE_CONFIG ?? "automation-bridge.config.json",
  revalidatePath: (p) => revalidatePath(p),
});
```

Set `"mode": "in-app"` and `"revalidate": {"mode": "in-app"}`. `state_dir` must be a persistent,
private directory outside `public/`, and outside every writable root. Several
Next.js workers share one state dir safely: mutations take a lock file on top of the in-process mutex.
In standalone builds without source files, list opted-in routes in the manifest's
`metadata_routes`, because the inventory cannot scan `app/`.

## Site runtime helpers

`@lst/automation-bridge/next` is read-only. The helpers read the override stores from
`AUTOMATION_OVERRIDES_DIR` (default `<cwd>/.automation/overrides`). A missing or corrupt store means "no overrides", so pages always render.

```tsx
import { withAutomationMetadata, EditableText, EditableRichText, EditableImage, AutomationJsonLd, matchRedirect, getRedirects, renderContentHtml } from "@lst/automation-bridge/next";

export async function generateMetadata() {
  return withAutomationMetadata("/about", { title: "About us", description: "…" }); // opt-in (detected by static scan)
}

<h1><EditableText id="home.hero.title">Default</EditableText></h1>
<EditableRichText id="about.body">{"<p>Default</p>"}</EditableRichText>   {/* sanitised again at render time */}
<EditableImage id="home.hero.image" src="/hero.svg" alt="Default alt" />
<AutomationJsonLd route="/about" extra={post.frontmatter.jsonLd} />          {/* escaped JSON-LD script */}
```

- **Opt-in**: metadata overrides work only on routes whose page source contains `withAutomationMetadata(`. `metadata.set` elsewhere succeeds with a `METADATA_NOT_OPTED_IN` plan warning and `effective: false`.
- **Blocks and images** must be registered in `automation.manifest.json`: `{"version":1,"blocks":[{"id","route","kind":"text|rich-text|image","default"?,"src"?,"alt"?}],"metadata_routes"?:[]}`. Unregistered ids → `UNREGISTERED_BLOCK`.
- **Redirects**: `matchRedirect(pathname)` in `middleware.ts` with `export const config = { runtime: "nodejs" }` (Next.js ≥ 15.5) applies changes at runtime. `getRedirects()` in `next.config` `redirects()` is read at build/start only.
- **Content**: `renderContentHtml(frontmatter, body)` sanitises `content_format: "html"` bodies (AI-generated posts, inline styles are dropped) with the article allow-list. Other bodies are returned for your own Markdown pipeline. Front matter may contain `tags`/`categories` arrays, `description`, `keywords` and a `jsonLd` object.
- **Revalidate endpoint (sidecar mode)**:

```ts
// app/api/automation-revalidate/route.ts
import { revalidatePath } from "next/cache";
import { createRevalidateHandler } from "@lst/automation-bridge/next/server";
export const runtime = "nodejs";
export const { POST } = createRevalidateHandler({ revalidatePath: (p) => revalidatePath(p) });
```

The bridge POSTs `{"paths": [...]}` with the impacted routes only (never the whole site).
Headers: `X-Revalidate-Timestamp` (±300 s) and `X-Revalidate-Signature = hex HMAC-SHA256(BRIDGE_REVALIDATE_SECRET, timestamp + "\n" + paths.join("\n"))`.
Pages using overrides must be eligible for revalidation, so do not use `force-static`.

## Configuration reference

`automation-bridge.config.json` is validated strictly: unknown keys are rejected. Relative paths resolve against the config file's directory.
`BRIDGE_CONFIG` selects the file (sidecar default: `/etc/automation-bridge/automation-bridge.config.json`).

| Key | Type / default | Notes |
|---|---|---|
| `mode` | `sidecar` \| `in-app` = sidecar | reported in `/capabilities` |
| `site.site_id` | `^[a-z0-9][a-z0-9-]{0,62}$` | |
| `site.environment` | production \| staging \| development | |
| `site.public_base_url` | URL | |
| `site.internal_url` | URL \| null | how the bridge reaches the site (`http://site:3000`). Enables `site_reachable`, post-apply route checks, smoke checks and sidecar revalidation |
| `state_dir` | path | keys, revisions, idempotency, audit, jobs, backups, locks. Must not be inside a writable root. Env override `BRIDGE_STATE_DIR` |
| `roots[]` | `{id, kind: content\|overrides\|code\|assets, path, writable=false, allow=[], deny=[]}` | responses use ids, never paths. `allow` globs gate `file.*` and `/files/{root}`. Built-in deny list always applies (`.env*`, `node_modules`, `.git`, `Dockerfile*`, compose files, lockfiles, `.npmrc`, keys, bridge files) |
| `overrides_root` | root id \| null | enables metadata/blocks/images/redirects writes |
| `code_root` | root id \| null | route inventory, git facts, validation worktrees |
| `manifest` | `{root, path="automation.manifest.json"}` \| `{inline: {...}}` \| null | block registry |
| `content.collections[]` | `{id, kind: mdx\|markdown\|json\|custom, root?, dir="", route_pattern=null, index_routes=[], frontmatter_schema=null, title_field="title", adapter?}` | `frontmatter_schema` is a JSON-Schema subset (type, required, properties, additionalProperties, enum, min/maxLength, minimum/maximum, items, maxItems, format date/date-time/uri) |
| `revalidate` | `{mode: none\|in-app\|sidecar = none, endpoint_path="/api/automation-revalidate", timeout_ms=5000}` | |
| `validation` | `{steps: {format?, lint?, typecheck?, build?, test?: string[]}, timeout_s=600, node_env="production", use_git_worktree=true, max_concurrent=1, run_as={uid,gid}\|null, allow_same_user=false, node_modules="copy"\|"symlink", scratch_dir=null}` \| null | command **arrays**, run without a shell. **Jobs refuse to run** unless `run_as` names a separate unprivileged user (bridge must run as root or with CAP_SETUID/SETGID; `state_dir` must be mode 0700) or `allow_same_user: true` is set explicitly. `preview` takes the same sandbox keys |
| `preview` | `{command: string[], url, timeout_s=900}` \| null | |
| `docker` | `{compose_file, project, profiles: {name: {services[], strategy="compose-recreate", health_timeout_s=120, smoke_paths=["/"]}}, log_services?, docker_binary="docker", command_timeout_s=900}` \| null | |
| `limits` | `max_body_bytes=1MiB (≤2MiB), max_file_bytes=512KiB, rate_per_minute=120, mutations_per_minute=20, max_operations=200, lock_wait_ms=10000` | |
| `retention` | `backups=30, revision_days=90, idempotency_hours=24` | env `BRIDGE_BACKUP_RETENTION`, `BRIDGE_REVISION_RETENTION_DAYS` win |
| `logging.level` | debug\|info\|warn\|error = info | JSON lines on stdout |
| `server` | `{host="0.0.0.0", port=8787}` | env `BRIDGE_HOST`, `BRIDGE_PORT` |

Environment (secrets never go in the config file):

| Variable | Purpose |
|---|---|
| `BRIDGE_BOOTSTRAP_KEY_ID`, `BRIDGE_BOOTSTRAP_SECRET` (+`_FILE`) | seed `keys.json` on first start. Secret = 32 random bytes, base64url without padding |
| `BRIDGE_BOOTSTRAP_SCOPES` | default `read,write,deploy,admin` |
| `BRIDGE_REVALIDATE_SECRET` (+`_FILE`) | shared with the site's revalidate endpoint |
| `BRIDGE_BACKUP_KEY` (+`_FILE`) | 32 bytes (64 hex or 43 base64url chars). Enables AES-256-GCM backups |
| `BRIDGE_IMAGE`, `BRIDGE_SERVICE` | optional, informational in `/capabilities.deployment` |

TODO for each target site: fill in real repository paths, the compose file and project, the service names, the validation commands (`["npm","run","lint"]`, and so on) and the preview command. None of these are known yet for the production sites.

## Credentials: bootstrap, rotation, revocation

- Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Give the same `{key_id, secret}` to the control plane (`POST /api/sites`).
- The key store is `<state>/keys.json` (mode 0600). Operators may edit it, for example to add a key or set `revoked_at`. The bridge reloads it when it changes. If the file is invalid, the previously loaded keys stay in effect and an error is logged.
- `POST /auth/rotate` (admin) returns a new secret **once**. The calling key then expires after `grace_seconds` (default 300). The new secret is never written to the idempotency store. A replay with the same `Idempotency-Key` works only within the same process lifetime.
- `POST /auth/revoke` (admin). Revoking the last active admin key requires `{"confirm":"REVOKE-LAST-KEY"}`.
- Scopes: `read` (GETs, plan, validate, preview), `write` (apply, rollback, backups), `deploy` (deployments, restore, forced rollback), `admin` (keys, audit). Scopes do not imply one another.
- Operator CLI: `node scripts/sign-request.mjs [-X POST] [--data-file body.json] --key-id ID --secret-file FILE URL`. It reads the secret from a file only. `--print-headers` prints curl `-H` lines.

## Security model

| Threat | Control |
|---|---|
| Forged/replayed requests | HMAC-SHA256 over method, exact path+query, timestamp, nonce and body hash. ±300 s skew, 600 s nonce cache per key. Constant-time compare, also for unknown key ids. `AUTH_REVOKED` is only disclosed to callers who proved possession of that key |
| Excess privilege | per-endpoint scope. `force` rollback requires `deploy` |
| Abuse / DoS | per-key 120 req/min and 20 mutations/min, 1 MiB bodies (413 before parsing), 200 ops / 2 MiB per change set |
| Double-apply | `Idempotency-Key` required on every mutation. Stored 24 h. Fingerprint = method + path + body hash |
| Path traversal | NFC, no `..`/absolute/backslash/NUL/control chars/percent-encoded dots or slashes, ≤ 240 bytes, realpath containment, symlink escape detection (including dangling links), final-component symlinks never written, re-check before rename, allow + deny globs |
| XSS through content | rich text sanitised on write and on render (allow-list per protocol §8). Article HTML sanitised on render. JSON-LD escaped |
| Arbitrary code/commands | no shell anywhere (`execFile` only). Validation/preview run only config-defined arrays with a clean env (`PATH, HOME, NODE_ENV, CI`), timeouts and 1 MiB output cap. Docker commands use fixed templates with config values only. MDX bodies containing `import`/`export`/`{…}` are rejected unless the collection sets `allow_executable_mdx: true` (then flagged `code-change`). `/validations` and `/previews` need `write` scope |
| Partial writes | temp file → fsync → rename → dir fsync. Before-snapshots. Hash verification. Automatic restore on failure. `IN_PROGRESS` markers are recovered on startup |
| Concurrent edits | per-site lock (mutex + lock file, 10 s → `LOCKED`). `base_sha256`, `base_revision` and `expected_plan_sha256` conflict detection |
| Secret leakage | responses never contain absolute paths or env values. Logs redact registered secrets, secret-like keys, bearer tokens and absolute root paths. The audit log stores paths without query strings |

Out of scope / residual risks: anyone with write access to the state dir or the
key store controls the bridge. Validation and preview run repository code on
*proposed* file contents: run them as a separate user (`run_as`), keep
scratch trees outside `state_dir` (the default), keep `node_modules: "copy"`,
and only enable them for trusted repositories. `allow_same_user: true` means a
malicious proposal can read the key store. The control plane restricts
validation to deployers for this reason. Nonces are persisted under
`state_dir/nonces`, so replays are caught across restarts and workers.

## Capability matrix

A capability is `true` only when its configuration is present **and** its self-check passes. When it is false, `/capabilities.unsupported[cap]` gives the reason.

| Capability | Requires | Self-check |
|---|---|---|
| `inventory` | `code_root` (or manifest `metadata_routes`) | root readable |
| `content.read` / `content.write` | collections | directory exists / root writable. Custom adapters report their own operations |
| `metadata.write`, `redirects.write` | writable `overrides_root` | root writable |
| `blocks.write` / `images.alt.write` | the above + text/rich-text / image blocks in the manifest | |
| `files.read` / `files.patch` | code/assets root with `allow` globs (writable for patch) | root accessible |
| `validate` | `validation.steps` + `code_root` | every command found on PATH |
| `preview` | `preview` + `code_root` | command found on PATH |
| `revalidate` | `revalidate.mode` sidecar (+`internal_url` + secret) or in-app (+`revalidatePath`) | |
| `deploy` / `ops.logs` | `docker` with a `compose-recreate` profile | compose file readable, `docker version` and `docker compose version` succeed |
| `backups` | any writable root | state dir writable |

## Backups, restore, retention

- `POST /backups {"kind": "overrides|content|full"}` → tar.gz of the matching writable roots (`full` = all writable roots, code roots limited to their allow-list). Deny-listed files are never included. The archive holds `manifest.json` (relative paths + sha256) and `roots/<id>/…`.
- With `BRIDGE_BACKUP_KEY` the archive is AES-256-GCM encrypted (`LSTB1 | iv | ciphertext | tag`). A tampered archive or wrong key → `VERIFY_FAILED`.
- `POST /backups/{id}/restore {"confirm": "<backup_id>", "dry_run": true}` returns the diff. `dry_run: false` (deploy scope) applies it as a **new revision**, so it can be rolled back, then runs a health check.
- Retention: newest `BRIDGE_BACKUP_RETENTION` (30) per kind. Revision snapshots older than `BRIDGE_REVISION_RETENTION_DAYS` (90) are pruned hourly, and their records and index entries remain (rolling back such a revision returns `OPERATION_NOT_ALLOWED`). Idempotency records expire after 24 h. The audit log rotates at 10 MiB and keeps 10 files.
- Back up the state volume itself (keys, revisions) with your normal volume backups. It contains secrets, so encrypt it.

## Docker operations and deployments

The `compose-recreate` strategy works as follows: record each service's image id → `docker compose build <svc>` →
`up -d --no-deps <svc>` → wait for container health (or 10 s of running without a HEALTHCHECK) →
GET every smoke path on `internal_url` expecting 2xx/3xx. On any failure, the bridge re-tags the recorded image,
runs `up -d --no-deps --no-build --force-recreate` and marks the deployment `rolled_back` with the failing step.
`POST /deployments/{id}/rollback` redeploys the recorded images. `build-and-swap` profiles are reported as
unsupported (`supported: false`) and refused with `CAPABILITY_UNSUPPORTED`.

This needs the Docker CLI in the image (`--build-arg WITH_DOCKER_CLI=1`), the compose file and build context
mounted at the same paths, and Docker API access. **Mounting `/var/run/docker.sock` gives the container
root-equivalent control of the host.** Instead, run
[`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy) on a separate internal network
with only what compose-recreate needs (`CONTAINERS=1 IMAGES=1 BUILD=1 POST=1 NETWORKS=1 VOLUMES=1`, everything
else 0), and point the bridge at it with `DOCKER_HOST=tcp://docker-proxy:2375`. Even through the proxy, the ability to
build and start containers is powerful. Enable `deploy` only for bridges whose credentials are held by the control plane alone.

## Custom content adapters

Implement `ContentAdapter` (`src/core/content/types.ts`) and register it:

```ts
import { createBridge, createHttpContentAdapter } from "@lst/automation-bridge";
const bridge = await createBridge(config, { adapters: { cms: createHttpContentAdapter({ id: "news", baseUrl: "https://cms.internal/api" }) } });
// config: { "id": "news", "kind": "custom", "adapter": "cms", "route_pattern": "/news/[slug]" }
```

File-backed adapters plan writes through the change-set virtual file system, so snapshots, verification and rollback apply to them.
An adapter that writes to an external system cannot be rolled back by the bridge, so the reference HTTP adapter is read-only (`operations: ["read"]`).

## Development

```bash
npm install
npm run typecheck && npm run lint && npm test   # unit + integration (real HTTP sidecar)
npm run build                                    # dist/
npm run openapi                                  # regenerate openapi.json (a test fails if it is stale)
npm run test:docker                              # builds sample site + bridge with docker compose, end-to-end
```

Layout: `src/core` (framework-agnostic: `createBridge(config).handle({method,url,headers,body})`), `src/sidecar` (node:http server),
`src/next` (route handlers and read-only runtime helpers), `src/shared` (store formats, revalidate signing), `examples/sample-site`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401 AUTH_INVALID` for every request | wrong secret, the secret was base64-decoded twice, or a proxy rewrote the path/query (the signature covers the exact target, e.g. `/api/automation-bridge/v1/items?status=all&limit=10`) |
| `401 AUTH_EXPIRED` | clock skew > 300 s. Run NTP on both hosts |
| `401 AUTH_REPLAY` | client reused a nonce (retries must re-sign) |
| `409 LOCKED` | another apply/rollback/restore is running for > 10 s |
| `409 CONFLICT_REVISION` on apply | something changed between plan and apply. Re-plan and re-approve |
| `metadata.set` has `effective: false` | the page does not call `withAutomationMetadata()`, see `GET /inventory/unsupported` |
| Change applied but page unchanged | `revalidate` capability false, page is `force-static`, or the site does not read `AUTOMATION_OVERRIDES_DIR` from the shared volume |
| `502 VERIFY_FAILED` | revalidation or post-apply route check failed. The snapshot was restored (`details.revision_id`, `details.step`) |
| capability unexpectedly false | read `/capabilities.unsupported` and `/health` checks |
| `EACCES` in logs | volumes not writable by uid 10001 |
