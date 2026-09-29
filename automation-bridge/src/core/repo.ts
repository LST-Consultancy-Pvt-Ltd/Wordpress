/** Repository / runtime facts for /capabilities, read from files only (no git binary needed). */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function readText(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, "utf8");
  } catch {
    return null;
  }
}

export async function gitInfo(repo: string | null): Promise<{ available: boolean; commit: string | null; branch: string | null; dirty: boolean | null; gitDir: string | null }> {
  const none = { available: false, commit: null, branch: null, dirty: null, gitDir: null };
  if (!repo) return none;
  let gitDir = path.join(repo, ".git");
  try {
    const st = await fsp.stat(gitDir);
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec((await readText(gitDir)) ?? "");
      if (!m) return none;
      gitDir = path.resolve(repo, m[1]!.trim());
    }
  } catch {
    return none;
  }
  const head = (await readText(path.join(gitDir, "HEAD")))?.trim();
  if (!head) return { ...none, available: true, gitDir };
  let branch: string | null = null;
  let commit: string | null = null;
  const ref = /^ref:\s*(.+)$/.exec(head);
  if (ref) {
    const refName = ref[1]!.trim();
    branch = refName.replace(/^refs\/heads\//, "");
    const commonDir = (await readText(path.join(gitDir, "commondir")))?.trim();
    const dirs = [gitDir, commonDir ? path.resolve(gitDir, commonDir) : null].filter(Boolean) as string[];
    for (const d of dirs) {
      const direct = (await readText(path.join(d, ...refName.split("/"))))?.trim();
      if (direct && /^[0-9a-f]{40,64}$/.test(direct)) {
        commit = direct;
        break;
      }
      const packed = await readText(path.join(d, "packed-refs"));
      const line = packed?.split("\n").find((l) => l.endsWith(` ${refName}`));
      if (line) {
        commit = line.split(" ")[0]!;
        break;
      }
    }
  } else if (/^[0-9a-f]{40,64}$/.test(head)) {
    commit = head;
  }
  // Dirtiness needs a full index/worktree comparison; report unknown rather than guess.
  return { available: true, commit, branch, dirty: null, gitDir };
}

export async function nextjsInfo(repo: string | null): Promise<string | null> {
  if (!repo) return null;
  const installed = await readText(path.join(repo, "node_modules", "next", "package.json"));
  if (installed) {
    try {
      return (JSON.parse(installed) as { version?: string }).version ?? null;
    } catch {
      /* ignore */
    }
  }
  const pkg = await readText(path.join(repo, "package.json"));
  if (pkg) {
    try {
      const p = JSON.parse(pkg) as { dependencies?: Record<string, string> };
      const v = p.dependencies?.next;
      if (v) return v.replace(/^[\^~>=<\s]+/, "") || null;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function packageManager(repo: string | null): "npm" | "pnpm" | "yarn" | "bun" | "unknown" {
  if (!repo) return "unknown";
  const has = (f: string) => fs.existsSync(path.join(repo, f));
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("bun.lockb") || has("bun.lock")) return "bun";
  if (has("package-lock.json")) return "npm";
  return "unknown";
}

export function containerId(): string | null {
  for (const f of ["/proc/self/mountinfo", "/proc/self/cgroup"]) {
    try {
      const txt = fs.readFileSync(f, "utf8");
      const m = /(?:containers|docker)\/([0-9a-f]{64})/.exec(txt) ?? /\b([0-9a-f]{64})\b/.exec(txt);
      if (m) return m[1]!.slice(0, 12);
    } catch {
      /* not linux / not a container */
    }
  }
  const h = os.hostname();
  return /^[0-9a-f]{12}$/.test(h) ? h : null;
}
