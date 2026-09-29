import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { signedHeaders } from "../../src/core/auth/signing.js";
import { BASE_PATH } from "../../src/core/http.js";
import { KEY_ID, SECRET, makeBridge } from "../helpers.js";

const CAP = `${BASE_PATH}/capabilities`;

describe("authentication", () => {
  it("allows /healthz without auth and nothing else", async () => {
    const { bridge } = await makeBridge();
    const h = await bridge.handle({ method: "GET", url: `${BASE_PATH}/healthz`, headers: {}, body: Buffer.alloc(0) });
    expect(h.status).toBe(200);
    expect(JSON.parse(h.body.toString())).toEqual({ ok: true });
    const r = await bridge.handle({ method: "GET", url: CAP, headers: {}, body: Buffer.alloc(0) });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body.toString()).error.code).toBe("AUTH_MISSING");
  });

  it("rejects a bad signature, unknown key (same code), expiry and replay", async () => {
    const { bridge } = await makeBridge();
    const good = signedHeaders({ keyId: KEY_ID, secret: SECRET, method: "GET", pathWithQuery: CAP });
    const bad = { ...good, "x-bridge-signature": "0".repeat(64) };
    const r1 = await bridge.handle({ method: "GET", url: CAP, headers: bad, body: Buffer.alloc(0) });
    expect(JSON.parse(r1.body.toString()).error.code).toBe("AUTH_INVALID");
    const unknown = signedHeaders({ keyId: "k_nope", secret: SECRET, method: "GET", pathWithQuery: CAP });
    const r2 = await bridge.handle({ method: "GET", url: CAP, headers: unknown, body: Buffer.alloc(0) });
    expect(r2.status).toBe(401);
    expect(JSON.parse(r2.body.toString()).error.code).toBe("AUTH_INVALID");
    const old = signedHeaders({ keyId: KEY_ID, secret: SECRET, method: "GET", pathWithQuery: CAP, timestamp: Math.floor(Date.now() / 1000) - 301 });
    const r3 = await bridge.handle({ method: "GET", url: CAP, headers: old, body: Buffer.alloc(0) });
    expect(JSON.parse(r3.body.toString()).error.code).toBe("AUTH_EXPIRED");
    const ok = await bridge.handle({ method: "GET", url: CAP, headers: good, body: Buffer.alloc(0) });
    expect(ok.status).toBe(200);
    const replay = await bridge.handle({ method: "GET", url: CAP, headers: good, body: Buffer.alloc(0) });
    expect(JSON.parse(replay.body.toString()).error.code).toBe("AUTH_REPLAY");
  });

  it("binds the signature to path, query and body", async () => {
    const { bridge } = await makeBridge();
    const h = signedHeaders({ keyId: KEY_ID, secret: SECRET, method: "GET", pathWithQuery: `${BASE_PATH}/revisions?limit=1` });
    const r = await bridge.handle({ method: "GET", url: `${BASE_PATH}/revisions?limit=2`, headers: h, body: Buffer.alloc(0) });
    expect(r.status).toBe(401);
    const body = Buffer.from(JSON.stringify({ change_id: "cs_1", operations: [{ op: "metadata.clear", route: "/" }] }));
    const hp = signedHeaders({ keyId: KEY_ID, secret: SECRET, method: "POST", pathWithQuery: `${BASE_PATH}/changesets/plan`, body });
    const tampered = Buffer.from(body.toString().replace("/", "/x"));
    const r2 = await bridge.handle({ method: "POST", url: `${BASE_PATH}/changesets/plan`, headers: hp, body: tampered });
    expect(r2.status).toBe(401);
  });

  it("rejects malformed nonces", async () => {
    const { bridge } = await makeBridge();
    const h = signedHeaders({ keyId: KEY_ID, secret: SECRET, method: "GET", pathWithQuery: CAP, nonce: "short" });
    const r = await bridge.handle({ method: "GET", url: CAP, headers: h, body: Buffer.alloc(0) });
    expect(JSON.parse(r.body.toString()).error.code).toBe("AUTH_INVALID");
  });

  it("enforces scopes", async () => {
    const { client } = await makeBridge({}, {}, { BRIDGE_BOOTSTRAP_SCOPES: "read" });
    expect((await client.get("/capabilities")).status).toBe(200);
    const r = await client.post("/changesets/apply", { change_id: "x", operations: [{ op: "metadata.clear", route: "/" }], expected_plan_sha256: "a".repeat(64) });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("AUTH_SCOPE");
    expect((await client.get("/audit")).status).toBe(403);
  });

  it("rotates: new key works once issued, old key expires after grace", async () => {
    const { client, bridge } = await makeBridge();
    const r = await client.post("/auth/rotate", { grace_seconds: 0 });
    expect(r.status).toBe(200);
    expect(r.json.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const old = await client.get("/capabilities");
    expect(old.status).toBe(401);
    expect(old.json.error.code).toBe("AUTH_REVOKED");
    client.keyId = r.json.key_id;
    client.secret = r.json.secret;
    expect((await client.get("/capabilities")).status).toBe(200);
    const keys = await client.get("/auth/keys");
    expect(JSON.stringify(keys.json)).not.toContain(r.json.secret);
    expect(JSON.stringify(keys.json)).not.toContain(SECRET);
    const st = fs.statSync(path.join(bridge.ctx.cfg.state_dir, "keys.json"));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("rotation secrets are never persisted in the idempotency store", async () => {
    const { client, bridge } = await makeBridge();
    const idem = "rotate-key-0001";
    const r = await client.post("/auth/rotate", { grace_seconds: 600 }, idem);
    const replay = await client.post("/auth/rotate", { grace_seconds: 600 }, idem);
    expect(replay.headers["idempotent-replay"]).toBe("true");
    expect(replay.json.secret).toBe(r.json.secret);
    const dir = path.join(bridge.ctx.cfg.state_dir, "idempotency");
    for (const f of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir, f), "utf8")).not.toContain(r.json.secret);
  });

  it("revokes; the last admin key needs confirmation", async () => {
    const { client } = await makeBridge();
    const last = await client.post("/auth/revoke", { key_id: KEY_ID });
    expect(last.status).toBe(400);
    const rot = await client.post("/auth/rotate", { grace_seconds: 3600 });
    const r = await client.post("/auth/revoke", { key_id: rot.json.key_id });
    expect(r.json).toEqual({ revoked: true });
    client.keyId = rot.json.key_id;
    client.secret = rot.json.secret;
    const denied = await client.get("/capabilities");
    expect(denied.json.error.code).toBe("AUTH_REVOKED");
  });

  it("reloads the key store when an operator edits it", async () => {
    const { client, bridge } = await makeBridge();
    const file = path.join(bridge.ctx.cfg.state_dir, "keys.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.keys[0].revoked_at = new Date().toISOString();
    data.keys.push({ key_id: "k_ops", secret: crypto.randomBytes(32).toString("base64url"), scopes: ["read"], created_at: new Date().toISOString(), not_after: null, revoked_at: null });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n".repeat(3));
    expect((await client.get("/capabilities")).json.error.code).toBe("AUTH_REVOKED");
    client.keyId = "k_ops";
    client.secret = data.keys[1].secret;
    expect((await client.get("/capabilities")).status).toBe(200);
  });

  it("writes every attempt to the audit log without secrets", async () => {
    const { client, bridge } = await makeBridge();
    await bridge.handle({ method: "GET", url: CAP, headers: {}, body: Buffer.alloc(0) });
    await client.get("/capabilities?x=secretvalue");
    const a = await client.get("/audit");
    expect(a.status).toBe(200);
    const items = a.json.items as { outcome: string; code?: string; path: string }[];
    expect(items.some((i) => i.outcome === "denied" && i.code === "AUTH_MISSING")).toBe(true);
    expect(JSON.stringify(items)).not.toContain("secretvalue");
    expect(JSON.stringify(items)).not.toContain(SECRET);
  });
});

describe("limits", () => {
  it("rate limits per key with Retry-After", async () => {
    const { client } = await makeBridge({ limits: { rate_per_minute: 3 } });
    for (let i = 0; i < 3; i++) expect((await client.get("/capabilities")).status).toBe(200);
    const r = await client.get("/capabilities");
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe("RATE_LIMITED");
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("limits mutations separately", async () => {
    const { client } = await makeBridge({ limits: { mutations_per_minute: 1 } });
    await client.post("/backups", { kind: "overrides" });
    const r = await client.post("/backups", { kind: "overrides" });
    expect(r.status).toBe(429);
  });

  it("rejects oversized bodies with 413", async () => {
    const { client } = await makeBridge({ limits: { max_body_bytes: 2048 } });
    const r = await client.post("/changesets/plan", { change_id: "cs_1", operations: [{ op: "block.set", block_id: "home.hero.title", value: "x".repeat(4000), format: "text" }] }, null);
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("idempotency", () => {
  it("requires a key on mutations, replays identical requests and rejects mismatches", async () => {
    const { client } = await makeBridge();
    const ops = [{ op: "metadata.set", route: "/about", fields: { title: "A" } }];
    const noKey = await client.post("/backups", { kind: "overrides" }, null);
    expect(noKey.json.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const plan = await client.post("/changesets/plan", { change_id: "cs_i", operations: ops }, null);
    const sha = crypto.createHash("sha256").update(plan.json.diff).digest("hex");
    const body = { change_id: "cs_i", operations: ops, base_revision: null, expected_plan_sha256: sha };
    const a = await client.post("/changesets/apply", body, "idem-key-0001");
    expect(a.status).toBe(200);
    const b = await client.post("/changesets/apply", body, "idem-key-0001");
    expect(b.status).toBe(200);
    expect(b.headers["idempotent-replay"]).toBe("true");
    expect(b.json.revision_id).toBe(a.json.revision_id);
    const c = await client.post("/changesets/apply", { ...body, change_id: "cs_other" }, "idem-key-0001");
    expect(c.status).toBe(409);
    expect(c.json.error.code).toBe("IDEMPOTENCY_MISMATCH");
    const revs = await client.get("/revisions");
    expect(revs.json.items.length).toBe(1);
  });
});

describe("persistent nonce cache", () => {
  it("detects a replay across processes / restarts sharing the state dir", async () => {
    const { NonceCache } = await import("../../src/core/auth/limits.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nonces-"));
    const first = new NonceCache(600, 1000, dir);
    expect(first.checkAndRemember("k1", "n-abcdefghijklmnop")).toBe(true);
    const afterRestart = new NonceCache(600, 1000, dir);          // fresh memory, same directory
    expect(afterRestart.checkAndRemember("k1", "n-abcdefghijklmnop")).toBe(false);
    expect(afterRestart.checkAndRemember("k2", "n-abcdefghijklmnop")).toBe(true); // per key
    const later = Date.now() + 601_000;
    expect(new NonceCache(600, 1000, dir).checkAndRemember("k1", "n-abcdefghijklmnop", later)).toBe(true);
    expect(fs.readdirSync(dir).every((f) => /^[0-9a-f]{64}$/.test(f))).toBe(true); // no raw nonces/key ids on disk
  });
});
