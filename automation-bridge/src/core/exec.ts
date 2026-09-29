/**
 * Command execution without a shell. Only ever called with command arrays
 * that come from the bridge config (validation/preview profiles) or fixed
 * docker templates — never with request data.
 */
import { execFile } from "node:child_process";

export interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Combined tail (stdout+stderr interleaved), capped. */
  tail: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  /** Bytes of combined output kept (tail). */
  capBytes?: number;
  onOutput?: (chunk: string) => void;
}

const HARD_BUFFER = 16 * 1024 * 1024;

export function runCommand(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  const cap = opts.capBytes ?? 1024 * 1024;
  const started = Date.now();
  return new Promise((resolve) => {
    let tail = "";
    let truncated = false;
    const push = (s: string) => {
      tail += s;
      if (Buffer.byteLength(tail) > cap) {
        truncated = true;
        tail = tail.slice(tail.length - cap);
      }
      opts.onOutput?.(s);
    };
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: HARD_BUFFER,
        shell: false,
        windowsHide: true,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string }) | null;
        const timedOut = !!e && !!e.killed && Date.now() - started >= opts.timeoutMs - 50;
        let code: number | null = 0;
        if (e) code = typeof e.code === "number" ? e.code : null;
        if (e && typeof e.code === "string") {
          // Spawn failure (ENOENT etc.) or maxBuffer exceeded.
          push(`\n[bridge] command could not run: ${e.code}\n`);
        }
        resolve({
          code,
          signal: e?.signal ?? null,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          tail,
          timedOut,
          truncated,
          durationMs: Date.now() - started,
        });
      },
    );
    child.stdout?.on("data", (d: string) => push(String(d)));
    child.stderr?.on("data", (d: string) => push(String(d)));
    child.stdin?.end();
  });
}

/** Resolve a bare command name against PATH (no shell). */
export async function which(cmd: string, pathEnv = process.env.PATH ?? ""): Promise<string | null> {
  const { access, constants } = await import("node:fs/promises");
  const path = await import("node:path");
  if (cmd.includes("/")) {
    try {
      await access(cmd, constants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try {
      await access(full, constants.X_OK);
      return full;
    } catch {
      /* next */
    }
  }
  return null;
}
