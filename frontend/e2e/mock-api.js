/**
 * Stateful in-memory control-plane mock for Playwright (page.route).
 * Mirrors protocol/control-plane-api.md closely enough to drive the UI:
 * sites, handshake, verify-write, writes, inventory, change sets (plan →
 * approve → apply → rollback), stream tokens + SSE, audit.
 */
const API = "http://api.e2e.test/api";

const DIFF = `--- a/overrides/metadata.json
+++ b/overrides/metadata.json
@@ -1,3 +1,3 @@
 {
-  "/": {"title": "Old title"}
+  "/": {"title": "New homepage title"}
 }
`;

function capabilities(overrides = {}) {
  return {
    protocol_version: "1",
    agent_version: "1.0.0",
    mode: "sidecar",
    site: { site_id: "marketing-site", environment: "production", public_base_url: "https://example.com" },
    nextjs: { version: "15.1.0", router: "app" },
    package_manager: "pnpm",
    repository: { available: true, commit: "abc1234def", branch: "main", dirty: false },
    deployment: { hostname: "web-1", container_id: "abcdef123456", image: "marketing:2026-09-28", compose_project: "marketing", service: "web", profiles: ["web"] },
    writable_roots: [
      { id: "content", kind: "content", writable: true },
      { id: "overrides", kind: "overrides", writable: true },
      { id: "code", kind: "code", writable: false },
    ],
    content_adapters: [],
    capabilities: {
      inventory: true, "content.read": true, "content.write": true, "metadata.write": true, "blocks.write": true,
      "images.alt.write": true, "redirects.write": true, "files.read": true, "files.patch": false, validate: false,
      preview: false, revalidate: true, deploy: false, "ops.logs": false, backups: true,
      ...overrides,
    },
    validation_steps: [],
    preview: { url: null, status: "unavailable" },
    limits: { max_body_bytes: 1048576 },
  };
}

function makeSite(over = {}) {
  return {
    id: "site-1",
    name: "Marketing site",
    base_url: "https://example.com",
    bridge_url: "https://example.com/api/automation-bridge/v1",
    environment: "production",
    site_key: "marketing-site",
    install_mode: "sidecar",
    connection: { status: "connected", key_id: "k_e2e", credential_rotated_at: null, last_handshake_at: "2026-09-28T09:00:00Z", last_error: null, private_network_http: false },
    writes_enabled: true,
    write_verified_at: "2026-09-28T08:00:00Z",
    capabilities: capabilities(),
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-28T00:00:00Z",
    ...over,
  };
}

function makeChangeSet(over = {}) {
  return {
    id: "cs_1",
    site_id: "site-1",
    title: "Metadata for /",
    description: "",
    source: "manual",
    status: "pending_approval",
    operations: [{ op: "metadata.set", route: "/", fields: { title: "New homepage title" } }],
    plan: {
      valid: true, errors: [], warnings: [], diff: DIFF, diff_sha256: "a".repeat(64),
      files: [{ root: "overrides", path: "metadata.json", change: "modify" }],
      impacted_routes: ["/"], risk: { level: "low", flags: [] }, planned_at: "2026-09-28T10:00:00Z", base_revision: "r_1",
    },
    validation: null,
    preview: null,
    policy_checks: [{ name: "writes_enabled", ok: true, message: "Writes are enabled" }],
    approvals: [],
    apply: null,
    rollback: null,
    created_by: "editor@example.com",
    created_at: "2026-09-28T10:00:00Z",
    updated_at: "2026-09-28T10:00:00Z",
    correlation_id: "corr-e2e-1",
    ...over,
  };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
};

/**
 * Install the mock. `opts.state` seeds data; `opts.handlers` can override
 * individual routes: `{ "POST /changesets/cs_1/apply": (ctx) => ({status, body}) }`.
 * Returns the state object (inspect `state.requests`, `state.audit`, …).
 */
async function installMockApi(page, { role = "admin", state: seed = {}, handlers = {} } = {}) {
  const state = {
    sites: [makeSite()],
    changesets: [makeChangeSet()],
    audit: [],
    requests: [],
    streamTokens: [],
    tasks: {},
    ...seed,
  };
  const user = { id: `u-${role}`, email: `${role}@example.com`, role };

  await page.addInitScript(([u]) => {
    window.localStorage.setItem("sa_token", "session-jwt-E2E-SECRET");
    window.localStorage.setItem("sa_user", JSON.stringify(u));
  }, [user]);

  const audit = (action, extra = {}) =>
    state.audit.unshift({
      id: `a${state.audit.length + 1}`, at: new Date().toISOString(), actor_id: user.id, actor_email: user.email, role,
      site_id: "site-1", environment: "production", action, target_type: "changeset", target_id: extra.change_id || null,
      change_id: null, revision_id: null, correlation_id: `corr-${state.audit.length + 1}`, outcome: "ok", detail: null, ...extra,
    });
  const findCs = (id) => state.changesets.find((c) => c.id === id);
  const site = (id) => state.sites.find((s) => s.id === id);
  const json = (body, status = 200) => ({ status, body });
  const err = (status, detail) => ({ status, body: { detail } });

  const routes = [
    ["GET", /^\/sites$/, () => json(state.sites)],
    ["POST", /^\/sites$/, ({ body }) => {
      const s = makeSite({
        id: "site-new", name: body.name, base_url: body.base_url, bridge_url: body.bridge_url, environment: body.environment,
        site_key: body.site_key, install_mode: body.install_mode, writes_enabled: false, write_verified_at: null,
      });
      if (state.handshakeFails) {
        s.connection = { ...s.connection, status: "unreachable", last_error: "AUTH_INVALID: signature mismatch" };
        s.capabilities = null;
      }
      state.sites.push(s);
      audit("site.create", { target_type: "site", target_id: s.id, site_id: s.id });
      return json(s, 201);
    }],
    ["GET", /^\/sites\/([^/]+)$/, ({ m }) => (site(m[1]) ? json(site(m[1])) : err(404, "Not found"))],
    ["POST", /^\/sites\/([^/]+)\/handshake$/, ({ m }) => {
      const s = site(m[1]);
      state.handshakeFails = false;
      s.connection = { ...s.connection, status: "connected", last_error: null, last_handshake_at: new Date().toISOString() };
      s.capabilities = s.capabilities || capabilities();
      return json(s);
    }],
    ["GET", /^\/sites\/([^/]+)\/health$/, () => json({ status: "ok", ready: true, checks: [{ name: "state_dir_writable", ok: true, detail: null }, { name: "site_reachable", ok: true, detail: "200 in 84 ms" }], current_revision: "r_1" })],
    ["POST", /^\/sites\/([^/]+)\/verify-write$/, ({ m }) => {
      site(m[1]).write_verified_at = new Date().toISOString();
      return json({ ok: true, details: "probe revision applied and rolled back" });
    }],
    ["POST", /^\/sites\/([^/]+)\/writes$/, ({ m, body }) => {
      const s = site(m[1]);
      if (body.confirm !== s.name) return err(400, { code: "CONFIRMATION_REQUIRED", message: "Type the site name to confirm" });
      s.writes_enabled = !!body.enabled;
      audit(body.enabled ? "site.writes.enable" : "site.writes.disable", { target_type: "site", target_id: s.id, site_id: s.id });
      return json(s);
    }],
    ["GET", /^\/sites\/([^/]+)\/policy$/, () => json({ auto_apply: { enabled: false }, limits: {} })],
    ["GET", /^\/sites\/([^/]+)\/inventory\/routes$/, () => json({ items: [
      { route: "/", kind: "page", router: "app", source: { root: "code", path: "app/page.tsx" }, dynamic: false, metadata: "generateMetadata-optin", blocks: ["home.hero.title"], adapter: null },
      { route: "/about", kind: "page", router: "app", source: { root: "code", path: "app/about/page.tsx" }, dynamic: false, metadata: "static", blocks: [], adapter: null },
    ], unsupported: [] })],
    ["GET", /^\/sites\/([^/]+)\/inventory\/metadata$/, () => json({ items: [{ route: "/", fields: { title: "Old title" }, updated_at: "2026-09-20T00:00:00Z", revision_id: "r_1" }] })],
    ["GET", /^\/sites\/([^/]+)\/inventory\/[a-z]+$/, () => json({ items: [] })],
    ["GET", /^\/sites\/([^/]+)\/revisions$/, () => json({ items: [], next_cursor: null })],
    ["GET", /^\/sites\/([^/]+)\/content\/collections$/, () => json({ items: [] })],
    ["GET", /^\/sites\/([^/]+)\/(ops\/status|backups|deployments)$/, () => json({ items: [] })],
    ["GET", /^\/sites\/([^/]+)\/deployments\/profiles$/, () => json([])],
    ["POST", /^\/sites\/([^/]+)\/changesets$/, ({ m, body }) => {
      const cs = makeChangeSet({ id: `cs_${state.changesets.length + 1}`, site_id: m[1], title: body.title, operations: body.operations, status: "planned", source: body.source || "manual", created_by: user.email });
      state.changesets.unshift(cs);
      audit("changeset.create", { change_id: cs.id, target_id: cs.id });
      return json(cs, 201);
    }],
    ["GET", /^\/changesets$/, ({ url }) => {
      const status = url.searchParams.get("status");
      return json({ items: state.changesets.filter((c) => !status || c.status === status), next_cursor: null });
    }],
    ["GET", /^\/changesets\/([^/]+)$/, ({ m }) => (findCs(m[1]) ? json(findCs(m[1])) : err(404, "Not found"))],
    ["POST", /^\/changesets\/([^/]+)\/plan$/, ({ m }) => {
      const cs = findCs(m[1]);
      state.conflictOnce = false;
      Object.assign(cs, { status: "planned", plan: { ...cs.plan, base_revision: "r_2", planned_at: new Date().toISOString() } });
      return json(cs);
    }],
    ["POST", /^\/changesets\/([^/]+)\/submit$/, ({ m }) => { const cs = findCs(m[1]); cs.status = "pending_approval"; audit("changeset.submit", { change_id: cs.id }); return json(cs); }],
    ["POST", /^\/changesets\/([^/]+)\/approve$/, ({ m, body }) => {
      if (role === "editor" || role === "viewer") { audit("changeset.approve", { change_id: m[1], outcome: "denied" }); return err(403, "Requires deployer"); }
      const cs = findCs(m[1]);
      cs.status = "approved";
      cs.approvals.push({ user_id: user.id, user_email: user.email, decision: "approved", comment: body.comment || "", at: new Date().toISOString() });
      audit("changeset.approve", { change_id: cs.id });
      return json(cs);
    }],
    ["POST", /^\/changesets\/([^/]+)\/reject$/, ({ m, body }) => { const cs = findCs(m[1]); cs.status = "rejected"; cs.approvals.push({ user_email: user.email, decision: "rejected", comment: body.comment, at: new Date().toISOString() }); return json(cs); }],
    ["POST", /^\/changesets\/([^/]+)\/apply$/, ({ m, body }) => {
      const cs = findCs(m[1]);
      const s = site(cs.site_id);
      if (s.environment === "production" && body.confirm !== s.name) return err(400, { code: "CONFIRMATION_REQUIRED", message: "Type the site name" });
      if (state.conflictOnce) {
        audit("changeset.apply", { change_id: cs.id, outcome: "error", detail: "CONFLICT_REVISION" });
        return err(409, { code: "CONFLICT_REVISION", message: "The site's revision moved since planning", correlation_id: "c_conflict" });
      }
      const taskId = `task-apply-${cs.id}`;
      state.tasks[taskId] = () => {
        Object.assign(cs, {
          status: "applied",
          apply: { job_id: "j1", revision_id: "r_3", result: { operations: cs.operations.map((_, i) => ({ index: i, effective: true })), verification: { hashes_ok: true, routes: [{ route: "/", status: 200 }] } }, error: null, applied_by: user.email, applied_at: new Date().toISOString() },
        });
        audit("changeset.apply", { change_id: cs.id, revision_id: "r_3" });
      };
      return json({ task_id: taskId });
    }],
    ["POST", /^\/changesets\/([^/]+)\/rollback$/, ({ m, body }) => {
      const cs = findCs(m[1]);
      if (body.confirm !== site(cs.site_id).name || !body.reason) return err(400, { code: "CONFIRMATION_REQUIRED", message: "confirm + reason required" });
      const taskId = `task-rb-${cs.id}`;
      state.tasks[taskId] = () => {
        Object.assign(cs, { status: "rolled_back", rollback: { revision_id: "r_4", by: user.email, at: new Date().toISOString(), reason: body.reason } });
        audit("changeset.rollback", { change_id: cs.id, revision_id: "r_4", detail: body.reason });
      };
      return json({ task_id: taskId });
    }],
    ["POST", /^\/stream-token$/, ({ body }) => { const t = `st_${state.streamTokens.length + 1}`; state.streamTokens.push({ token: t, ...body }); return json({ token: t, expires_in: 120 }); }],
    ["GET", /^\/tasks\/([^/]+)$/, () => json({ status: "completed" })],
    ["GET", /^\/audit$/, ({ url }) => {
      const action = url.searchParams.get("action");
      return json({ items: state.audit.filter((a) => !action || a.action === action), next_cursor: null });
    }],
    ["GET", /^\/notifications\/.*$/, () => json([])],
    ["GET", /^\/dashboard\/stats$/, () => json({ total_sites: 1, connected_sites: 1, write_enabled_sites: 1, changesets_pending_approval: 1 })],
  ];

  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const method = req.method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    let body = {};
    try { body = req.postDataJSON() || {}; } catch { body = {}; }
    state.requests.push({ method, path, body, search: url.search, auth: req.headers()["authorization"] || null });

    // SSE task stream: runs the task's side effect, then streams progress + done.
    const sse = path.match(/^\/stream\/([^/]+)$/);
    if (sse && method === "GET") {
      const token = url.searchParams.get("token");
      const valid = state.streamTokens.some((t) => t.token === token);
      if (!valid) return route.fulfill({ status: 401, headers: CORS, body: "bad stream token" });
      const run = state.tasks[sse[1]];
      if (run) run();
      const events = [{ type: "progress", data: { percent: 50, message: "Writing files" } }, { type: "done", data: { message: "Finished" } }];
      return route.fulfill({
        status: 200,
        headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
      });
    }

    const key = `${method} ${path}`;
    let result;
    if (handlers[key]) result = handlers[key]({ body, url, state });
    if (!result) {
      for (const [m, re, fn] of routes) {
        const mm = m === method && path.match(re);
        if (mm) { result = fn({ m: mm, body, url, state }); break; }
      }
    }
    if (!result) result = method === "GET" ? json({ items: [] }) : json({});
    return route.fulfill({ status: result.status, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(result.body) });
  });

  return state;
}

module.exports = { installMockApi, makeSite, makeChangeSet, capabilities, DIFF };
