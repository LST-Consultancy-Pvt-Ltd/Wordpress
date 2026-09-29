/**
 * Starts the real node:http sidecar against a temp fixture repository and
 * talks to it over HTTP with a signing client.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signedHeaders } from "../../src/core/auth/signing.js";
import { BASE_PATH } from "../../src/core/http.js";
import { sha256Hex } from "../../src/core/util.js";
import { startSidecar, type SidecarServer } from "../../src/sidecar/server.js";
import { KEY_ID, SECRET, fixtureConfig, makeFixture } from "../helpers.js";

let s: SidecarServer;
let f: ReturnType<typeof makeFixture>;
const logs: string[] = [];

async function call(method: string, rel: string, body?: unknown, extra: Record<string, string> = {}) {
  const url = BASE_PATH + rel;
  const buf = body === undefined ? "" : JSON.stringify(body);
  const res = await fetch(s.url + url, {
    method,
    headers: { ...signedHeaders({ keyId: KEY_ID, secret: SECRET, method, pathWithQuery: url, body: buf }), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra },
    body: body === undefined ? undefined : buf,
  });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, json };
}

beforeAll(async () => {
  f = makeFixture();
  s = await startSidecar(fixtureConfig(f), { host: "127.0.0.1", port: 0, logSink: (l) => logs.push(l) });
});

afterAll(async () => {
  await s.close();
});

describe("sidecar over HTTP", () => {
  it("serves /healthz unauthenticated and nothing else outside the base path", async () => {
    const h = await fetch(`${s.url}/healthz`);
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ ok: true });
    expect((await fetch(`${s.url}/`)).status).toBe(404);
    expect((await fetch(`${s.url}${BASE_PATH}/capabilities`)).status).toBe(401);
  });

  it("health, capabilities and openapi", async () => {
    const h = await call("GET", "/health");
    expect(h.status).toBe(200);
    expect(h.headers.get("x-correlation-id")).toMatch(/^c_/);
    const c = await call("GET", "/capabilities", undefined, { "x-correlation-id": "corr-123" });
    expect(c.headers.get("x-correlation-id")).toBe("corr-123");
    expect(c.json.protocol_version).toBe("1");
    expect(c.json.mode).toBe("sidecar");
    expect(JSON.stringify(c.json)).not.toContain(f.dir);
    expect(JSON.stringify(c.json)).not.toContain(SECRET);
    const o = await call("GET", "/openapi.json");
    expect(o.json.openapi).toBe("3.1.0");
  });

  it("plan → apply → rollback → audit", async () => {
    const ops = [{ op: "metadata.set", route: "/about", fields: { title: "Over HTTP", description: "d" } }];
    const plan = await call("POST", "/changesets/plan", { change_id: "cs_http", operations: ops, base_revision: null });
    expect(plan.status).toBe(200);
    expect(plan.json.valid).toBe(true);
    const apply = await call("POST", "/changesets/apply", { change_id: "cs_http", operations: ops, base_revision: plan.json.current_revision, expected_plan_sha256: sha256Hex(plan.json.diff) }, { "idempotency-key": crypto.randomUUID() });
    expect(apply.status).toBe(200);
    expect(apply.json.status).toBe("applied");
    const store = JSON.parse(fs.readFileSync(path.join(f.overrides, "metadata.json"), "utf8"));
    expect(store.routes["/about"].fields.title).toBe("Over HTTP");
    const rb = await call("POST", `/revisions/${apply.json.revision_id}/rollback`, { reason: "test" }, { "idempotency-key": crypto.randomUUID() });
    expect(rb.status).toBe(200);
    // The apply created the store file, so restoring its before-state removes it.
    expect(fs.existsSync(path.join(f.overrides, "metadata.json"))).toBe(false);
    const revs = await call("GET", "/revisions?limit=10");
    expect(revs.json.items.map((r: { status: string }) => r.status)).toEqual(["applied", "reverted"]);
    const audit = await call("GET", "/audit?limit=50");
    const paths = audit.json.items.map((i: { path: string; outcome: string }) => `${i.outcome} ${i.path}`);
    expect(paths).toContain(`ok ${BASE_PATH}/changesets/apply`);
    expect(paths).toContain(`denied ${BASE_PATH}/capabilities`);
    const applyEntry = audit.json.items.find((i: { path: string }) => i.path.endsWith("/changesets/apply"));
    expect(applyEntry).toMatchObject({ key_id: KEY_ID, op: "metadata.set", change_id: "cs_http", revision_id: apply.json.revision_id });
  });

  it("rejects oversized bodies at the socket with 413", async () => {
    const big = "x".repeat(1024 * 1024 + 10);
    const url = `${BASE_PATH}/changesets/plan`;
    const res = await fetch(s.url + url, { method: "POST", body: big, headers: { ...signedHeaders({ keyId: KEY_ID, secret: SECRET, method: "POST", pathWithQuery: url, body: big }), "content-type": "application/json" } });
    expect(res.status).toBe(413);
  });

  it("never logs secrets or absolute paths", () => {
    const all = logs.join("\n");
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(f.dir);
    for (const l of logs) expect(() => JSON.parse(l)).not.toThrow();
  });
});
