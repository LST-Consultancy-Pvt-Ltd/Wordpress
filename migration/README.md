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

