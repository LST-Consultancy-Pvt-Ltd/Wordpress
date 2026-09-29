/**
 * `automation-bridge.config.json` — one explicit file, validated strictly
 * (unknown keys are rejected). Secrets never live here: they come from the
 * environment (or `*_FILE` variants pointing at mounted secret files).
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const cmd = z.array(z.string().min(1).max(512)).min(1).max(64);

export const RootKind = z.enum(["content", "overrides", "code", "assets"]);

export const RootConfig = z
  .object({
    id: z.string().regex(ID),
    kind: RootKind,
    /** Absolute, or relative to the config file's directory. */
    path: z.string().min(1),
    writable: z.boolean().default(false),
    /** Globs (relative to the root) that `file.*` operations may touch. Empty = none. */
    allow: z.array(z.string().min(1)).default([]),
    /** Extra deny globs; the built-in deny list always applies as well. */
    deny: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const JsonSchemaLike: z.ZodType<Record<string, unknown>> = z.record(z.string(), z.unknown());

export const CollectionConfig = z
  .object({
    id: z.string().regex(ID),
    kind: z.enum(["mdx", "markdown", "json", "custom"]),
    /** Root id (for file-backed kinds). */
    root: z.string().regex(ID).optional(),
    /** Directory inside the root holding the published documents. "" = root itself. */
    dir: z.string().default(""),
    /** Public route of one item, e.g. "/blog/[slug]". */
    route_pattern: z.string().startsWith("/").nullable().default(null),
    /** Listing routes revalidated when any item changes, e.g. ["/blog"]. */
    index_routes: z.array(z.string().startsWith("/")).default([]),
    frontmatter_schema: JsonSchemaLike.nullable().default(null),
    title_field: z.string().default("title"),
    /** Allow MDX bodies containing import/export/{expressions} (code that runs at build/render). Default false. */
    allow_executable_mdx: z.boolean().default(false),
    /** For kind=custom: name of an adapter registered programmatically. */
    adapter: z.string().optional(),
  })
  .strict();

const StepName = z.enum(["format", "lint", "typecheck", "build", "test"]);
export type StepName = z.infer<typeof StepName>;
export const STEP_NAMES = StepName.options;

/**
 * Isolation settings shared by validation and preview jobs. Job commands run
 * repository code on proposed file contents, so by default they must run as a
 * different user than the bridge (`run_as`), which cannot read `state_dir`
 * (mode 0700). `allow_same_user: true` opts out explicitly.
 */
const sandboxShape = {
  /** uid/gid for job commands. Requires the bridge to run as root (or with CAP_SETUID/CAP_SETGID). */
  run_as: z.object({ uid: z.number().int().min(0).max(2 ** 31), gid: z.number().int().min(0).max(2 ** 31) }).strict().nullable().default(null),
  /** Accept running job commands as the bridge user, which can read the key store. Default false. */
  allow_same_user: z.boolean().default(false),
  /** How the repository's node_modules is made available: a private copy (default) or a symlink (faster; a job can modify the original). */
  node_modules: z.enum(["copy", "symlink"]).default("copy"),
  /** Parent directory for scratch trees; must not be inside state_dir or any root. Default: <os tmp>/automation-bridge-scratch. */
  scratch_dir: z.string().min(1).nullable().default(null),
};

export const ValidationConfig = z
  .object({
    ...sandboxShape,
    steps: z
      .object({
        format: cmd.optional(),
        lint: cmd.optional(),
        typecheck: cmd.optional(),
        build: cmd.optional(),
        test: cmd.optional(),
      })
      .strict(),
    timeout_s: z.number().int().min(1).max(3600).default(600),
    node_env: z.enum(["production", "development", "test"]).default("production"),
    /** Use `git worktree add` when the code root is a git checkout; otherwise copy. */
    use_git_worktree: z.boolean().default(true),
    /** Max concurrently running validation/preview jobs. */
    max_concurrent: z.number().int().min(1).max(4).default(1),
  })
  .strict();

export const PreviewConfig = z
  .object({
    /** Command run inside the scratch worktree after proposed files are written. */
    command: cmd,
    /** URL reported to the control plane once the command succeeds. */
    url: z.string().url(),
    timeout_s: z.number().int().min(1).max(3600).default(900),
    ...sandboxShape,
  })
  .strict();

export const DeployProfile = z
  .object({
    services: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/)).min(1).max(10),
    strategy: z.enum(["compose-recreate", "build-and-swap"]).default("compose-recreate"),
    health_timeout_s: z.number().int().min(5).max(1800).default(120),
    smoke_paths: z.array(z.string().startsWith("/")).max(20).default(["/"]),
  })
  .strict();

export const DockerConfig = z
  .object({
    compose_file: z.string().min(1),
    project: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
    profiles: z.record(z.string().regex(ID), DeployProfile).default({}),
    /** Services whose logs may be read (defaults to every profile service). */
    log_services: z.array(z.string()).optional(),
    docker_binary: z.string().default("docker"),
    command_timeout_s: z.number().int().min(5).max(3600).default(900),
  })
  .strict();

export const ConfigSchema = z
  .object({
    $schema: z.string().optional(),
    mode: z.enum(["sidecar", "in-app"]).default("sidecar"),
    site: z
      .object({
        site_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
        environment: z.enum(["production", "staging", "development"]),
        public_base_url: z.string().url(),
        /** URL the bridge uses to reach the site (e.g. http://site:3000 on the private network). */
        internal_url: z.string().url().nullable().default(null),
      })
      .strict(),
    state_dir: z.string().min(1),
    roots: z.array(RootConfig).min(1),
    /** Root id holding runtime override stores (metadata/blocks/images/redirects). */
    overrides_root: z.string().regex(ID).nullable().default(null),
    /** Root id of the site repository (route inventory, validation worktrees). */
    code_root: z.string().regex(ID).nullable().default(null),
    manifest: z
      .union([
        z.object({ root: z.string().regex(ID), path: z.string().default("automation.manifest.json") }).strict(),
        z.object({ inline: z.record(z.string(), z.unknown()) }).strict(),
      ])
      .nullable()
      .default(null),
    content: z
      .object({ collections: z.array(CollectionConfig).default([]) })
      .strict()
      .default({ collections: [] }),
    revalidate: z
      .object({
        mode: z.enum(["none", "in-app", "sidecar"]).default("none"),
        endpoint_path: z.string().startsWith("/").default("/api/automation-revalidate"),
        timeout_ms: z.number().int().min(100).max(60000).default(5000),
      })
      .strict()
      .default({ mode: "none", endpoint_path: "/api/automation-revalidate", timeout_ms: 5000 }),
    validation: ValidationConfig.nullable().default(null),
    preview: PreviewConfig.nullable().default(null),
    docker: DockerConfig.nullable().default(null),
    limits: z
      .object({
        max_body_bytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(1024 * 1024),
        max_file_bytes: z.number().int().min(1024).max(10 * 1024 * 1024).default(512 * 1024),
        rate_per_minute: z.number().int().min(1).max(10000).default(120),
        mutations_per_minute: z.number().int().min(1).max(1000).default(20),
        max_operations: z.number().int().min(1).max(200).default(200),
        lock_wait_ms: z.number().int().min(0).max(60000).default(10000),
      })
      .strict()
      .default({
        max_body_bytes: 1024 * 1024,
        max_file_bytes: 512 * 1024,
        rate_per_minute: 120,
        mutations_per_minute: 20,
        max_operations: 200,
        lock_wait_ms: 10000,
      }),
    retention: z
      .object({
        backups: z.number().int().min(1).max(1000).optional(),
        revision_days: z.number().int().min(1).max(3650).optional(),
        idempotency_hours: z.number().int().min(1).max(168).default(24),
      })
      .strict()
      .default({ idempotency_hours: 24 }),
    logging: z
      .object({ level: z.enum(["debug", "info", "warn", "error"]).default("info") })
      .strict()
      .default({ level: "info" }),
    server: z
      .object({
        host: z.string().default("0.0.0.0"),
        port: z.number().int().min(1).max(65535).default(8787),
      })
      .strict()
      .default({ host: "0.0.0.0", port: 8787 }),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const ids = new Set<string>();
    for (const [i, r] of cfg.roots.entries()) {
      if (ids.has(r.id)) ctx.addIssue({ code: "custom", path: ["roots", i, "id"], message: "duplicate root id" });
      ids.add(r.id);
    }
    const check = (id: string | null | undefined, p: (string | number)[]) => {
      if (id && !ids.has(id)) ctx.addIssue({ code: "custom", path: p, message: `unknown root id "${id}"` });
    };
    check(cfg.overrides_root, ["overrides_root"]);
    check(cfg.code_root, ["code_root"]);
    if (cfg.manifest && "root" in cfg.manifest) check(cfg.manifest.root, ["manifest", "root"]);
    const cids = new Set<string>();
    for (const [i, c] of cfg.content.collections.entries()) {
      if (cids.has(c.id)) ctx.addIssue({ code: "custom", path: ["content", "collections", i, "id"], message: "duplicate collection id" });
      cids.add(c.id);
      if (c.kind === "custom") {
        if (!c.adapter) ctx.addIssue({ code: "custom", path: ["content", "collections", i, "adapter"], message: "custom collections need an adapter name" });
      } else if (!c.root) {
        ctx.addIssue({ code: "custom", path: ["content", "collections", i, "root"], message: "file-backed collections need a root" });
      } else check(c.root, ["content", "collections", i, "root"]);
    }
  });

export type BridgeConfigInput = z.input<typeof ConfigSchema>;
export type BridgeConfigParsed = z.infer<typeof ConfigSchema>;
export type RootConfigT = z.infer<typeof RootConfig>;
export type CollectionConfigT = z.infer<typeof CollectionConfig>;
export type DeployProfileT = z.infer<typeof DeployProfile>;

export interface ResolvedRoot extends RootConfigT {
  /** Absolute path; never leaves the process (responses use ids). */
  abs: string;
}

export interface Secrets {
  bootstrapKeyId: string | null;
  bootstrapSecret: string | null;
  bootstrapScopes: string[];
  backupKey: Buffer | null;
  revalidateSecret: string | null;
}

export interface ResolvedConfig extends Omit<BridgeConfigParsed, "roots" | "state_dir"> {
  roots: ResolvedRoot[];
  state_dir: string;
  backupRetention: number;
  revisionRetentionDays: number;
  secrets: Secrets;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function readSecretEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const file = env[`${name}_FILE`];
  if (file) {
    try {
      return fs.readFileSync(file, "utf8").trim() || null;
    } catch {
      throw new ConfigError(`${name}_FILE is set but cannot be read`);
    }
  }
  const v = env[name];
  return v && v.trim() ? v.trim() : null;
}

/** BRIDGE_BACKUP_KEY: 32 bytes as base64url/base64 (43/44 chars) or hex (64 chars). */
export function parseBackupKey(raw: string | null): Buffer | null {
  if (!raw) return null;
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, "hex");
  else if (/^[A-Za-z0-9_\-+/]{43}=?$/.test(raw)) buf = Buffer.from(raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "base64url");
  if (!buf || buf.length !== 32) throw new ConfigError("BRIDGE_BACKUP_KEY must be 32 bytes (64 hex chars or 43 base64url chars)");
  return buf;
}

export function formatZodIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export function resolveConfig(input: unknown, opts: { baseDir: string; env?: NodeJS.ProcessEnv }): ResolvedConfig {
  const env = opts.env ?? process.env;
  const parsed = ConfigSchema.safeParse(input);
  if (!parsed.success) throw new ConfigError(`invalid bridge config: ${formatZodIssues(parsed.error)}`);
  const cfg = parsed.data;
  const abs = (p: string) => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(opts.baseDir, p));
  const roots: ResolvedRoot[] = cfg.roots.map((r) => ({ ...r, abs: abs(r.path) }));
  const stateDir = abs(env.BRIDGE_STATE_DIR || cfg.state_dir);
  for (const r of roots) {
    const rel = path.relative(r.abs, stateDir);
    if (r.writable && (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)))) {
      throw new ConfigError(`state_dir must not be inside writable root "${r.id}"`);
    }
  }
  const scopesRaw = env.BRIDGE_BOOTSTRAP_SCOPES || "read,write,deploy,admin";
  const scopes = scopesRaw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of scopes) {
    if (!["read", "write", "deploy", "admin"].includes(s)) throw new ConfigError(`BRIDGE_BOOTSTRAP_SCOPES: unknown scope "${s}"`);
  }
  const intEnv = (name: string, fallback: number, min: number, max: number) => {
    const v = env[name];
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer in ${min}..${max}`);
    return n;
  };
  return {
    ...cfg,
    roots,
    state_dir: stateDir,
    server: {
      host: env.BRIDGE_HOST || cfg.server.host,
      port: env.BRIDGE_PORT ? intEnv("BRIDGE_PORT", cfg.server.port, 1, 65535) : cfg.server.port,
    },
    backupRetention: intEnv("BRIDGE_BACKUP_RETENTION", cfg.retention.backups ?? 30, 1, 1000),
    revisionRetentionDays: intEnv("BRIDGE_REVISION_RETENTION_DAYS", cfg.retention.revision_days ?? 90, 1, 3650),
    secrets: {
      bootstrapKeyId: readSecretEnv(env, "BRIDGE_BOOTSTRAP_KEY_ID"),
      bootstrapSecret: readSecretEnv(env, "BRIDGE_BOOTSTRAP_SECRET"),
      bootstrapScopes: scopes,
      backupKey: parseBackupKey(readSecretEnv(env, "BRIDGE_BACKUP_KEY")),
      revalidateSecret: readSecretEnv(env, "BRIDGE_REVALIDATE_SECRET"),
    },
  };
}

export function loadConfigFile(file: string, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new ConfigError(`cannot read config file ${path.basename(file)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError("config file is not valid JSON");
  }
  return resolveConfig(json, { baseDir: path.dirname(path.resolve(file)), env });
}

export function rootById(cfg: ResolvedConfig, id: string | null | undefined): ResolvedRoot | undefined {
  if (!id) return undefined;
  return cfg.roots.find((r) => r.id === id);
}
