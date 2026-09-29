import { describe, expect, it } from "vitest";
import { ConfigSchema, resolveConfig } from "../../src/core/config.js";
import { checkRoute, matchRoutePattern } from "../../src/core/route.js";
import { ApplyRequest, MetadataFields, Operation, PlanRequest } from "../../src/core/schemas.js";
import { buildOpenApi } from "../../src/core/openapi.js";
import { fixtureConfigInput, makeFixture } from "../helpers.js";

describe("operation schemas", () => {
  it("accepts every documented operation", () => {
    const sha = "a".repeat(64);
    const ops = [
      { op: "content.upsert", collection: "posts", slug: "a-b", status: "draft", frontmatter: {}, body: "", base_sha256: null },
      { op: "content.delete", collection: "posts", slug: "a", base_sha256: sha },
      { op: "metadata.set", route: "/", fields: { title: "x", robots: { index: true, follow: true }, jsonLd: [{ "@type": "Thing" }] } },
      { op: "metadata.clear", route: "/a" },
      { op: "block.set", block_id: "home.hero", value: "x", format: "text" },
      { op: "block.clear", block_id: "home.hero" },
      { op: "image.alt.set", image_id: "img", alt: "x" },
      { op: "image.alt.clear", image_id: "img" },
      { op: "redirect.upsert", source: "/old", destination: "https://example.com/new", permanent: true },
      { op: "redirect.delete", source: "/old" },
      { op: "file.write", root: "code", path: "app/x.tsx", content: "", base_sha256: null },
      { op: "file.delete", root: "code", path: "app/x.tsx", base_sha256: sha },
    ];
    for (const o of ops) expect(Operation.safeParse(o).success, o.op).toBe(true);
  });
  it("rejects unknown ops, extra fields and bad values", () => {
    expect(Operation.safeParse({ op: "shell.exec", cmd: "rm -rf /" }).success).toBe(false);
    expect(Operation.safeParse({ op: "metadata.clear", route: "/", extra: 1 }).success).toBe(false);
    expect(Operation.safeParse({ op: "metadata.clear", route: "/../etc" }).success).toBe(false);
    expect(Operation.safeParse({ op: "metadata.clear", route: "/a?b=1" }).success).toBe(false);
    expect(Operation.safeParse({ op: "content.delete", collection: "posts", slug: "../x", base_sha256: "a".repeat(64) }).success).toBe(false);
    expect(Operation.safeParse({ op: "image.alt.set", image_id: "i", alt: "x".repeat(251) }).success).toBe(false);
    expect(Operation.safeParse({ op: "redirect.upsert", source: "/a", destination: "http://insecure.example", permanent: true }).success).toBe(false);
    expect(Operation.safeParse({ op: "redirect.upsert", source: "/a", destination: "javascript:alert(1)", permanent: true }).success).toBe(false);
  });
  it("normalises trailing slashes and accepts the write-probe route", () => {
    const r = Operation.parse({ op: "metadata.clear", route: "/about/" });
    expect(r.op === "metadata.clear" && r.route).toBe("/about");
    expect(Operation.safeParse({ op: "metadata.set", route: "/__automation-write-probe", fields: { title: "probe" } }).success).toBe(true);
  });
  it("validates metadata fields", () => {
    expect(MetadataFields.safeParse({ canonical: "/x" }).success).toBe(true);
    expect(MetadataFields.safeParse({ canonical: "http://x.example" }).success).toBe(false);
    expect(MetadataFields.safeParse({ jsonLd: [{ name: "no type" }] }).success).toBe(false);
    expect(MetadataFields.safeParse({ jsonLd: [{ "@type": "T", big: "x".repeat(33 * 1024) }] }).success).toBe(false);
    expect(MetadataFields.safeParse({ title: "x".repeat(301) }).success).toBe(false);
  });
  it("plan and apply requests", () => {
    expect(PlanRequest.safeParse({ change_id: "cs_1", operations: [{ op: "metadata.clear", route: "/" }], base_revision: null }).success).toBe(true);
    expect(PlanRequest.safeParse({ change_id: "cs_1", operations: [] }).success).toBe(false);
    expect(ApplyRequest.safeParse({ change_id: "cs_1", operations: [{ op: "metadata.clear", route: "/" }], expected_plan_sha256: "zz" }).success).toBe(false);
  });
});

describe("routes", () => {
  it("checks and matches patterns", () => {
    expect(checkRoute("/")).toEqual({ ok: true, route: "/" });
    expect(checkRoute("/a//b").ok).toBe(false);
    expect(checkRoute("/%2e%2e/x").ok).toBe(false);
    expect(checkRoute("relative").ok).toBe(false);
    expect(matchRoutePattern("/blog/[slug]", "/blog/hello")).toBe(true);
    expect(matchRoutePattern("/blog/[slug]", "/blog/a/b")).toBe(false);
    expect(matchRoutePattern("/docs/[...p]", "/docs/a/b")).toBe(true);
    expect(matchRoutePattern("/docs/[...p]", "/docs")).toBe(false);
    expect(matchRoutePattern("/shop/[[...p]]", "/shop")).toBe(true);
  });
});

describe("config", () => {
  it("rejects unknown keys and bad references", () => {
    const f = makeFixture();
    const base = fixtureConfigInput(f);
    expect(ConfigSchema.safeParse({ ...base, surprise: true }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...base, overrides_root: "nope" }).success).toBe(false);
    expect(() => resolveConfig({ ...base, state_dir: f.overrides + "/state" }, { baseDir: f.dir, env: {} })).toThrow(/state_dir/);
  });
  it("parses the backup key", () => {
    const f = makeFixture();
    const cfg = resolveConfig(fixtureConfigInput(f), { baseDir: f.dir, env: { BRIDGE_BACKUP_KEY: "ab".repeat(32) } });
    expect(cfg.secrets.backupKey?.length).toBe(32);
    expect(() => resolveConfig(fixtureConfigInput(f), { baseDir: f.dir, env: { BRIDGE_BACKUP_KEY: "short" } })).toThrow();
  });
});

describe("openapi", () => {
  it("is OpenAPI 3.1 and covers the endpoints", () => {
    const doc = buildOpenApi() as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    for (const p of ["/capabilities", "/changesets/plan", "/changesets/apply", "/revisions/{id}/rollback", "/deployments", "/backups/{id}/restore", "/audit"]) {
      expect(doc.paths[`/api/automation-bridge/v1${p}`], p).toBeTruthy();
    }
  });
});
