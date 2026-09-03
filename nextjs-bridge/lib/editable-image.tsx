/**
 * Editable image alt text for Next.js pages.
 *
 * Same idea as lib/page-content.tsx, in a separate store — an image needs
 * `alt` (and optionally the `src` it was registered against, so the SEO
 * platform can show a thumbnail), which is a different shape from a plain
 * text block. Reads/writes the same JSON store the SEO Bridge route
 * reads/writes (see app/api/seo-bridge/[[...path]]/route.ts), keyed by page
 * path + an id you choose.
 *
 * Install: copy to lib/editable-image.tsx.
 *
 * -------------------------------------------------------------------------
 * Preferred pattern — <EditableImg>, a drop-in replacement for <img>:
 *
 *   import { EditableImg } from "@/lib/editable-image";
 *
 *   <EditableImg path="/about" id="team-photo" src="/team.jpg"
 *     alt="Our team at the 2024 offsite" className="rounded-lg" />
 *
 * Every prop except `path`/`id` passes straight through to the rendered
 * <img> (src, className, width, height, loading, etc.) — only `alt` gets
 * swapped out for the stored override, if one exists.
 *
 * -------------------------------------------------------------------------
 * Function form — when you need just the string (e.g. a CSS background-image
 * div, or next/image's `alt` prop):
 *
 *   import { getImageAlt } from "@/lib/editable-image";
 *
 *   const alt = await getImageAlt("/about", "team-photo", "Our team.");
 *   return <Image src="/team.jpg" alt={alt} width={800} height={600} />;
 *
 * -------------------------------------------------------------------------
 * Both forms self-register the default alt (and src) on first render, so the
 * image shows up as editable in the SEO platform without a manifest step. An
 * edit made from the platform always wins over the default in your code;
 * clearing it there hands control back to your code — same as content blocks
 * and meta overrides.
 *
 * `id` only needs to be unique within one `path`.
 *
 * Caching: a page using these must not be fully static (no
 * `export const dynamic = "force-static"`) — the bridge calls
 * revalidatePath() after every edit.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { ImgHTMLAttributes } from "react";

const CONTENT_DIR = process.env.SEO_BRIDGE_CONTENT_DIR || "content/posts";
const IMAGES_FILE = path.resolve(process.cwd(), CONTENT_DIR, "_image-alt.json");

type ImageEntry = { alt: string; src?: string; updatedAt?: string };
type Store = Record<string, Record<string, ImageEntry>>;

function normalizeRoutePath(input: string): string {
  let p = String(input || "").trim();
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

async function readStore(): Promise<Store> {
  try {
    return JSON.parse(await fs.readFile(IMAGES_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeStore(store: Store): Promise<void> {
  await fs.mkdir(path.dirname(IMAGES_FILE), { recursive: true });
  await fs.writeFile(IMAGES_FILE, JSON.stringify(store, null, 2), "utf8");
}

/** Resolved alt text for one image. Never throws — falls back to
 *  `defaultAlt` on any missing/corrupt store or failed registration write. */
export async function getImageAlt(pagePath: string, id: string, defaultAlt: string, src?: string): Promise<string> {
  const p = normalizeRoutePath(pagePath);
  try {
    const store = await readStore();
    const existing = store[p]?.[id];
    if (existing !== undefined) return existing.alt;

    store[p] = { ...(store[p] || {}), [id]: { alt: defaultAlt, ...(src ? { src } : {}) } };
    await writeStore(store).catch(() => {});
    return defaultAlt;
  } catch {
    return defaultAlt;
  }
}

type EditableImgProps = { path: string; id: string } & ImgHTMLAttributes<HTMLImageElement>;

/** Drop-in <img> replacement — every prop passes through except `alt`, which
 *  is swapped for the stored override (falling back to the `alt` you pass). */
export async function EditableImg({ path: pagePath, id, alt, src, ...rest }: EditableImgProps) {
  const resolvedAlt = await getImageAlt(pagePath, id, String(alt || ""), typeof src === "string" ? src : undefined);
  return <img src={src} alt={resolvedAlt} {...rest} />;
}
