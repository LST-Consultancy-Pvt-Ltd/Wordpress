/**
 * Editable body-copy blocks for Next.js pages.
 *
 * withSeoMeta() (see lib/seo-meta.ts) covers <title>/<meta> tags, but a static
 * page's actual body text is compiled TSX — there's no equivalent hook for
 * rewriting arbitrary copy from outside the repo. This helper closes that gap
 * for whichever specific pieces of text you choose to wrap, reading an
 * override from the same JSON store the SEO Bridge route reads/writes (see
 * app/api/seo-bridge/[[...path]]/route.ts), keyed by page path + a key you
 * choose.
 *
 * Install: copy to lib/page-content.tsx.
 *
 * -------------------------------------------------------------------------
 * Preferred pattern — <Editable>, one import, wraps any JSX text node:
 *
 *   import { Editable } from "@/lib/page-content";
 *
 *   export default function AboutPage() {
 *     return (
 *       <div>
 *         <h1><Editable path="/about" id="h1">Who we are</Editable></h1>
 *         <p><Editable path="/about" id="intro">
 *           We've been building great products since 2015.
 *         </Editable></p>
 *       </div>
 *     );
 *   }
 *
 * This is the form an AI coding agent should default to when building new
 * pages on this site — see the "For future pages" note below.
 *
 * -------------------------------------------------------------------------
 * Function form — for text used outside JSX (e.g. in generateMetadata, or
 * built up before render):
 *
 *   import { getContentBlock, getContentBlocks } from "@/lib/page-content";
 *
 *   const intro = await getContentBlock("/about", "intro", "Who we are.");
 *
 *   const { heroTitle, heroSubtitle } = await getContentBlocks("/", {
 *     heroTitle: "Build faster, ship sooner",
 *     heroSubtitle: "Everything you need in one platform.",
 *   });
 *
 * -------------------------------------------------------------------------
 * Both forms behave the same underneath: the first render of a block writes
 * its default into the store (best-effort, never blocks or throws) so it
 * shows up as editable in the SEO platform without a manual manifest step.
 * After that, an edit made from the platform always wins over the default
 * in your code; clearing it there hands control back to your code.
 *
 * `id` only needs to be unique within one `path` — reuse "intro", "h1" etc.
 * freely across different pages.
 *
 * Caching: a page using these blocks must not be fully static (no
 * `export const dynamic = "force-static"`) — the bridge calls
 * revalidatePath() after every edit, and that only takes effect on pages
 * eligible for revalidation (the Next.js default, or explicit ISR).
 */
import fs from "node:fs/promises";
import path from "node:path";

const CONTENT_DIR = process.env.SEO_BRIDGE_CONTENT_DIR || "content/posts";
const CONTENT_FILE = path.resolve(process.cwd(), CONTENT_DIR, "_content-blocks.json");

type Store = Record<string, Record<string, string>>;

function normalizeRoutePath(input: string): string {
  let p = String(input || "").trim();
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

async function readStore(): Promise<Store> {
  try {
    return JSON.parse(await fs.readFile(CONTENT_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeStore(store: Store): Promise<void> {
  await fs.mkdir(path.dirname(CONTENT_FILE), { recursive: true });
  await fs.writeFile(CONTENT_FILE, JSON.stringify(store, null, 2), "utf8");
}

/** One editable block of body copy. Never throws — a missing or corrupt
 *  store, or a failed self-registration write, simply falls back to
 *  `defaultValue` so the page always renders. */
export async function getContentBlock(pagePath: string, key: string, defaultValue: string): Promise<string> {
  const p = normalizeRoutePath(pagePath);
  try {
    const store = await readStore();
    const existing = store[p]?.[key];
    if (existing !== undefined) return existing;

    store[p] = { ...(store[p] || {}), [key]: defaultValue };
    await writeStore(store).catch(() => {});
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

/** Several blocks on the same page in one go, e.g. a hero title + subtitle. */
export async function getContentBlocks<T extends Record<string, string>>(pagePath: string, defaults: T): Promise<T> {
  const out = {} as T;
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    out[key] = (await getContentBlock(pagePath, String(key), defaults[key])) as T[keyof T];
  }
  return out;
}

/** JSX wrapper around getContentBlock() — the default way to mark a piece of
 *  copy editable. `children` must be the plain default text (a string), not
 *  other elements: `<Editable path="/about" id="intro">Default text</Editable>`.
 *  Renders as plain text (React escapes it) — use <EditableHtml> below for a
 *  block that needs real markup (paragraphs, bold, links). */
export async function Editable({ path: pagePath, id, children }: { path: string; id: string; children: string }) {
  const text = await getContentBlock(pagePath, id, children);
  return <>{text}</>;
}

/** Like <Editable>, but the stored value is rendered as HTML rather than
 *  escaped text — for a block that's a whole section of formatted copy
 *  (paragraphs, bold, links) rather than a single line of plain text.
 *
 *  This is also the pattern for editing a page's ENTIRE body as one block,
 *  the same way blog posts are edited as one piece of content: give the
 *  whole page a single call instead of wrapping each paragraph separately —
 *
 *    export default async function AboutPage() {
 *      return (
 *        <div className="prose">
 *          <EditableHtml path="/about" id="body">
 *            {`<h1>Who we are</h1><p>We've been building great products since 2015.</p>`}
 *          </EditableHtml>
 *        </div>
 *      );
 *    }
 *
 *  `children` is trusted HTML — only pass markup you wrote yourself as the
 *  default (same trust boundary as any other dangerouslySetInnerHTML in this
 *  codebase); the value coming back from the store was itself written
 *  through this same bridge by an authenticated editor. */
export async function EditableHtml({ path: pagePath, id, children }: { path: string; id: string; children: string }) {
  const html = await getContentBlock(pagePath, id, children);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
