/**
 * The bridge's service container: config, stores, adapters, and the cached
 * capability self-check. Created once per process by createBridge().
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { AuditLog } from "./audit.js";
import { Authenticator } from "./auth/authenticate.js";
import { KeyStore } from "./auth/keystore.js";
import { RateLimiter } from "./auth/limits.js";
import { BackupStore } from "./backups.js";
import { rootById, type ResolvedConfig, type ResolvedRoot } from "./config.js";
import { FileContentAdapter } from "./content/file-adapter.js";
import type { ContentAdapter } from "./content/types.js";
import { DockerOps, type DockerExecutor } from "./docker.js";
import { IdempotencyStore } from "./idempotency.js";
import { scanRoutes, type RouteInventory } from "./inventory.js";
import { JobRegistry } from "./jobs.js";
import { SiteLock } from "./lock.js";
import { createLogger, Redactor, type LogSink, type Logger } from "./logger.js";
import { createRevalidator, type RevalidateFn } from "./revalidate.js";
import { RevisionStore } from "./revisions.js";
import type { CapabilityFlagsT, CapabilityName } from "./schemas.js";
import { ValidationRunner } from "./validation.js";
import { parseManifest, type Manifest } from "../shared/stores.js";

export interface BridgeOptions {
  /** Custom content adapters by name (collections with kind "custom" reference them). */
  adapters?: Record<string, ContentAdapter>;
  dockerExecutor?: DockerExecutor;
  /** Used for site checks, smoke checks and sidecar revalidation. */
  fetch?: typeof fetch;
  /** In-app mode: Next's revalidatePath. */
  revalidatePath?: (p: string) => void | Promise<void>;
  logSink?: LogSink;
  now?: () => number;
  /** Poll interval for docker health waits (tests use a small value). */
  dockerPollMs?: number;
}

export interface CapabilityState {
  flags: CapabilityFlagsT;
  reasons: Partial<Record<CapabilityName, string>>;
  checkedAt: number;
}

export class BridgeContext {
  readonly cfg: ResolvedConfig;
  readonly opts: BridgeOptions;
  readonly redactor = new Redactor();
  readonly logger: Logger;
  readonly keys: KeyStore;
  readonly auth: Authenticator;
  readonly rate = new RateLimiter();
  readonly idem: IdempotencyStore;
  readonly lock: SiteLock;
  readonly audit: AuditLog;
  readonly revisions: RevisionStore;
  readonly jobs: JobRegistry;
  readonly validation: ValidationRunner;
  readonly docker: DockerOps | null;
  readonly backups: BackupStore;
  readonly adapters = new Map<string, ContentAdapter>();
  readonly adapterErrors = new Map<string, string>();
  readonly revalidator: { enabled: boolean; reason: string | null; run: RevalidateFn };
  readonly fetchFn: typeof fetch;
  readonly now: () => number;
  private capCache: CapabilityState | null = null;
  private capPending: Promise<CapabilityState> | null = null;
  private invCache: { at: number; inv: RouteInventory } | null = null;

  constructor(cfg: ResolvedConfig, opts: BridgeOptions = {}) {
    this.cfg = cfg;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.fetchFn = opts.fetch ?? fetch;
    for (const r of cfg.roots) this.redactor.addPath(r.abs, `<root:${r.id}>`);
    this.redactor.addPath(cfg.state_dir, "<state>");
    for (const s of [cfg.secrets.bootstrapSecret, cfg.secrets.revalidateSecret]) this.redactor.addSecret(s);
    if (cfg.secrets.backupKey) this.redactor.addSecret(cfg.secrets.backupKey.toString("base64url"));
    this.logger = createLogger({ level: cfg.logging.level, redactor: this.redactor, sink: opts.logSink, base: { site_id: cfg.site.site_id } });
    this.keys = new KeyStore({
      file: path.join(cfg.state_dir, "keys.json"),
      bootstrap: { keyId: cfg.secrets.bootstrapKeyId, secret: cfg.secrets.bootstrapSecret, scopes: cfg.secrets.bootstrapScopes },
      onSecret: (s) => this.redactor.addSecret(s),
      onError: (m) => this.logger.error(m),
    });
    this.keys.init();
    this.auth = new Authenticator(this.keys, { now: this.now });
    this.idem = new IdempotencyStore(path.join(cfg.state_dir, "idempotency"), cfg.retention.idempotency_hours);
    this.lock = new SiteLock({ dir: path.join(cfg.state_dir, "locks"), waitMs: cfg.limits.lock_wait_ms });
    this.audit = new AuditLog({ dir: path.join(cfg.state_dir, "audit") });
    this.revisions = new RevisionStore(cfg.state_dir);
    this.jobs = new JobRegistry(cfg.state_dir);
    this.validation = new ValidationRunner({ cfg, jobs: this.jobs, logger: this.logger, codeRoot: this.codeRoot() });
    this.docker = cfg.docker ? new DockerOps({ cfg, executor: opts.dockerExecutor, logger: this.logger, redactor: this.redactor, fetch: this.fetchFn, pollMs: opts.dockerPollMs }) : null;
    this.backups = new BackupStore(cfg);
    this.revalidator = createRevalidator({
      mode: cfg.revalidate.mode,
      internalUrl: cfg.site.internal_url,
      endpointPath: cfg.revalidate.endpoint_path,
      secret: cfg.secrets.revalidateSecret,
      timeoutMs: cfg.revalidate.timeout_ms,
      revalidatePath: opts.revalidatePath,
      fetch: this.fetchFn,
    });
    for (const c of cfg.content.collections) {
      if (c.kind === "custom") {
        const a = opts.adapters?.[c.adapter!];
        if (a) this.adapters.set(c.id, a);
        else this.adapterErrors.set(c.id, `custom adapter "${c.adapter}" is not registered`);
      } else {
        const root = rootById(cfg, c.root)!;
        this.adapters.set(c.id, new FileContentAdapter(c, root));
      }
    }
  }

  codeRoot(): ResolvedRoot | undefined {
    return rootById(this.cfg, this.cfg.code_root);
  }

  overridesRoot(): ResolvedRoot | undefined {
    return rootById(this.cfg, this.cfg.overrides_root);
  }

  async loadManifest(): Promise<{ manifest: Manifest; errors: string[]; source: "file" | "inline" | "none" }> {
    const m = this.cfg.manifest;
    if (!m) return { manifest: { version: 1, blocks: [], metadata_routes: [] }, errors: [], source: "none" };
    if ("inline" in m) return { ...parseManifest(m.inline), source: "inline" };
    const root = rootById(this.cfg, m.root)!;
    try {
      const raw = await fsp.readFile(path.join(root.abs, ...m.path.split("/")), "utf8");
      return { ...parseManifest(JSON.parse(raw)), source: "file" };
    } catch {
      return { manifest: { version: 1, blocks: [], metadata_routes: [] }, errors: ["manifest file missing or not valid JSON"], source: "file" };
    }
  }

  async inventory(maxAgeMs = 5000): Promise<RouteInventory> {
    if (this.invCache && this.now() - this.invCache.at < maxAgeMs) return this.invCache.inv;
    const code = this.codeRoot();
    const { manifest } = await this.loadManifest();
    const inv = await scanRoutes({
      codeRoot: code?.abs ?? null,
      codeRootId: code?.id ?? null,
      manifest,
      collections: this.cfg.content.collections.map((c) => ({ id: c.id, route_pattern: c.route_pattern })),
    });
    this.invCache = { at: this.now(), inv };
    return inv;
  }

  invalidateCaches(): void {
    this.invCache = null;
  }

  private async rootOk(r: ResolvedRoot): Promise<boolean> {
    try {
      const st = await fsp.stat(r.abs);
      if (!st.isDirectory()) return false;
      if (r.writable) await fsp.access(r.abs, fsp.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Capability flags: configuration present AND self-check passes. Cached 30 s. */
  async capabilities(force = false): Promise<CapabilityState> {
    if (!force && this.capCache && this.now() - this.capCache.checkedAt < 30_000) return this.capCache;
    if (this.capPending) return this.capPending;
    this.capPending = this.computeCapabilities().finally(() => (this.capPending = null));
    this.capCache = await this.capPending;
    return this.capCache;
  }

  private async computeCapabilities(): Promise<CapabilityState> {
    const reasons: Partial<Record<CapabilityName, string>> = {};
    const code = this.codeRoot();
    const ov = this.overridesRoot();
    const ovOk = !!ov && ov.writable && (await this.rootOk(ov));
    const manifest = await this.loadManifest();
    const codeOk = !!code && (await this.rootOk(code));
    const flags: CapabilityFlagsT = {
      inventory: codeOk || (manifest.manifest.metadata_routes?.length ?? 0) > 0,
      "content.read": false,
      "content.write": false,
      "metadata.write": ovOk,
      "blocks.write": ovOk && manifest.manifest.blocks.some((b) => b.kind !== "image"),
      "images.alt.write": ovOk && manifest.manifest.blocks.some((b) => b.kind === "image"),
      "redirects.write": ovOk,
      "files.read": false,
      "files.patch": false,
      validate: false,
      preview: false,
      revalidate: this.revalidator.enabled,
      deploy: false,
      "ops.logs": false,
      backups: false,
    };
    if (!flags.inventory) reasons.inventory = code ? "code root is not readable" : "no code_root configured";
    if (!ovOk) {
      const why = !ov ? "no overrides_root configured" : !ov.writable ? "overrides root is not writable" : "overrides root is not accessible";
      reasons["metadata.write"] = why;
      reasons["redirects.write"] = why;
    }
    if (!flags["blocks.write"]) reasons["blocks.write"] = ovOk ? "no text/rich-text blocks registered in the manifest" : reasons["metadata.write"];
    if (!flags["images.alt.write"]) reasons["images.alt.write"] = ovOk ? "no image blocks registered in the manifest" : reasons["metadata.write"];
    // Content
    let anyRead = false;
    let anyWrite = false;
    for (const [id, a] of this.adapters) {
      const chk = a.check ? await a.check() : { ok: true, detail: null };
      if (!chk.ok) {
        this.adapterErrors.set(id, chk.detail ?? "self-check failed");
        continue;
      }
      this.adapterErrors.delete(id);
      if (a.descriptor.operations.includes("read")) anyRead = true;
      if (a.descriptor.operations.some((o) => o !== "read")) anyWrite = true;
    }
    flags["content.read"] = anyRead;
    flags["content.write"] = anyWrite;
    if (!anyRead) reasons["content.read"] = this.cfg.content.collections.length ? "no collection passed its self-check" : "no content collections configured";
    if (!anyWrite) reasons["content.write"] = this.cfg.content.collections.length ? "no writable collection" : "no content collections configured";
    // Files
    const fileRoots = [];
    for (const r of this.cfg.roots) {
      if ((r.kind === "code" || r.kind === "assets") && r.allow.length > 0 && (await this.rootOk(r))) fileRoots.push(r);
    }
    flags["files.read"] = fileRoots.length > 0;
    flags["files.patch"] = fileRoots.some((r) => r.writable);
    if (!flags["files.read"]) reasons["files.read"] = "no code/assets root with an allow-list";
    if (!flags["files.patch"]) reasons["files.patch"] = "no writable code/assets root with an allow-list";
    // Validation / preview
    const vchk = await this.validation.selfCheck();
    flags.validate = !vchk.validate;
    flags.preview = !vchk.preview;
    if (vchk.validate) reasons.validate = vchk.validate;
    if (vchk.preview) reasons.preview = vchk.preview;
    if (!flags.revalidate) reasons.revalidate = this.revalidator.reason ?? "not configured";
    // Docker
    if (this.docker) {
      const d = await this.docker.selfCheck().catch(() => "docker self-check failed");
      const supportedProfiles = this.docker.profiles().filter((p) => p.profile.strategy === "compose-recreate");
      flags.deploy = !d && supportedProfiles.length > 0;
      flags["ops.logs"] = !d && this.docker.logServices().length > 0;
      if (d) {
        reasons.deploy = d;
        reasons["ops.logs"] = d;
      } else if (!supportedProfiles.length) reasons.deploy = "no compose-recreate deployment profile configured";
    } else {
      reasons.deploy = "docker is not configured";
      reasons["ops.logs"] = "docker is not configured";
    }
    // Backups
    flags.backups = this.backups.rootsFor("full").length > 0 && (await this.stateWritable());
    if (!flags.backups) reasons.backups = "no writable roots to back up";
    return { flags, reasons, checkedAt: this.now() };
  }

  async stateWritable(): Promise<boolean> {
    try {
      await fsp.access(this.cfg.state_dir, fsp.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** GET a route on the site (internal URL); null when the site is not configured/reachable. */
  async siteStatus(route: string, timeoutMs = 5000): Promise<number | null> {
    const base = this.cfg.site.internal_url;
    if (!base) return null;
    try {
      const res = await this.fetchFn(new URL(route, base).toString(), { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "automation-bridge/1" } });
      await res.body?.cancel().catch(() => {});
      return res.status;
    } catch {
      return null;
    }
  }
}
