/**
 * Site runtime helpers (read-only). They read the override stores written by
 * the bridge and never write anything; a missing or corrupt store simply
 * means "no overrides", so pages always render with their own defaults.
 *
 * Location of the overrides directory: `AUTOMATION_OVERRIDES_DIR`
 * (default `<cwd>/.automation/overrides`), or call `configureAutomation()`.
 */
import path from "node:path";
import { sanitizeArticleHtml, sanitizeRichText } from "../core/sanitize.js";
import { normalizeRoutePath, readStore, readStoreSync, type MetadataOverride, type RedirectEntry } from "../shared/stores.js";

let configuredDir: string | null = null;

export function configureAutomation(opts: { overridesDir: string }): void {
  configuredDir = path.resolve(opts.overridesDir);
}

export function overridesDir(): string {
  return configuredDir ?? path.resolve(process.env.AUTOMATION_OVERRIDES_DIR || path.join(process.cwd(), ".automation", "overrides"));
}

export async function getMetadataOverride(route: string): Promise<MetadataOverride | null> {
  const store = await readStore(overridesDir(), "metadata");
  return store.routes[normalizeRoutePath(route)]?.fields ?? null;
}

type Obj = Record<string, unknown>;

/**
 * Wrap your page's metadata defaults; an override set through the bridge
 * wins field by field, and clearing it hands control back to your code.
 *
 *   export async function generateMetadata(): Promise<Metadata> {
 *     return withAutomationMetadata("/about", { title: "About us", description: "…" });
 *   }
 *
 * The literal call `withAutomationMetadata(` in the page source is how the
 * bridge's inventory detects that the route opted in.
 */
export async function withAutomationMetadata<T extends object>(route: string, defaults: T = {} as T): Promise<T> {
  const o = await getMetadataOverride(route);
  if (!o) return defaults;
  const d = defaults as Obj;
  const meta: Obj = { ...d };
  if (o.title !== undefined) meta.title = o.title;
  if (o.description !== undefined) meta.description = o.description;
  if (o.canonical) meta.alternates = { ...((d.alternates as Obj) ?? {}), canonical: o.canonical };
  if (o.robots) meta.robots = { index: o.robots.index, follow: o.robots.follow };
  const og = (d.openGraph as Obj) ?? {};
  if (o.openGraph || o.title !== undefined || o.description !== undefined) {
    meta.openGraph = {
      ...og,
      title: o.openGraph?.title ?? o.title ?? og.title ?? (typeof meta.title === "string" ? meta.title : undefined),
      description: o.openGraph?.description ?? o.description ?? og.description ?? (typeof meta.description === "string" ? meta.description : undefined),
      ...(o.openGraph?.image ? { images: [o.openGraph.image] } : {}),
    };
  }
  return meta as T;
}

/** JSON-LD objects for a route: bridge overrides first, then `extra` (e.g. a post's front matter `jsonLd`). */
export async function getAutomationJsonLd(route: string, extra?: unknown): Promise<Obj[]> {
  const o = await getMetadataOverride(route);
  const out: Obj[] = [...(o?.jsonLd ?? [])];
  const push = (v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v) && ("@type" in (v as Obj) || "@graph" in (v as Obj))) out.push(v as Obj);
  };
  if (Array.isArray(extra)) extra.forEach(push);
  else push(extra);
  return out;
}

/** JSON for a <script type="application/ld+json"> body; `<`, `>` and `&` are escaped so it cannot close the tag. */
export function serializeJsonLd(items: Obj[]): string {
  const v = items.length === 1 ? items[0] : items;
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export async function getBlock(id: string, fallback: string): Promise<string> {
  const store = await readStore(overridesDir(), "blocks");
  const v = store.blocks[id]?.value;
  return typeof v === "string" ? v : fallback;
}

/** Sanitised HTML for a rich-text block (sanitised again on render, even though the bridge sanitised on write). */
export async function getRichTextBlockHtml(id: string, fallbackHtml: string): Promise<string> {
  return sanitizeRichText(await getBlock(id, fallbackHtml));
}

export async function getImageAlt(id: string, fallback: string): Promise<string> {
  const store = await readStore(overridesDir(), "images");
  const v = store.images[id]?.alt;
  return typeof v === "string" ? v : fallback;
}

/** Redirects for next.config.js `redirects()` (build/start time) — use matchRedirect() in middleware for runtime changes. */
export function getRedirects(): { source: string; destination: string; permanent: boolean }[] {
  return readStoreSync(overridesDir(), "redirects").redirects.map((r: RedirectEntry) => ({ source: r.source, destination: r.destination, permanent: !!r.permanent }));
}

/** Runtime lookup for middleware (Node.js runtime): exact source match on the normalised pathname. */
export function matchRedirect(pathname: string): { destination: string; permanent: boolean } | null {
  const p = normalizeRoutePath(pathname);
  const r = readStoreSync(overridesDir(), "redirects").redirects.find((x) => x.source === p);
  return r ? { destination: r.destination, permanent: !!r.permanent } : null;
}

/**
 * Render a content item body stored by the bridge. Items whose front matter
 * says `content_format: "html"` are sanitised with the article allow-list;
 * other bodies are returned as-is for your own Markdown/MDX pipeline.
 */
export function renderContentHtml(frontmatter: Record<string, unknown>, body: string): { format: "html"; html: string } | { format: "source"; source: string } {
  if (frontmatter.content_format === "html") return { format: "html", html: sanitizeArticleHtml(body) };
  return { format: "source", source: body };
}

export { sanitizeRichText, sanitizeArticleHtml };
