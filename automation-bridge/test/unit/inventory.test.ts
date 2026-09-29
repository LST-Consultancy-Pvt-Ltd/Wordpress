import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanRoutes } from "../../src/core/inventory.js";
import { makeBridge, tmpDir } from "../helpers.js";

describe("route inventory", () => {
  it("discovers App Router pages, handlers, layouts, groups, dynamic and unsupported routes", async () => {
    const { client } = await makeBridge();
    const r = await client.get("/inventory/routes");
    expect(r.status).toBe(200);
    const byKey = Object.fromEntries(r.json.items.map((i: { route: string; kind: string }) => [`${i.kind} ${i.route}`, i]));
    expect(byKey["page /"]).toMatchObject({ metadata: "generateMetadata-optin", blocks: ["home.hero.title", "home.hero.image"], source: { root: "code", path: "app/page.tsx" } });
    expect(byKey["page /about"].metadata).toBe("generateMetadata-optin");
    expect(byKey["page /pricing"]).toMatchObject({ metadata: "static", source: { path: "app/(marketing)/pricing/page.tsx" } });
    expect(byKey["page /blog"].metadata).toBe("none");
    expect(byKey["page /blog/[slug]"]).toMatchObject({ dynamic: true, adapter: "posts", metadata: "generateMetadata-optin" });
    expect(byKey["page /docs/[...parts]"].dynamic).toBe(true);
    expect(byKey["route-handler /api/hello"]).toBeTruthy();
    expect(byKey["layout /"]).toBeTruthy();
    expect(Object.keys(byKey).some((k) => k.includes("_components"))).toBe(false);
    expect(r.json.unsupported.map((u: { reason: string }) => u.reason).sort()).toEqual(["intercepting route is not supported", "parallel route (@slot) is not supported"]);
    const caps = await client.get("/capabilities");
    expect(caps.json.nextjs).toEqual({ version: "15.5.0", router: "app" });
    const un = await client.get("/inventory/unsupported");
    expect(un.json.items.some((i: { feature: string; reason: string }) => i.feature === "static metadata in app/(marketing)/pricing/page.tsx" && /not opted in/.test(i.reason))).toBe(true);
  });

  it("handles the Pages Router", async () => {
    const d = tmpDir();
    fs.mkdirSync(path.join(d, "pages/blog"), { recursive: true });
    fs.mkdirSync(path.join(d, "pages/api"), { recursive: true });
    for (const f of ["index.tsx", "_app.tsx", "_document.tsx", "blog/[slug].tsx", "api/ping.ts", "about.jsx"]) fs.writeFileSync(path.join(d, "pages", f), "export default 1");
    const inv = await scanRoutes({ codeRoot: d, codeRootId: "code", manifest: { version: 1, blocks: [] }, collections: [] });
    expect(inv.router).toBe("pages");
    expect(inv.items.map((i) => `${i.kind} ${i.route}`)).toEqual(["page /", "page /about", "route-handler /api/ping", "page /blog/[slug]"]);
    expect(inv.items[0]!.metadata).toBe("unknown");
  });

  it("lists assets with hashes (paginated) and never exposes absolute paths", async () => {
    const { client, f } = await makeBridge();
    fs.writeFileSync(path.join(f.assets, "images/b.png"), "B");
    fs.writeFileSync(path.join(f.assets, ".env"), "SECRET");
    const p1 = await client.get("/inventory/assets?limit=1");
    expect(p1.json.items).toEqual([{ root: "assets", path: "images/b.png", bytes: 1, sha256: expect.any(String) }]);
    const p2 = await client.get(`/inventory/assets?limit=1&cursor=${p1.json.next_cursor}`);
    expect(p2.json.items[0].path).toBe("images/pic.png");
    expect(p2.json.next_cursor).toBeNull();
    for (const ep of ["/capabilities", "/health", "/inventory/routes", "/content/posts/items/hello-world"]) {
      const r = await client.get(ep);
      expect(JSON.stringify(r.json), ep).not.toContain(f.dir);
    }
  });

  it("health reports checks", async () => {
    const { client } = await makeBridge();
    const h = await client.get("/health");
    expect(h.json.status).toBe("ok");
    expect(h.json.checks.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(["state_dir_writable", "root:content", "disk_free"]));
  });
});
