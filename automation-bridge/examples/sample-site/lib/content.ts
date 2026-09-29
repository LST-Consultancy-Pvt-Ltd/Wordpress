import fs from "node:fs/promises";
import path from "node:path";
import { marked } from "marked";
import { renderContentHtml, sanitizeArticleHtml } from "@lst/automation-bridge/next";
import { parse } from "yaml";

const POSTS_DIR = path.resolve(process.env.CONTENT_DIR || path.join(process.cwd(), "content", "posts"));
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface Post {
  slug: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

function split(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  const fm = m[1] ? (parse(m[1], { schema: "core" }) as unknown) : {};
  return { frontmatter: fm && typeof fm === "object" ? (fm as Record<string, unknown>) : {}, body: raw.slice(m[0].length) };
}

/** Published posts only; drafts live in _drafts/ and are never routed. */
export async function listPosts(): Promise<Post[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(POSTS_DIR);
  } catch {
    return [];
  }
  const posts: Post[] = [];
  for (const n of names.sort()) {
    const slug = n.replace(/\.(mdx|md)$/, "");
    if (slug === n || !SLUG_RE.test(slug)) continue;
    const p = await getPost(slug);
    if (p) posts.push(p);
  }
  return posts;
}

export async function getPost(slug: string): Promise<Post | null> {
  if (!SLUG_RE.test(slug)) return null;
  for (const ext of [".mdx", ".md"]) {
    try {
      const raw = await fs.readFile(path.join(POSTS_DIR, slug + ext), "utf8");
      return { slug, ...split(raw) };
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * HTML for a post body. `content_format: "html"` bodies (AI-generated posts)
 * go through the bridge's article sanitiser; Markdown/MDX-as-Markdown bodies
 * are rendered with `marked` and sanitised the same way. No MDX code runs.
 */
export function postHtml(post: Post): string {
  const r = renderContentHtml(post.frontmatter, post.body);
  if (r.format === "html") return r.html;
  return sanitizeArticleHtml(marked.parse(r.source, { async: false }) as string);
}
