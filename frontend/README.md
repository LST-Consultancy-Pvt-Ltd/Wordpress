# Site Autopilot — frontend

The web UI for **Site Autopilot**, a Next.js automation platform. It connects to
Next.js sites through the automation bridge (`protocol/automation-bridge-v1.md`)
and talks only to the control-plane API (`protocol/control-plane-api.md`).
Nothing in the UI writes to a site directly: every edit becomes a **change set**
that is planned, validated, approved and applied — and can be rolled back.

React 19 · CRACO (Create React App) · Tailwind · shadcn-style components in
`src/components/ui` · react-router v7 · sonner toasts.

## Scripts (use yarn)

| Command | What it does |
|---|---|
| `yarn install --frozen-lockfile` | Install dependencies |
| `yarn start` | Dev server on :3000 |
| `yarn build` | Production build into `build/` (CI runs it with `CI=true`) |
| `yarn test` / `yarn test:ci` | Jest + React Testing Library (watch / single run) |
| `yarn e2e` | Playwright E2E (`npx playwright install chromium` once). Builds the app, serves `build/`, mocks the API with `page.route`. `E2E_SKIP_BUILD=1` reuses an existing build |

Configuration: `REACT_APP_BACKEND_URL` (defaults to `http://localhost:8000`); the
client calls `${REACT_APP_BACKEND_URL}/api`.

## Structure

```
src/
  lib/
    api.js           control-plane client (one export per endpoint), error helpers,
                     central 401 (logout) / 403 (toast) handling
    session.js       sa_token / sa_user; sessions stored under other key names by
                     older builds are dropped at start-up (users sign in again)
    stream.js        SSE via short-lived stream tokens (POST /stream-token → ?token=)
    roles.js         viewer < editor < deployer < admin
    capabilities.js  bridge capability flags, labels and "how to enable" help
    changesets.js    status labels/predicates, {changeset} extraction, "change set
                     created → review" toast, operation descriptions
    diff.js          unified-diff parser + side-by-side row builder (no deps)
    metadata.js      MetadataFields form mapping and validation (incl. JSON-LD)
    urlPolicy.js     client-side mirror of the connection URL policy
    markdown.jsx     safe Markdown preview (React elements, no HTML injection)
  hooks/             useRole, useSite(s), useBridgeRead (422 CAPABILITY_UNSUPPORTED
                     aware), useTaskStream (stream-token SSE with task fallback)
  components/
    RequireRole.jsx  page/inline role guard
    sa/              GatedButton (role/capability-gated, tooltip, never dead),
                     ConfirmDialog (typed confirmation + reason), ChangeSetPanel,
                     DiffView, SiteHeader (read-only vs write-enabled banner),
                     HandshakeDetails, CapabilityNotice, StatusBadge, ErrorCallout
    content/         collection/item editor, metadata editor, blocks + image alt
  pages/
    sites/           SitesList, SiteWizard, SiteDetail, SiteInventory, SiteContent,
                     SiteCode, SiteOperations, SiteBackups
    changesets/      ChangeSetList, ChangeSetDetail
    Audit.jsx        control-plane audit log
    …                retained SEO / analytics / outreach / ads screens
e2e/                 Playwright specs, mock API (mock-api.js), static server
```

## Areas (nav group "Sites & Delivery")

| Route | Purpose | Minimum role |
|---|---|---|
| `/sites` | Connected sites, connection status, read-only vs write-enabled | viewer |
| `/sites/new` | Connection wizard: install mode (sidecar / in-app, copyable snippets) → endpoint (base URL, bridge URL, environment, site key, private-network HTTP toggle) → credential (key id + masked secret, never re-shown) → handshake results (capabilities, health, writable roots, deployment identity, commit) → verify write, then enable with typed site name | admin |
| `/sites/:id` | Connection, write enablement, credential rotate / replace / revoke, health, capabilities, identity, policy | viewer (actions admin) |
| `/sites/:id/inventory` | Routes (metadata opt-in, blocks, adapter, source), content collections, metadata coverage, editable components, assets, redirects (propose `redirect.*`), unsupported items, revision & deployment | viewer |
| `/sites/:id/content` | Collections → item editor (front matter from the adapter schema, Markdown body with preview), registered blocks, per-route metadata (title, description, canonical, robots, Open Graph, JSON-LD), image alt text. Each shows its source of truth, validation errors and not-opted-in / unsupported states; saving creates a change set | viewer (save editor) |
| `/sites/:id/code` | Allow-listed file explorer (route sources + text assets; needs `files.read`), edits → `file.write` operations, side-by-side diff, affected routes, then inline review (validate, approve, apply) | viewer (propose editor + `files.patch`) |
| `/changesets`, `/changesets/:id` | Status filters; detail with operations, plan (policy checks, risk flags, impacted routes, files), unified / side-by-side diff, validation steps, preview, approval history, apply (typed site name on production), result (revision, verification, `effective:false` warnings), rollback, live progress | viewer (submit editor, approve/apply/rollback deployer) |
| `/sites/:id/operations` | Services, image/revision, deployment profiles, deploy (typed confirmation on production), history with step logs, rollback, bridge diagnostics, container logs (`ops.logs`) | viewer (deploy deployer) |
| `/sites/:id/backups` | Create backups, dry-run restore diff, restore (backup id + site name) | viewer (deployer) |
| `/audit` | Who requested / approved / applied, outcome (ok / denied / error), revision, correlation id | viewer |

Every control the current role can't use is disabled with a tooltip (or hidden
where noted); every capability-dependent feature shows an empty state explaining
how to enable the capability on the bridge (see `automation-bridge/README.md`).

## Security notes

- The session JWT is sent only in the `Authorization` header. Event streams use
  a short-lived stream token from `POST /stream-token` (`{task_id}`; the
  autopilot stream uses `autopilot:{site_id}`). A unit test fails if any file
  other than `lib/stream.js` constructs an `EventSource`.
- Credential secrets are write-only in the UI; the wizard clears the value after
  submitting and nothing displays it again.
- 401 from the control plane clears the session; bridge-originated errors
  (`{detail: {code, message, correlation_id}}`) never log the user out.

## Retained screens

Keyword research/tracking/clusters/analysis, reports and report builder, SEO
metrics (metrics, competitor analysis, PageSpeed, rankings), on-page SEO audit,
site health, broken links, duplicate content, content refresh, crawl report,
sitemap & robots (read-only; edited through the Code workspace), mobile and
indexing checks, AI content detector, programmatic SEO, auto blog generation,
autopilot, AI command, outreach / citations / off-page, ads, media plan,
company profile, portfolio, activity and settings. Their write actions now
create change sets ("Change set created → review in Change Sets").

The old SEO page's per-page plugin instructions, auto-SEO apply flows, internal
link insertion and image-alt tabs were removed: metadata, JSON-LD and canonical
editing live in the metadata editor; image alt text in the content editor.
