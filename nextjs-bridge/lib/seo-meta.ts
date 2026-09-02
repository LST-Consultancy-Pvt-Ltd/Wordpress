/**
 * SEO metadata overrides for Next.js pages.
 *
 * A static page's metadata lives in generateMetadata(), which is TypeScript —
 * so nothing outside your repo can change it. This helper reads overrides the
 * SEO platform writes to a JSON file on your content volume, letting titles
 * and descriptions be edited at runtime with no rebuild and no code change.
 *
 * Install: copy to lib/seo-meta.ts, then add one line per page:
 *
 *   import { withSeoMeta } from "@/lib/seo-meta";
 *
 *   export async function generateMetadata(): Promise<Metadata> {
 *     return withSeoMeta("/about", {
 *       title: "About us",                 // your defaults, used when no
 *       description: "Who we are.",        // override has been set
 *     });
 *   }
 *
 * For a dynamic route, pass the resolved path:
 *
 *   export async function generateMetadata({ params }): Promise<Metadata> {
 *     const post = await getPost(params.slug);
 *     return withSeoMeta(`/blog/${params.slug}`, {
 *       title: post.title,
 *       description: post.description,
 *     });
 *   }
 *
 * Precedence: an override always wins over the defaults you pass. Clearing an
 * override in the platform hands control back to your code.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";

const CONTENT_DIR = process.env.SEO_BRIDGE_CONTENT_DIR || "content/posts";
const META_FILE = path.resolve(process.cwd(), CONTENT_DIR, "_seo-meta.json");

export type SeoOverride = {
  title?: string;
  description?: string;
  canonical?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  noindex?: boolean;
};

function normalizeRoutePath(input: string): string {
  let p = String(input || "").trim();
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

/** The raw override for a route, or null. Never throws — a missing or corrupt
 *  store simply means "no overrides", so your page still renders. */
export async function getSeoOverride(routePath: string): Promise<SeoOverride | null> {
  try {
    const store = JSON.parse(await fs.readFile(META_FILE, "utf8"));
    return store[normalizeRoutePath(routePath)] ?? null;
  } catch {
    return null;
  }
}

/** Merge any override on top of your page's own defaults and return a
 *  Next.js Metadata object. */
export async function withSeoMeta(routePath: string, defaults: Metadata = {}): Promise<Metadata> {
  const o = await getSeoOverride(routePath);
  if (!o) return defaults;

  const meta: Metadata = { ...defaults };

  if (o.title) meta.title = o.title;
  if (o.description) meta.description = o.description;
  if (o.canonical) meta.alternates = { ...(defaults.alternates || {}), canonical: o.canonical };
  if (o.noindex) meta.robots = { index: false, follow: false };

  const og = (defaults.openGraph || {}) as Record<string, unknown>;
  if (o.ogTitle || o.ogDescription || o.ogImage || o.title || o.description) {
    meta.openGraph = {
      ...og,
      title: o.ogTitle || o.title || (og.title as string) || undefined,
      description: o.ogDescription || o.description || (og.description as string) || undefined,
      ...(o.ogImage ? { images: [o.ogImage] } : {}),
    };
  }

  return meta;
}
