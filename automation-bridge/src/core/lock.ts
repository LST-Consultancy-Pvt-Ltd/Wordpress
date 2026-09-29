/**
 * Per-site mutation lock: an in-process mutex (serialises requests inside one
 * Node process) plus an exclusive lock file (serialises across processes,
 * e.g. several Next.js workers in in-app mode, or a sidecar restart overlap).
 *
 * The lock file holds {pid, host, token, at}; it is refreshed while held and
 * considered stale when not refreshed for `staleMs` or when its pid is gone
 * on this host. Waiting longer than `waitMs` → 409 LOCKED.
 */
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "./errors.js";
import { sleep } from "./util.js";

class Mutex {
  private queue: Promise<void> = Promise.resolve();
  private waiting = 0;

  async acquire(waitMs: number): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.queue;
    this.queue = prev.then(() => next);
    this.waiting++;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timedOut = await Promise.race([
        prev.then(() => false),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(true), waitMs);
        }),
      ]);
      if (timedOut) {
        // Give up our slot once the predecessor finishes.
        prev.then(() => release());
        throw new BridgeError("LOCKED", "another mutation holds the site lock");
      }
      return release;
    } finally {
      this.waiting--;
      if (timer) clearTimeout(timer);
    }
  }
}

export interface LockOptions {
  dir: string;
  waitMs?: number;
  staleMs?: number;
  refreshMs?: number;
}

export class SiteLock {
  private readonly mutexes = new Map<string, Mutex>();
  private readonly dir: string;
  private readonly waitMs: number;
  private readonly staleMs: number;
  private readonly refreshMs: number;

  constructor(opts: LockOptions) {
    this.dir = opts.dir;
    this.waitMs = opts.waitMs ?? 10_000;
    this.staleMs = opts.staleMs ?? 60_000;
    this.refreshMs = opts.refreshMs ?? 5_000;
  }

  private mutex(name: string): Mutex {
    let m = this.mutexes.get(name);
    if (!m) {
      m = new Mutex();
      this.mutexes.set(name, m);
    }
    return m;
  }

  /** Run fn while holding the named lock ("site" for content, "deploy" for Docker ops). */
  async withLock<T>(name: string, fn: () => Promise<T>, waitMs = this.waitMs): Promise<T> {
    const started = Date.now();
    const releaseMutex = await this.mutex(name).acquire(waitMs);
    let releaseFile: (() => Promise<void>) | undefined;
    try {
      releaseFile = await this.acquireFile(name, Math.max(0, waitMs - (Date.now() - started)));
      return await fn();
    } finally {
      if (releaseFile) await releaseFile().catch(() => {});
      releaseMutex();
    }
  }

  private async acquireFile(name: string, waitMs: number): Promise<() => Promise<void>> {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, `${name}.lock`);
    const token = crypto.randomBytes(8).toString("hex");
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        const fh = await fsp.open(file, "wx", 0o600);
        await fh.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), token, at: new Date().toISOString() }));
        await fh.close();
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (await this.isStale(file)) {
          await fsp.rm(file, { force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new BridgeError("LOCKED", "another mutation holds the site lock");
        await sleep(50);
      }
    }
    const timer = setInterval(() => {
      const now = new Date();
      fsp.utimes(file, now, now).catch(() => {});
    }, this.refreshMs);
    timer.unref();
    return async () => {
      clearInterval(timer);
      try {
        const cur = JSON.parse(await fsp.readFile(file, "utf8")) as { token?: string };
        if (cur.token === token) await fsp.rm(file, { force: true });
      } catch {
        /* already gone */
      }
    };
  }

  private async isStale(file: string): Promise<boolean> {
    try {
      const st = await fsp.stat(file);
      if (Date.now() - st.mtimeMs > this.staleMs) return true;
      const info = JSON.parse(await fsp.readFile(file, "utf8")) as { pid?: number; host?: string };
      if (info.host === os.hostname() && typeof info.pid === "number" && info.pid !== process.pid) {
        try {
          process.kill(info.pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
        }
      }
      return false;
    } catch {
      // Unreadable or half-written lock: stale only if old.
      try {
        const st = await fsp.stat(file);
        return Date.now() - st.mtimeMs > 2000;
      } catch {
        return true;
      }
    }
  }
}
