/**
 * Validation and preview jobs (protocol §10). Proposed files are
 * materialised into a scratch worktree (`git worktree add --detach` at HEAD,
 * or a filtered copy when git is unavailable / the repo is read-only), then
 * ONLY the configured command arrays run, without a shell, with a clean env,
 * a per-step timeout and capped output.
 *
 * Isolation (these commands run repository code on proposed content):
 *  - scratch trees live outside `state_dir` and every root (`scratch_dir`,
 *    default `<os tmp>/automation-bridge-scratch`);
 *  - jobs refuse to start unless they run as a different user (`run_as`) or
 *    the operator opted in with `allow_same_user: true`; a bridge running as
 *    root must use `run_as`; with `run_as`, `state_dir` must not be
 *    group/other-accessible;
 *  - `node_modules` is a private copy by default (`node_modules: "symlink"` is
 *    faster but lets a job modify the repository's copy);
 *  - job output is redacted (registered secrets, bearer tokens, signatures,
 *    absolute root/state paths) before it is stored or streamed.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResolvedConfig, ResolvedRoot, StepName } from "./config.js";
import type { FileChange } from "./diff.js";
import { runCommand, which } from "./exec.js";
import type { JobRegistry } from "./jobs.js";
import type { Logger, Redactor } from "./logger.js";

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

export interface Sandbox {
  run_as: { uid: number; gid: number } | null;
  allow_same_user: boolean;
  node_modules: "copy" | "symlink";
  scratch_dir: string | null;
}

export interface ScratchDeps {
  cfg: ResolvedConfig;
  codeRoot: ResolvedRoot;
  logger: Logger;
  sandbox: Sandbox;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function scratchBase(cfg: ResolvedConfig, sb: Sandbox): string {
  return path.resolve(sb.scratch_dir ?? path.join(os.tmpdir(), "automation-bridge-scratch"));
}

/** Why a job must not run with this sandbox, or null when it may. */
export async function sandboxProblem(cfg: ResolvedConfig, sb: Sandbox, codeRoot: ResolvedRoot | undefined): Promise<string | null> {
  const myUid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (!sb.run_as && !sb.allow_same_user) {
    return "jobs would run as the bridge user and could read the key store: set run_as (separate user) or allow_same_user: true";
  }
  if (myUid === 0 && (!sb.run_as || sb.run_as.uid === 0)) return "the bridge runs as root: set run_as to an unprivileged uid/gid";
  if (sb.run_as && sb.run_as.uid === myUid && !sb.allow_same_user) return "run_as equals the bridge uid: use a different user or allow_same_user: true";
  const base = scratchBase(cfg, sb);
  const state = path.resolve(cfg.state_dir);
  if (isInside(state, base) || isInside(base, state)) return "scratch_dir and state_dir must not contain each other";
  for (const r of cfg.roots) {
    if (isInside(r.abs, base)) return `scratch_dir must not be inside root "${r.id}"`;
  }
  if (codeRoot && isInside(codeRoot.abs, state)) return "state_dir is inside the code root and would be copied into scratch trees";
  if (sb.run_as && sb.run_as.uid !== myUid) {
    try {
      const st = await fsp.stat(state);
      if ((st.mode & 0o077) !== 0) return "state_dir is accessible to other users (must be mode 0700 when run_as is used)";
    } catch {
      return "state_dir is not accessible";
    }
  }
  return null;
}

async function gitAvailable(): Promise<boolean> {
  return (await which("git")) !== null;
}

function cleanEnv(home: string, nodeEnv: string): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: home, NODE_ENV: nodeEnv, CI: "1" };
}

async function chownTree(dir: string, uid: number, gid: number): Promise<void> {
  await fsp.lchown(dir, uid, gid);
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await chownTree(p, uid, gid);
    else await fsp.lchown(p, uid, gid);
  }
}

/** Create the scratch tree and write the proposed files into it. */
export async function materialize(deps: ScratchDeps, jobId: string, changes: FileChange[], log: (s: string) => void): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const base = scratchBase(deps.cfg, deps.sandbox);
  await fsp.mkdir(base, { recursive: true, mode: 0o711 });
  const dir = path.join(base, jobId);
  const code = deps.codeRoot.abs;
  const state = path.resolve(deps.cfg.state_dir);
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
        if (isInside(state, path.resolve(src))) return false;
        const rel = path.relative(code, src);
        if (!rel) return true;
        return !rel.split(path.sep).some((s) => s === "node_modules" || s === ".git" || s === ".next");
      },
    });
  }
  const nm = path.join(code, "node_modules");
  const target = path.join(dir, "node_modules");
  if (fs.existsSync(nm) && !fs.existsSync(target)) {
    if (deps.sandbox.node_modules === "symlink") {
      log("[bridge] node_modules is a symlink to the repository's copy (validation.node_modules = symlink)\n");
      await fsp.symlink(nm, target, "dir");
    } else {
      await fsp.cp(nm, target, { recursive: true, dereference: false, verbatimSymlinks: true });
    }
  }
  for (const c of changes) {
    const root = deps.cfg.roots.find((r) => r.id === c.root);
    if (!root) continue;
    const relRoot = path.relative(code, root.abs);
    if (relRoot.startsWith("..") || path.isAbsolute(relRoot)) {
      log(`[bridge] ${c.root}/${c.path} is outside the repository and is not part of the scratch tree\n`);
      continue;
    }
    const t = path.join(dir, relRoot, ...c.path.split("/"));
    if (!t.startsWith(dir + path.sep)) continue;
    if (c.after === null) await fsp.rm(t, { force: true });
    else {
      await fsp.mkdir(path.dirname(t), { recursive: true });
      await fsp.writeFile(t, c.after);
    }
  }
  await fsp.mkdir(path.join(dir, ".bridge-home"), { recursive: true });
  if (deps.sandbox.run_as) await chownTree(dir, deps.sandbox.run_as.uid, deps.sandbox.run_as.gid);
  else await fsp.chmod(dir, 0o700);
  const cleanup = async () => {
    if (usedGit) {
      await runCommand("git", ["-C", code, "worktree", "remove", "--force", dir], { timeoutMs: 60_000, env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir() } });
    }
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  return { dir, cleanup };
}

/** Line-buffered redaction so secrets split across chunks are still masked. */
class RedactingSink {
  private partial = "";
  tail = "";
  truncated = false;
  constructor(
    private readonly redactor: Redactor,
    private readonly emit: (s: string) => void,
  ) {}
  private out(s: string): void {
    const r = this.redactor.redactString(s);
    this.tail += r;
    if (Buffer.byteLength(this.tail) > OUTPUT_CAP) {
      this.truncated = true;
      this.tail = this.tail.slice(this.tail.length - OUTPUT_CAP);
    }
    this.emit(r);
  }
  write(chunk: string): void {
    const text = this.partial + chunk;
    const nl = text.lastIndexOf("\n");
    if (nl < 0) {
      this.partial = text;
      if (this.partial.length > 64 * 1024) {
        this.out(this.partial);
        this.partial = "";
      }
      return;
    }
    this.partial = text.slice(nl + 1);
    this.out(text.slice(0, nl + 1));
  }
  end(extra = ""): string {
    if (this.partial) this.out(this.partial);
    this.partial = "";
    if (extra) this.out(extra);
    return this.tail;
  }
}

export class ValidationRunner {
  private readonly sem: Semaphore;
  constructor(
    private readonly deps: { cfg: ResolvedConfig; jobs: JobRegistry; logger: Logger; redactor: Redactor; codeRoot: ResolvedRoot | undefined },
  ) {
    this.sem = new Semaphore(deps.cfg.validation?.max_concurrent ?? 1);
  }

  configuredSteps(): StepName[] {
    const s = this.deps.cfg.validation?.steps ?? {};
    return (["format", "lint", "typecheck", "build", "test"] as StepName[]).filter((n) => !!s[n]);
  }

  private sandbox(kind: "validation" | "preview"): Sandbox {
    const c = kind === "validation" ? this.deps.cfg.validation : this.deps.cfg.preview;
    return { run_as: c?.run_as ?? null, allow_same_user: c?.allow_same_user ?? false, node_modules: c?.node_modules ?? "copy", scratch_dir: c?.scratch_dir ?? null };
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
      validate ??= await sandboxProblem(cfg, this.sandbox("validation"), this.deps.codeRoot);
      for (const n of this.configuredSteps()) {
        const c = cfg.validation.steps[n]!;
        if (!(await which(c[0]!))) validate ??= `command for step "${n}" not found on PATH`;
      }
    }
    if (!cfg.preview) preview ??= "no preview profile configured";
    else {
      preview ??= await sandboxProblem(cfg, this.sandbox("preview"), this.deps.codeRoot);
      if (!(await which(cfg.preview.command[0]!))) preview ??= "preview command not found on PATH";
    }
    return { validate, preview };
  }

  private async exec(jobId: string, step: string, cmd: string[], dir: string, home: string, nodeEnv: string, timeoutS: number, sb: Sandbox) {
    const sink = new RedactingSink(this.deps.redactor, (s) => this.deps.jobs.log(jobId, step, s));
    const r = await runCommand(cmd[0]!, cmd.slice(1), {
      cwd: dir,
      env: cleanEnv(home, nodeEnv),
      timeoutMs: timeoutS * 1000,
      capBytes: OUTPUT_CAP,
      ...(sb.run_as ? { uid: sb.run_as.uid, gid: sb.run_as.gid } : {}),
      onOutput: (chunk) => sink.write(chunk),
    });
    const notRun = r.code === null && !r.timedOut && !r.signal ? "\n[bridge] command could not be started\n" : "";
    const tail = sink.end((r.timedOut ? `\n[bridge] step timed out after ${timeoutS}s\n` : "") + notRun).slice(-8192);
    return { ok: r.code === 0 && !r.timedOut, code: r.code, durationMs: r.durationMs, tail };
  }

  startValidation(jobId: string, changes: FileChange[], steps: StepName[]): void {
    const sb = this.sandbox("validation");
    void this.run(jobId, changes, sb, async (dir, home) => {
      const v = this.deps.cfg.validation!;
      let failed = false;
      for (const name of steps) {
        const cmd = v.steps[name];
        if (!cmd || failed) {
          this.deps.jobs.stepUpdate(jobId, name, { status: "skipped" });
          continue;
        }
        this.deps.jobs.stepUpdate(jobId, name, { status: "running" });
        const r = await this.exec(jobId, name, cmd, dir, home, v.node_env, v.timeout_s, sb);
        this.deps.jobs.stepUpdate(jobId, name, { status: r.ok ? "succeeded" : "failed", exit_code: r.code, duration_ms: r.durationMs, output_tail: r.tail });
        if (!r.ok) failed = true;
      }
      return { ok: !failed, result: { steps_run: steps } };
    });
  }

  startPreview(jobId: string, changes: FileChange[]): void {
    const sb = this.sandbox("preview");
    void this.run(jobId, changes, sb, async (dir, home) => {
      const p = this.deps.cfg.preview!;
      this.deps.jobs.stepUpdate(jobId, "preview", { status: "running" });
      const r = await this.exec(jobId, "preview", p.command, dir, home, "production", p.timeout_s, sb);
      this.deps.jobs.stepUpdate(jobId, "preview", { status: r.ok ? "succeeded" : "failed", exit_code: r.code, duration_ms: r.durationMs, output_tail: r.tail });
      return { ok: r.ok, result: r.ok ? { preview_url: p.url } : { preview_url: null } };
    });
  }

  private async run(jobId: string, changes: FileChange[], sb: Sandbox, body: (dir: string, home: string) => Promise<{ ok: boolean; result: Record<string, unknown> }>): Promise<void> {
    const jobs = this.deps.jobs;
    const release = await this.sem.acquire();
    let scratch: { dir: string; cleanup: () => Promise<void> } | null = null;
    let outcome: { ok: boolean; result: Record<string, unknown> | null; error: string | null };
    try {
      jobs.update(jobId, (j) => (j.status = "running"), "status");
      const problem = await sandboxProblem(this.deps.cfg, sb, this.deps.codeRoot);
      if (problem) throw new Error(`sandbox refused: ${problem}`);
      scratch = await materialize({ cfg: this.deps.cfg, codeRoot: this.deps.codeRoot!, logger: this.deps.logger, sandbox: sb }, jobId, changes, (s) =>
        jobs.log(jobId, "setup", this.deps.redactor.redactString(s)),
      );
      const { ok, result } = await body(scratch.dir, path.join(scratch.dir, ".bridge-home"));
      outcome = { ok, result, error: ok ? null : "one or more steps failed" };
    } catch (e) {
      this.deps.logger.error("job failed", { job_id: jobId, err: e });
      outcome = { ok: false, result: null, error: "job could not run (see bridge log)" };
    } finally {
      // Clean up before reporting a terminal status so observers never see a stale scratch tree.
      await scratch?.cleanup().catch(() => {});
      release();
    }
    jobs.update(
      jobId,
      (j) => {
        j.status = outcome.ok ? "succeeded" : "failed";
        j.result = outcome.result;
        j.error = outcome.error;
      },
      "status",
    );
  }
}
