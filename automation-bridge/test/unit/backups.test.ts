import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeBridge } from "../helpers.js";

const KEY = "cd".repeat(32);

describe("backups", () => {
  it("creates an encrypted overrides backup, dry-runs and restores it as a revision", async () => {
    const { client, f, cfg } = await makeBridge({}, {}, { BRIDGE_BACKUP_KEY: KEY });
    await client.planAndApply([{ op: "metadata.set", route: "/", fields: { title: "Before backup" } }]);
    const b = await client.post("/backups", { kind: "overrides" });
    expect(b.status).toBe(201);
    expect(b.json).toMatchObject({ kind: "overrides", encrypted: true, files: 1 });
    const file = path.join(cfg.state_dir, "backups", `${b.json.backup_id}.tar.gz.enc`);
    const raw = fs.readFileSync(file);
    expect(raw.subarray(0, 5).toString()).toBe("LSTB1");
    expect(raw.includes(Buffer.from("Before backup"))).toBe(false); // ciphertext, not plaintext
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    await client.planAndApply([{ op: "metadata.set", route: "/", fields: { title: "After backup" } }, { op: "redirect.upsert", source: "/a", destination: "/b", permanent: true }]);
    const wrong = await client.post(`/backups/${b.json.backup_id}/restore`, { confirm: "b_wrong", dry_run: true });
    expect(wrong.status).toBe(400);
    const dry = await client.post(`/backups/${b.json.backup_id}/restore`, { confirm: b.json.backup_id, dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.json.diff).toContain("-        \"title\": \"After backup\"");
    expect(dry.json.files.map((x: { path: string; change: string }) => `${x.path}:${x.change}`).sort()).toEqual(["metadata.json:modify", "redirects.json:delete"]);
    expect(JSON.parse(fs.readFileSync(path.join(f.overrides, "metadata.json"), "utf8")).routes["/"].fields.title).toBe("After backup");

    const real = await client.post(`/backups/${b.json.backup_id}/restore`, { confirm: b.json.backup_id, dry_run: false });
    expect(real.status).toBe(200);
    expect(real.json.revision_id).toMatch(/^r_/);
    expect(JSON.parse(fs.readFileSync(path.join(f.overrides, "metadata.json"), "utf8")).routes["/"].fields.title).toBe("Before backup");
    expect(fs.existsSync(path.join(f.overrides, "redirects.json"))).toBe(false);
    // The restore is itself revertible.
    const rb = await client.post(`/revisions/${real.json.revision_id}/rollback`, {});
    expect(rb.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(f.overrides, "metadata.json"), "utf8")).routes["/"].fields.title).toBe("After backup");
  });

  it("detects tampering and a wrong key", async () => {
    const { client, cfg } = await makeBridge({}, {}, { BRIDGE_BACKUP_KEY: KEY });
    await client.planAndApply([{ op: "metadata.set", route: "/", fields: { title: "x" } }]);
    const b = await client.post("/backups", { kind: "content" });
    const file = path.join(cfg.state_dir, "backups", `${b.json.backup_id}.tar.gz.enc`);
    const buf = fs.readFileSync(file);
    buf[buf.length - 20] = buf[buf.length - 20]! ^ 0xff;
    fs.writeFileSync(file, buf);
    const r = await client.post(`/backups/${b.json.backup_id}/restore`, { confirm: b.json.backup_id, dry_run: true });
    expect(r.json.error.code).toBe("VERIFY_FAILED");
  });

  it("plain backups exclude deny-listed files, include allow-listed code only for full, and apply retention", async () => {
    const { client, f, cfg } = await makeBridge({}, {}, { BRIDGE_BACKUP_RETENTION: "2" });
    fs.writeFileSync(path.join(f.content, ".env"), "SECRET=1");
    const full = await client.post("/backups", { kind: "full" });
    expect(full.json.encrypted).toBe(false);
    const meta = JSON.parse(fs.readFileSync(path.join(cfg.state_dir, "backups", `${full.json.backup_id}.json`), "utf8"));
    expect(meta.roots).toEqual(["code", "content", "overrides"]);
    const { execFileSync } = await import("node:child_process");
    const listing = execFileSync("tar", ["-tzf", path.join(cfg.state_dir, "backups", `${full.json.backup_id}.tar.gz`)], { encoding: "utf8" });
    expect(listing).toContain("roots/content/posts/hello-world.mdx");
    expect(listing).toContain("roots/code/app/page.tsx");
    expect(listing).not.toContain(".env");
    expect(listing).not.toContain("package.json");
    for (let i = 0; i < 3; i++) await client.post("/backups", { kind: "overrides" });
    const list = await client.get("/backups");
    expect(list.json.items.filter((x: { kind: string }) => x.kind === "overrides").length).toBe(2);
    expect(list.json.items.filter((x: { kind: string }) => x.kind === "full").length).toBe(1);
  });

  it("restore requires the deploy scope", async () => {
    const { client } = await makeBridge({}, {}, { BRIDGE_BOOTSTRAP_SCOPES: "read,write" });
    const b = await client.post("/backups", { kind: "overrides" });
    expect(b.status).toBe(201);
    const r = await client.post(`/backups/${b.json.backup_id}/restore`, { confirm: b.json.backup_id, dry_run: true });
    expect(r.status).toBe(403);
  });
});
