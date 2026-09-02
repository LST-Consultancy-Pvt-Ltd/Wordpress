/**
 * SEO Bridge — drop-in App Router endpoint that lets the SEO platform publish
 * blog posts into this Next.js site at runtime.
 *
 * Posts are written as .mdx files into a content directory that should live on
 * a mounted Docker volume, so they survive container rebuilds. After a write
 * the affected paths are revalidated, so a published post appears immediately
 * without rebuilding or redeploying the image.
 *
 * Install: copy this file to app/api/seo-bridge/[[...path]]/route.ts
 *
 * Required env:
 *   SEO_BRIDGE_TOKEN             long random secret; the route refuses ALL
 *                                requests until it is set (never defaults open)
 * Optional env:
 *   SEO_BRIDGE_CONTENT_DIR       default "content/posts", relative to cwd
 *   SEO_BRIDGE_REVALIDATE_PATHS  default "/blog" (comma-separated)
 *
 * Endpoints (all require `Authorization: Bearer $SEO_BRIDGE_TOKEN`):
 *   GET    /api/seo-bridge/health        what the bridge resolved + a sample post
 *   GET    /api/seo-bridge/meta          all SEO overrides
 *   GET    /api/seo-bridge/meta?path=/x  the override for one route
 *   PUT    /api/seo-bridge/meta          upsert one (body: {path, title, description, ...})
 *   DELETE /api/seo-bridge/meta?path=/x  remove one
 *   GET    /api/seo-bridge/posts         list posts
 *   GET    /api/seo-bridge/posts/:slug   read one post
 *   POST   /api/seo-bridge/posts         create (body: {slug?, title, content, ...})
 *   PUT    /api/seo-bridge/posts/:slug   update
 *   DELETE /api/seo-bridge/posts/:slug   delete
 */
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN = process.env.SEO_BRIDGE_TOKEN || "";
const CONTENT_DIR = process.env.SEO_BRIDGE_CONTENT_DIR || "content/posts";
const REVALIDATE_PATHS = (process.env.SEO_BRIDGE_REVALIDATE_PATHS || "/blog")
  .split(",").map((s) => s.trim()).filter(Boolean);

const contentRoot = path.resolve(process.cwd(), CONTENT_DIR);

/** Slugs are the only caller-controlled part of a filesystem path, so they are
 *  restricted to a strict charset. That alone makes traversal impossible (no
 *  dots, no separators); the resolved-path check below is belt-and-braces. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function postPath(slug: string): string {
  if (!SLUG_RE.test(slug)) throw new Error(`Invalid slug "${slug}" — use lowercase letters, numbers and hyphens only.`);
  const expected = path.join(contentRoot, `${slug}.mdx`);
  const resolved = path.resolve(expected);
  if (resolved !== expected) throw new Error("Refusing to write outside the content directory.");
  return resolved;
}

function authorized(req: NextRequest): boolean {
  if (!TOKEN) return false; // unset token = closed, never open
  const header = req.headers.get("authorization") || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(TOKEN);
  // Length must match before timingSafeEqual, which throws on a mismatch.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function slugify(input: string): string {
  return input.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function toFrontmatter(fields: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map((x) => JSON.stringify(String(x))).join(", ")}]`);
    } else if (typeof v === "boolean" || typeof v === "number") {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(String(v))}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

/** Minimal frontmatter reader — deliberately dependency-free so this file can
 *  be dropped in without touching package.json. Only used for reporting. */
function readFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, "");
  }
  return out;
}

async function listPosts() {
  let names: string[] = [];
  try {
    names = (await fs.readdir(contentRoot)).filter((n) => n.endsWith(".mdx") || n.endsWith(".md"));
  } catch {
    return [];
  }
  const posts = [];
  for (const name of names) {
    const raw = await fs.readFile(path.join(contentRoot, name), "utf8").catch(() => "");
    const fm = readFrontmatter(raw);
    posts.push({
      slug: name.replace(/\.mdx?$/, ""),
      title: fm.title || "",
      date: fm.date || "",
      draft: fm.draft === "true",
      file: name,
    });
  }
  return posts.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

function revalidateAll() {
  for (const p of REVALIDATE_PATHS) {
    try { revalidatePath(p); } catch { /* a bad path must not fail the write */ }
  }
}

async function writePost(body: any, slugOverride?: string) {
  const title = String(body?.title || "").trim();
  if (!title) throw new Error("`title` is required.");
  const content = String(body?.content ?? "");
  const slug = slugOverride || (body?.slug ? slugify(String(body.slug)) : slugify(title));
  if (!slug) throw new Error("Could not derive a slug — supply one explicitly.");

  const file = postPath(slug);
  const frontmatter = toFrontmatter({
    title,
    date: body?.date || new Date().toISOString(),
    description: body?.description,
    tags: body?.tags,
    draft: body?.draft === true ? true : undefined,
    // Any extra frontmatter the caller needs to match this site's schema.
    ...(body?.frontmatter && typeof body.frontmatter === "object" ? body.frontmatter : {}),
  });

  await fs.mkdir(contentRoot, { recursive: true });
  await fs.writeFile(file, frontmatter + content, "utf8");
  revalidateAll();
  return { slug, file: path.relative(process.cwd(), file), revalidated: REVALIDATE_PATHS };
}

/* ------------------------------------------------------------------ *
 * SEO metadata overrides
 *
 * A static Next.js page keeps its metadata in generateMetadata(), which is
 * TypeScript — nothing outside the repo can rewrite it. So overrides live in
 * a JSON file on the same volume, keyed by route path, and the page reads
 * them at render time via getSeoMeta() (see lib/seo-meta.ts). That makes
 * titles and descriptions editable at runtime for pages AND posts, with no
 * rebuild and no code change after the one-time wiring.
 * ------------------------------------------------------------------ */

const META_FILE = path.join(contentRoot, "_seo-meta.json");

const META_FIELDS = [
  "title", "description", "canonical",
  "ogTitle", "ogDescription", "ogImage", "noindex",
] as const;

function normalizeRoutePath(input: string): string {
  let p = String(input || "").trim();
  if (!p.startsWith("/")) p = "/" + p;
  try { p = new URL(p, "https://placeholder.local").pathname; } catch { /* keep as-is */ }
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

async function readMetaStore(): Promise<Record<string, Record<string, unknown>>> {
  try {
    return JSON.parse(await fs.readFile(META_FILE, "utf8"));
  } catch {
    return {};                       // absent file simply means no overrides yet
  }
}

async function writeMetaStore(store: Record<string, Record<string, unknown>>) {
  await fs.mkdir(contentRoot, { recursive: true });
  await fs.writeFile(META_FILE, JSON.stringify(store, null, 2), "utf8");
}

function json(data: unknown, status = 200) {
  return NextResponse.json(data as any, { status });
}

function guard(req: NextRequest) {
  if (!TOKEN) {
    return json({ error: "SEO_BRIDGE_TOKEN is not set on this deployment — the bridge is disabled." }, 503);
  }
  if (!authorized(req)) return json({ error: "Unauthorized" }, 401);
  return null;
}

type Ctx = { params: Promise<{ path?: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const denied = guard(req);
  if (denied) return denied;
  const segments = (await ctx.params).path || [];

  if (segments[0] === "health" || segments.length === 0) {
    const posts = await listPosts();
    let canWrite = false;
    try {
      await fs.mkdir(contentRoot, { recursive: true });
      const probe = path.join(contentRoot, ".seo-bridge-write-probe");
      await fs.writeFile(probe, "ok", "utf8");
      await fs.unlink(probe);
      canWrite = true;
    } catch { canWrite = false; }
    let sampleFrontmatter: Record<string, string> = {};
    if (posts.length) {
      const raw = await fs.readFile(path.join(contentRoot, posts[0].file), "utf8").catch(() => "");
      sampleFrontmatter = readFrontmatter(raw);
    }
    return json({
      ok: true,
      contentDir: path.relative(process.cwd(), contentRoot) || contentRoot,
      absoluteContentDir: contentRoot,
      canWrite,
      postCount: posts.length,
      revalidatePaths: REVALIDATE_PATHS,
      // Compare this against what your blog pages expect — if the keys differ,
      // set them explicitly via the `frontmatter` field when publishing.
      sampleFrontmatter,
    });
  }

  if (segments[0] === "meta") {
    const store = await readMetaStore();
    const wanted = req.nextUrl.searchParams.get("path");
    if (wanted) {
      const key = normalizeRoutePath(wanted);
      return json({ path: key, meta: store[key] || null });
    }
    return json({ meta: store, count: Object.keys(store).length, file: path.relative(process.cwd(), META_FILE) });
  }

  if (segments[0] === "posts" && segments.length === 1) {
    return json({ posts: await listPosts() });
  }

  if (segments[0] === "posts" && segments.length === 2) {
    try {
      const raw = await fs.readFile(postPath(segments[1]), "utf8");
      return json({ slug: segments[1], frontmatter: readFrontmatter(raw), raw });
    } catch (e: any) {
      return json({ error: e?.code === "ENOENT" ? "Post not found" : String(e?.message || e) }, e?.code === "ENOENT" ? 404 : 400);
    }
  }

  return json({ error: "Unknown endpoint" }, 404);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const denied = guard(req);
  if (denied) return denied;
  const segments = (await ctx.params).path || [];
  if (segments[0] !== "posts") return json({ error: "Unknown endpoint" }, 404);
  try {
    return json(await writePost(await req.json()), 201);
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 400);
  }
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const denied = guard(req);
  if (denied) return denied;
  const segments = (await ctx.params).path || [];

  if (segments[0] === "meta") {
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
    if (!body?.path) return json({ error: "`path` is required (e.g. \"/about\")." }, 400);
    const key = normalizeRoutePath(body.path);
    const store = await readMetaStore();
    const entry: Record<string, unknown> = { ...(store[key] || {}) };
    for (const field of META_FIELDS) {
      if (field in body) {
        // null or "" clears the override and lets the page's own value win again.
        if (body[field] === null || body[field] === "") delete entry[field];
        else entry[field] = body[field];
      }
    }
    entry.updatedAt = new Date().toISOString();
    if (Object.keys(entry).length <= 1) delete store[key];   // only updatedAt left
    else store[key] = entry;
    await writeMetaStore(store);
    try { revalidatePath(key); } catch { /* a bad path must not fail the write */ }
    revalidateAll();
    return json({ path: key, meta: store[key] || null, revalidated: [key, ...REVALIDATE_PATHS] });
  }

  if (segments[0] !== "posts" || segments.length !== 2) return json({ error: "Unknown endpoint" }, 404);
  try {
    return json(await writePost(await req.json(), segments[1]));
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 400);
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const denied = guard(req);
  if (denied) return denied;
  const segments = (await ctx.params).path || [];

  if (segments[0] === "meta") {
    const wanted = req.nextUrl.searchParams.get("path");
    if (!wanted) return json({ error: "`path` query parameter is required." }, 400);
    const key = normalizeRoutePath(wanted);
    const store = await readMetaStore();
    if (!(key in store)) return json({ error: "No override for that path" }, 404);
    delete store[key];
    await writeMetaStore(store);
    try { revalidatePath(key); } catch { /* ignore */ }
    return json({ deleted: key });
  }

  if (segments[0] !== "posts" || segments.length !== 2) return json({ error: "Unknown endpoint" }, 404);
  try {
    await fs.unlink(postPath(segments[1]));
    revalidateAll();
    return json({ deleted: segments[1] });
  } catch (e: any) {
    return json({ error: e?.code === "ENOENT" ? "Post not found" : String(e?.message || e) }, e?.code === "ENOENT" ? 404 : 400);
  }
}
