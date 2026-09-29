/**
 * Content adapter interface.
 *
 * File-backed adapters (mdx, markdown, json) never touch the disk when
 * planning: they read and write through the change-set's virtual file
 * system (`Vfs`), so every content change goes through the same snapshot /
 * atomic write / verify / rollback pipeline as overrides.
 *
 * A custom adapter (e.g. a headless CMS over HTTP) can be registered
 * programmatically: `createBridge(config, { adapters: { myCms: adapter } })`
 * with a collection `{ "id": "news", "kind": "custom", "adapter": "myCms" }`.
 * It must report its operations honestly; write operations it does not list
 * are rejected with CAPABILITY_UNSUPPORTED before any planning happens.
 * Custom adapters that write outside the bridge's filesystem cannot be
 * snapshotted, so the reference HTTP adapter is read-only.
 */
import type { z } from "zod";
import type { ContentAdapterDescriptor, ContentItem, ContentItemSummary, OpContentDelete, OpContentUpsert } from "../schemas.js";

export type ContentAdapterDescriptorT = z.infer<typeof ContentAdapterDescriptor>;
export type ContentItemT = z.infer<typeof ContentItem>;
export type ContentItemSummaryT = z.infer<typeof ContentItemSummary>;
export type ContentStatusFilter = "draft" | "published" | "all";

export interface Vfs {
  /** Current (virtual) content, or null when absent. */
  read(root: string, relPath: string): Promise<Buffer | null>;
  /** Stage a write (Buffer) or delete (null). Validates root writability and path safety. */
  write(root: string, relPath: string, content: Buffer | null): Promise<void>;
}

export interface AdapterPlanResult {
  impactedRoutes: string[];
  warnings?: { code: string; message: string }[];
  riskFlags?: ("code-change" | "deletes-content")[];
}

export interface ContentAdapter {
  readonly descriptor: ContentAdapterDescriptorT;
  list(status: ContentStatusFilter): Promise<ContentItemSummaryT[]>;
  get(slug: string): Promise<ContentItemT | null>;
  planUpsert?(op: z.infer<typeof OpContentUpsert>, vfs: Vfs): Promise<AdapterPlanResult>;
  planDelete?(op: z.infer<typeof OpContentDelete>, vfs: Vfs): Promise<AdapterPlanResult>;
  /** Self-check used for capability flags and /health. */
  check?(): Promise<{ ok: boolean; detail: string | null }>;
}
