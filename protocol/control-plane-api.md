# Control-plane API (Next.js automation platform)

All routes are under `/api`, authenticated with the app's own JWT
(`Authorization: Bearer <token>`), errors are `{"detail": "…"}` (FastAPI) or,
for bridge-originated failures, `{"detail": {"code": "…", "message": "…", "correlation_id": "…"}}`.

Roles (ascending): `viewer` < `editor` < `deployer` < `admin`.

| Role | May |
|---|---|
| viewer | read everything below |
| editor | create/edit/validate/preview/submit change sets; run audits; request backups of non-production |
| deployer | approve/reject, apply, roll back, deploy, restart, create backups, restore (with confirmation) |
| admin | everything, plus site connections, credentials, write enablement, policies, users |

Confirmation: every production apply, deployment, rollback, restore, credential
revoke and write-enable requires `"confirm": "<site name>"` in the body,
matching the site's `name` exactly (case-sensitive). Missing/wrong → `400`.

## Sites and connections

`Site` (response shape; never contains secrets):

```json
{"id": "uuid", "name": "Marketing site", "base_url": "https://example.com",
 "bridge_url": "https://example.com/api/automation-bridge/v1",
 "environment": "production|staging|development", "site_key": "marketing-site",
 "install_mode": "sidecar|in-app",
 "connection": {"status": "unverified|connected|degraded|unreachable|revoked",
                "key_id": "k_…", "credential_rotated_at": "…", "last_handshake_at": "…",
                "last_error": null, "private_network_http": false},
 "writes_enabled": false, "write_verified_at": null,
 "capabilities": { …bridge /capabilities snapshot… } | null,
 "created_at": "…", "updated_at": "…"}
```

| Method & path | Role | Body / notes |
|---|---|---|
| `GET /sites` | viewer | `Site[]` |
| `POST /sites` | admin | `{name, base_url, bridge_url, environment, site_key, install_mode, key_id, secret, allow_private_http?: bool}` → validates URL policy, stores the secret encrypted, performs the handshake; `201 Site`. Handshake failure → `201` with `connection.status="unreachable"` + `last_error` |
| `GET /sites/{id}` | viewer | `Site` |
| `PATCH /sites/{id}` | admin | `{name?, base_url?, bridge_url?, environment?}` (URL change resets `writes_enabled`) |
| `DELETE /sites/{id}` | admin | `{confirm}` in body |
| `POST /sites/{id}/handshake` | editor | refresh capabilities + health → `Site` |
| `GET /sites/{id}/health` | viewer | bridge `/health` |
| `POST /sites/{id}/verify-write` | admin | plans+applies a no-op probe revision on the bridge's overrides root and rolls it back; sets `write_verified_at` → `{ok, details}` |
| `POST /sites/{id}/writes` | admin | `{enabled: bool, confirm}`; enabling requires a successful verify-write within 24 h |
| `POST /sites/{id}/credential/rotate` | admin | → `{key_id, rotated_at}` (secret stored, never returned) |
| `POST /sites/{id}/credential/replace` | admin | `{key_id, secret}` — operator-issued key (e.g. after revocation) |
| `POST /sites/{id}/credential/revoke` | admin | `{confirm}` → revokes on the bridge, marks `revoked`, disables writes |
| `GET /sites/{id}/policy` / `PUT` | viewer / admin | `Policy` (below) |

URL policy: `base_url` must be `https://`. `bridge_url` must be `https://`,
or `http://` **only** when `allow_private_http` is true and the host is a
Docker service name / RFC1918 / loopback address. Userinfo, fragments and
non-default ports on public hosts are rejected. The resolved address of a
public `https` bridge must not be private (SSRF guard).

## Inventory and read APIs (viewer)

- `GET /sites/{id}/inventory/{kind}` — kind ∈ `routes|metadata|blocks|assets|redirects|unsupported` → bridge payload.
- `GET /sites/{id}/content/collections`
- `GET /sites/{id}/content/{collection}/items?status=&cursor=&limit=`
- `GET /sites/{id}/content/{collection}/items/{slug}`
- `GET /sites/{id}/revisions?cursor=` / `GET /sites/{id}/revisions/{rid}`
- `GET /sites/{id}/ops/status`, `GET /sites/{id}/ops/logs?service=&tail=`
- `GET /sites/{id}/bridge/audit?cursor=` (admin)

Each returns `422 {"detail": {"code": "CAPABILITY_UNSUPPORTED", "capability": "…"}}` when the site lacks the capability.

## Change sets

`ChangeSet`:

```json
{"id": "cs_…", "site_id": "…", "title": "…", "description": "…",
 "source": "manual|onpage-seo|auto-seo|autopilot|blog-generation|programmatic|redirects|ai-agent|backup-restore",
 "status": "draft|planned|plan_failed|validating|validated|validation_failed|pending_approval|approved|rejected|applying|applied|apply_failed|rolled_back|cancelled",
 "operations": [ …bridge Operation… ],
 "plan": {"valid": true, "errors": [], "warnings": [], "diff": "…", "diff_sha256": "…", "files": [], "impacted_routes": [], "risk": {"level": "low", "flags": []}, "planned_at": "…", "base_revision": "r_…|null"} | null,
 "validation": {"job_id": "…", "status": "…", "steps": [ … ]} | null,
 "preview": {"job_id": "…", "url": "…|null", "status": "…"} | null,
 "policy_checks": [{"name": "writes_enabled", "ok": true, "message": "…"}],
 "approvals": [{"user_id": "…", "user_email": "…", "decision": "approved|rejected", "comment": "…", "at": "…"}],
 "apply": {"job_id": "…", "revision_id": "r_…", "result": { …bridge apply response… }, "error": null, "applied_by": "…", "applied_at": "…"} | null,
 "rollback": {"revision_id": "r_…", "by": "…", "at": "…", "reason": "…"} | null,
 "created_by": "…", "created_at": "…", "updated_at": "…", "correlation_id": "…"}
```

| Method & path | Role | Notes |
|---|---|---|
| `POST /sites/{id}/changesets` | editor | `{title, description?, operations, source?}` → creates and plans → `201 ChangeSet` (`planned` or `plan_failed`) |
| `GET /sites/{id}/changesets?status=&cursor=` | viewer | `{items, next_cursor}` |
| `GET /changesets/{cid}` | viewer | `ChangeSet` |
| `PUT /changesets/{cid}` | editor | replace operations/title while `draft|planned|plan_failed|validation_failed|rejected` → re-plans |
| `POST /changesets/{cid}/plan` | editor | re-plan against the current revision |
| `POST /changesets/{cid}/validate` | editor | `{steps?}` → `{task_id}`; SSE via `/stream/{task_id}` |
| `POST /changesets/{cid}/preview` | editor | → `{task_id}` or 422 |
| `POST /changesets/{cid}/submit` | editor | → `pending_approval` (requires a valid plan) |
| `POST /changesets/{cid}/approve` | deployer | `{comment?}`; a user cannot approve their own change set on production |
| `POST /changesets/{cid}/reject` | deployer | `{comment}` |
| `POST /changesets/{cid}/apply` | deployer | `{confirm}` (production) → `{task_id}`; requires `approved` (or auto-apply policy match) and `writes_enabled` |
| `POST /changesets/{cid}/rollback` | deployer | `{confirm, reason}` → `{task_id}` |
| `POST /changesets/{cid}/cancel` | editor | from any non-terminal pre-apply state |

## Deployments and backups

| Method & path | Role | Notes |
|---|---|---|
| `GET /sites/{id}/deployments/profiles` | viewer | |
| `GET /sites/{id}/deployments` | viewer | local records merged with bridge status |
| `POST /sites/{id}/deployments` | deployer | `{profile, reason, confirm}` → `{deployment_id, task_id}` |
| `GET /deployments/{did}` | viewer | |
| `POST /deployments/{did}/rollback` | deployer | `{confirm, reason}` |
| `GET /sites/{id}/backups` | viewer | |
| `POST /sites/{id}/backups` | deployer | `{kind}` |
| `POST /sites/{id}/backups/{bid}/restore` | deployer | `{confirm, dry_run}`; dry run returns diff; real restore requires `confirm` = backup id **and** site name via `{confirm_site}` |

## Policy

```json
{"auto_apply": {"enabled": false, "environments": ["staging"], "sources": ["onpage-seo"],
                "ops": ["metadata.set", "metadata.clear", "image.alt.set"], "max_risk": "low"},
 "limits": {"max_changesets_per_day": 20, "max_operations_per_changeset": 50,
            "ai_daily_budget_usd": 5},
 "require_validation_for_file_ops": true, "allow_self_approval_nonprod": true}
```

Auto-apply never covers: production (unless explicitly listed), `file.*`,
`content.delete`, `redirect.*`, risk above `max_risk`, deployments, restores.

## Audit

`GET /audit?site_id=&actor=&action=&cursor=` (viewer) → control-plane audit
events: `{id, at, actor_id, actor_email, role, site_id, environment, action,
target_type, target_id, change_id, revision_id, correlation_id, outcome: ok|denied|error, detail}`.
Every mutation route writes one, including denied attempts (403) and failures.

## Streaming

Existing: `GET /stream/{task_id}` (SSE, now requires `?token=` short-lived
stream token from `POST /stream-token` — never the session JWT) and
`GET /tasks/{task_id}`.

## Retained generic APIs

Auth/users, settings, activity, reports, keyword research/tracking, SEO audit
(`/onpage/*`, now producing change sets instead of direct writes), analytics,
PageSpeed, monitoring/uptime, off-page outreach, ads, media plan, company
profile. Endpoints that wrote to the old CMS are removed or now return a
created `ChangeSet`.
