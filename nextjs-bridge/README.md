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

## 6. Connect it in the SEO platform

Sites → Add Site → platform **Next.js / other**, then supply the site URL, the
bridge URL (`https://your-site.com/api/seo-bridge`) and the token.

## Security notes

- The token is compared in constant time, and an unset token disables the route
  entirely rather than leaving it open.
- Slugs are restricted to `[a-z0-9-]`, so path traversal isn't possible; the
  resolved path is additionally checked to be inside the content directory.
- Serve this over HTTPS only — the token is a bearer credential.
- The route is `force-dynamic` and never cached.
