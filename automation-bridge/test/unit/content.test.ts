import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHttpContentAdapter } from "../../src/core/content/http-adapter.js";
import { splitFrontmatter, joinFrontmatter } from "../../src/core/content/frontmatter.js";
import { renderContentHtml } from "../../src/next/runtime.js";
import { makeBridge } from "../helpers.js";

describe("front matter", () => {
  it("round-trips and keeps dates as strings", () => {
    const raw = joinFrontmatter({ title: "T", date: "2024-01-01", tags: ["a", "b"], jsonLd: { "@type": "Article" } }, "Body ![x](/i.png)\n");
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toEqual({ title: "T", date: "2024-01-01", tags: ["a", "b"], jsonLd: { "@type": "Article" } });
    expect(body).toBe("Body ![x](/i.png)\n");
    expect(splitFrontmatter("---\ndate: 2024-01-01\n---\nx").frontmatter.date).toBe("2024-01-01");
    expect(splitFrontmatter("no front matter").body).toBe("no front matter");
  });
});

describe("mdx adapter", () => {
  it("lists, reads, filters by status and exposes route_pattern", async () => {
    const { client } = await makeBridge();
    const cols = await client.get("/content/collections");
    expect(cols.json.items.find((c: { id: string }) => c.id === "posts")).toMatchObject({ kind: "mdx", root: "content", route_pattern: "/blog/[slug]", operations: ["read", "create", "update", "delete"] });
    const caps = await client.get("/capabilities");
    expect(caps.json.content_adapters.map((a: { route_pattern: string | null }) => a.route_pattern)).toEqual(["/blog/[slug]", "/[slug]"]);
    const all = await client.get("/content/posts/items?status=all");
    expect(all.json.items.map((i: { slug: string; status: string }) => `${i.slug}:${i.status}`)).toEqual(["hello-world:published", "draft-one:draft"]);
    const pub = await client.get("/content/posts/items?status=published&limit=1");
    expect(pub.json.items.length).toBe(1);
    const item = await client.get("/content/posts/items/hello-world");
    expect(item.json).toMatchObject({ slug: "hello-world", status: "published", frontmatter: { title: "Hello world", date: "2024-01-01" }, path: { root: "content", path: "posts/hello-world.mdx" } });
    expect(item.json.body).toContain("![pic](/images/pic.png)");
    expect((await client.get("/content/posts/items/nope")).status).toBe(404);
    expect([400, 404]).toContain((await client.get("/content/posts/items/..%2F..%2Fetc")).status);
    expect((await client.get("/content/posts/items/Bad_Slug")).status).toBe(400);
    expect((await client.get("/content/unknown/items")).status).toBe(404);
  });

  it("creates drafts in _drafts, publishes by moving, validates front matter and base hashes", async () => {
    const { client, f } = await makeBridge();
    const create = await client.planAndApply([{ op: "content.upsert", collection: "posts", slug: "new-post", status: "draft", frontmatter: { title: "New" }, body: "Body ![a](/images/a.png)\n", base_sha256: null }]);
    expect(create.apply!.status).toBe(200);
    expect(create.plan.json.impacted_routes).toEqual([]);
    const draftFile = path.join(f.content, "posts/_drafts/new-post.mdx");
    expect(fs.readFileSync(draftFile, "utf8")).toContain("![a](/images/a.png)");
    const item = await client.get("/content/posts/items/new-post");
    const pub = await client.planAndApply([{ op: "content.upsert", collection: "posts", slug: "new-post", status: "published", frontmatter: { title: "New" }, body: "Body\n", base_sha256: item.json.sha256 }]);
    expect(pub.apply!.status).toBe(200);
    expect(pub.plan.json.impacted_routes).toEqual(["/blog", "/blog/new-post"]);
    expect(fs.existsSync(draftFile)).toBe(false);
    expect(fs.existsSync(path.join(f.content, "posts/new-post.mdx"))).toBe(true);
    const stale = await client.post("/changesets/plan", { change_id: "c", operations: [{ op: "content.upsert", collection: "posts", slug: "new-post", status: "published", frontmatter: { title: "x" }, body: "", base_sha256: item.json.sha256 }] }, null);
    expect(stale.json.errors[0].code).toBe("CONFLICT_REVISION");
    const exists = await client.post("/changesets/plan", { change_id: "c", operations: [{ op: "content.upsert", collection: "posts", slug: "new-post", status: "draft", frontmatter: { title: "x" }, body: "", base_sha256: null }] }, null);
    expect(exists.json.errors[0].code).toBe("CONFLICT_REVISION");
    const invalid = await client.post("/changesets/plan", { change_id: "c", operations: [{ op: "content.upsert", collection: "posts", slug: "bad", status: "draft", frontmatter: { date: "yesterday" }, body: "", base_sha256: null }] }, null);
    expect(invalid.json.errors[0].code).toBe("VALIDATION_FAILED");
    expect(invalid.json.errors[0].message).toMatch(/title is required/);
    const cur = await client.get("/content/posts/items/new-post");
    const del = await client.planAndApply([{ op: "content.delete", collection: "posts", slug: "new-post", base_sha256: cur.json.sha256 }]);
    expect(del.plan.json.risk.flags).toContain("deletes-content");
    expect(del.apply!.status).toBe(200);
    expect(fs.existsSync(path.join(f.content, "posts/new-post.mdx"))).toBe(false);
  });

  it("accepts AI-generated HTML posts (content_format html) with arrays, keywords and a jsonLd object", async () => {
    const { client, f } = await makeBridge();
    const html = '<h2 style="color:#333">Intro</h2><p style="margin:0">Text <img src="/images/x.png" alt="x"></p><script>alert(1)</script>';
    const fm = { title: "AI post", content_format: "html", tags: ["seo", "ai"], categories: ["news"], description: "d", keywords: "a, b", jsonLd: { "@type": "Article", headline: "AI post" } };
    const r = await client.planAndApply([{ op: "content.upsert", collection: "posts", slug: "ai-post", status: "published", frontmatter: fm, body: html, base_sha256: null }]);
    expect(r.plan.json.valid).toBe(true);
    expect(r.plan.json.warnings).toEqual([]);
    expect(r.apply!.status).toBe(200);
    const item = await client.get("/content/posts/items/ai-post");
    expect(item.json.body).toBe(html); // stored verbatim
    expect(item.json.frontmatter).toEqual(fm);
    const rendered = renderContentHtml(item.json.frontmatter, item.json.body);
    expect(rendered.format).toBe("html");
    if (rendered.format === "html") {
      expect(rendered.html).toContain('<img src="/images/x.png" alt="x" />');
      expect(rendered.html).not.toMatch(/style=|<script/);
    }
    expect(fs.readFileSync(path.join(f.content, "posts/ai-post.mdx"), "utf8")).toContain("content_format: html");
  });

  it("flags MDX bodies that execute code", async () => {
    const { client } = await makeBridge();
    const r = await client.post("/changesets/plan", { change_id: "c", operations: [{ op: "content.upsert", collection: "posts", slug: "x", status: "draft", frontmatter: { title: "x" }, body: "import X from 'y'\n\n<X />", base_sha256: null }] }, null);
    expect(r.json.warnings[0].code).toBe("MDX_EXECUTABLE_CONTENT");
    expect(r.json.risk).toEqual({ level: "high", flags: ["code-change"] });
  });
});

describe("json adapter", () => {
  it("reads and writes JSON documents", async () => {
    const { client, f } = await makeBridge();
    const item = await client.get("/content/pages/items/team");
    expect(item.json).toMatchObject({ frontmatter: { title: "Team" }, body: "We" });
    const r = await client.planAndApply([{ op: "content.upsert", collection: "pages", slug: "team", status: "published", frontmatter: { title: "Our team" }, body: "Us", base_sha256: item.json.sha256 }]);
    expect(r.apply!.status).toBe(200);
    expect(r.plan.json.impacted_routes).toEqual(["/team"]);
    expect(JSON.parse(fs.readFileSync(path.join(f.content, "pages/team.json"), "utf8"))).toEqual({ body: "Us", frontmatter: { title: "Our team" } });
  });
});

describe("custom HTTP adapter (read-only stub)", () => {
  const fakeFetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/items?status=all") || u.endsWith("/items?status=published")) return Response.json([{ slug: "cms-one", title: "From CMS", status: "published" }, { slug: "BAD SLUG" }]);
    if (u.endsWith("/items/cms-one")) return Response.json({ slug: "cms-one", status: "published", frontmatter: { title: "From CMS" }, body: "hello" });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;

  it("reports read-only capabilities honestly and refuses writes", async () => {
    const adapter = createHttpContentAdapter({ id: "news", baseUrl: "https://cms.example/api", fetch: fakeFetch, routePattern: "/news/[slug]" });
    const { client } = await makeBridge(
      {
        content: { collections: [{ id: "news", kind: "custom", adapter: "cms", route_pattern: "/news/[slug]" }] },
      },
      { adapters: { cms: adapter } },
    );
    const caps = await client.get("/capabilities");
    expect(caps.json.capabilities["content.read"]).toBe(true);
    expect(caps.json.capabilities["content.write"]).toBe(false);
    expect(caps.json.content_adapters).toEqual([{ id: "news", kind: "custom", root: null, operations: ["read"], frontmatter_schema: null, route_pattern: "/news/[slug]" }]);
    const list = await client.get("/content/news/items");
    expect(list.json.items.map((i: { slug: string }) => i.slug)).toEqual(["cms-one"]);
    const one = await client.get("/content/news/items/cms-one");
    expect(one.json).toMatchObject({ body: "hello", path: null });
    const w = await client.post("/changesets/plan", { change_id: "c", operations: [{ op: "content.upsert", collection: "news", slug: "x", status: "draft", frontmatter: {}, body: "", base_sha256: null }] }, null);
    expect(w.json.errors[0].code).toBe("CAPABILITY_UNSUPPORTED");
  });

  it("a custom collection without a registered adapter is excluded and reported", async () => {
    const { client } = await makeBridge({ content: { collections: [{ id: "news", kind: "custom", adapter: "missing" }] } });
    expect((await client.get("/content/collections")).json.items).toEqual([]);
    const u = await client.get("/inventory/unsupported");
    expect(u.json.items.some((i: { feature: string }) => i.feature === "collection news")).toBe(true);
  });
});
