#!/usr/bin/env node
/**
 * Operator CLI: send one signed request to an Automation Bridge.
 *
 *   node scripts/sign-request.mjs --key-id k_abc --secret-file ./bridge.secret \
 *     http://bridge:8787/api/automation-bridge/v1/capabilities
 *
 *   node scripts/sign-request.mjs -X POST --data-file plan.json --key-id k_abc --secret-file ./bridge.secret \
 *     http://bridge:8787/api/automation-bridge/v1/changesets/plan
 *
 * Options:
 *   -X, --method <M>          HTTP method (default GET, or POST when a body is given)
 *   -d, --data <json>         request body
 *   --data-file <file>        request body from a file ("-" = stdin)
 *   --key-id <id>             key id (or BRIDGE_KEY_ID)
 *   --secret-file <file>      file containing the base64url secret (or BRIDGE_SECRET_FILE)
 *   --idempotency-key <k>     Idempotency-Key header; "auto" generates one (default for POST)
 *   --print-headers           print the signed headers instead of sending (curl -H friendly)
 *   -i, --include             print response status and headers
 *
 * The secret is only ever read from a file, never from argv, so it does not
 * end up in shell history or `ps` output.
 */
import crypto from "node:crypto";
import fs from "node:fs";

function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write("usage: sign-request.mjs [-X METHOD] [-d JSON | --data-file FILE] --key-id ID --secret-file FILE URL\n");
  process.exit(2);
}

const args = process.argv.slice(2);
const opt = { method: null, data: null, keyId: process.env.BRIDGE_KEY_ID ?? null, secretFile: process.env.BRIDGE_SECRET_FILE ?? null, idem: null, printHeaders: false, include: false, url: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    const v = args[++i];
    if (v === undefined) usage(`${a} needs a value`);
    return v;
  };
  if (a === "-X" || a === "--method") opt.method = next().toUpperCase();
  else if (a === "-d" || a === "--data") opt.data = next();
  else if (a === "--data-file") {
    const f = next();
    opt.data = fs.readFileSync(f === "-" ? 0 : f, "utf8");
  } else if (a === "--key-id") opt.keyId = next();
  else if (a === "--secret-file") opt.secretFile = next();
  else if (a === "--idempotency-key") opt.idem = next();
  else if (a === "--print-headers") opt.printHeaders = true;
  else if (a === "-i" || a === "--include") opt.include = true;
  else if (a === "-h" || a === "--help") usage();
  else if (a.startsWith("-")) usage(`unknown option ${a}`);
  else opt.url = a;
}
if (!opt.url) usage("URL is required");
if (!opt.keyId) usage("--key-id is required");
if (!opt.secretFile) usage("--secret-file is required");

const secretText = fs.readFileSync(opt.secretFile, "utf8").trim();
const secret = Buffer.from(secretText, "base64url");
if (!/^[A-Za-z0-9_-]{43}$/.test(secretText) || secret.length !== 32) usage("secret file must contain a 32-byte base64url secret");

const method = opt.method ?? (opt.data !== null ? "POST" : "GET");
const url = new URL(opt.url);
const pathWithQuery = url.pathname + url.search;
const body = opt.data ?? "";
const ts = Math.floor(Date.now() / 1000);
const nonce = crypto.randomBytes(16).toString("base64url");
const canonical = `${method}\n${pathWithQuery}\n${ts}\n${nonce}\n${crypto.createHash("sha256").update(body, "utf8").digest("hex")}`;
const headers = {
  "X-Bridge-Key-Id": opt.keyId,
  "X-Bridge-Timestamp": String(ts),
  "X-Bridge-Nonce": nonce,
  "X-Bridge-Signature": crypto.createHmac("sha256", secret).update(canonical, "utf8").digest("hex"),
};
if (body) headers["Content-Type"] = "application/json";
const idem = opt.idem === "auto" || (opt.idem === null && method !== "GET") ? crypto.randomUUID() : opt.idem;
if (idem) headers["Idempotency-Key"] = idem;

if (opt.printHeaders) {
  for (const [k, v] of Object.entries(headers)) process.stdout.write(`${k}: ${v}\n`);
  process.exit(0);
}

const res = await fetch(url, { method, headers, body: body || undefined });
if (opt.include) {
  process.stdout.write(`HTTP ${res.status}\n`);
  res.headers.forEach((v, k) => process.stdout.write(`${k}: ${v}\n`));
  process.stdout.write("\n");
}
const text = await res.text();
try {
  process.stdout.write(JSON.stringify(JSON.parse(text), null, 2) + "\n");
} catch {
  process.stdout.write(text + "\n");
}
process.exit(res.ok ? 0 : 1);
