#!/usr/bin/env node
/**
 * End-to-end check with real containers (not part of `npm test`):
 *   1. docker compose up --build the sample site + bridge sidecar
 *   2. read <title> of /about
 *   3. signed plan + apply of metadata.set on /about → <title> changes
 *   4. rollback of that revision → <title> is restored
 *   5. docker compose down -v (set KEEP=1 to keep the stack)
 */
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(here, "..", "examples", "sample-site");
const project = `lstbridge-e2e-${process.pid}`;
const SITE_PORT = process.env.SITE_PORT || "13000";
const BRIDGE_PORT = process.env.BRIDGE_PORT || "18787";
const BASE = "/api/automation-bridge/v1";
const keyId = `k_${crypto.randomBytes(8).toString("hex")}`;
const secret = crypto.randomBytes(32).toString("base64url");
const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-e2e-")), "e2e.env");
fs.writeFileSync(
  envFile,
  [`BRIDGE_BOOTSTRAP_KEY_ID=${keyId}`, `BRIDGE_BOOTSTRAP_SECRET=${secret}`, `BRIDGE_REVALIDATE_SECRET=${crypto.randomBytes(24).toString("base64url")}`, `SITE_PORT=${SITE_PORT}`, `BRIDGE_PORT=${BRIDGE_PORT}`].join("\n") + "\n",
  { mode: 0o600 },
);
const compose = ["compose", "-f", path.join(siteDir, "docker-compose.yml"), "-f", path.join(siteDir, "docker-compose.e2e.yml"), "-p", project, "--env-file", envFile];

function docker(args, opts = {}) {
  const r = spawnSync("docker", [...compose, ...args], { stdio: opts.quiet ? "pipe" : "inherit", encoding: "utf8" });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`docker ${args.join(" ")} failed (${r.status})`);
  return r;
}

function signed(method, rel, body = "") {
  const pathWithQuery = BASE + rel;
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("base64url");
  const canonical = `${method}\n${pathWithQuery}\n${ts}\n${nonce}\n${crypto.createHash("sha256").update(body).digest("hex")}`;
  const headers = {
    "x-bridge-key-id": keyId,
    "x-bridge-timestamp": String(ts),
    "x-bridge-nonce": nonce,
    "x-bridge-signature": crypto.createHmac("sha256", Buffer.from(secret, "base64url")).update(canonical).digest("hex"),
  };
  if (body) headers["content-type"] = "application/json";
  if (method === "POST" && !rel.endsWith("/plan")) headers["idempotency-key"] = crypto.randomUUID();
  return fetch(`http://127.0.0.1:${BRIDGE_PORT}${pathWithQuery}`, { method, headers, body: body || undefined }).then(async (r) => ({ status: r.status, json: await r.json() }));
}

async function title(route) {
  const r = await fetch(`http://127.0.0.1:${SITE_PORT}${route}`, { cache: "no-store" });
  const html = await r.text();
  return /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? null;
}

async function waitFor(what, fn, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what} (last: ${last})`);
}

function check(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`ok - ${msg}`);
}

let failed = false;
try {
  execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" });
  console.log("# building and starting the sample stack (first build takes a few minutes)");
  docker(["up", "-d", "--build", "--wait", "--wait-timeout", "300"]);
  await waitFor("site", async () => (await fetch(`http://127.0.0.1:${SITE_PORT}/about`)).ok);
  await waitFor("bridge", async () => (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`)).ok);

  const caps = await signed("GET", "/capabilities");
  check(caps.status === 200 && caps.json.capabilities["metadata.write"] === true, "bridge capabilities report metadata.write");
  check(caps.json.capabilities.revalidate === true, "sidecar revalidation is configured");

  const before = await title("/about");
  check(before === "About us", `initial /about title is "About us" (got ${JSON.stringify(before)})`);

  const newTitle = `E2E title ${Date.now()}`;
  const ops = [{ op: "metadata.set", route: "/about", fields: { title: newTitle } }];
  const plan = await signed("POST", "/changesets/plan", JSON.stringify({ change_id: "cs_e2e", operations: ops, base_revision: null }));
  check(plan.status === 200 && plan.json.valid && plan.json.warnings.length === 0, "plan is valid without warnings (route opted in)");
  const planSha = crypto.createHash("sha256").update(plan.json.diff).digest("hex");
  const apply = await signed("POST", "/changesets/apply", JSON.stringify({ change_id: "cs_e2e", operations: ops, base_revision: plan.json.current_revision, expected_plan_sha256: planSha }));
  check(apply.status === 200 && apply.json.operations[0].effective === true, `apply succeeded (revision ${apply.json.revision_id})`);
  check(apply.json.revalidated.includes("/about"), "apply revalidated /about");
  await waitFor("new title", async () => (await title("/about")) === newTitle, 30_000);
  check(true, `rendered <title> on /about is now "${newTitle}"`);

  const notOpted = await signed("POST", "/changesets/plan", JSON.stringify({ change_id: "cs_e2e2", operations: [{ op: "metadata.set", route: "/contact", fields: { title: "x" } }], base_revision: null }));
  check(notOpted.json.warnings[0]?.code === "METADATA_NOT_OPTED_IN", "metadata.set on /contact warns METADATA_NOT_OPTED_IN");

  const rb = await signed("POST", `/revisions/${apply.json.revision_id}/rollback`, JSON.stringify({ reason: "e2e" }));
  check(rb.status === 200, `rollback created revision ${rb.json.revision_id}`);
  await waitFor("restored title", async () => (await title("/about")) === "About us", 30_000);
  check(true, 'rendered <title> on /about is restored to "About us"');

  const audit = await signed("GET", "/audit?limit=20");
  check(audit.json.items.some((i) => i.path.endsWith("/changesets/apply") && i.outcome === "ok"), "audit log recorded the apply");
  console.log("# e2e passed");
} catch (e) {
  failed = true;
  console.error(`# e2e FAILED: ${e.message}`);
  docker(["logs", "--no-color", "--tail", "80"], { allowFail: true });
} finally {
  if (process.env.KEEP !== "1") docker(["down", "-v", "--remove-orphans"], { allowFail: true, quiet: true });
  fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
