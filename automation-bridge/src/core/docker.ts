/**
 * Docker / Compose operations (protocol §11). Every command is built from a
 * fixed template with values taken from the bridge config only:
 *   docker compose -f <compose_file> -p <project> <verb> [flags] <service>
 *   docker inspect <container-id-from-compose> | docker tag <image-id> <image-ref>
 * The executor is injectable so tests use a fake instead of a real daemon.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { DeployProfileT, ResolvedConfig } from "./config.js";
import { BridgeError } from "./errors.js";
import { runCommand } from "./exec.js";
import { atomicWrite, ensureDirSync } from "./fsutil.js";
import type { JobRegistry } from "./jobs.js";
import type { Logger, Redactor } from "./logger.js";
import type { DeploymentT } from "./schemas.js";
import { newId, nowIso, sleep } from "./util.js";

export interface DockerExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export interface DockerExecutor {
  run(args: string[], opts: { timeoutMs: number }): Promise<DockerExecResult>;
}

export function createDockerExecutor(binary = "docker"): DockerExecutor {
  return {
    async run(args, opts) {
      const r = await runCommand(binary, args, {
        timeoutMs: opts.timeoutMs,
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) },
        capBytes: 1024 * 1024,
      });
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

interface Inspect {
  Id?: string;
  Image?: string;
  Config?: { Image?: string };
  State?: { Status?: string; Running?: boolean; StartedAt?: string; Health?: { Status?: string } };
}

export interface ServiceStatus {
  service: string;
  state: string;
  health: string | null;
  image: string | null;
  image_id: string | null;
  started_at: string | null;
}

export class DockerOps {
  private readonly deploymentsDir: string;
  readonly exec: DockerExecutor;
  private readonly cfg: ResolvedConfig;
  private readonly logger: Logger;
  private readonly redactor: Redactor;
  private readonly fetchFn: typeof fetch;
  private readonly pollMs: number;

  constructor(opts: { cfg: ResolvedConfig; executor?: DockerExecutor; logger: Logger; redactor: Redactor; fetch?: typeof fetch; pollMs?: number }) {
    this.cfg = opts.cfg;
    this.exec = opts.executor ?? createDockerExecutor(opts.cfg.docker?.docker_binary ?? "docker");
    this.logger = opts.logger;
    this.redactor = opts.redactor;
    this.fetchFn = opts.fetch ?? fetch;
    this.pollMs = opts.pollMs ?? 2000;
    this.deploymentsDir = path.join(opts.cfg.state_dir, "deployments");
    ensureDirSync(this.deploymentsDir);
  }

  private get docker() {
    const d = this.cfg.docker;
    if (!d) throw new BridgeError("CAPABILITY_UNSUPPORTED", "docker operations are not configured", { capability: "deploy" });
    return d;
  }

  private compose(verb: string[], service?: string): string[] {
    const d = this.docker;
    return ["compose", "-f", d.compose_file, "-p", d.project, ...verb, ...(service ? [service] : [])];
  }

  private timeout(): number {
    return (this.cfg.docker?.command_timeout_s ?? 900) * 1000;
  }

  allServices(): string[] {
    const d = this.cfg.docker;
    if (!d) return [];
    return [...new Set(Object.values(d.profiles).flatMap((p) => p.services))];
  }

  logServices(): string[] {
    return this.cfg.docker?.log_services ?? this.allServices();
  }

  /** `docker version` + compose file readable. */
  async selfCheck(): Promise<string | null> {
    const d = this.cfg.docker;
    if (!d) return "docker is not configured";
    try {
      await fsp.access(d.compose_file);
    } catch {
      return "compose file is not readable";
    }
    const r = await this.exec.run(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000 });
    if (r.code !== 0) return "docker daemon is not reachable";
    const c = await this.exec.run(["compose", "version", "--short"], { timeoutMs: 10_000 });
    if (c.code !== 0) return "docker compose plugin is not available";
    return null;
  }

  private async containerId(service: string): Promise<string | null> {
    const r = await this.exec.run(this.compose(["ps", "-q"], service), { timeoutMs: 30_000 });
    if (r.code !== 0) return null;
    const id = r.stdout.trim().split("\n")[0]?.trim();
    return id && /^[0-9a-f]{12,64}$/.test(id) ? id : null;
  }

  private async inspect(containerId: string): Promise<Inspect | null> {
    const r = await this.exec.run(["inspect", containerId], { timeoutMs: 30_000 });
    if (r.code !== 0) return null;
    try {
      const arr = JSON.parse(r.stdout) as Inspect[];
      return arr[0] ?? null;
    } catch {
      return null;
    }
  }

  async status(): Promise<ServiceStatus[]> {
    const out: ServiceStatus[] = [];
    for (const service of this.allServices()) {
      const id = await this.containerId(service);
      const ins = id ? await this.inspect(id) : null;
      out.push({
        service,
        state: ins?.State?.Status ?? "absent",
        health: ins?.State?.Health?.Status ?? null,
        image: ins?.Config?.Image ?? null,
        image_id: ins?.Image ?? null,
        started_at: ins?.State?.StartedAt ?? null,
      });
    }
    return out;
  }

  async logs(service: string, tail: number): Promise<string[]> {
    if (!this.logServices().includes(service)) throw new BridgeError("OPERATION_NOT_ALLOWED", "service is not configured for log access");
    const r = await this.exec.run(this.compose(["logs", "--no-color", "--no-log-prefix", "--tail", String(tail)], service), { timeoutMs: 60_000 });
    if (r.code !== 0) throw new BridgeError("UPSTREAM_FAILED", "docker logs failed");
    const lines = (r.stdout + r.stderr).split("\n").filter((l) => l.length);
    return lines.slice(-tail).map((l) => this.redactor.redactString(l).slice(0, 4000));
  }

  profiles(): { name: string; profile: DeployProfileT }[] {
    return Object.entries(this.cfg.docker?.profiles ?? {}).map(([name, profile]) => ({ name, profile }));
  }

  // ---- deployment records -------------------------------------------------

  private file(id: string): string {
    if (!/^d_[a-z0-9]+$/.test(id)) throw new BridgeError("NOT_FOUND", "deployment not found");
    return path.join(this.deploymentsDir, `${id}.json`);
  }

  private async save(d: DeploymentT): Promise<void> {
    await atomicWrite(this.file(d.deployment_id), JSON.stringify(d, null, 2), { mode: 0o600 });
  }

  async get(id: string): Promise<DeploymentT | null> {
    try {
      return JSON.parse(await fsp.readFile(this.file(id), "utf8")) as DeploymentT;
    } catch {
      return null;
    }
  }

  async list(): Promise<DeploymentT[]> {
    const names = (await fsp.readdir(this.deploymentsDir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    const all: DeploymentT[] = [];
    for (const n of names) {
      try {
        all.push(JSON.parse(await fsp.readFile(path.join(this.deploymentsDir, n), "utf8")) as DeploymentT);
      } catch {
        /* skip */
      }
    }
    return all.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  }

  /** Create the record and return it; the caller runs `execute` in the background. */
  async begin(profileName: string, reason: string, kind: "deploy" | "rollback", previous: string | null = null): Promise<DeploymentT> {
    const p = this.cfg.docker?.profiles[profileName];
    if (!p) throw new BridgeError("NOT_FOUND", "unknown deployment profile");
    if (p.strategy === "build-and-swap") {
      throw new BridgeError("CAPABILITY_UNSUPPORTED", "strategy build-and-swap is not supported by this bridge version; use compose-recreate", { capability: "deploy" });
    }
    const d: DeploymentT = {
      deployment_id: newId("d"),
      profile: profileName,
      status: "running",
      previous_image_id: previous,
      new_image_id: null,
      previous_images: {},
      steps: [],
      started_at: nowIso(),
      finished_at: null,
      reason,
      failed_step: null,
      kind,
    };
    await this.save(d);
    return d;
  }

  private async step(d: DeploymentT, jobs: JobRegistry | null, jobId: string | null, name: string, fn: () => Promise<string | null>): Promise<void> {
    const rec: DeploymentT["steps"][number] = { name, status: "running", detail: null, at: nowIso() };
    d.steps.push(rec);
    await this.save(d);
    if (jobs && jobId) jobs.log(jobId, "deploy", `[${name}] started\n`);
    try {
      rec.detail = await fn();
      rec.status = "succeeded";
    } catch (e) {
      rec.status = "failed";
      rec.detail = e instanceof BridgeError ? e.message : "step failed";
      d.failed_step = name;
      await this.save(d);
      if (jobs && jobId) jobs.log(jobId, "deploy", `[${name}] failed: ${rec.detail}\n`);
      throw e;
    }
    await this.save(d);
    if (jobs && jobId) jobs.log(jobId, "deploy", `[${name}] ok${rec.detail ? `: ${rec.detail}` : ""}\n`);
  }

  private async mustRun(args: string[], what: string): Promise<DockerExecResult> {
    const r = await this.exec.run(args, { timeoutMs: this.timeout() });
    if (r.code !== 0) {
      this.logger.warn("docker command failed", { what, stderr: r.stderr.slice(-2000) });
      throw new BridgeError("DEPLOY_FAILED", `${what} failed`);
    }
    return r;
  }

  private async waitHealthy(service: string, timeoutS: number): Promise<string> {
    const deadline = Date.now() + timeoutS * 1000;
    let stableSince: number | null = null;
    for (;;) {
      const id = await this.containerId(service);
      const ins = id ? await this.inspect(id) : null;
      const health = ins?.State?.Health?.Status;
      if (health === "healthy") return "healthy";
      if (health === "unhealthy") throw new BridgeError("DEPLOY_FAILED", `${service} reported unhealthy`);
      if (!health && ins?.State?.Running) {
        // No HEALTHCHECK: require 10 s of continuous running.
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= Math.min(10_000, timeoutS * 1000)) return "running (no healthcheck)";
      } else if (!ins?.State?.Running) stableSince = null;
      if (Date.now() >= deadline) throw new BridgeError("DEPLOY_FAILED", `${service} did not become healthy within ${timeoutS}s`);
      await sleep(this.pollMs);
    }
  }

  private async smoke(paths: string[]): Promise<string> {
    const base = this.cfg.site.internal_url;
    if (!base || !paths.length) return "skipped (no internal_url or smoke paths)";
    const results: string[] = [];
    for (const p of paths) {
      let status = 0;
      try {
        const res = await this.fetchFn(new URL(p, base).toString(), { redirect: "manual", signal: AbortSignal.timeout(15_000) });
        status = res.status;
      } catch {
        status = 0;
      }
      results.push(`${p} ${status}`);
      if (status < 200 || status >= 400) throw new BridgeError("DEPLOY_FAILED", `smoke check ${p} returned ${status || "no response"}`);
    }
    return results.join(", ");
  }

  /** Run a compose-recreate deployment (or a rollback to recorded images). */
  async execute(d: DeploymentT, jobs: JobRegistry | null, jobId: string | null, rollbackImages?: Record<string, string>): Promise<DeploymentT> {
    const p = this.cfg.docker!.profiles[d.profile]!;
    const previous: Record<string, { id: string | null; ref: string | null }> = {};
    const fail = async (status: DeploymentT["status"]) => {
      d.status = status;
      d.finished_at = nowIso();
      if (jobs && jobId) jobs.update(jobId, (j) => ((j.status = "failed"), (j.error = `deployment ${status} at step ${d.failed_step}`), (j.result = { deployment_id: d.deployment_id, status })), "status");
      await this.save(d);
      return d;
    };
    try {
      if (jobs && jobId) jobs.update(jobId, (j) => (j.status = "running"), "status");
      await this.step(d, jobs, jobId, "record-images", async () => {
        for (const s of p.services) {
          const id = await this.containerId(s);
          const ins = id ? await this.inspect(id) : null;
          previous[s] = { id: ins?.Image ?? null, ref: ins?.Config?.Image ?? null };
        }
        d.previous_image_id ??= previous[p.services[0]!]?.id ?? null;
        if (!rollbackImages) {
          d.previous_images = Object.fromEntries(Object.entries(previous).filter(([, v]) => v.id).map(([k, v]) => [k, v.id!]));
        }
        return p.services.map((s) => `${s}=${previous[s]?.id?.slice(0, 19) ?? "none"}`).join(", ");
      });
      if (rollbackImages) {
        for (const s of p.services) {
          const target = rollbackImages[s];
          const ref = previous[s]?.ref;
          if (!target || !ref) throw new BridgeError("DEPLOY_FAILED", `no recorded image for ${s}`);
          await this.step(d, jobs, jobId, `retag:${s}`, async () => {
            await this.mustRun(["tag", target, ref], `docker tag for ${s}`);
            return null;
          });
          await this.step(d, jobs, jobId, `up:${s}`, async () => {
            await this.mustRun(this.compose(["up", "-d", "--no-deps", "--no-build", "--force-recreate"], s), `compose up ${s}`);
            return null;
          });
        }
      } else {
        for (const s of p.services) {
          await this.step(d, jobs, jobId, `build:${s}`, async () => {
            await this.mustRun(this.compose(["build"], s), `compose build ${s}`);
            return null;
          });
          await this.step(d, jobs, jobId, `up:${s}`, async () => {
            await this.mustRun(this.compose(["up", "-d", "--no-deps"], s), `compose up ${s}`);
            return null;
          });
        }
      }
      for (const s of p.services) {
        await this.step(d, jobs, jobId, `health:${s}`, () => this.waitHealthy(s, p.health_timeout_s));
      }
      await this.step(d, jobs, jobId, "smoke", () => this.smoke(p.smoke_paths));
      const firstId = await this.containerId(p.services[0]!);
      d.new_image_id = firstId ? ((await this.inspect(firstId))?.Image ?? null) : null;
      d.status = "succeeded";
      d.finished_at = nowIso();
      if (jobs && jobId) jobs.update(jobId, (j) => ((j.status = "succeeded"), (j.result = { deployment_id: d.deployment_id, status: d.status })), "status");
      await this.save(d);
      return d;
    } catch (e) {
      this.logger.warn("deployment failed", { deployment_id: d.deployment_id, step: d.failed_step, err: e });
      if (rollbackImages) return fail("failed");
      // Automatic rollback to the recorded images.
      const recorded = Object.entries(previous).filter(([, v]) => v.id && v.ref);
      if (!recorded.length) return fail("failed");
      try {
        for (const [s, v] of recorded) {
          await this.rollbackStep(d, jobs, jobId, `auto-rollback:retag:${s}`, ["tag", v.id!, v.ref!]);
          await this.rollbackStep(d, jobs, jobId, `auto-rollback:up:${s}`, this.compose(["up", "-d", "--no-deps", "--no-build", "--force-recreate"], s));
        }
        for (const [s] of recorded) {
          const rec: DeploymentT["steps"][number] = { name: `auto-rollback:health:${s}`, status: "running", detail: null, at: nowIso() };
          d.steps.push(rec);
          try {
            rec.detail = await this.waitHealthy(s, p.health_timeout_s);
            rec.status = "succeeded";
          } catch {
            rec.status = "failed";
            rec.detail = "service not healthy after rollback";
          }
        }
        return fail("rolled_back");
      } catch {
        return fail("failed");
      }
    }
  }

  private async rollbackStep(d: DeploymentT, jobs: JobRegistry | null, jobId: string | null, name: string, args: string[]): Promise<void> {
    const rec: DeploymentT["steps"][number] = { name, status: "running", detail: null, at: nowIso() };
    d.steps.push(rec);
    const r = await this.exec.run(args, { timeoutMs: this.timeout() });
    rec.status = r.code === 0 ? "succeeded" : "failed";
    await this.save(d);
    if (jobs && jobId) jobs.log(jobId, "deploy", `[${name}] ${rec.status}\n`);
    if (r.code !== 0) throw new BridgeError("DEPLOY_FAILED", `${name} failed`);
  }

  /** Images a rollback of deployment `d` should return to. */
  rollbackTargets(d: DeploymentT): Record<string, string> | null {
    const p = this.cfg.docker?.profiles[d.profile];
    if (!p) return null;
    const targets: Record<string, string> = {};
    for (const s of p.services) {
      const id = d.previous_images?.[s] ?? (s === p.services[0] ? d.previous_image_id : null);
      if (!id) return null;
      targets[s] = id;
    }
    return targets;
  }
}
