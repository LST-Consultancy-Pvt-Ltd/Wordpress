/**
 * Validation and preview jobs (protocol §10). Proposed files are
 * materialised into a scratch worktree (`git worktree add --detach` at HEAD,
 * or a filtered copy when git is unavailable / the repo is read-only), then
 * ONLY the configured command arrays run, without a shell, with a clean env,
 * a per-step timeout and capped output.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResolvedConfig, ResolvedRoot, StepName } from "./config.js";
import type { FileChange } from "./diff.js";
import { runCommand, which } from "./exec.js";
import type { JobRegistry } from "./jobs.js";
import type { Logger } from "./logger.js";

const OUTPUT_CAP = 1024 * 1024;

class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    return () => {
      this.active--;
      this.waiters.shift()?.();
    };
  }
}

export interface ScratchDeps {
  cfg: ResolvedConfig;
  codeRoot: ResolvedRoot;
  logger: Logger;
}

async function gitAvailable(): Promise<boolean> {
  return (await which("git")) !== null;
}

function cleanEnv(home: string, nodeEnv: string): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: home, NODE_ENV: nodeEnv, CI: "1" };
}

/** Create the scratch tree and write the proposed files into it. */
export async function materialize(deps: ScratchDeps, jobId: string, changes: FileChange[], log: (s: string) => void): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const base = path.join(deps.cfg.state_dir, "scratch");
  await fsp.mkdir(base, { recursive: true, mode: 0o700 });
  const dir = path.join(base, jobId);
  const code = deps.codeRoot.abs;
  let usedGit = false;
  const useGit = deps.cfg.validation?.use_git_worktree !== false && fs.existsSync(path.join(code, ".git")) && (await gitAvailable());
  if (useGit) {
    const r = await runCommand("git", ["-C", code, "worktree", "add", "--detach", dir, "HEAD"], {
      timeoutMs: 120_000,
      env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), GIT_TERMINAL_PROMPT: "0" },
    });
    usedGit = r.code === 0;
    if (!usedGit) log("[bridge] git worktree unavailable (read-only repository?); falling back to a copy\n");
  }
  if (!usedGit) {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.cp(code, dir, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: (src) => {
        const rel = path.relative(code, src);
        if (!rel) return true;
        const top = rel.split(path.sep);
        return !top.some((s) => s === "node_modules" || s === ".git" || s === ".next");
      },
    });
  }
  const nm = path.join(code, "node_modules");
  if (fs.existsSync(nm) && !fs.existsSync(path.join(dir, "node_modules"))) {
    await fsp.symlink(nm, path.join(dir, "node_modules"), "dir");
  }
  for (const c of changes) {
    const root = deps.cfg.roots.find((r) => r.id === c.root);
    if (!root) continue;
    const relRoot = path.relative(code, root.abs);
    if (relRoot.startsWith("..") || path.isAbsolute(relRoot)) {
      log(`[bridge] ${c.root}/${c.path} is outside the repository and is not part of the scratch tree\n`);
      continue;
    }
    const target = path.join(dir, relRoot, ...c.path.split("/"));
    if (!target.startsWith(dir + path.sep)) continue;
    if (c.after === null) await fsp.rm(target, { force: true });
    else {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, c.after);
    }
  }
  const cleanup = async () => {
    if (usedGit) {
      await runCommand("git", ["-C", code, "worktree", "remove", "--force", dir], { timeoutMs: 60_000, env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir() } });
    }
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  return { dir, cleanup };
}

export class ValidationRunner {
  private readonly sem: Semaphore;
  constructor(
    private readonly deps: { cfg: ResolvedConfig; jobs: JobRegistry; logger: Logger; codeRoot: ResolvedRoot | undefined },
  ) {
    this.sem = new Semaphore(deps.cfg.validation?.max_concurrent ?? 1);
  }

  configuredSteps(): StepName[] {
    const s = this.deps.cfg.validation?.steps ?? {};
    return (["format", "lint", "typecheck", "build", "test"] as StepName[]).filter((n) => !!s[n]);
  }

  async selfCheck(): Promise<{ validate: string | null; preview: string | null }> {
    const cfg = this.deps.cfg;
    let validate: string | null = null;
    let preview: string | null = null;
    if (!this.deps.codeRoot) {
      validate = "no code_root configured";
      preview = validate;
    }
    if (!cfg.validation) validate ??= "no validation profile configured";
    else if (!this.configuredSteps().length) validate ??= "validation profile has no steps";
    else {
      for (const n of this.configuredSteps()) {
        const c = cfg.validation.steps[n]!;
        if (!(await which(c[0]!))) {
          validate ??= `command for step "${n}" not found on PATH`;
        }
      }
    }
    if (!cfg.preview) preview ??= "no preview profile configured";
    else if (!(await which(cfg.preview.command[0]!))) preview ??= "preview command not found on PATH";
    return { validate, preview };
  }

  startValidation(jobId: string, changes: FileChange[], steps: StepName[]): void {
    void this.run(jobId, changes, async (dir, home) => {
      const v = this.deps.cfg.validation!;
      let failed = false;
      for (const name of steps) {
        const cmd = v.steps[name];
        if (!cmd || failed) {
          this.deps.jobs.stepUpdate(jobId, name, { status: "skipped" });
          continue;
        }
        this.deps.jobs.stepUpdate(jobId, name, { status: "running" });
        const r = await runCommand(cmd[0]!, cmd.slice(1), {
          cwd: dir,
          env: cleanEnv(home, v.node_env),
          timeoutMs: v.timeout_s * 1000,
          capBytes: OUTPUT_CAP,
          onOutput: (chunk) => this.deps.jobs.log(jobId, name, chunk),
        });
        const ok = r.code === 0 && !r.timedOut;
        const tail = r.tail.slice(-8192) + (r.timedOut ? `\n[bridge] step timed out after ${v.timeout_s}s\n` : "");
        this.deps.jobs.stepUpdate(jobId, name, { status: ok ? "succeeded" : "failed", exit_code: r.code, duration_ms: r.durationMs, output_tail: tail });
        if (!ok) failed = true;
      }
      return { ok: !failed, result: { steps_run: steps } };
    });
  }

  startPreview(jobId: string, changes: FileChange[]): void {
    void this.run(jobId, changes, async (dir, home) => {
      const p = this.deps.cfg.preview!;
      this.deps.jobs.stepUpdate(jobId, "preview", { status: "running" });
      const r = await runCommand(p.command[0]!, p.command.slice(1), {
        cwd: dir,
        env: cleanEnv(home, "production"),
        timeoutMs: p.timeout_s * 1000,
        capBytes: OUTPUT_CAP,
        onOutput: (chunk) => this.deps.jobs.log(jobId, "preview", chunk),
      });
      const ok = r.code === 0 && !r.timedOut;
      this.deps.jobs.stepUpdate(jobId, "preview", { status: ok ? "succeeded" : "failed", exit_code: r.code, duration_ms: r.durationMs, output_tail: r.tail.slice(-8192) });
      return { ok, result: ok ? { preview_url: p.url } : { preview_url: null } };
    });
  }

  private async run(jobId: string, changes: FileChange[], body: (dir: string, home: string) => Promise<{ ok: boolean; result: Record<string, unknown> }>): Promise<void> {
    const jobs = this.deps.jobs;
    const release = await this.sem.acquire();
    let scratch: { dir: string; cleanup: () => Promise<void> } | null = null;
    try {
      jobs.update(jobId, (j) => (j.status = "running"), "status");
      scratch = await materialize({ cfg: this.deps.cfg, codeRoot: this.deps.codeRoot!, logger: this.deps.logger }, jobId, changes, (s) => jobs.log(jobId, "setup", s));
      const home = path.join(scratch.dir, ".bridge-home");
      await fsp.mkdir(home, { recursive: true });
      const { ok, result } = await body(scratch.dir, home);
      jobs.update(
        jobId,
        (j) => {
          j.status = ok ? "succeeded" : "failed";
          j.result = result;
          j.error = ok ? null : "one or more steps failed";
        },
        "status",
      );
    } catch (e) {
      this.deps.logger.error("job failed", { job_id: jobId, err: e });
      jobs.update(
        jobId,
        (j) => {
          j.status = "failed";
          j.error = "job could not run (see bridge log)";
        },
        "status",
      );
    } finally {
      await scratch?.cleanup().catch(() => {});
      release();
    }
  }
}
