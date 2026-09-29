/**
 * Zod schemas for every request and response body (protocol v1). The same
 * schemas generate the OpenAPI document (see openapi.ts).
 */
import { z } from "zod";
import { checkRoute } from "./route.js";
import { ERROR_CODES } from "./errors.js";

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const COLLECTION_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const PROFILE_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const ROOT_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const BLOCK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const REVISION_RE = /^r_[a-z0-9]{1,64}$/;
export const CHANGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export const Slug = z.string().max(120).regex(SLUG_RE, "slug must be lowercase words joined by '-'");
export const CollectionId = z.string().regex(COLLECTION_RE);
export const Sha256 = z.string().regex(SHA256_RE, "must be a lowercase hex sha256");

export const Route = z
  .string()
  .superRefine((v, ctx) => {
    const c = checkRoute(v);
    if (!c.ok) ctx.addIssue({ code: "custom", message: c.message });
  })
  .transform((v) => {
    const c = checkRoute(v);
    return c.ok ? c.route : v;
  });

const httpsUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "must be an absolute https URL");

const httpUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "must be an absolute http(s) URL");

const pathRef = z
  .string()
  .max(2048)
  .refine((v) => v.startsWith("/") && !v.startsWith("//") && !v.includes("\\") && !/[\s<>"]/.test(v), "must be a path starting with '/'");

export const JsonLdItem = z
  .record(z.string(), z.unknown())
  .refine((o) => typeof o["@type"] === "string" || Array.isArray(o["@type"]), 'each JSON-LD object needs "@type"');

export const MetadataFields = z
  .object({
    title: z.string().max(300).optional(),
    description: z.string().max(1000).optional(),
    canonical: z.union([httpsUrl, pathRef]).optional(),
    robots: z.object({ index: z.boolean(), follow: z.boolean() }).strict().optional(),
    openGraph: z
      .object({
        title: z.string().max(300).optional(),
        description: z.string().max(1000).optional(),
        image: z.union([httpUrl, pathRef]).optional(),
      })
      .strict()
      .optional(),
    jsonLd: z
      .array(JsonLdItem)
      .max(20)
      .refine((a) => Buffer.byteLength(JSON.stringify(a), "utf8") <= 32 * 1024, "jsonLd must be ≤ 32 KiB serialized")
      .optional(),
  })
  .strict();
export type MetadataFieldsT = z.infer<typeof MetadataFields>;

const baseSha = Sha256.nullable();

export const OpContentUpsert = z
  .object({
    op: z.literal("content.upsert"),
    collection: CollectionId,
    slug: Slug,
    status: z.enum(["draft", "published"]),
    frontmatter: z.record(z.string(), z.unknown()),
    body: z.string().max(1024 * 1024),
    base_sha256: baseSha,
  })
  .strict();
export const OpContentDelete = z
  .object({ op: z.literal("content.delete"), collection: CollectionId, slug: Slug, base_sha256: Sha256 })
  .strict();
export const OpMetadataSet = z.object({ op: z.literal("metadata.set"), route: Route, fields: MetadataFields }).strict();
export const OpMetadataClear = z.object({ op: z.literal("metadata.clear"), route: Route }).strict();
export const OpBlockSet = z
  .object({
    op: z.literal("block.set"),
    block_id: z.string().regex(BLOCK_ID_RE),
    value: z.string().max(64 * 1024),
    format: z.enum(["text", "rich-text"]),
  })
  .strict();
export const OpBlockClear = z.object({ op: z.literal("block.clear"), block_id: z.string().regex(BLOCK_ID_RE) }).strict();
export const OpImageAltSet = z
  .object({ op: z.literal("image.alt.set"), image_id: z.string().regex(BLOCK_ID_RE), alt: z.string().max(250) })
  .strict();
export const OpImageAltClear = z.object({ op: z.literal("image.alt.clear"), image_id: z.string().regex(BLOCK_ID_RE) }).strict();
export const OpRedirectUpsert = z
  .object({
    op: z.literal("redirect.upsert"),
    source: Route,
    destination: z.union([httpsUrl, pathRef]),
    permanent: z.boolean(),
  })
  .strict();
export const OpRedirectDelete = z.object({ op: z.literal("redirect.delete"), source: Route }).strict();
export const OpFileWrite = z
  .object({
    op: z.literal("file.write"),
    root: z.string().regex(ROOT_ID_RE),
    path: z.string().min(1).max(1024),
    content: z.string(),
    base_sha256: baseSha,
  })
  .strict();
export const OpFileDelete = z
  .object({ op: z.literal("file.delete"), root: z.string().regex(ROOT_ID_RE), path: z.string().min(1).max(1024), base_sha256: Sha256 })
  .strict();

export const Operation = z.discriminatedUnion("op", [
  OpContentUpsert,
  OpContentDelete,
  OpMetadataSet,
  OpMetadataClear,
  OpBlockSet,
  OpBlockClear,
  OpImageAltSet,
  OpImageAltClear,
  OpRedirectUpsert,
  OpRedirectDelete,
  OpFileWrite,
  OpFileDelete,
]);
export type OperationT = z.infer<typeof Operation>;
export const OP_NAMES = Operation.options.map((o) => o.shape.op.value);

export const OP_CAPABILITY: Record<OperationT["op"], string> = {
  "content.upsert": "content.write",
  "content.delete": "content.write",
  "metadata.set": "metadata.write",
  "metadata.clear": "metadata.write",
  "block.set": "blocks.write",
  "block.clear": "blocks.write",
  "image.alt.set": "images.alt.write",
  "image.alt.clear": "images.alt.write",
  "redirect.upsert": "redirects.write",
  "redirect.delete": "redirects.write",
  "file.write": "files.patch",
  "file.delete": "files.patch",
};

export const PlanRequest = z
  .object({
    change_id: z.string().regex(CHANGE_ID_RE),
    operations: z.array(Operation).min(1).max(200),
    base_revision: z.string().regex(REVISION_RE).nullable().default(null),
  })
  .strict();
export type PlanRequestT = z.infer<typeof PlanRequest>;

export const ApplyRequest = PlanRequest.extend({ expected_plan_sha256: Sha256 }).strict();
export type ApplyRequestT = z.infer<typeof ApplyRequest>;

export const FileRef = z.object({ root: z.string(), path: z.string() });
export const PlanFile = z.object({
  root: z.string(),
  path: z.string(),
  change: z.enum(["modify", "create", "delete"]),
  before_sha256: Sha256.nullable(),
  after_sha256: Sha256.nullable(),
});
export type PlanFileT = z.infer<typeof PlanFile>;

export const PlanIssue = z.object({ index: z.number().int(), code: z.string(), message: z.string() });
export type PlanIssueT = z.infer<typeof PlanIssue>;

export const RiskFlag = z.enum(["code-change", "deletes-content", "robots-noindex", "redirect"]);
export const PlanResponse = z.object({
  valid: z.boolean(),
  errors: z.array(PlanIssue),
  warnings: z.array(PlanIssue),
  diff: z.string(),
  files: z.array(PlanFile),
  impacted_routes: z.array(z.string()),
  risk: z.object({ level: z.enum(["low", "medium", "high"]), flags: z.array(RiskFlag) }),
  current_revision: z.string().nullable(),
});
export type PlanResponseT = z.infer<typeof PlanResponse>;

export const ApplyResponse = z.object({
  revision_id: z.string(),
  change_id: z.string(),
  status: z.literal("applied"),
  operations: z.array(z.object({ index: z.number().int(), effective: z.boolean() })),
  files: z.array(PlanFile),
  revalidated: z.array(z.string()),
  verification: z.object({
    hashes_ok: z.boolean(),
    routes: z.array(z.object({ route: z.string(), status: z.number().int() })),
  }),
  applied_at: z.string(),
});
export type ApplyResponseT = z.infer<typeof ApplyResponse>;

export const RevisionStatus = z.enum(["applied", "rolled_back", "reverted"]);
export const RevisionSummary = z.object({
  revision_id: z.string(),
  change_id: z.string(),
  status: RevisionStatus,
  parent_revision: z.string().nullable(),
  files: z.number().int(),
  created_at: z.string(),
});
export const RevisionRecord = RevisionSummary.extend({
  kind: z.enum(["changeset", "rollback", "restore"]),
  reverts: z.string().nullable(),
  operations: z.array(z.unknown()),
  file_changes: z.array(PlanFile),
  diff: z.string(),
  impacted_routes: z.array(z.string()),
  snapshot_available: z.boolean(),
  key_id: z.string().nullable(),
  reason: z.string().nullable(),
  error: z.string().nullable(),
});
export const RollbackRequest = z
  .object({ reason: z.string().max(1000).default(""), force: z.boolean().default(false) })
  .strict();

export const RotateRequest = z.object({ grace_seconds: z.number().int().min(0).max(3600).default(300) }).strict();
export const RotateResponse = z.object({ key_id: z.string(), secret: z.string(), scopes: z.array(z.string()), created_at: z.string() });
export const RevokeRequest = z.object({ key_id: z.string().min(1).max(128), confirm: z.string().optional() }).strict();
export const KeyInfo = z.object({
  key_id: z.string(),
  scopes: z.array(z.string()),
  created_at: z.string(),
  not_after: z.string().nullable(),
  revoked_at: z.string().nullable(),
});

export const ValidationRequest = z
  .object({
    operations: z.array(Operation).min(1).max(200),
    steps: z.array(z.string()).min(1).max(5).optional(),
  })
  .strict();
export const PreviewRequest = z.object({ operations: z.array(Operation).min(1).max(200) }).strict();
export const JobAccepted = z.object({ job_id: z.string() });
export const JobStep = z.object({
  name: z.string(),
  status: z.enum(["pending", "running", "succeeded", "failed", "skipped"]),
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
  output_tail: z.string(),
});
export const Job = z.object({
  job_id: z.string(),
  kind: z.enum(["validation", "preview", "deployment"]),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  steps: z.array(JobStep),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
export type JobT = z.infer<typeof Job>;

export const DeploymentRequest = z.object({ profile: z.string().regex(PROFILE_RE), reason: z.string().max(1000).default("") }).strict();
export const DeploymentAccepted = z.object({ deployment_id: z.string(), job_id: z.string() });
export const DeploymentStep = z.object({
  name: z.string(),
  status: z.enum(["running", "succeeded", "failed", "skipped"]),
  detail: z.string().nullable(),
  at: z.string(),
});
export const Deployment = z.object({
  deployment_id: z.string(),
  profile: z.string(),
  status: z.enum(["running", "succeeded", "failed", "rolled_back"]),
  previous_image_id: z.string().nullable(),
  new_image_id: z.string().nullable(),
  /** Per-service image ids recorded before the deployment (rollback targets). */
  previous_images: z.record(z.string(), z.string()).default({}),
  steps: z.array(DeploymentStep),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  reason: z.string(),
  failed_step: z.string().nullable(),
  kind: z.enum(["deploy", "rollback"]),
});
export type DeploymentT = z.infer<typeof Deployment>;
export const DeploymentRollbackRequest = z.object({ reason: z.string().max(1000).default("") }).strict();
export const DeploymentProfileInfo = z.object({
  name: z.string(),
  strategy: z.enum(["compose-recreate", "build-and-swap"]),
  services: z.array(z.string()),
  smoke_paths: z.array(z.string()),
  supported: z.boolean(),
  unsupported_reason: z.string().nullable(),
});

export const BackupKind = z.enum(["overrides", "content", "full"]);
export const BackupRequest = z.object({ kind: BackupKind }).strict();
export const Backup = z.object({
  backup_id: z.string(),
  kind: BackupKind,
  bytes: z.number().int(),
  sha256: Sha256,
  encrypted: z.boolean(),
  created_at: z.string(),
  revision_id: z.string().nullable(),
  files: z.number().int(),
});
export const RestoreRequest = z.object({ confirm: z.string(), dry_run: z.boolean().default(true) }).strict();

export const ErrorBody = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES as [string, ...string[]]),
    message: z.string(),
    correlation_id: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded", "down"]),
  ready: z.boolean(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string().nullable() })),
  current_revision: z.string().nullable(),
  time: z.string(),
});

export const CapabilityFlags = z.object({
  inventory: z.boolean(),
  "content.read": z.boolean(),
  "content.write": z.boolean(),
  "metadata.write": z.boolean(),
  "blocks.write": z.boolean(),
  "images.alt.write": z.boolean(),
  "redirects.write": z.boolean(),
  "files.read": z.boolean(),
  "files.patch": z.boolean(),
  validate: z.boolean(),
  preview: z.boolean(),
  revalidate: z.boolean(),
  deploy: z.boolean(),
  "ops.logs": z.boolean(),
  backups: z.boolean(),
});
export type CapabilityFlagsT = z.infer<typeof CapabilityFlags>;
export type CapabilityName = keyof CapabilityFlagsT;

export const ContentAdapterDescriptor = z.object({
  id: z.string(),
  kind: z.enum(["mdx", "markdown", "json", "custom"]),
  root: z.string().nullable(),
  operations: z.array(z.enum(["read", "create", "update", "delete"])),
  frontmatter_schema: z.record(z.string(), z.unknown()).nullable(),
  /** Public route of one item, e.g. "/blog/[slug]"; null when unknown. */
  route_pattern: z.string().nullable(),
});

export const CapabilitiesResponse = z.object({
  protocol_version: z.literal("1"),
  agent_version: z.string(),
  mode: z.enum(["sidecar", "in-app"]),
  site: z.object({ site_id: z.string(), environment: z.string(), public_base_url: z.string() }),
  nextjs: z.object({ version: z.string().nullable(), router: z.enum(["app", "pages", "mixed", "unknown"]) }),
  package_manager: z.enum(["npm", "pnpm", "yarn", "bun", "unknown"]),
  repository: z.object({ available: z.boolean(), commit: z.string().nullable(), branch: z.string().nullable(), dirty: z.boolean().nullable() }),
  deployment: z.object({
    hostname: z.string(),
    container_id: z.string().nullable(),
    image: z.string().nullable(),
    compose_project: z.string().nullable(),
    service: z.string().nullable(),
    profiles: z.array(z.string()),
  }),
  writable_roots: z.array(z.object({ id: z.string(), kind: z.string(), writable: z.boolean() })),
  content_adapters: z.array(ContentAdapterDescriptor),
  capabilities: CapabilityFlags,
  validation_steps: z.array(z.string()),
  preview: z.object({ url: z.string().nullable(), status: z.enum(["available", "unavailable"]) }),
  limits: z.object({ max_body_bytes: z.number(), max_file_bytes: z.number(), rate_per_minute: z.number() }),
  unsupported: z.record(z.string(), z.string()),
});

export const InventoryRoute = z.object({
  route: z.string(),
  kind: z.enum(["page", "route-handler", "layout"]),
  router: z.enum(["app", "pages"]),
  source: FileRef.nullable(),
  dynamic: z.boolean(),
  metadata: z.enum(["generateMetadata-optin", "static", "none", "unknown"]),
  blocks: z.array(z.string()),
  adapter: z.string().nullable(),
});
export type InventoryRouteT = z.infer<typeof InventoryRoute>;
export const InventoryRoutesResponse = z.object({
  items: z.array(InventoryRoute),
  unsupported: z.array(z.object({ route: z.string(), reason: z.string() })),
});
export const InventoryMetadataResponse = z.object({
  items: z.array(z.object({ route: z.string(), fields: MetadataFields, updated_at: z.string().nullable(), revision_id: z.string().nullable() })),
});
export const InventoryBlock = z.object({
  id: z.string(),
  route: z.string(),
  kind: z.enum(["text", "rich-text", "image"]),
  default: z.string().optional(),
  value: z.string().optional(),
  alt: z.string().optional(),
  src: z.string().optional(),
});
export const InventoryBlocksResponse = z.object({ items: z.array(InventoryBlock) });
export const InventoryAsset = z.object({ root: z.string(), path: z.string(), bytes: z.number().int(), sha256: Sha256 });
export const Paginated = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), next_cursor: z.string().nullable() });
export const Redirect = z.object({ source: z.string(), destination: z.string(), permanent: z.boolean() });
export const InventoryRedirectsResponse = z.object({ items: z.array(Redirect) });
export const InventoryUnsupportedResponse = z.object({ items: z.array(z.object({ feature: z.string(), reason: z.string() })) });

export const ContentItemSummary = z.object({
  slug: z.string(),
  title: z.string().nullable(),
  status: z.enum(["draft", "published"]),
  updated_at: z.string().nullable(),
  sha256: Sha256,
});
export const ContentItem = z.object({
  slug: z.string(),
  status: z.enum(["draft", "published"]),
  frontmatter: z.record(z.string(), z.unknown()),
  body: z.string(),
  sha256: Sha256,
  path: FileRef.nullable(),
});

export const FileReadResponse = z.object({ root: z.string(), path: z.string(), content: z.string(), sha256: Sha256, bytes: z.number().int() });

export const OpsStatusResponse = z.object({
  items: z.array(
    z.object({
      service: z.string(),
      state: z.string(),
      health: z.string().nullable(),
      image: z.string().nullable(),
      image_id: z.string().nullable(),
      started_at: z.string().nullable(),
    }),
  ),
});
export const OpsLogsResponse = z.object({ lines: z.array(z.string()) });

export const AuditEntry = z.object({
  at: z.string(),
  correlation_id: z.string(),
  key_id: z.string().nullable(),
  method: z.string(),
  path: z.string(),
  op: z.string().optional(),
  outcome: z.enum(["ok", "denied", "error"]),
  code: z.string().optional(),
  change_id: z.string().optional(),
  revision_id: z.string().optional(),
});
export type AuditEntryT = z.infer<typeof AuditEntry>;

export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
