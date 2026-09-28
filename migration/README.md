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

## Decisions needed before phase 2/3

1. **Target sites:** repository path(s) on the VPS, App vs Pages Router, content
   source (MDX in repo, JSON, DB, headless CMS), how they are deployed today
   (compose file / service names), reverse proxy (Traefik / Caddy / nginx), and
   whether a staging environment exists.
2. **Bridge mode:** sidecar agent container (recommended; it keeps write
   capability out of the public Next.js process) vs an in-app App Router route.
3. **Frontend stack:** keep React/CRACO and refactor in place (less risk) vs
   rebuild on Next.js/Vite (the brief allows either).
4. **Roles:** add a `deployer` role between `editor` and `admin`?
5. **Features to drop rather than port:** A/B title tests, newsletter-from-posts,
   calendar scheduling, programmatic page push, social-from-post, and so on. Each
   ported feature becomes a change-set producer, so every one kept adds phase 6 work.
