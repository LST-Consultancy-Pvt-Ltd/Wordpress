/**
 * Nonce replay cache and per-key sliding-window rate limits.
 *
 * Nonces are kept in memory (fast path) and, when a directory is given,
 * persisted as exclusively-created files named sha256(key_id \0 nonce), so a
 * replay is still detected after a restart or by another process sharing the
 * state dir (in-app mode with several workers). Files older than the TTL are
 * swept periodically.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class NonceCache {
  private seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly dir: string | null;
  private lastSweep = 0;

  constructor(ttlSeconds = 600, max = 200_000, dir: string | null = null) {
    this.ttlMs = ttlSeconds * 1000;
    this.max = max;
    this.dir = dir;
    if (dir) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** Returns false when (keyId, nonce) was already used inside the TTL. */
  checkAndRemember(keyId: string, nonce: string, now = Date.now()): boolean {
    const k = `${keyId}\u0000${nonce}`;
    if (now - this.lastSweep > 60_000) this.prune(now);
    const exp = this.seen.get(k);
    if (exp !== undefined && exp > now) return false;
    if (this.seen.size >= this.max) this.prune(now);
    if (this.seen.size >= this.max) {
      // Still full of live entries: refuse rather than forget (fail closed).
      return false;
    }
    if (this.dir && !this.persist(k, now)) return false;
    this.seen.set(k, now + this.ttlMs);
    return true;
  }

  private persist(k: string, now: number): boolean {
    const file = path.join(this.dir!, crypto.createHash("sha256").update(k).digest("hex"));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.closeSync(fs.openSync(file, "wx", 0o600));
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false; // fail closed
        try {
          const st = fs.statSync(file);
          if (now - st.mtimeMs <= this.ttlMs) return false; // live entry → replay
          fs.rmSync(file, { force: true }); // expired: reuse
        } catch {
          return false;
        }
      }
    }
    return false;
  }

  prune(now = Date.now()): void {
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
    if (this.dir && now - this.lastSweep > 60_000) {
      this.lastSweep = now;
      this.sweep(now);
    }
  }

  /** Delete persisted nonces older than the TTL. */
  sweep(now = Date.now()): number {
    if (!this.dir) return 0;
    let n = 0;
    for (const name of fs.readdirSync(this.dir)) {
      const f = path.join(this.dir, name);
      try {
        if (now - fs.statSync(f).mtimeMs > this.ttlMs) {
          fs.rmSync(f, { force: true });
          n++;
        }
      } catch {
        /* raced with another sweeper */
      }
    }
    return n;
  }
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private readonly windowMs: number;

  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
  }

  /** Records a hit and returns 0 if allowed, else seconds until a slot frees up. */
  hit(bucket: string, limit: number, now = Date.now()): number {
    const arr = (this.hits.get(bucket) ?? []).filter((t) => t > now - this.windowMs);
    if (arr.length >= limit) {
      this.hits.set(bucket, arr);
      const retry = Math.ceil((arr[0]! + this.windowMs - now) / 1000);
      return Math.max(1, retry);
    }
    arr.push(now);
    this.hits.set(bucket, arr);
    return 0;
  }
}
