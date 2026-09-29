/**
 * Endpoint table. Each entry declares method, path pattern, scope, whether it
 * is a mutation (Idempotency-Key required, mutation rate limit), and the Zod
 * schemas used both for validation and for the OpenAPI document.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import { z } from "zod";
import type { Scope } from "./auth/keystore.js";
import { rootById, STEP_NAMES, type StepName } from "./config.js";
import type { BridgeContext } from "./context.js";
import { BridgeError, validationError } from "./errors.js";
import { walkFiles } from "./fsutil.js";
import { unsupportedFeatures } from "./inventory.js";
import { applyChangeSet, executeChanges, planChangeSet, rollbackRevision } from "./engine.js";
import { combinedDiff, planFiles } from "./diff.js";
import { checkFileOpPathReal, isDenied, resolveInRoot } from "./paths.js";
import { containerId, gitInfo, nextjsInfo, packageManager } from "./repo.js";
import * as S from "./schemas.js";
import { paginate, sha256Hex } from "./util.js";
import { readStore } from "../shared/stores.js";
import { VERSION } from "../version.js";

export interface HandlerInput {
  ctx: BridgeContext;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  keyId: string;
  scopes: Scope[];
  signal?: AbortSignal;
}

export type HandlerResult =
  | { status?: number; body: unknown; audit?: { op?: string; change_id?: string; revision_id?: string } }
  | { stream: AsyncIterable<string> };

export interface RouteDef {
  method: "GET" | "POST";
  path: string; // e.g. "/content/{collection}/items/{slug}"
  scope: Scope;
  mutating: boolean;
  sensitive?: boolean;
  summary: string;
  request?: z.ZodTypeAny;
  response?: z.ZodTypeAny;
  successStatus?: number;
  query?: Record<string, string>;
  handler: (i: HandlerInput) => Promise<HandlerResult>;
}

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw validationError(r.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message })));
  return r.data;
}

function listQuery(q: URLSearchParams): { limit: number; cursor: string | undefined } {
  const r = S.ListQuery.safeParse({ limit: q.get("limit") ?? undefined, cursor: q.get("cursor") ?? undefined });
  if (!r.success) throw validationError(r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return { limit: r.data.limit, cursor: r.data.cursor };
}

async function requireCap(ctx: BridgeContext, cap: S.CapabilityName): Promise<void> {
  const c = await ctx.capabilities();
  if (!c.flags[cap]) throw new BridgeError("CAPABILITY_UNSUPPORTED", `capability ${cap} is not available: ${c.reasons[cap] ?? "unsupported"}`, { capability: cap });
}

function seg(v: string | undefined, re: RegExp, what: string): string {
  if (!v || !re.test(v)) throw validationError([{ path: what, message: `must match ${re.source}` }]);
  return v;
}

async function capabilitiesBody(ctx: BridgeContext): Promise<z.infer<typeof S.CapabilitiesResponse>> {
  const caps = await ctx.capabilities();
  const code = ctx.codeRoot();
  const git = await gitInfo(code?.abs ?? null);
  const inv = caps.flags.inventory ? await ctx.inventory() : null;
  const profiles = Object.keys(ctx.cfg.docker?.profiles ?? {});
  return {
    protocol_version: "1",
    agent_version: VERSION,
    mode: ctx.cfg.mode,
    site: { site_id: ctx.cfg.site.site_id, environment: ctx.cfg.site.environment, public_base_url: ctx.cfg.site.public_base_url },
    nextjs: { version: await nextjsInfo(code?.abs ?? null), router: inv?.router ?? "unknown" },
    package_manager: packageManager(code?.abs ?? null),
    repository: { available: git.available, commit: git.commit, branch: git.branch, dirty: git.dirty },
    deployment: {
      hostname: os.hostname(),
      container_id: containerId(),
      image: process.env.BRIDGE_IMAGE ?? null,
      compose_project: ctx.cfg.docker?.project ?? null,
      service: process.env.BRIDGE_SERVICE ?? null,
      profiles,
    },
    writable_roots: ctx.cfg.roots.map((r) => ({ id: r.id, kind: r.kind, writable: r.writable })),
    content_adapters: [...ctx.adapters.entries()].filter(([id]) => !ctx.adapterErrors.has(id)).map(([, a]) => a.descriptor),
    capabilities: caps.flags,
    validation_steps: caps.flags.validate ? ctx.validation.configuredSteps() : [],
    preview: { url: ctx.cfg.preview?.url ?? null, status: caps.flags.preview ? "available" : "unavailable" },
    limits: { max_body_bytes: ctx.cfg.limits.max_body_bytes, max_file_bytes: ctx.cfg.limits.max_file_bytes, rate_per_minute: ctx.cfg.limits.rate_per_minute },
    unsupported: caps.reasons as Record<string, string>,
  };
}

async function healthBody(ctx: BridgeContext): Promise<z.infer<typeof S.HealthResponse>> {
  const checks: { name: string; ok: boolean; detail: string | null }[] = [];
  const stateOk = await ctx.stateWritable();
  checks.push({ name: "state_dir_writable", ok: stateOk, detail: null });
  for (const r of ctx.cfg.roots) {
    let ok = true;
    try {
      await fsp.access(r.abs, r.writable ? fsp.constants.W_OK : fsp.constants.R_OK);
    } catch {
      ok = false;
    }
    checks.push({ name: `root:${r.id}`, ok, detail: ok ? null : "not accessible" });
  }
  try {
    const st = await fsp.statfs(ctx.cfg.state_dir);
    const free = st.bavail * st.bsize;
    checks.push({ name: "disk_free", ok: free > 512 * 1024 * 1024, detail: `${(free / 1024 ** 3).toFixed(1)} GiB` });
  } catch {
    checks.push({ name: "disk_free", ok: false, detail: "unknown" });
  }
  if (ctx.cfg.site.internal_url) {
    const t = Date.now();
    const s = await ctx.siteStatus("/", 5000);
    checks.push({ name: "site_reachable", ok: s !== null && s < 500, detail: s === null ? "no response" : `${s} in ${Date.now() - t} ms` });
  }
  for (const [id, err] of ctx.adapterErrors) checks.push({ name: `collection:${id}`, ok: false, detail: err });
  const status = !stateOk ? "down" : checks.every((c) => c.ok) ? "ok" : "degraded";
  return { status, ready: status !== "down", checks, current_revision: await ctx.revisions.current(), time: new Date().toISOString() };
}

export const ROUTES: RouteDef[] = [
  {
    method: "GET",
    path: "/health",
    scope: "read",
    mutating: false,
    summary: "Readiness and self-checks",
    response: S.HealthResponse,
    handler: async ({ ctx }) => ({ body: await healthBody(ctx) }),
  },
  {
    method: "GET",
    path: "/capabilities",
    scope: "read",
    mutating: false,
    summary: "Capability flags and site facts",
    response: S.CapabilitiesResponse,
    handler: async ({ ctx }) => ({ body: await capabilitiesBody(ctx) }),
  },
  // ---- auth ---------------------------------------------------------------
  {
    method: "POST",
    path: "/auth/rotate",
    scope: "admin",
    mutating: true,
    sensitive: true,
    summary: "Issue a new credential; the calling key expires after the grace period",
    request: S.RotateRequest,
    response: S.RotateResponse,
    handler: async ({ ctx, body, keyId }) => {
      const b = parse(S.RotateRequest, body);
      const k = await ctx.keys.rotate(keyId, b.grace_seconds);
      return { body: { key_id: k.key_id, secret: k.secret, scopes: k.scopes, created_at: k.created_at } };
    },
  },
  {
    method: "POST",
    path: "/auth/revoke",
    scope: "admin",
    mutating: true,
    summary: "Revoke a credential",
    request: S.RevokeRequest,
    response: z.object({ revoked: z.literal(true) }),
    handler: async ({ ctx, body }) => {
      const b = parse(S.RevokeRequest, body);
      const r = await ctx.keys.revoke(b.key_id, { confirmLast: b.confirm === "REVOKE-LAST-KEY" });
      if (r === "not_found") throw new BridgeError("NOT_FOUND", "key not found or already revoked");
      if (r === "last_admin") throw new BridgeError("OPERATION_NOT_ALLOWED", 'revoking the last admin key requires {"confirm": "REVOKE-LAST-KEY"}');
      return { body: { revoked: true } };
    },
  },
  {
    method: "GET",
    path: "/auth/keys",
    scope: "admin",
    mutating: false,
    summary: "List credentials (never secrets)",
    response: z.object({ items: z.array(S.KeyInfo) }),
    handler: async ({ ctx }) => ({ body: { items: ctx.keys.list() } }),
  },
  // ---- inventory ------------------------------------------------------------
  {
    method: "GET",
    path: "/inventory/routes",
    scope: "read",
    mutating: false,
    summary: "Route inventory",
    response: S.InventoryRoutesResponse,
    handler: async ({ ctx }) => {
      await requireCap(ctx, "inventory");
      const inv = await ctx.inventory(0);
      return { body: { items: inv.items, unsupported: inv.unsupported } };
    },
  },
  {
    method: "GET",
    path: "/inventory/metadata",
    scope: "read",
    mutating: false,
    summary: "Runtime metadata overrides",
    response: S.InventoryMetadataResponse,
    handler: async ({ ctx }) => {
      const ov = ctx.overridesRoot();
      if (!ov) return { body: { items: [] } };
      const store = await readStore(ov.abs, "metadata");
      const revs = await ctx.revisions.byChangeId();
      const items = Object.entries(store.routes)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([route, v]) => {
          const r = revs.get(v.change_id);
          return { route, fields: v.fields, updated_at: r?.created_at ?? null, revision_id: r?.revision_id ?? null };
        });
      return { body: { items } };
    },
  },
  {
    method: "GET",
    path: "/inventory/blocks",
    scope: "read",
    mutating: false,
    summary: "Registered blocks merged with current values",
    response: S.InventoryBlocksResponse,
    handler: async ({ ctx }) => {
      const { manifest } = await ctx.loadManifest();
      const ov = ctx.overridesRoot();
      const blocks = ov ? await readStore(ov.abs, "blocks") : { blocks: {} as Record<string, { value: string }> };
      const images = ov ? await readStore(ov.abs, "images") : { images: {} as Record<string, { alt: string }> };
      const items = manifest.blocks.map((b) => {
        const out: z.infer<typeof S.InventoryBlock> = { id: b.id, route: b.route, kind: b.kind };
        if (b.kind === "image") {
          if (b.src) out.src = b.src;
          const alt = images.images[b.id]?.alt ?? b.alt;
          if (b.alt !== undefined) out.default = b.alt;
          if (alt !== undefined) out.alt = alt;
        } else {
          if (b.default !== undefined) out.default = b.default;
          const v = blocks.blocks[b.id]?.value;
          if (v !== undefined) out.value = v;
        }
        return out;
      });
      return { body: { items } };
    },
  },
  {
    method: "GET",
    path: "/inventory/assets",
    scope: "read",
    mutating: false,
    summary: "Asset files (paginated)",
    query: { limit: "1..200", cursor: "opaque" },
    response: S.Paginated(S.InventoryAsset),
    handler: async ({ ctx, query }) => {
      const { limit, cursor } = listQuery(query);
      const all: { root: string; path: string }[] = [];
      for (const r of ctx.cfg.roots.filter((x) => x.kind === "assets")) {
        const files = await walkFiles(r.abs, (rel, isDir) => (isDir ? isDenied(r, rel) || isDenied(r, rel + "/x") : isDenied(r, rel)), 50_000);
        for (const f of files) all.push({ root: r.id, path: f });
      }
      const page = paginate(all, cursor, limit);
      const items = [];
      for (const it of page.items) {
        const root = rootById(ctx.cfg, it.root)!;
        try {
          const buf = await fsp.readFile(await resolveInRoot(root, it.path));
          items.push({ root: it.root, path: it.path, bytes: buf.length, sha256: sha256Hex(buf) });
        } catch {
          /* vanished or unsafe path: skip */
        }
      }
      return { body: { items, next_cursor: page.next_cursor } };
    },
  },
  {
    method: "GET",
    path: "/inventory/redirects",
    scope: "read",
    mutating: false,
    summary: "Runtime redirects",
    response: S.InventoryRedirectsResponse,
    handler: async ({ ctx }) => {
      const ov = ctx.overridesRoot();
      const store = ov ? await readStore(ov.abs, "redirects") : { redirects: [] };
      return { body: { items: store.redirects.map((r) => ({ source: r.source, destination: r.destination, permanent: r.permanent })) } };
    },
  },
  {
    method: "GET",
    path: "/inventory/unsupported",
    scope: "read",
    mutating: false,
    summary: "Features the bridge cannot manage",
    response: S.InventoryUnsupportedResponse,
    handler: async ({ ctx }) => {
      const caps = await ctx.capabilities();
      const items = caps.flags.inventory ? unsupportedFeatures(await ctx.inventory(0)) : [];
      for (const [id, err] of ctx.adapterErrors) items.push({ feature: `collection ${id}`, reason: err });
      return { body: { items } };
    },
  },
  // ---- content ---------------------------------------------------------------
  {
    method: "GET",
    path: "/content/collections",
    scope: "read",
    mutating: false,
    summary: "Content collections",
    response: z.object({ items: z.array(S.ContentAdapterDescriptor) }),
    handler: async ({ ctx }) => {
      await ctx.capabilities();
      return { body: { items: [...ctx.adapters.entries()].filter(([id]) => !ctx.adapterErrors.has(id)).map(([, a]) => a.descriptor) } };
    },
  },
  {
    method: "GET",
    path: "/content/{collection}/items",
    scope: "read",
    mutating: false,
    summary: "Items of a collection (paginated)",
    query: { status: "draft|published|all", limit: "1..200", cursor: "opaque" },
    response: S.Paginated(S.ContentItemSummary),
    handler: async ({ ctx, params, query }) => {
      await requireCap(ctx, "content.read");
      const id = seg(params.collection, S.COLLECTION_RE, "collection");
      const a = ctx.adapters.get(id);
      if (!a || ctx.adapterErrors.has(id)) throw new BridgeError("NOT_FOUND", "collection not found");
      const status = query.get("status") ?? "all";
      if (!["draft", "published", "all"].includes(status)) throw validationError([{ path: "status", message: "must be draft|published|all" }]);
      const { limit, cursor } = listQuery(query);
      const all = await a.list(status as "draft" | "published" | "all");
      return { body: paginate(all, cursor, limit) };
    },
  },
  {
    method: "GET",
    path: "/content/{collection}/items/{slug}",
    scope: "read",
    mutating: false,
    summary: "One content item",
    response: S.ContentItem,
    handler: async ({ ctx, params }) => {
      await requireCap(ctx, "content.read");
      const id = seg(params.collection, S.COLLECTION_RE, "collection");
      const slug = seg(params.slug, S.SLUG_RE, "slug");
      const a = ctx.adapters.get(id);
      if (!a || ctx.adapterErrors.has(id)) throw new BridgeError("NOT_FOUND", "collection not found");
      const item = await a.get(slug);
      if (!item) throw new BridgeError("NOT_FOUND", "item not found");
      return { body: item };
    },
  },
  // ---- files -------------------------------------------------------------------
  {
    method: "GET",
    path: "/files/{root}",
    scope: "read",
    mutating: false,
    summary: "Read one allow-listed text file (?path=)",
    query: { path: "relative path inside the root" },
    response: S.FileReadResponse,
    handler: async ({ ctx, params, query }) => {
      await requireCap(ctx, "files.read");
      const root = rootById(ctx.cfg, seg(params.root, S.ROOT_ID_RE, "root"));
      if (!root || (root.kind !== "code" && root.kind !== "assets")) throw new BridgeError("NOT_FOUND", "root not found");
      const rel = await checkFileOpPathReal(root, query.get("path") ?? "");
      const abs = await resolveInRoot(root, rel);
      let buf: Buffer;
      try {
        const st = await fsp.stat(abs);
        if (!st.isFile()) throw new Error();
        if (st.size > ctx.cfg.limits.max_file_bytes) throw new BridgeError("OPERATION_NOT_ALLOWED", "file is larger than max_file_bytes");
        buf = await fsp.readFile(abs);
      } catch (e) {
        if (e instanceof BridgeError) throw e;
        throw new BridgeError("NOT_FOUND", "file not found");
      }
      const text = buf.toString("utf8");
      if (buf.includes(0) || !Buffer.from(text, "utf8").equals(buf)) throw new BridgeError("OPERATION_NOT_ALLOWED", "binary files cannot be read through this endpoint");
      return { body: { root: root.id, path: rel, content: text, sha256: sha256Hex(buf), bytes: buf.length } };
    },
  },
  // ---- change sets --------------------------------------------------------------
  {
    method: "POST",
    path: "/changesets/plan",
    scope: "read",
    mutating: false,
    summary: "Plan a change set (no side effects)",
    request: S.PlanRequest,
    response: S.PlanResponse,
    handler: async ({ ctx, body }) => {
      const req = parse(S.PlanRequest, body);
      const p = await planChangeSet(ctx, req);
      return { body: p.response, audit: { op: opsOf(req.operations), change_id: req.change_id } };
    },
  },
  {
    method: "POST",
    path: "/changesets/apply",
    scope: "write",
    mutating: true,
    summary: "Apply a planned change set",
    request: S.ApplyRequest,
    response: S.ApplyResponse,
    handler: async ({ ctx, body, keyId }) => {
      const req = parse(S.ApplyRequest, body);
      const r = await applyChangeSet(ctx, req, keyId);
      return { body: r, audit: { op: opsOf(req.operations), change_id: req.change_id, revision_id: r.revision_id } };
    },
  },
  // ---- revisions -----------------------------------------------------------------
  {
    method: "GET",
    path: "/revisions",
    scope: "read",
    mutating: false,
    summary: "Revisions, newest first (paginated)",
    query: { limit: "1..200", cursor: "opaque" },
    response: S.Paginated(S.RevisionSummary),
    handler: async ({ ctx, query }) => {
      const { limit, cursor } = listQuery(query);
      const all = (await ctx.revisions.list()).map(({ error: _e, ...r }) => r);
      return { body: paginate(all, cursor, limit) };
    },
  },
  {
    method: "GET",
    path: "/revisions/{id}",
    scope: "read",
    mutating: false,
    summary: "Full revision record including diff",
    response: S.RevisionRecord,
    handler: async ({ ctx, params }) => {
      const id = seg(params.id, S.REVISION_RE, "id");
      const r = await ctx.revisions.get(id);
      if (!r) throw new BridgeError("NOT_FOUND", "revision not found");
      return { body: { ...r, files: r.file_changes.length } };
    },
  },
  {
    method: "POST",
    path: "/revisions/{id}/rollback",
    scope: "write",
    mutating: true,
    summary: "Restore a revision's before-state as a new revision",
    request: S.RollbackRequest,
    handler: async ({ ctx, params, body, keyId, scopes }) => {
      const id = seg(params.id, S.REVISION_RE, "id");
      const b = parse(S.RollbackRequest, body);
      if (b.force && !scopes.includes("deploy")) throw new BridgeError("AUTH_SCOPE", "force requires the deploy scope");
      const r = await rollbackRevision(ctx, id, { reason: b.reason, force: b.force, keyId });
      return { body: r, audit: { op: "rollback", revision_id: r.revision_id } };
    },
  },
  // ---- validation / preview / jobs ------------------------------------------------------
  {
    method: "POST",
    path: "/validations",
    scope: "write",
    mutating: false,
    summary: "Validate proposed operations in a scratch worktree",
    request: S.ValidationRequest,
    response: S.JobAccepted,
    successStatus: 202,
    handler: async ({ ctx, body }) => {
      await requireCap(ctx, "validate");
      const req = parse(S.ValidationRequest, body);
      const configured = ctx.validation.configuredSteps();
      const steps = (req.steps ?? configured) as string[];
      for (const s of steps) {
        if (!(STEP_NAMES as readonly string[]).includes(s) || !configured.includes(s as StepName)) {
          throw new BridgeError("OPERATION_NOT_ALLOWED", `step "${String(s).slice(0, 40)}" is not configured`);
        }
      }
      const ordered = configured.filter((s) => steps.includes(s));
      const plan = await planChangeSet(ctx, { change_id: "validation", operations: req.operations, base_revision: null });
      if (!plan.response.valid) throw new BridgeError("VALIDATION_FAILED", "operations do not plan cleanly", { errors: plan.response.errors });
      const job = ctx.jobs.create("validation", ordered);
      ctx.validation.startValidation(job.job_id, plan.changes, ordered);
      return { status: 202, body: { job_id: job.job_id } };
    },
  },
  {
    method: "POST",
    path: "/previews",
    scope: "write",
    mutating: false,
    summary: "Build a preview of proposed operations",
    request: S.PreviewRequest,
    response: S.JobAccepted,
    successStatus: 202,
    handler: async ({ ctx, body }) => {
      await requireCap(ctx, "preview");
      const req = parse(S.PreviewRequest, body);
      const plan = await planChangeSet(ctx, { change_id: "preview", operations: req.operations, base_revision: null });
      if (!plan.response.valid) throw new BridgeError("VALIDATION_FAILED", "operations do not plan cleanly", { errors: plan.response.errors });
      const job = ctx.jobs.create("preview", ["preview"]);
      ctx.validation.startPreview(job.job_id, plan.changes);
      return { status: 202, body: { job_id: job.job_id } };
    },
  },
  {
    method: "GET",
    path: "/jobs/{id}",
    scope: "read",
    mutating: false,
    summary: "Job status",
    response: S.Job,
    handler: async ({ ctx, params }) => {
      const j = await ctx.jobs.get(seg(params.id, /^j_[a-z0-9]+$/, "id"));
      if (!j) throw new BridgeError("NOT_FOUND", "job not found");
      return { body: j };
    },
  },
  {
    method: "GET",
    path: "/jobs/{id}/events",
    scope: "read",
    mutating: false,
    summary: "Server-Sent Events: event log|step|status",
    handler: async ({ ctx, params, signal }) => {
      const id = seg(params.id, /^j_[a-z0-9]+$/, "id");
      if (!(await ctx.jobs.get(id))) throw new BridgeError("NOT_FOUND", "job not found");
      return { stream: ctx.jobs.stream(id, signal) };
    },
  },
  // ---- ops / deployments ---------------------------------------------------------------
  {
    method: "GET",
    path: "/ops/status",
    scope: "read",
    mutating: false,
    summary: "Container status of configured services",
    response: S.OpsStatusResponse,
    handler: async ({ ctx }) => {
      if (!ctx.docker) throw new BridgeError("CAPABILITY_UNSUPPORTED", "docker is not configured", { capability: "deploy" });
      return { body: { items: await ctx.docker.status() } };
    },
  },
  {
    method: "GET",
    path: "/ops/logs",
    scope: "read",
    mutating: false,
    summary: "Recent logs of one configured service",
    query: { service: "configured service", tail: "1..2000" },
    response: S.OpsLogsResponse,
    handler: async ({ ctx, query }) => {
      await requireCap(ctx, "ops.logs");
      const service = query.get("service") ?? "";
      const tail = Number(query.get("tail") ?? "200");
      if (!Number.isInteger(tail) || tail < 1 || tail > 2000) throw validationError([{ path: "tail", message: "must be 1..2000" }]);
      return { body: { lines: await ctx.docker!.logs(service, tail) } };
    },
  },
  {
    method: "GET",
    path: "/deployments/profiles",
    scope: "read",
    mutating: false,
    summary: "Configured deployment profiles",
    response: z.array(S.DeploymentProfileInfo),
    handler: async ({ ctx }) => ({
      body: (ctx.docker?.profiles() ?? []).map(({ name, profile }) => ({
        name,
        strategy: profile.strategy,
        services: profile.services,
        smoke_paths: profile.smoke_paths,
        supported: profile.strategy === "compose-recreate",
        unsupported_reason: profile.strategy === "compose-recreate" ? null : "build-and-swap is not implemented by this bridge version",
      })),
    }),
  },
  {
    method: "POST",
    path: "/deployments",
    scope: "deploy",
    mutating: true,
    summary: "Start a deployment of a configured profile",
    request: S.DeploymentRequest,
    response: S.DeploymentAccepted,
    successStatus: 202,
    handler: async ({ ctx, body }) => {
      await requireCap(ctx, "deploy");
      const b = parse(S.DeploymentRequest, body);
      const r = await startDeployment(ctx, b.profile, b.reason, null);
      return { status: 202, body: r, audit: { op: `deploy:${b.profile}` } };
    },
  },
  {
    method: "GET",
    path: "/deployments",
    scope: "read",
    mutating: false,
    summary: "Deployments, newest first (paginated)",
    query: { limit: "1..200", cursor: "opaque" },
    response: S.Paginated(S.Deployment),
    handler: async ({ ctx, query }) => {
      const { limit, cursor } = listQuery(query);
      return { body: paginate(ctx.docker ? await ctx.docker.list() : [], cursor, limit) };
    },
  },
  {
    method: "GET",
    path: "/deployments/{id}",
    scope: "read",
    mutating: false,
    summary: "One deployment",
    response: S.Deployment,
    handler: async ({ ctx, params }) => {
      const d = ctx.docker ? await ctx.docker.get(seg(params.id, /^d_[a-z0-9]+$/, "id")) : null;
      if (!d) throw new BridgeError("NOT_FOUND", "deployment not found");
      return { body: d };
    },
  },
  {
    method: "POST",
    path: "/deployments/{id}/rollback",
    scope: "deploy",
    mutating: true,
    summary: "Redeploy the images recorded before a deployment",
    request: S.DeploymentRollbackRequest,
    response: S.DeploymentAccepted,
    successStatus: 202,
    handler: async ({ ctx, params, body }) => {
      await requireCap(ctx, "deploy");
      const b = parse(S.DeploymentRollbackRequest, body);
      const d = await ctx.docker!.get(seg(params.id, /^d_[a-z0-9]+$/, "id"));
      if (!d) throw new BridgeError("NOT_FOUND", "deployment not found");
      if (d.status === "running") throw new BridgeError("LOCKED", "deployment is still running");
      const targets = ctx.docker!.rollbackTargets(d);
      if (!targets) throw new BridgeError("OPERATION_NOT_ALLOWED", "no recorded previous image for this deployment");
      const r = await startDeployment(ctx, d.profile, b.reason || `rollback of ${d.deployment_id}`, targets);
      return { status: 202, body: r, audit: { op: `deploy-rollback:${d.profile}` } };
    },
  },
  // ---- backups ---------------------------------------------------------------------------
  {
    method: "GET",
    path: "/backups",
    scope: "read",
    mutating: false,
    summary: "Backups, newest first",
    response: z.object({ items: z.array(S.Backup) }),
    handler: async ({ ctx }) => ({ body: { items: (await ctx.backups.list()).map(({ roots: _r, ...b }) => b) } }),
  },
  {
    method: "POST",
    path: "/backups",
    scope: "write",
    mutating: true,
    summary: "Create a backup",
    request: S.BackupRequest,
    response: S.Backup,
    successStatus: 201,
    handler: async ({ ctx, body }) => {
      await requireCap(ctx, "backups");
      const b = parse(S.BackupRequest, body);
      const meta = await ctx.lock.withLock("site", async () => ctx.backups.create(b.kind, await ctx.revisions.current()));
      const { roots: _r, ...out } = meta;
      return { status: 201, body: out, audit: { op: `backup:${b.kind}` } };
    },
  },
  {
    method: "POST",
    path: "/backups/{id}/restore",
    scope: "deploy",
    mutating: true,
    summary: "Restore a backup (dry run returns the diff)",
    request: S.RestoreRequest,
    handler: async ({ ctx, params, body, keyId }) => {
      await requireCap(ctx, "backups");
      const id = seg(params.id, /^b_[a-z0-9]+$/, "id");
      const b = parse(S.RestoreRequest, body);
      if (b.confirm !== id) throw validationError([{ path: "confirm", message: "must equal the backup id" }]);
      if (b.dry_run) {
        const { changes } = await ctx.backups.restoreChanges(id);
        return { body: { dry_run: true, backup_id: id, diff: combinedDiff(changes), files: planFiles(changes) } };
      }
      const r = await ctx.lock.withLock("site", async () => {
        const { changes } = await ctx.backups.restoreChanges(id);
        const diff = combinedDiff(changes);
        const ex = await executeChanges(ctx, { kind: "restore", changeId: `restore-${id}`, changes, operations: [], impactedRoutes: [], diff, keyId, reason: null, reverts: null });
        return { ex, files: planFiles(changes), diff };
      });
      const site = await ctx.siteStatus("/", 10_000);
      return {
        body: { dry_run: false, backup_id: id, revision_id: r.ex.revisionId, files: r.files, diff: r.diff, health: { site_status: site } },
        audit: { op: "backup-restore", revision_id: r.ex.revisionId },
      };
    },
  },
  // ---- audit -----------------------------------------------------------------------------
  {
    method: "GET",
    path: "/audit",
    scope: "admin",
    mutating: false,
    summary: "Bridge audit log, newest first",
    query: { limit: "1..200", cursor: "opaque" },
    response: S.Paginated(S.AuditEntry),
    handler: async ({ ctx, query }) => {
      const { limit, cursor } = listQuery(query);
      return { body: await ctx.audit.list(cursor, limit) };
    },
  },
];

function opsOf(ops: { op: string }[]): string {
  return [...new Set(ops.map((o) => o.op))].join(",");
}

async function startDeployment(ctx: BridgeContext, profile: string, reason: string, rollbackImages: Record<string, string> | null) {
  const docker = ctx.docker!;
  let started!: (v: { deployment_id: string; job_id: string }) => void;
  const startedP = new Promise<{ deployment_id: string; job_id: string }>((r) => (started = r));
  const run = ctx.lock.withLock(
    "deploy",
    async () => {
      const d = await docker.begin(profile, reason, rollbackImages ? "rollback" : "deploy");
      const job = ctx.jobs.create("deployment", ["deploy"]);
      started({ deployment_id: d.deployment_id, job_id: job.job_id });
      await docker.execute(d, ctx.jobs, job.job_id, rollbackImages ?? undefined);
    },
    1000,
  );
  run.catch((e) => {
    if (!(e instanceof BridgeError)) ctx.logger.error("deployment crashed", { err: e });
  });
  return Promise.race([startedP, run.then(() => startedP)]);
}

export interface MatchedRoute {
  def: RouteDef;
  params: Record<string, string>;
}

export function matchRoute(method: string, rel: string): MatchedRoute | null | "method" {
  const segs = rel.split("/").slice(1);
  let pathMatched = false;
  for (const def of ROUTES) {
    const ps = def.path.split("/").slice(1);
    if (ps.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!;
      const s = segs[i]!;
      if (p.startsWith("{")) {
        let d: string;
        try {
          d = decodeURIComponent(s);
        } catch {
          ok = false;
          break;
        }
        if (!d || d.includes("/") || d === "." || d === "..") {
          ok = false;
          break;
        }
        params[p.slice(1, -1)] = d;
      } else if (p !== s) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    pathMatched = true;
    if (def.method === method) return { def, params };
  }
  return pathMatched ? "method" : null;
}
