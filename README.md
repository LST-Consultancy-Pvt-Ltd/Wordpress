# Site Autopilot

An automation platform for self-hosted **Next.js** sites running in Docker on
a VPS. It audits and improves sites (SEO, content, metadata, code/design
changes) and deploys them. Every change goes through a reviewed, reversible
pipeline.

```
 ┌──────────────── control plane (this repo) ────────────────┐        ┌──── per site ────┐
 │ React UI ── FastAPI API ── MongoDB                          │  HMAC  │ automation bridge │
 │   change sets · approvals · audit · policies · scheduling   │───────▶│ (sidecar or route)│
 └─────────────────────────────────────────────────────────────┘ signed │  typed ops only   │
                                                                        └─────────┬─────────┘
                                                                     repo / content / Docker
```

| Path | What it is |
|---|---|
| `backend/` | FastAPI control plane: sites, bridge client, change sets, deployments, backups, audit, SEO/AI tools |
| `frontend/` | React UI |
| `automation-bridge/` | The per-site agent (TypeScript): sidecar server or App Router route, plus site runtime helpers |
| `protocol/` | The contracts: `automation-bridge-v1.md` (bridge protocol), `control-plane-api.md`, signing test vectors |
| `migration/` | Log of the move off the previous platform. Internal only, not shipped |
| `scripts/legacy_reference_scan.py` | CI gate that keeps the repo free of the removed stack |

## How a change reaches a site

1. **Propose.** A person or an automation (on-page SEO, blog generation,
   autopilot, AI agent) creates a *change set*: a list of typed operations
   such as `metadata.set`, `content.upsert`, `redirect.upsert` or `file.write`.
2. **Plan.** The bridge computes the exact diff, the impacted routes and a
   risk level without writing anything.
3. **Validate and preview.** Code changes run the site's configured
   format/lint/typecheck/build/test steps in a scratch worktree.
4. **Approve.** A deployer approves that exact diff. Editing the change set
   discards the approval, and production forbids self-approval.
5. **Apply.** The bridge re-checks the diff and base revision, snapshots the
   files, writes them atomically, verifies the result and revalidates the
   impacted routes. If verification fails, it restores the snapshot.
6. **Record and roll back.** Every apply creates an immutable revision, and
   rollback is itself a new revision.

Roles are viewer < editor < deployer < admin. Viewers are read-only on every
route. Production applies, deploys, rollbacks, restores and credential
revocation require typing the site name.

## Running

```bash
cp backend/.env.example backend/.env    # MONGO_URL, DB_NAME, JWT_SECRET_KEY, ENCRYPTION_KEY
docker compose up -d                     # UI :3007, API :8002
```

`ENCRYPTION_KEY` is a Fernet key, generated with
`python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"`.
Unattended writes (scheduled autopilot runs and auto-apply policies) stay off
until `AUTOMATION_WRITES_FROZEN=0`.

To connect a site, install the bridge (`automation-bridge/README.md`), issue a
key on it, then use **Sites → Connect site** in the UI.

## Development

```bash
cd backend && python -m pytest -q tests          # needs MONGO_URL (a throwaway mongo:7 is fine)
cd frontend && yarn test --watchAll=false && yarn build
cd automation-bridge && npm test
python3 scripts/legacy_reference_scan.py check   # must pass before every commit
```
