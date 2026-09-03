# SEO Bridge for a self-hosted Next.js site

Lets the SEO platform publish blog posts into a Next.js app at runtime — no
image rebuild, no redeploy. Posts are written as `.mdx` files into a content
directory on a mounted Docker volume, then the affected routes are revalidated
so the post is live immediately.

Built for the **App Router**. Requires Next.js 13.4+ (uses `revalidatePath`).

## 1. Copy the route in

```
cp -r nextjs-bridge/app/api/seo-bridge  <your-nextjs-repo>/app/api/
```

Final path: `app/api/seo-bridge/[[...path]]/route.ts`

## 2. Set the environment variables

```bash
# REQUIRED — the bridge refuses every request until this is set (it never
# defaults to open). Generate one with: openssl rand -hex 32
SEO_BRIDGE_TOKEN=<long random secret>

# OPTIONAL — defaults shown
SEO_BRIDGE_CONTENT_DIR=content/posts     # where your blog pages read posts from
SEO_BRIDGE_REVALIDATE_PATHS=/blog        # comma-separated paths to revalidate
```

Set `SEO_BRIDGE_CONTENT_DIR` to whatever directory your **existing** blog pages
already read from. Step 4 verifies you got it right.

## 3. Mount the content directory as a volume

Posts written into the container are lost on rebuild unless the directory is a
volume. In your `docker-compose.yml`:

```yaml
services:
  web:
    # ...your existing Next.js service...
    environment:
      - SEO_BRIDGE_TOKEN=${SEO_BRIDGE_TOKEN}
      - SEO_BRIDGE_CONTENT_DIR=content/posts
      - SEO_BRIDGE_REVALIDATE_PATHS=/blog
    volumes:
      - blog_content:/app/content/posts     # adjust /app to your WORKDIR

volumes:
  blog_content:
```

If your build bakes existing posts into the image, copy them into the volume
once so nothing disappears:

```bash
docker compose cp web:/app/content/posts/. ./seed-posts/
docker compose run --rm -v "$PWD/seed-posts:/seed" web sh -c 'cp -n /seed/* /app/content/posts/'
```

## 4. Verify before connecting

```bash
curl -s -H "Authorization: Bearer $SEO_BRIDGE_TOKEN" \
  https://your-site.com/api/seo-bridge/health | jq
```

Expected:

```json
{
  "ok": true,
  "contentDir": "content/posts",
  "canWrite": true,
  "postCount": 12,
  "revalidatePaths": ["/blog"],
  "sampleFrontmatter": { "title": "...", "date": "...", "description": "..." }
}
```

Check two things:
- **`canWrite: true`** — if false, the volume isn't writable by the container user.
- **`sampleFrontmatter`** — these are the keys your existing posts actually use.
  If your blog expects keys the bridge doesn't write by default (it writes
  `title`, `date`, `description`, `tags`, `draft`), pass the extras through the
  `frontmatter` field when publishing and new posts will match your schema.

## 5. Enable editable meta titles &amp; descriptions

A static page keeps its metadata in `generateMetadata()`, which is TypeScript —
nothing outside your repo can rewrite it. So the bridge stores overrides in
`_seo-meta.json` on your content volume, and your pages read them at render
time. One line per page, once, and titles/descriptions become editable from the
platform forever after.

```
cp nextjs-bridge/lib/seo-meta.ts  <your-nextjs-repo>/lib/
```

Then wrap each page's metadata:

```ts
import { withSeoMeta } from "@/lib/seo-meta";

export async function generateMetadata(): Promise<Metadata> {
  return withSeoMeta("/about", {
    title: "About us",              // your defaults, used when no
    description: "Who we are.",     // override is set
  });
}
```

For a dynamic route, pass the resolved path:

```ts
export async function generateMetadata({ params }): Promise<Metadata> {
  const post = await getPost(params.slug);
  return withSeoMeta(`/blog/${params.slug}`, {
    title: post.title,
    description: post.description,
  });
}
```

An override always wins over your defaults; clearing it in the platform hands
control back to your code. Pages you don't wrap simply aren't editable — they
still get audited and scored.

### Which metadata fields your bridge can store

There are two metadata contracts in the wild, and the platform **discovers**
which one you implement from the shape of `GET /meta` rather than assuming:

| Your `GET /meta` returns | Contract | Write endpoint | Fields it can store |
|---|---|---|---|
| `{"meta": {"/about": {…}}}` | override store (this reference bridge) | `PUT /meta` with `{path, …}` | `title`, `description`, `canonical`, `ogTitle`, `ogDescription`, `ogImage`, `noindex` |
| `{"pages": [{"slug": …}]}` | page record keyed by slug | `PUT /pages/:slug` | `title`, `description`, `ogImage` |

This matters because a bridge handed a body it doesn't recognise still answers
`200 OK`, echoes back the metadata it already had, and writes nothing. The
platform therefore verifies every write against that echo, and reports any
field your bridge could not store as *unsupported* rather than showing it as
saved. The On-Page SEO tab shows you which fields are which, and generates the
`generateMetadata()` code for the rest.

If you implement the slug-keyed contract, expose the home page under the slug
`home` (or `index`) — an empty slug isn't addressable in a URL, and without it
the site's most important page is the one page whose title can't be edited.

## 6. Enable editable body copy (for keyword optimization)

Meta titles/descriptions aren't the only thing worth rewording for a target
keyword — the visible page copy usually matters more. Wrap whichever pieces
of body text you want the platform to be able to edit:

```
cp nextjs-bridge/lib/page-content.tsx  <your-nextjs-repo>/lib/
```

The default pattern is `<Editable>` — wraps any text node in JSX, one import:

```tsx
import { Editable } from "@/lib/page-content";

export default function AboutPage() {
  return (
    <div>
      <h1><Editable path="/about" id="h1">Who we are</Editable></h1>
      <p><Editable path="/about" id="intro">
        We've been building great products since 2015.
      </Editable></p>
    </div>
  );
}
```

For text used outside JSX (`generateMetadata`, computed before render), use
the function form instead:

```ts
import { getContentBlock, getContentBlocks } from "@/lib/page-content";

const { heroTitle, heroSubtitle } = await getContentBlocks("/", {
  heroTitle: "Build faster, ship sooner",
  heroSubtitle: "Everything you need in one platform.",
});
```

For a whole section of formatted copy (paragraphs, bold, links) — or to make
an ENTIRE page's body editable as one piece of content, the same way a blog
post is edited as one piece of content — use `<EditableHtml>` instead. It
renders the stored value as real HTML rather than escaped text:

```tsx
import { EditableHtml } from "@/lib/page-content";

export default async function AboutPage() {
  return (
    <div className="prose">
      <EditableHtml path="/about" id="body">
        {`<h1>Who we are</h1><p>We've been building great products since 2015.</p>`}
      </EditableHtml>
    </div>
  );
}
```

Either pattern is editable the same way from the platform's Live Editor: a
`<Editable>` block gets a plain text field, an `<EditableHtml>` block gets a
full split-pane editor with a live rendered preview (same as blog posts).

A block's first render registers its default in the same JSON store the
bridge writes to, so it shows up as editable in the platform without a
manifest step — nothing needs listing until it has actually been rendered
once. An edit made from the platform always wins over the default you pass
in code; clearing it there hands control back to your code, same as meta
overrides.

Only wrap text on pages that aren't `force-static` — the bridge revalidates
the route after every edit, and that only takes effect on pages eligible for
revalidation (the default, or explicit ISR).

## 7. Enable editable image alt text

```
cp nextjs-bridge/lib/editable-image.tsx  <your-nextjs-repo>/lib/
```

`<EditableImg>` is a drop-in replacement for `<img>` — every prop passes
through unchanged except `alt`, which is swapped for the stored override:

```tsx
import { EditableImg } from "@/lib/editable-image";

<EditableImg path="/about" id="team-photo" src="/team.jpg"
  alt="Our team at the 2024 offsite" className="rounded-lg" />
```

Outside JSX, or for `next/image`'s `alt` prop, use the function form:

```ts
import { getImageAlt } from "@/lib/editable-image";

const alt = await getImageAlt("/about", "team-photo", "Our team.");
```

Same self-registration behavior as body-copy blocks — the first render
records the image's default alt (and its `src`, so the platform can show a
thumbnail) in a separate store (`_image-alt.json`), and it becomes editable
from the platform's Live Editor with an AI "Generate with AI" option (Claude
vision writes SEO alt text directly from the live image).

## 8. Applying this to every page — including ones you haven't built yet

Wrapping copy and images is a per-page, one-time edit — nothing makes it
automatic on its own. Two situations to cover:

- **Existing pages**: retrofit them all in one pass.
- **Future pages**: whoever/whatever builds new pages on this site needs to
  apply the same `<Editable>`/`<EditableImg>` pattern by default, without
  being asked each time.

If an AI coding agent (Claude Code, Cursor, etc.) maintains this repo, the
fastest way to cover both is to hand it the prompt below once. It retrofits
what exists today AND adds a standing rule to the repo (its `CLAUDE.md` /
`.cursorrules` / equivalent) so the agent keeps doing this on every future
page without a repeat prompt.

```
This repo is a self-hosted Next.js site with the SEO Bridge installed
(app/api/seo-bridge/[[...path]]/route.ts + lib/page-content.tsx +
lib/editable-image.tsx). It lets an external SEO platform edit page copy and
image alt text at runtime for keyword/SEO optimization — no rebuild — by
reading/writing JSON files on this app's content volume.

First, confirm this deployment can actually support it: the bridge writes to
JSON files on disk and expects them to persist across requests and rebuilds.
That's true for a self-hosted Docker/VPS deployment with a mounted volume,
but NOT true on Vercel or other serverless hosts (ephemeral, non-shared
filesystem). Check how this app is deployed before doing anything else —
if it's serverless, stop and tell me instead of proceeding.

If it checks out, do the following:

1. Retrofit every existing page under app/ (excluding pure UI chrome — nav
   labels, buttons, footers, form placeholders):

   a. Wrap its real content copy — H1s, headings, intro/lead paragraphs, key
      body paragraphs, CTA copy that carries a message rather than a generic
      action — in <Editable> from @/lib/page-content, e.g.:

        <h1><Editable path="/about" id="h1">Who we are</Editable></h1>

      Use the page's route as `path` and a short, stable, kebab-or-camelCase
      `id` unique within that page (h1, intro, section-1-heading, etc.). Use
      getContentBlock/getContentBlocks instead when the text is needed
      outside JSX (e.g. inside generateMetadata). For a page whose body is
      one continuous piece of formatted copy rather than distinct fields,
      wrap the whole thing in a single <EditableHtml> block instead of many
      small <Editable> ones — your call, based on how the page is actually
      structured.

   b. Replace every meaningful content <img> (not icons, logos, or decorative
      background images) with <EditableImg> from @/lib/editable-image, e.g.:

        <EditableImg path="/about" id="team-photo" src="/team.jpg"
          alt="Our team at the 2024 offsite" />

      Keep all existing props (src, className, width, height, etc.) — only
      the element name changes. Use the same `path`/`id` conventions as
      above.

   Do not wrap text or images on any page marked
   `export const dynamic = "force-static"` — either wrap it there too after
   removing that flag, or skip it and tell me which pages you skipped and
   why.

2. Add a permanent rule to this repo's AI agent instructions (CLAUDE.md, or
   create one if it doesn't exist) stating: every new page added to this
   site must (a) wrap its real content copy (headings, intro/lead
   paragraphs, key body paragraphs, meaningful CTA copy) in
   <Editable path="{route}" id="{...}"> (or <EditableHtml> for a whole
   section of formatted copy) from @/lib/page-content, and (b) wrap every
   meaningful content <img> in <EditableImg> from @/lib/editable-image —
   unless the page is `force-static`. Do not wrap navigation, buttons, icons,
   logos, or other UI chrome — only content a marketer would want to reword
   or re-caption for SEO/keyword targeting.

3. Report back: which pages/images you wrapped, which you skipped and why,
   and confirm the "future pages" rule was added to the repo's instructions
   file.
```

Point that at whatever tool built/maintains the site's codebase — this
platform doesn't have access to that repo, so the wiring has to happen there.

## 9. Connect it in the SEO platform

Sites → Add Site → platform **Next.js / other**, then supply the site URL, the
bridge URL (`https://your-site.com/api/seo-bridge`) and the token.

## Security notes

- The token is compared in constant time, and an unset token disables the route
  entirely rather than leaving it open.
- Slugs are restricted to `[a-z0-9-]`, so path traversal isn't possible; the
  resolved path is additionally checked to be inside the content directory.
- Serve this over HTTPS only — the token is a bearer credential.
- The route is `force-dynamic` and never cached.
