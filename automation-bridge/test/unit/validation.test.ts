import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { signedHeaders } from "../../src/core/auth/signing.js";
import { BASE_PATH } from "../../src/core/http.js";
import { KEY_ID, SECRET, makeBridge, type TestClient } from "../helpers.js";

const NODE = process.execPath;

async function waitJob(client: TestClient, id: string) {
  for (let i = 0; i < 200; i++) {
    const j = await client.get(`/jobs/${id}`);
    if (["succeeded", "failed", "cancelled"].includes(j.json.status)) return j.json;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job did not finish");
}

const writeOp = { op: "file.write", root: "code", path: "app/proposed.ts", content: "export const x = 1;\n", base_sha256: null };

// Echoed back by the job command; resolved lazily to the test key's secret.
const client_secret_placeholder = () => SECRET;

describe("validation jobs", () => {
  it("runs only configured command arrays in a scratch tree with a clean env", async () => {
    const pwned = path.join(process.cwd(), "pwned-marker");
    const { client, f } = await makeBridge({
      validation: {
        allow_same_user: true,
        steps: {
          lint: [NODE, "-e", "require('fs').accessSync('app/proposed.ts'); console.log('lint ok')"],
          typecheck: [NODE, "-e", "console.log(JSON.stringify(Object.keys(process.env).sort()))"],
          test: [NODE, "-e", "console.log(process.argv[1])", `$(touch ${pwned}); echo injected`],
        },
        timeout_s: 20,
      },
    });
    const caps = await client.get("/capabilities");
    expect(caps.json.capabilities.validate).toBe(true);
    expect(caps.json.validation_steps).toEqual(["lint", "typecheck", "test"]);
    const r = await client.post("/validations", { operations: [writeOp] }, null);
    expect(r.status).toBe(202);
    const job = await waitJob(client, r.json.job_id);
    expect(job.status).toBe("succeeded");
    const steps = Object.fromEntries(job.steps.map((s: { name: string }) => [s.name, s]));
    expect(steps.lint.output_tail).toContain("lint ok");
    // macOS injects __CF_USER_TEXT_ENCODING into every process; nothing else may leak.
    expect((JSON.parse(steps.typecheck.output_tail.trim()) as string[]).filter((k) => k !== "__CF_USER_TEXT_ENCODING")).toEqual(["CI", "HOME", "NODE_ENV", "PATH"]);
    expect(steps.test.output_tail).toContain("$(touch");
    expect(fs.existsSync(pwned)).toBe(false);
    // The real repository was not modified and the scratch tree is gone.
    expect(fs.existsSync(path.join(f.repo, "app/proposed.ts"))).toBe(false);
    // Scratch trees never live under state_dir (the key store), and this job's tree is gone.
    expect(fs.existsSync(path.join(f.state, "scratch"))).toBe(false);
    expect(fs.existsSync(path.join(os.tmpdir(), "automation-bridge-scratch", r.json.job_id))).toBe(false);
  });

  it("rejects unknown or unconfigured steps (no arbitrary commands)", async () => {
    const { client } = await makeBridge({ validation: { allow_same_user: true, steps: { lint: [NODE, "-e", "1"] } } });
    for (const steps of [["lint; rm -rf /"], ["build"], ["$(id)"]]) {
      const r = await client.post("/validations", { operations: [writeOp], steps }, null);
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("OPERATION_NOT_ALLOWED");
    }
    const extra = await client.post("/validations", { operations: [writeOp], command: ["sh", "-c", "id"] }, null);
    expect(extra.json.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails a step on non-zero exit and on timeout, skipping later steps", async () => {
    const { client } = await makeBridge({
      validation: { allow_same_user: true, steps: { format: [NODE, "-e", "setTimeout(() => {}, 20000)"], lint: [NODE, "-e", "1"] }, timeout_s: 1 },
    });
    const r = await client.post("/validations", { operations: [writeOp] }, null);
    const job = await waitJob(client, r.json.job_id);
    expect(job.status).toBe("failed");
    expect(job.steps[0]).toMatchObject({ name: "format", status: "failed" });
    expect(job.steps[0].output_tail).toContain("timed out");
    expect(job.steps[1]).toMatchObject({ name: "lint", status: "skipped" });
  });

  it("streams job events over SSE", async () => {
    const { client, bridge } = await makeBridge({ validation: { allow_same_user: true, steps: { lint: [NODE, "-e", "console.log('hello-sse')"] } } });
    const r = await client.post("/validations", { operations: [writeOp] }, null);
    const url = `${BASE_PATH}/jobs/${r.json.job_id}/events`;
    const res = await bridge.handle({ method: "GET", url, headers: signedHeaders({ keyId: KEY_ID, secret: SECRET, method: "GET", pathWithQuery: url }), body: Buffer.alloc(0) });
    expect(res.headers["content-type"]).toContain("text/event-stream");
    let text = "";
    for await (const chunk of res.body as AsyncIterable<string>) text += chunk;
    expect(text).toContain("event: status");
    expect(text).toContain("event: step");
    expect(text).toContain("hello-sse");
    expect(text).toMatch(/"status":"succeeded"/);
  });

  it("capability is false when the command does not exist", async () => {
    const { client } = await makeBridge({ validation: { allow_same_user: true, steps: { lint: ["definitely-not-a-real-binary-xyz"] } } });
    const caps = await client.get("/capabilities");
    expect(caps.json.capabilities.validate).toBe(false);
    expect(caps.json.unsupported.validate).toMatch(/not found/);
  });

  it("previews report the configured URL", async () => {
    const { client } = await makeBridge({ preview: { allow_same_user: true, command: [NODE, "-e", "console.log('built')"], url: "https://staging.example.com" } });
    const r = await client.post("/previews", { operations: [writeOp] }, null);
    expect(r.status).toBe(202);
    const job = await waitJob(client, r.json.job_id);
    expect(job.result).toEqual({ preview_url: "https://staging.example.com" });
    const { client: c2 } = await makeBridge();
    expect((await c2.post("/previews", { operations: [writeOp] }, null)).status).toBe(422);
  });

  it("refuses to run jobs as the bridge user unless explicitly allowed", async () => {
    const { client } = await makeBridge({ validation: { steps: { lint: [NODE, "-e", "1"] } } });
    const caps = await client.get("/capabilities");
    expect(caps.json.capabilities.validate).toBe(false);
    expect(caps.json.unsupported.validate).toMatch(/run_as|allow_same_user/);
    expect((await client.post("/validations", { operations: [writeOp] }, null)).status).toBe(422);
  });

  it("requires write scope: a read-only key cannot start validation or previews", async () => {
    const { client: reader } = await makeBridge(
      { validation: { allow_same_user: true, steps: { lint: [NODE, "-e", "1"] } } }, {}, { BRIDGE_BOOTSTRAP_SCOPES: "read" });
    expect((await reader.post("/validations", { operations: [writeOp] }, null)).status).toBe(403);
    expect((await reader.post("/previews", { operations: [writeOp] }, null)).status).toBe(403);
  });

  it("keeps scratch trees out of the state dir and redacts secrets from job output", async () => {
    const { client, f } = await makeBridge({
      validation: { allow_same_user: true, steps: { lint: [NODE, "-e", "console.log(process.cwd()); console.log(process.argv[1])", client_secret_placeholder()] } },
    });
    const r = await client.post("/validations", { operations: [writeOp] }, null);
    const job = await waitJob(client, r.json.job_id);
    const out = job.steps[0].output_tail as string;
    expect(out).not.toContain(f.state);           // scratch tree is not under state_dir, no absolute state paths
    expect(out).not.toContain(client.secret);     // the bridge key never appears in job output
  });
});