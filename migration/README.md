# Next.js-only migration log

Internal, not shipped: `migration/` is outside both Docker build contexts
(`backend/`, `frontend/`) and is the only allow-listed location for legacy CMS
terminology in the reference scan.

- Branch: `nextjs-migration`
- Pre-migration boundary: tag `pre-nextjs-migration` (commit `237eac6`, which also contains the
  previously uncommitted "move page" WIP as its own commit)

## Phase 1: Discovery and safety baseline

### Delivered

| Artifact | Purpose |
|---|---|
| `scripts/legacy_reference_scan.py` | Scanner with three modes: `inventory` (JSON of every reference), `baseline` (only allowed to shrink), `check` (the CI gate). Scans git-visible files only, so local `.env` files and build output are excluded. File names count as references |
| `migration/legacy-scan-baseline.json` | Ratchet: per-file allowed counts. 3266 references in 115 files at tag time |
| `migration/legacy-scan-allowlist.txt` | Skips `migration/**` and the scanner and its tests. Neither is in any image |
| `migration/inventory/legacy-references.json` | Every hit: file, line, category, match |
| `migration/inventory/routes.json` | All 384 API routes with module, handler, and direct legacy references (126 handlers) |
| `migration/inventory/backend-modules.md`, `frontend-modules.md` | Per-module classification and planned action, plus existing defects |
| `backend/core/automation_policy.py` | **Write freeze.** On by default; lifted only by `AUTOMATION_WRITES_FROZEN=0` |
| `.github/workflows/ci.yml` | Jobs: legacy-reference gate + scanner tests, backend pytest (with a Mongo service), frontend production build |

### Write freeze: what it covers

| Unattended write path | Behaviour while frozen |
|---|---|
| `/jobs` "scheduled publish" cron (`core/scheduled_jobs.py`) | Not registered at startup or on save. If it fires anyway, it records `skipped: automatic writes frozen` and returns before loading credentials |
| Autopilot cron per site (`routers/autopilot.py`) | Not registered. The cron entry point is now `_scheduled_autopilot_run`, which checks the freeze again at fire time |
| Rank-drop / new-keyword watchers (`routers/monitoring_triggers.py`) | Detection and activity logging still run. The job is recorded as skipped and no pipeline run starts |
| Read-only jobs (freshness scan, SEO health, daily crawl, ads check) | Unchanged |
| User-initiated requests | Unchanged. The freeze only covers unattended paths |

`GET /api/health` now reports `automatic_site_writes: frozen|enabled`.

### Pre-migration database backup: **not taken yet (needs you)**

There is no WP Autopilot database on this workstation, so the backup has to run
where production Mongo lives. A wrapper script for the steps below was drafted,
but endpoint-security software on this Mac killed it (SIGKILL) and deleted it
twice. That is probably because it pipes a database dump into `openssl enc`. It
was not worked around. Run these commands on the VPS instead, by hand or as a
script your security policy permits:

```bash
umask 077; mkdir -p backups; STAMP=$(date -u +%Y%m%dT%H%M%SZ); NAME="premigration-$DB_NAME-$STAMP"
# 1. dump + encrypt (passphrase read from a file, never argv)
docker compose exec -T mongo mongodump --quiet --archive --gzip --db "$DB_NAME" \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass file:/secure/backup-pass.txt \
      -out "backups/$NAME.archive.gz.enc"
# 2. verify it decrypts and is a valid archive, then checksum it
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass file:/secure/backup-pass.txt \
  -in "backups/$NAME.archive.gz.enc" | gzip -t && shasum -a 256 "backups/$NAME.archive.gz.enc" > "backups/$NAME.sha256"
# 3. record collection counts beside it
docker compose exec -T mongo mongosh --quiet "$DB_NAME" --eval \
  'JSON.stringify(Object.fromEntries(db.getCollectionNames().map(c=>[c,db.getCollection(c).countDocuments()])))' \
  > "backups/$NAME.counts.json"
# Restore rehearsal (into a side database, never over the original):
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass file:/secure/backup-pass.txt -in "backups/$NAME.archive.gz.enc" \
  | docker compose exec -T mongo mongorestore --archive --gzip --nsFrom "$DB_NAME.*" --nsTo "restored_$DB_NAME.*"
```

Copy the archive off-host. `backups/` is git-ignored. Phase 3's data migration
refuses to purge credential fields until a backup manifest is registered.

### Tests run

- `scripts/tests`: 38 passed (patterns, false positives, gitignore/allowlist handling, ratchet refuses growth).
- `backend/tests/test_automation_freeze.py`: 18 passed.
- `backend/tests/test_seo_audit.py` + `test_route_parity.py`: 33 passed. The route surface is unchanged by phase 1.
- `backend/tests/test_evidence_rule.py`: **not run locally**. It needs a live MongoDB. CI provides one.
- Frontend build: not run locally in this phase (no frontend changes).

### Known limitations / notes for later phases

- The Docker volume is named `wp_mongo_data`. Renaming it in compose would orphan
  the data, so the rename needs a data-copy step (phase 6), not a find/replace.
- `DB_NAME` in the deployed `.env` contains the old product name. Changing it
  also means moving data. Decide in phase 6.
- `core/crypto.py` silently skips encryption when `ENCRYPTION_KEY` is unset, and it
  returns ciphertext unchanged when decryption fails. Phase 3 makes both errors.
- The sample Dockerized Next.js target fixture moves to phase 2, where the
  bridge's integration tests are its first consumer.

### Rollback

Phase 1 changes no data and no routes. To roll back, revert the phase-1 commit.
To lift the freeze without reverting, set `AUTOMATION_WRITES_FROZEN=0` on the
backend and restart.

## Decisions taken (defaults; revisit any of them)

The user asked for every phase to run without pausing, so each open decision took
the recommended default. All of them are recorded in `endpoint-plan.md`:

- **Bridge placement:** the sidecar agent is the primary mode. The in-app App Router mode shares the same core.
- **Frontend:** refactored in place, with no stack change.
- **Roles:** a new `deployer` role sits between editor and admin.
- **Features dropped rather than ported:** CMS users, plugins, themes, commerce, forms,
  comments, media library, menus, CMS backups, taxonomies, A/B title tests, calendar
  scheduling, translation, automatic interlink editing, bulk publish, EXIF/WebP rewriting,
  crawl auto-fix, plugin downloads, and generated featured-image upload (protocol v1 has
  no binary asset operation).
- **Sites** are shared across the team, not filtered per user.
- **Target-site specifics** (repository paths, compose services, validation commands,
  proxy, staging) are explicit bridge configuration marked TODO in
  `automation-bridge/automation-bridge.config.example.json`.

## Phase 2: Protocol and bridge agent

- `protocol/automation-bridge-v1.md` covers HMAC signing, scopes, rotation, idempotency,
  capabilities, inventory, content, typed operations, plan/apply/verify/rollback, jobs,
  Docker profiles, backups and audit, plus the §15 clarifications. Signing vectors are in
  `protocol/signing-test-vectors.json`.
- `automation-bridge/` is a TypeScript package with three parts: a sidecar server, an
  in-app route, and site runtime helpers (`withAutomationMetadata`, editable blocks,
  JSON-LD, redirects, revalidation). It also serves OpenAPI, and ships a Dockerfile
  (uid 10001, tini, healthcheck) and a sample Next.js 15 site with a compose file.
- Tests: 154 vitest tests (13 unit files, plus HTTP integration against the real sidecar).
  `npm run test:docker` builds the sample site and the bridge, applies `metadata.set`,
  checks the rendered `<title>` changed, rolls it back and checks again. The bridge agent
  ran this and reported it passing.
- The `nextjs-bridge/` prototype was deleted.

## Phase 3: Control-plane core

- **Models:** `models/sites.py` defines ManagedSite, SiteConnection, the BridgeAgent
  snapshot, ChangeSet, SitePolicy, and the deployment and backup requests.
- **Bridge client:** `providers/bridge_client.py` does the signing, retries only for
  idempotent calls, maps errors (a bridge 401/403 becomes a 502 with a `BRIDGE_*` code),
  negotiates the protocol, and re-checks DNS on every request.
- **Onboarding:** `routers/sites.py` enforces the HTTPS/SSRF URL policy
  (`core/url_policy.py`) and strict encrypted secrets (`core/secrets.py`, which refuses
  to work without `ENCRYPTION_KEY`). It also handles the handshake, write verification
  by probe revision, write enablement (typed confirmation, verified within 24 h),
  rotate/replace/revoke and policy.
- **Access:** `core/router.py` applies a baseline policy to every `/api` route. It
  requires authentication except on an explicit public list, and editor or higher for
  mutations. Streams use task-bound tokens, and the audit trail is in `core/audit.py`.
- **Data migration:** `backend/migrations/m001_managed_sites.py`, described below.

### Data migration commands

```bash
cd backend
python -m migrations.m001_managed_sites plan                       # dry run: what changes, which fields are dropped
python -m migrations.m001_managed_sites apply --backup-manifest /path/to/premigration-<db>-<ts>.manifest.json
python -m migrations.m001_managed_sites rollback                   # restores originals from the archive (before finalize)
python -m migrations.m001_managed_sites finalize --confirm-finalize # irreversible: drops archive + legacy caches
```

Status: the migration is implemented and tested against a disposable MongoDB. It has
**not been run against production** because there is no access from this workstation.
Every migrated site comes up as `unverified` with writes disabled, and an admin must
reconnect it with a new bridge key; old credentials are never migrated.

### Mongo volume rename (run once on the VPS, before first `up` with the new compose file)

```bash
docker compose down
docker volume create <project>_sa_mongo_data
docker run --rm -v <project>_wp_mongo_data:/from -v <project>_sa_mongo_data:/to alpine sh -c 'cp -a /from/. /to/'
docker compose up -d        # verify, then later: docker volume rm <project>_wp_mongo_data
```

`DB_NAME` can stay as it is. Renaming it also needs a `mongodump`/`mongorestore`.

## Phase 4: Change-set workflow

`core/changesets.py` implements plan → validate/preview → submit → approve → apply →
verify → revision → rollback. The rules it enforces:

- Approvals are tied to the diff hash, and editing a change set discards them.
- Self-approval is refused on production.
- Code changes need a passing validation of the same diff before they can be submitted.
- Transitions use an optimistic status check, so a change set can't be applied twice.
- The revision is recorded before the status changes.
- The bridge re-checks the diff hash and base revision. `VERIFY_FAILED` and
  `CONFLICT_REVISION` both come back with recovery instructions.

Every producer now creates change sets: on-page SEO meta and move-page, schema,
canonical, blog and auto-blog generation, autopilot, content refresh, programmatic
pages, reclamation redirects and the AI agent.

## Phase 5: Docker/VPS operations

`routers/operations.py` accepts only profile names from the browser. It gates deploy,
rollback and restore by role and by typed confirmation on production, reports
`rolled_back` together with recovery instructions, and requires the backup id plus the
site name for a real restore. The bridge implements `compose-recreate` with automatic
rollback. Its tests use a fake executor; **it has not been run against a real Docker
daemon**.

## Phase 6: Feature migration and deletion

- 132 routes removed and 49 added (388 → 306), listed in `inventory/route-changes.json`.
- Removed code: the legacy provider, nine routers, the PHP plugin tree, the CMS models,
  scheduled publish, the dev-tool auth shims and old test reports.
- Historical docs moved to `migration/history/`.
- `db.content_items` replaces the post and page caches, filled by
  `POST /sites/{id}/content/sync`.
- Compose, images and the volume have neutral names, and the backend image runs as
  non-root.

## Phase 7: Hardening and release

### Security review

The review was an adversarial, read-only pass over the backend and the bridge. It
found 15 issues, and every one of them is fixed with a regression test:

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | critical | Validation and preview ran proposed code with a read-scope key or an editor role, in a scratch tree that could read the key store | Deployer role and `write` scope required. Jobs refuse to run as the bridge user unless `run_as` (or explicit `allow_same_user`) is set. Scratch trees live outside `state_dir`, `node_modules` is copied, and output is redacted |
| 2 | high | SSRF through editor-, model- and site-supplied URLs, with the responses reflected back | `core/safe_fetch.py`: `is_global` only, DNS pinning, per-hop redirect checks, body caps, and a guard hook on every fetching client |
| 3 | high | Bridge deny globs were case-sensitive, and symlinks were checked lexically | `nocase` matching, plus a realpath allow/deny check |
| 4 | medium | Self-approval by editing someone else's change set | An authors set (creator, editors, submitter) is enforced |
| 5 | medium | CGNAT and metadata ranges were missing from the IP check; DNS rebinding | `ip.is_global`, and bridge connections pinned to the vetted IP |
| 6 | medium | A client could pick `source` to trigger auto-apply | The server sets `source=manual` |
| 7 | medium | Re-plan could overwrite an in-flight apply | Compare-and-swap on the status |
| 8 | medium | Binary files had identical diffs, so approvals didn't cover their content | The approval hash includes per-file sha256, and bridge diff lines carry the hashes |
| 9 | medium | Rate limiter trusted `X-Forwarded-For`; no idle eviction | `TRUSTED_PROXY_IPS`, eviction, and a per-account login throttle |
| 10 | low | Nonce cache lived only in memory | Persisted under `state_dir/nonces` |
| 11 | low | Executable MDX was only flagged | Rejected unless the collection sets `allow_executable_mdx` |
| 12 | low | AI HTML preview was rendered in the app DOM | Sandboxed iframe |
| 13 | low | First-admin registration race | Atomic bootstrap marker |
| 14 | low | Migrated internal URLs reached the audit fetchers | Validated in `transform`; rejected URLs are kept only as `legacy_url` |
| 15 | low | Unbounded bridge and upstream response reads | Streamed with a cap, or the body is cancelled |

Earlier fixes from this phase: public-only `base_url`, a 4 MiB request body limit,
unauthenticated legacy routes closed by the baseline policy, the dev auth shims removed,
the backend image running as a non-root user, and a per-site daily AI budget.

### Test evidence (final run on this workstation)

| Suite | Result |
|---|---|
| `scripts/tests` (reference scanner) | 38 passed |
| `backend/tests`: unit, control-plane integration against the fake bridge, end-to-end against the **real** bridge sidecar, migration, freeze and budget, evidence rules | 164 passed |
| `automation-bridge`: vitest unit and HTTP integration | 170 passed; typecheck and lint clean; `npm audit` shows 0 vulnerabilities |
| `automation-bridge`: `npm run test:docker` (sample Next.js site + bridge in Docker: apply metadata, rendered `<title>` changes, roll back) | passed, re-run after the security fixes (11/11 checks) |
| `frontend`: jest unit | 54 passed |
| `frontend`: Playwright E2E (Chromium, mocked API) | 10 passed |
| `frontend`: `CI=true` production build | passes |
| Backend image | builds, runs as uid 10001, `/api/health` ok, anonymous requests get 401 |
| Legacy reference scan | **0 references in 0 files**; baseline empty |

Not run: load tests; a real Docker-daemon deploy through the bridge (only the fake
executor); the production data migration and backup (no access from here).

### Removed surface (summary)

- **Backend:** the legacy provider module, 9 routers (users/plugins/themes, media and
  comments, forms and commerce, plugin downloads, CMS backups and redirects, the prototype
  content bridge router, CMS content CRUD, CMS-meta auto-SEO, image EXIF/WebP), the CMS
  site and request models, scheduled publish, `main.py` and the dev auth shims.
  132 routes in total; see `inventory/route-changes.json`.
- **Other trees:** the PHP plugin tree (`.tmp_plugin/`), the `nextjs-bridge/` prototype,
  old test reports and helper scripts.
- **Frontend:** 17 pages, the apply-mode sheet/hook, and every related route, nav entry and
  API export. The product is renamed and the session keys are neutral.
- **Deploy:** images, the volume, the compose defaults and the env are all neutral;
  `ENCRYPTION_KEY` is required.

### VPS / Docker setup

1. **Back up**, using the Phase 1 commands, and copy the archive off the host.
2. **Rename the volume** with the copy step under Phase 3.
3. **Set** `ENCRYPTION_KEY`, `JWT_SECRET_KEY` and `DB_NAME`, plus `TRUSTED_PROXY_IPS`
   if you're behind a reverse proxy. Then run `docker compose up -d`.
4. **Migrate the data:** `docker compose exec backend python -m migrations.m001_managed_sites plan`,
   then `apply --backup-manifest …`.
5. **For each Next.js site:**
   - Add the bridge sidecar, using `automation-bridge/examples/sample-site/docker-compose.yml`
     as the template.
   - Fill in `automation-bridge.config.json`: the roots, collections, validation steps
     with `run_as`, and the Docker profile behind a socket proxy.
   - Generate `BRIDGE_BOOTSTRAP_KEY_ID/SECRET` and `BRIDGE_REVALIDATE_SECRET`.
   - Opt pages in with `withAutomationMetadata` and the editable components.
6. **Connect.** Either join the control plane to the bridges' private network
   (`docker-compose.bridges.yml`) or publish each bridge behind an authenticated HTTPS
   route. Then go to **Sites → Connect site** in the UI, verify write access, and enable
   writes.
7. **Lift the freeze** (`AUTOMATION_WRITES_FROZEN=0`) only after policies are set.
8. **Finalize** the migration (`finalize --confirm-finalize`) once everything is verified.
   This is irreversible.

### Rollback

- **Code:** the `pre-nextjs-migration` tag.
- **Data:** before finalize, run `m001 rollback`. After finalize, restore the Phase 1
  backup.
- **Sites:** every bridge change is a revision that can be rolled back from the change-set
  view or `POST /revisions/{id}/rollback`.

### Decisions still needed from you

1. Target-site specifics: repository paths, content sources, compose files and services,
   the proxy, and staging.
2. Whether any of the dropped features should come back as change-set producers.
3. The auto-apply policy per site. The default is off, and frozen until lifted.
4. The validation sandbox user (`run_as`) on each VPS.
5. A load-test and staged-rollout plan, which needs a staging environment.

## Production deployment: 2026-09-29 (srv707772)

| Step | Result |
|---|---|
| Backup | `/root/backups/site-autopilot/premigration-<db>-20260929T164823Z.*`: encrypted, decrypt-verified and checksummed; 23 collections. The passphrase is in `.backup-pass`, root-only. An off-host copy is in the local `backups/` directory, which git ignores |
| Images | built on the VPS from `5b36b38` and `2fda2b9` (backend) as `site-autopilot-{backend,frontend}`; nothing published to a registry |
| Cutover | new Compose project `site-autopilot` in `/docker/site-autopilot`, on the same ports 3007 and 8002. Volume copied to `site-autopilot_sa_mongo_data` (518 MB) |
| Health | `/api/health` ok, writes frozen; anonymous requests get 401; UI serves "Site Autopilot"; backend uid 10001; reachable externally |
| Data migration | `m001 apply`: 2 sites migrated, credential fields purged, onboarding fields kept; `sites_premigration_archive` holds the originals until finalize |

Rollback, until `finalize`:

```bash
cd /docker/site-autopilot && docker compose -p site-autopilot down   # keeps its volume
cd /docker/wordpress-manager && docker compose start                 # old stack + untouched old volume
```

Still open: reconnect both sites with bridge keys once bridges are installed. The
first site's legacy CMS and the Next.js site both come up `unverified`. Then remove the
old stack and volume, and run `finalize`, once you're satisfied.
