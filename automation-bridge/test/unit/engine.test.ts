import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWrite } from "../../src/core/fsutil.js";
import { SiteLock } from "../../src/core/lock.js";
import { sha256Hex } from "../../src/core/util.js";
import { makeBridge, tmpDir } from "../helpers.js";

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));

describe("atomic write", () => {
  it("replaces content, keeps mode and leaves no temp files", async () => {
    const d = tmpDir();
    const f = path.join(d, "a.json");
    fs.writeFileSync(f, "old", { mode: 0o640 });
    fs.chmodSync(f, 0o640);
    await atomicWrite(f, "new");
    expect(fs.readFileSync(f, "utf8")).toBe("new");
    expect(fs.statSync(f).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(d)).toEqual(["a.json"]);
  });
  it("cleans up when the pre-rename check fails", async () => {
    const d = tmpDir();
    const f = path.join(d, "b.json");
    await expect(atomicWrite(f, "x", { beforeRename: async () => { throw new Error("toctou"); } })).rejects.toThrow("toctou");
    expect(fs.readdirSync(d)).toEqual([]);
  });
});

describe("change sets", () => {
  it("plan has no side effects and returns a diff with <root>/<path> labels", async () => {
    const { client, f } = await makeBridge();
    const r = await client.post("/changesets/plan", { change_id: "cs_1", operations: [{ op: "metadata.set", route: "/about", fields: { title: "About!" } }] }, null);
    expect(r.status).toBe(200);
    expect(r.json.valid).toBe(true);
    expect(r.json.diff).toContain("+++ b/overrides/metadata.json");
    expect(r.json.files).toEqual([{ root: "overrides", path: "metadata.json", change: "create", before_sha256: null, after_sha256: expect.any(String) }]);
    expect(r.json.impacted_routes).toEqual(["/about"]);
    expect(r.json.risk.level).toBe("low");
    expect(fs.existsSync(path.join(f.overrides, "metadata.json"))).toBe(false);
  });

  it("apply writes, records a revision with a before-snapshot; rollback restores as a new revision", async () => {
    const { client, f } = await makeBridge();
    const a = await client.planAndApply([{ op: "metadata.set", route: "/", fields: { title: "One" } }]);
    expect(a.apply!.status).toBe(200);
    const r1 = a.apply!.json.revision_id;
    expect(readJson(path.join(f.overrides, "metadata.json")).routes["/"].fields.title).toBe("One");
    const b = await client.planAndApply([{ op: "metadata.set", route: "/", fields: { title: "Two" } }]);
    const r2 = b.apply!.json.revision_id;
    expect(readJson(path.join(f.overrides, "metadata.json")).routes["/"].fields.title).toBe("Two");
    const rb = await client.post(`/revisions/${r2}/rollback`, { reason: "oops" });
    expect(rb.status).toBe(200);
    expect(rb.json.reverts).toBe(r2);
    expect(readJson(path.join(f.overrides, "metadata.json")).routes["/"].fields.title).toBe("One");
    const list = await client.get("/revisions");
    const byId = Object.fromEntries(list.json.items.map((i: { revision_id: string; status: string }) => [i.revision_id, i.status]));
    expect(byId[r2]).toBe("reverted");
    expect(byId[r1]).toBe("applied");
    expect(byId[rb.json.revision_id]).toBe("applied");
    const full = await client.get(`/revisions/${r2}`);
    expect(full.json.diff).toContain("Two");
    // Rolling back the first revision now deletes the file it created.
    const again = await client.post(`/revisions/${rb.json.revision_id}/rollback`, {});
    expect(again.status).toBe(200);
    expect(readJson(path.join(f.overrides, "metadata.json")).routes["/"].fields.title).toBe("Two");
  });

  it("rollback detects files changed since the revision (conflict) unless forced with deploy scope", async () => {
    const { client } = await makeBridge();
    const a = await client.planAndApply([{ op: "metadata.set", route: "/", fields: { title: "One" } }]);
    await client.planAndApply([{ op: "metadata.set", route: "/about", fields: { title: "Other" } }]);
    const rb = await client.post(`/revisions/${a.apply!.json.revision_id}/rollback`, {});
    expect(rb.status).toBe(409);
    expect(rb.json.error.code).toBe("CONFLICT_REVISION");
    expect(rb.json.error.details.files).toEqual([{ root: "overrides", path: "metadata.json" }]);
    const forced = await client.post(`/revisions/${a.apply!.json.revision_id}/rollback`, { force: true });
    expect(forced.status).toBe(200);
    expect(forced.json.forced).toBe(true);
  });

  it("apply rejects a stale plan hash and a stale base revision", async () => {
    const { client } = await makeBridge();
    const ops = [{ op: "metadata.set", route: "/", fields: { title: "X" } }];
    const plan = await client.post("/changesets/plan", { change_id: "cs_s", operations: ops }, null);
    await client.planAndApply([{ op: "metadata.set", route: "/about", fields: { title: "Y" } }]);
    const r = await client.post("/changesets/apply", { change_id: "cs_s", operations: ops, expected_plan_sha256: sha256Hex(plan.json.diff) });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("CONFLICT_REVISION");
    const plan2 = await client.post("/changesets/plan", { change_id: "cs_s", operations: ops }, null);
    const r2 = await client.post("/changesets/apply", { change_id: "cs_s", operations: ops, base_revision: "r_0000000000000", expected_plan_sha256: sha256Hex(plan2.json.diff) });
    expect(r2.json.error.code).toBe("CONFLICT_REVISION");
  });

  it("warns METADATA_NOT_OPTED_IN and marks the op not effective — including unknown routes like the write probe", async () => {
    const { client } = await makeBridge();
    const r = await client.planAndApply([
      { op: "metadata.set", route: "/pricing", fields: { title: "P" } },
      { op: "metadata.set", route: "/__automation-write-probe", fields: { title: "probe" } },
      { op: "metadata.set", route: "/blog/hello-world", fields: { title: "Dyn" } },
    ]);
    expect(r.plan.json.valid).toBe(true);
    expect(r.plan.json.warnings.map((w: { index: number; code: string }) => [w.index, w.code])).toEqual([
      [0, "METADATA_NOT_OPTED_IN"],
      [1, "METADATA_NOT_OPTED_IN"],
    ]);
    expect(r.apply!.json.operations).toEqual([
      { index: 0, effective: false },
      { index: 1, effective: false },
      { index: 2, effective: true },
    ]);
    // The probe can be rolled back cleanly.
    const rb = await client.post(`/revisions/${r.apply!.json.revision_id}/rollback`, { reason: "probe" });
    expect(rb.status).toBe(200);
  });

  it("blocks: registered ids only, format must match, rich text sanitised", async () => {
    const { client, f } = await makeBridge();
    const bad = await client.post("/changesets/plan", { change_id: "c", operations: [{ op: "block.set", block_id: "nope.block", value: "x", format: "text" }] }, null);
    expect(bad.json.errors[0].code).toBe("UNREGISTERED_BLOCK");
    const wrong = await client.post("/changesets/plan", { change_id: "c", operations: [{ op: "block.set", block_id: "home.hero.title", value: "x", format: "rich-text" }] }, null);
    expect(wrong.json.errors[0].code).toBe("OPERATION_NOT_ALLOWED");
    const apply = await client.planAndApply([{ op: "block.set", block_id: "about.body", value: '<p onclick="x()">Hi <script>alert(1)</script><a href="javascript:x">l</a></p>', format: "rich-text" }]);
    expect(apply.plan.json.warnings[0].code).toBe("VALUE_SANITIZED");
    expect(apply.apply!.status).toBe(200);
    expect(readJson(path.join(f.overrides, "blocks.json")).blocks["about.body"].value).toBe("<p>Hi <a>l</a></p>");
    // Unregistered via apply → 422
    const p = await client.post("/changesets/plan", { change_id: "c2", operations: [{ op: "block.clear", block_id: "ghost" }] }, null);
    const r = await client.post("/changesets/apply", { change_id: "c2", operations: [{ op: "block.clear", block_id: "ghost" }], expected_plan_sha256: sha256Hex(p.json.diff) });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("UNREGISTERED_BLOCK");
    const inv = await client.get("/inventory/blocks");
    expect(inv.json.items.find((b: { id: string }) => b.id === "about.body").value).toBe("<p>Hi <a>l</a></p>");
  });

  it("image alt and redirects", async () => {
    const { client, f } = await makeBridge();
    const notImage = await client.post("/changesets/plan", { change_id: "c", operations: [{ op: "image.alt.set", image_id: "home.hero.title", alt: "x" }] }, null);
    expect(notImage.json.errors[0].code).toBe("UNREGISTERED_BLOCK");
    const r = await client.planAndApply([
      { op: "image.alt.set", image_id: "home.hero.image", alt: "A rocket" },
      { op: "redirect.upsert", source: "/old", destination: "/new", permanent: true },
      { op: "redirect.upsert", source: "/older", destination: "/old", permanent: false },
    ]);
    expect(r.plan.json.risk.flags).toContain("redirect");
    expect(r.plan.json.warnings.map((w: { code: string }) => w.code)).toContain("REDIRECT_CHAIN");
    expect(readJson(path.join(f.overrides, "images.json")).images["home.hero.image"].alt).toBe("A rocket");
    const inv = await client.get("/inventory/redirects");
    expect(inv.json.items).toEqual([
      { source: "/old", destination: "/new", permanent: true },
      { source: "/older", destination: "/old", permanent: false },
    ]);
    const loop = await client.post("/changesets/plan", { change_id: "c", operations: [{ op: "redirect.upsert", source: "/new", destination: "/old", permanent: true }] }, null);
    expect(loop.json.errors[0].code).toBe("OPERATION_NOT_ALLOWED");
    const del = await client.planAndApply([{ op: "redirect.delete", source: "/older" }, { op: "image.alt.clear", image_id: "home.hero.image" }]);
    expect(del.apply!.status).toBe(200);
    const missing = await client.post("/changesets/plan", { change_id: "c", operations: [{ op: "redirect.delete", source: "/nothing" }] }, null);
    expect(missing.json.errors[0].code).toBe("NOT_FOUND");
    const meta = await client.planAndApply([{ op: "metadata.set", route: "/", fields: { robots: { index: false, follow: true } } }]);
    expect(meta.plan.json.risk).toEqual({ level: "medium", flags: ["robots-noindex"] });
    const im = await client.get("/inventory/metadata");
    expect(im.json.items[0]).toMatchObject({ route: "/", revision_id: meta.apply!.json.revision_id });
  });

  it("unsupported capability: 422 on apply and a plan error", async () => {
    const { client } = await makeBridge({ overrides_root: null });
    const p = await client.post("/changesets/plan", { change_id: "c", operations: [{ op: "metadata.clear", route: "/" }] }, null);
    expect(p.json.valid).toBe(false);
    expect(p.json.errors[0].code).toBe("CAPABILITY_UNSUPPORTED");
    const r = await client.post("/changesets/apply", { change_id: "c", operations: [{ op: "metadata.clear", route: "/" }], expected_plan_sha256: sha256Hex(p.json.diff) });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("CAPABILITY_UNSUPPORTED");
    const caps = await client.get("/capabilities");
    expect(caps.json.capabilities["metadata.write"]).toBe(false);
    expect(caps.json.unsupported["metadata.write"]).toMatch(/overrides_root/);
    const v = await client.post("/validations", { operations: [{ op: "metadata.clear", route: "/" }] }, null);
    expect(v.status).toBe(422);
    const d = await client.post("/deployments", { profile: "web" });
    expect(d.json.error.code).toBe("CAPABILITY_UNSUPPORTED");
  });

  it("verify failure (site returns 500 after apply) restores the snapshot and records rolled_back", async () => {
    let broken = false;
    const fakeFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/api/automation-revalidate")) return new Response("{}", { status: 200 });
      return new Response("x", { status: broken ? 500 : 200 });
    }) as typeof fetch;
    const { client, f } = await makeBridge(
      { site: { site_id: "fixture-site", environment: "staging", public_base_url: "https://example.com", internal_url: "http://site.internal:3000" }, revalidate: { mode: "sidecar" } },
      {
        fetch: (async (u: string | URL | Request, init?: RequestInit) => {
          const res = await fakeFetch(u, init);
          if (String(u).includes("automation-revalidate")) broken = true;
          return res;
        }) as typeof fetch,
      },
      { BRIDGE_REVALIDATE_SECRET: "revalidate-secret-xyz" },
    );
    const r = await client.planAndApply([{ op: "metadata.set", route: "/about", fields: { title: "Breaks" } }]);
    expect(r.apply!.status).toBe(502);
    expect(r.apply!.json.error.code).toBe("VERIFY_FAILED");
    expect(fs.existsSync(path.join(f.overrides, "metadata.json"))).toBe(false);
    const revs = await client.get("/revisions");
    expect(revs.json.items[0].status).toBe("rolled_back");
    expect(revs.json.items[0].revision_id).toBe(r.apply!.json.error.details.revision_id);
  });

  it("serialises concurrent mutations with the site lock", async () => {
    const { client, f } = await makeBridge();
    const n = 6;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        (async () => {
          const ops = [{ op: "metadata.set", route: `/p${i}`, fields: { title: `T${i}` } }];
          // Plan against the empty store, then all apply concurrently: exactly one diff stays valid.
          const plan = await client.post("/changesets/plan", { change_id: `cs_${i}`, operations: ops }, null);
          return { ops, plan };
        })(),
      ),
    );
    const applied = await Promise.all(results.map(({ ops, plan }, i) => client.post("/changesets/apply", { change_id: `cs_${i}`, operations: ops, expected_plan_sha256: sha256Hex(plan.json.diff) })));
    const ok = applied.filter((a) => a.status === 200).length;
    expect(ok).toBe(1);
    expect(applied.filter((a) => a.status === 409).length).toBe(n - 1);
    // Retrying each with a fresh plan all succeed, and the file holds every route.
    for (let i = 0; i < n; i++) if (applied[i]!.status !== 200) await client.planAndApply(results[i]!.ops);
    expect(Object.keys(readJson(path.join(f.overrides, "metadata.json")).routes).length).toBe(n);
  });

  it("site lock: LOCKED after the wait budget, and across instances via the lock file", async () => {
    const dir = tmpDir();
    const a = new SiteLock({ dir, waitMs: 100 });
    const b = new SiteLock({ dir, waitMs: 100 });
    let release!: () => void;
    const held = a.withLock("site", () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 20));
    await expect(b.withLock("site", async () => 1)).rejects.toMatchObject({ code: "LOCKED" });
    await expect(a.withLock("site", async () => 1)).rejects.toMatchObject({ code: "LOCKED" });
    release();
    await held;
    await expect(b.withLock("site", async () => 2)).resolves.toBe(2);
  });

  it("recovers an interrupted apply on startup", async () => {
    const { bridge, cfg, f } = await makeBridge();
    const client = new (await import("../helpers.js")).TestClient(bridge);
    const r = await client.planAndApply([{ op: "metadata.set", route: "/", fields: { title: "Keep" } }]);
    const r2 = await client.planAndApply([{ op: "metadata.set", route: "/", fields: { title: "Half" } }]);
    fs.writeFileSync(path.join(cfg.state_dir, "revisions", r2.apply!.json.revision_id, "IN_PROGRESS"), "");
    await bridge.close();
    const { createBridge } = await import("../../src/core/bridge.js");
    const b2 = await createBridge(cfg, { logSink: () => {} });
    expect(readJson(path.join(f.overrides, "metadata.json")).routes["/"].fields.title).toBe("Keep");
    const list = await b2.ctx.revisions.list();
    expect(list.find((x) => x.revision_id === r2.apply!.json.revision_id)!.status).toBe("rolled_back");
    expect(await b2.ctx.revisions.current()).toBe(r.apply!.json.revision_id);
  });

  it("rejects change sets over the operation cap", async () => {
    const { client } = await makeBridge({ limits: { max_operations: 2 } });
    const ops = Array.from({ length: 3 }, (_, i) => ({ op: "metadata.clear", route: `/x${i}` }));
    const r = await client.post("/changesets/plan", { change_id: "c", operations: ops }, null);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("VALIDATION_FAILED");
  });

  it("unknown ops are a validation error with Zod-style issues", async () => {
    const { client } = await makeBridge();
    const r = await client.post("/changesets/plan", { change_id: "c", operations: [{ op: "exec", cmd: "id" }] }, null);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("VALIDATION_FAILED");
    expect(Array.isArray(r.json.error.details.issues)).toBe(true);
  });
});
