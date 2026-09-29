/**
 * Example custom adapter backed by an HTTP API (a stub for headless CMSs).
 *
 * It is READ-ONLY on purpose and says so in its descriptor: writes to an
 * external system cannot be snapshotted, verified or rolled back by the
 * bridge's revision pipeline, so offering them would break the protocol's
 * rollback guarantee. Expected upstream API (adapt `mapItem` for yours):
 *
 *   GET {baseUrl}/items?status=draft|published|all → [{slug, title, status, updated_at, frontmatter?, body?}]
 *   GET {baseUrl}/items/{slug}                     → {slug, status, frontmatter, body}
 *
 * Register it programmatically:
 *
 *   createBridge(config, { adapters: { cms: createHttpContentAdapter({ id: "news", baseUrl, headers }) } })
 *   // config: { "id": "news", "kind": "custom", "adapter": "cms", "route_pattern": "/news/[slug]" }
 */
import { SLUG_RE } from "../schemas.js";
import { sha256Hex } from "../util.js";
import type { ContentAdapter, ContentAdapterDescriptorT, ContentItemSummaryT, ContentItemT, ContentStatusFilter } from "./types.js";

export interface HttpAdapterOptions {
  id: string;
  baseUrl: string;
  /** Static request headers (e.g. an API token read from a secret file by the host). */
  headers?: Record<string, string>;
  routePattern?: string | null;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface UpstreamItem {
  slug?: unknown;
  title?: unknown;
  status?: unknown;
  updated_at?: unknown;
  frontmatter?: unknown;
  body?: unknown;
}

export function createHttpContentAdapter(opts: HttpAdapterOptions): ContentAdapter {
  const f = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const descriptor: ContentAdapterDescriptorT = {
    id: opts.id,
    kind: "custom",
    root: null,
    operations: ["read"],
    frontmatter_schema: null,
    route_pattern: opts.routePattern ?? null,
  };
  async function getJson(url: string): Promise<unknown> {
    const res = await f(url, { headers: { accept: "application/json", ...(opts.headers ?? {}) }, signal: AbortSignal.timeout(opts.timeoutMs ?? 5000), redirect: "error" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`upstream responded ${res.status}`);
    return res.json();
  }
  const status = (v: unknown): "draft" | "published" => (v === "draft" ? "draft" : "published");
  return {
    descriptor,
    async list(filter: ContentStatusFilter): Promise<ContentItemSummaryT[]> {
      const data = await getJson(`${base}/items?status=${encodeURIComponent(filter)}`);
      if (!Array.isArray(data)) return [];
      return (data as UpstreamItem[])
        .filter((i) => typeof i.slug === "string" && SLUG_RE.test(i.slug))
        .map((i) => ({
          slug: i.slug as string,
          title: typeof i.title === "string" ? i.title : null,
          status: status(i.status),
          updated_at: typeof i.updated_at === "string" ? i.updated_at : null,
          sha256: sha256Hex(JSON.stringify(i)),
        }));
    },
    async get(slug: string): Promise<ContentItemT | null> {
      const i = (await getJson(`${base}/items/${encodeURIComponent(slug)}`)) as UpstreamItem | null;
      if (!i) return null;
      const fm = i.frontmatter && typeof i.frontmatter === "object" && !Array.isArray(i.frontmatter) ? (i.frontmatter as Record<string, unknown>) : {};
      return { slug, status: status(i.status), frontmatter: fm, body: typeof i.body === "string" ? i.body : "", sha256: sha256Hex(JSON.stringify(i)), path: null };
    },
    async check() {
      try {
        await getJson(`${base}/items?status=published`);
        return { ok: true, detail: null };
      } catch {
        return { ok: false, detail: "upstream unreachable" };
      }
    },
  };
}
