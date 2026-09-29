/**
 * Override store formats, shared by the bridge (writer, via the change-set
 * pipeline only) and the site runtime helpers (read-only). Kept dependency
 * free so it is cheap to import inside a Next.js server bundle.
 *
 * Files inside the overrides root:
 *   metadata.json   {"version":1,"routes":{"/about":{"fields":{…},"change_id":"cs_1"}}}
 *   blocks.json     {"version":1,"blocks":{"home.hero.title":{"value":"…","format":"text","change_id":"…"}}}
 *   images.json     {"version":1,"images":{"home.hero.image":{"alt":"…","change_id":"…"}}}
 *   redirects.json  {"version":1,"redirects":[{"source":"/old","destination":"/new","permanent":true,"change_id":"…"}]}
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const STORE_FILES = {
  metadata: "metadata.json",
  blocks: "blocks.json",
  images: "images.json",
  redirects: "redirects.json",
} as const;

export interface MetadataOverride {
  title?: string;
  description?: string;
  canonical?: string;
  robots?: { index: boolean; follow: boolean };
  openGraph?: { title?: string; description?: string; image?: string };
  jsonLd?: Record<string, unknown>[];
}

export interface MetadataStore {
  version: 1;
  routes: Record<string, { fields: MetadataOverride; change_id: string }>;
}
export interface BlocksStore {
  version: 1;
  blocks: Record<string, { value: string; format: "text" | "rich-text"; change_id: string }>;
}
export interface ImagesStore {
  version: 1;
  images: Record<string, { alt: string; change_id: string }>;
}
export interface RedirectEntry {
  source: string;
  destination: string;
  permanent: boolean;
  change_id?: string;
}
export interface RedirectsStore {
  version: 1;
  redirects: RedirectEntry[];
}

export type StoreKind = keyof typeof STORE_FILES;
export interface StoreMap {
  metadata: MetadataStore;
  blocks: BlocksStore;
  images: ImagesStore;
  redirects: RedirectsStore;
}

export function emptyStore<K extends StoreKind>(kind: K): StoreMap[K] {
  switch (kind) {
    case "metadata":
      return { version: 1, routes: {} } as StoreMap[K];
    case "blocks":
      return { version: 1, blocks: {} } as StoreMap[K];
    case "images":
      return { version: 1, images: {} } as StoreMap[K];
    default:
      return { version: 1, redirects: [] } as unknown as StoreMap[K];
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Parse a store file's content; malformed input yields an empty store. */
export function parseStore<K extends StoreKind>(kind: K, raw: string | Buffer | null): StoreMap[K] {
  if (!raw) return emptyStore(kind);
  try {
    const v = JSON.parse(raw.toString()) as unknown;
    if (!isObj(v)) return emptyStore(kind);
    if (kind === "metadata" && isObj(v.routes)) return { version: 1, routes: v.routes } as StoreMap[K];
    if (kind === "blocks" && isObj(v.blocks)) return { version: 1, blocks: v.blocks } as StoreMap[K];
    if (kind === "images" && isObj(v.images)) return { version: 1, images: v.images } as StoreMap[K];
    if (kind === "redirects" && Array.isArray(v.redirects)) return { version: 1, redirects: v.redirects } as unknown as StoreMap[K];
  } catch {
    /* fallthrough */
  }
  return emptyStore(kind);
}

/** Read a store from an overrides directory. Never throws. */
export async function readStore<K extends StoreKind>(dir: string, kind: K): Promise<StoreMap[K]> {
  try {
    return parseStore(kind, await fsp.readFile(path.join(dir, STORE_FILES[kind])));
  } catch {
    return emptyStore(kind);
  }
}

export function readStoreSync<K extends StoreKind>(dir: string, kind: K): StoreMap[K] {
  try {
    return parseStore(kind, fs.readFileSync(path.join(dir, STORE_FILES[kind])));
  } catch {
    return emptyStore(kind);
  }
}

/** Block manifest (`automation.manifest.json`). */
export interface ManifestBlock {
  id: string;
  route: string;
  kind: "text" | "rich-text" | "image";
  default?: string;
  src?: string;
  alt?: string;
}
export interface Manifest {
  version: 1;
  blocks: ManifestBlock[];
  /** Routes asserted to use withAutomationMetadata when source scanning is not possible. */
  metadata_routes?: string[];
}

export function parseManifest(raw: unknown): { manifest: Manifest; errors: string[] } {
  const errors: string[] = [];
  const out: Manifest = { version: 1, blocks: [], metadata_routes: [] };
  if (!isObj(raw)) return { manifest: out, errors: ["manifest must be an object"] };
  const ids = new Set<string>();
  const blocks = Array.isArray(raw.blocks) ? raw.blocks : [];
  for (const [i, b] of blocks.entries()) {
    if (!isObj(b) || typeof b.id !== "string" || typeof b.route !== "string" || !["text", "rich-text", "image"].includes(String(b.kind))) {
      errors.push(`blocks[${i}]: needs id, route and kind (text|rich-text|image)`);
      continue;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(b.id)) {
      errors.push(`blocks[${i}]: invalid id`);
      continue;
    }
    if (ids.has(b.id)) {
      errors.push(`blocks[${i}]: duplicate id ${b.id}`);
      continue;
    }
    ids.add(b.id);
    const entry: ManifestBlock = { id: b.id, route: b.route, kind: b.kind as ManifestBlock["kind"] };
    if (typeof b.default === "string") entry.default = b.default;
    if (typeof b.src === "string") entry.src = b.src;
    if (typeof b.alt === "string") entry.alt = b.alt;
    out.blocks.push(entry);
  }
  if (Array.isArray(raw.metadata_routes)) out.metadata_routes = raw.metadata_routes.filter((r): r is string => typeof r === "string");
  return { manifest: out, errors };
}

export function normalizeRoutePath(input: string): string {
  let p = String(input || "").trim();
  if (!p.startsWith("/")) p = "/" + p;
  const q = p.search(/[?#]/);
  if (q >= 0) p = p.slice(0, q);
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}
