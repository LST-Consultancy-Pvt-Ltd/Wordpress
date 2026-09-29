import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DockerExecutor } from "../../src/core/docker.js";
import { makeBridge, tmpDir, type TestClient } from "../helpers.js";

class FakeDocker implements DockerExecutor {
  calls: string[][] = [];
  image = "sha256:old";
  pendingBuild: string | null = null;
  tags = new Map<string, string>([["site-site:latest", "sha256:old"]]);
  healthAfterUp: "healthy" | "unhealthy" = "healthy";
  health = "healthy";
  failBuild = false;

  async run(args: string[]) {
    this.calls.push(args);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (args[0] === "version") return ok("27.0.0");
    if (args[0] === "compose" && args[1] === "version") return ok("2.29.0");
    if (args[0] === "inspect") {
      return ok(JSON.stringify([{ Id: "c0ffee", Image: this.image, Config: { Image: "site-site:latest" }, State: { Status: "running", Running: true, StartedAt: "2026-01-01T00:00:00Z", Health: { Status: this.health } } }]));
    }
    if (args[0] === "tag") {
      this.tags.set(args[2]!, args[1]!);
      return ok();
    }
    if (args[0] === "compose") {
      const verb = args[5];
      if (verb === "ps") return ok("c0ffee1234ab\n");
      if (verb === "build") {
        if (this.failBuild) return { code: 1, stdout: "", stderr: "build failed" };
        this.pendingBuild = "sha256:new";
        this.tags.set("site-site:latest", "sha256:new");
        return ok();
      }
      if (verb === "up") {
        this.image = this.tags.get("site-site:latest")!;
        this.health = args.includes("--force-recreate") ? "healthy" : this.healthAfterUp;
        return ok();
      }
      if (verb === "logs") return ok("line one\nDATABASE_PASSWORD=hunter2hunter2\nline three\n");
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  }
}

async function setup(fake: FakeDocker, smokeStatus: () => number) {
  const dir = tmpDir();
  const compose = path.join(dir, "docker-compose.yml");
  fs.writeFileSync(compose, "services: {}\n");
  const ctx = await makeBridge(
    {
      site: { site_id: "fixture-site", environment: "staging", public_base_url: "https://example.com", internal_url: "http://site:3000" },
      docker: { compose_file: compose, project: "site", profiles: { web: { services: ["site"], strategy: "compose-recreate", health_timeout_s: 5, smoke_paths: ["/", "/about"] }, swap: { services: ["site"], strategy: "build-and-swap" } } },
    },
    { dockerExecutor: fake, dockerPollMs: 5, fetch: (async () => new Response("ok", { status: smokeStatus() })) as typeof fetch },
  );
  return { ...ctx, compose };
}

async function waitDeployment(client: TestClient, id: string) {
  for (let i = 0; i < 200; i++) {
    const d = await client.get(`/deployments/${id}`);
    if (d.json.status !== "running") return d.json;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("deployment did not finish");
}

describe("docker deployments (fake executor)", () => {
  it("status, profiles, logs with redaction", async () => {
    const fake = new FakeDocker();
    const { client } = await setup(fake, () => 200);
    const caps = await client.get("/capabilities");
    expect(caps.json.capabilities.deploy).toBe(true);
    expect(caps.json.capabilities["ops.logs"]).toBe(true);
    const st = await client.get("/ops/status");
    expect(st.json.items).toEqual([{ service: "site", state: "running", health: "healthy", image: "site-site:latest", image_id: "sha256:old", started_at: "2026-01-01T00:00:00Z" }]);
    const profiles = await client.get("/deployments/profiles");
    expect(profiles.json.find((p: { name: string }) => p.name === "swap")).toMatchObject({ supported: false });
    const logs = await client.get("/ops/logs?service=site&tail=10");
    expect(logs.json.lines).toContain("line one");
    expect(JSON.stringify(logs.json)).not.toContain("hunter2hunter2");
    const other = await client.get("/ops/logs?service=db&tail=10");
    expect(other.json.error.code).toBe("OPERATION_NOT_ALLOWED");
    const badTail = await client.get("/ops/logs?service=site&tail=5000");
    expect(badTail.status).toBe(400);
  });

  it("compose-recreate success records images and uses only fixed templates", async () => {
    const fake = new FakeDocker();
    const { client, compose } = await setup(fake, () => 200);
    const r = await client.post("/deployments", { profile: "web", reason: "release" });
    expect(r.status).toBe(202);
    const d = await waitDeployment(client, r.json.deployment_id);
    expect(d).toMatchObject({ status: "succeeded", previous_image_id: "sha256:old", new_image_id: "sha256:new", failed_step: null });
    const verbs = fake.calls.filter((c) => c[0] === "compose" && c[1] === "-f").map((c) => c.slice(5).join(" "));
    expect(verbs).toContain("build site");
    expect(verbs).toContain("up -d --no-deps site");
    for (const c of fake.calls.filter((c) => c[0] === "compose" && c[1] === "-f")) expect(c.slice(0, 5)).toEqual(["compose", "-f", compose, "-p", "site"]);
    const job = await client.get(`/jobs/${r.json.job_id}`);
    expect(job.json.status).toBe("succeeded");
  });

  it("smoke failure triggers automatic rollback to the recorded image", async () => {
    const fake = new FakeDocker();
    let smoke = 500;
    const { client } = await setup(fake, () => smoke);
    const r = await client.post("/deployments", { profile: "web", reason: "bad release" });
    const d = await waitDeployment(client, r.json.deployment_id);
    expect(d.status).toBe("rolled_back");
    expect(d.failed_step).toBe("smoke");
    expect(fake.calls).toContainEqual(["tag", "sha256:old", "site-site:latest"]);
    expect(fake.image).toBe("sha256:old");
    expect(d.steps.map((s: { name: string }) => s.name)).toEqual(expect.arrayContaining(["auto-rollback:retag:site", "auto-rollback:up:site", "auto-rollback:health:site"]));
    smoke = 200;
    const job = await client.get(`/jobs/${r.json.job_id}`);
    expect(job.json.status).toBe("failed");
  });

  it("unhealthy container triggers automatic rollback; build failure rolls back too", async () => {
    const fake = new FakeDocker();
    fake.healthAfterUp = "unhealthy";
    const { client } = await setup(fake, () => 200);
    const r = await client.post("/deployments", { profile: "web" });
    const d = await waitDeployment(client, r.json.deployment_id);
    expect(d).toMatchObject({ status: "rolled_back", failed_step: "health:site" });
    const fake2 = new FakeDocker();
    fake2.failBuild = true;
    const s2 = await setup(fake2, () => 200);
    const r2 = await s2.client.post("/deployments", { profile: "web" });
    const d2 = await waitDeployment(s2.client, r2.json.deployment_id);
    expect(d2).toMatchObject({ status: "rolled_back", failed_step: "build:site" });
  });

  it("manual rollback redeploys the previous image; unknown profiles and build-and-swap are refused", async () => {
    const fake = new FakeDocker();
    const { client } = await setup(fake, () => 200);
    const r = await client.post("/deployments", { profile: "web" });
    await waitDeployment(client, r.json.deployment_id);
    expect(fake.image).toBe("sha256:new");
    const rb = await client.post(`/deployments/${r.json.deployment_id}/rollback`, { reason: "revert" });
    expect(rb.status).toBe(202);
    const d = await waitDeployment(client, rb.json.deployment_id);
    expect(d).toMatchObject({ status: "succeeded", kind: "rollback" });
    expect(fake.image).toBe("sha256:old");
    expect((await client.post("/deployments", { profile: "nope" })).status).toBe(404);
    expect((await client.post("/deployments", { profile: "swap" })).json.error.code).toBe("CAPABILITY_UNSUPPORTED");
    expect((await client.post("/deployments", { profile: "web", services: ["db"] })).json.error.code).toBe("VALIDATION_FAILED");
    expect((await client.post("/deployments", { profile: "Web; rm -rf /" })).json.error.code).toBe("VALIDATION_FAILED");
  });

  it("capability is false when the daemon is unreachable", async () => {
    const fake = new FakeDocker();
    fake.run = async (args: string[]) => (args[0] === "version" ? { code: 1, stdout: "", stderr: "no daemon" } : { code: 0, stdout: "", stderr: "" });
    const { client } = await setup(fake, () => 200);
    const caps = await client.get("/capabilities");
    expect(caps.json.capabilities.deploy).toBe(false);
    expect(caps.json.unsupported.deploy).toMatch(/daemon/);
  });
});
