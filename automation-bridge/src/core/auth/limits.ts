/** Nonce replay cache and per-key sliding-window rate limits (in memory). */

export class NonceCache {
  private seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(ttlSeconds = 600, max = 200_000) {
    this.ttlMs = ttlSeconds * 1000;
    this.max = max;
  }

  /** Returns false when (keyId, nonce) was already used inside the TTL. */
  checkAndRemember(keyId: string, nonce: string, now = Date.now()): boolean {
    const k = `${keyId}\u0000${nonce}`;
    const exp = this.seen.get(k);
    if (exp !== undefined && exp > now) return false;
    if (this.seen.size >= this.max) this.prune(now);
    if (this.seen.size >= this.max) {
      // Still full of live entries: refuse rather than forget (fail closed).
      return false;
    }
    this.seen.set(k, now + this.ttlMs);
    return true;
  }

  prune(now = Date.now()): void {
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
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
