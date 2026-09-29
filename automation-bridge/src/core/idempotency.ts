/**
 * Idempotency store (protocol §3): (key_id, Idempotency-Key) →
 * (fingerprint, status, response) for 24 h, persisted under
 * `<state>/idempotency/`. The fingerprint covers method, path and
 * sha256(body), so reusing a key on a different endpoint is a mismatch too.
 *
 * Responses flagged `sensitive` (credential rotation) are never written to
 * disk; they are replayable only from memory within the same process.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "./errors.js";
import { atomicWrite, ensureDirSync } from "./fsutil.js";
import { sha256Hex } from "./util.js";

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: string; // utf-8 JSON
}

interface Record_ {
  fingerprint: string;
  created_at: number;
  response: StoredResponse | null; // null = sensitive, not persisted
}

export class IdempotencyStore {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly memory = new Map<string, { fingerprint: string; created_at: number; response: StoredResponse }>();
  private readonly inflight = new Map<string, { fingerprint: string; promise: Promise<StoredResponse> }>();

  constructor(dir: string, ttlHours = 24) {
    this.dir = dir;
    this.ttlMs = ttlHours * 3600 * 1000;
    ensureDirSync(dir);
  }

  static fingerprint(method: string, pathNoQuery: string, body: Buffer): string {
    return sha256Hex(`${method.toUpperCase()}\n${pathNoQuery}\n${sha256Hex(body)}`);
  }

  private fileFor(keyId: string, idemKey: string): string {
    return path.join(this.dir, `${sha256Hex(`${keyId}\u0000${idemKey}`)}.json`);
  }

  private async load(keyId: string, idemKey: string): Promise<Record_ | null> {
    try {
      const rec = JSON.parse(await fsp.readFile(this.fileFor(keyId, idemKey), "utf8")) as Record_;
      if (Date.now() - rec.created_at > this.ttlMs) return null;
      return rec;
    } catch {
      return null;
    }
  }

  /**
   * Run `fn` at most once per (keyId, idemKey). Replays return the stored
   * response with `Idempotent-Replay: true`. `shouldStore` decides whether a
   * given outcome is final (transient failures such as LOCKED are not stored).
   */
  async run(
    keyId: string,
    idemKey: string,
    fingerprint: string,
    fn: () => Promise<StoredResponse>,
    opts: { sensitive?: boolean; shouldStore: (r: StoredResponse) => boolean },
  ): Promise<StoredResponse> {
    const mkey = `${keyId}\u0000${idemKey}`;
    const live = this.inflight.get(mkey);
    if (live) {
      if (live.fingerprint !== fingerprint) throw new BridgeError("IDEMPOTENCY_MISMATCH", "Idempotency-Key was already used with a different request");
      const r = await live.promise;
      return replay(r);
    }
    const mem = this.memory.get(mkey);
    if (mem && Date.now() - mem.created_at <= this.ttlMs) {
      if (mem.fingerprint !== fingerprint) throw new BridgeError("IDEMPOTENCY_MISMATCH", "Idempotency-Key was already used with a different request");
      return replay(mem.response);
    }
    const stored = await this.load(keyId, idemKey);
    if (stored) {
      if (stored.fingerprint !== fingerprint) throw new BridgeError("IDEMPOTENCY_MISMATCH", "Idempotency-Key was already used with a different request");
      if (!stored.response) {
        throw new BridgeError("IDEMPOTENCY_MISMATCH", "this response contained a one-time secret and cannot be replayed; retry with a new Idempotency-Key", {
          reason: "secret_not_replayable",
        });
      }
      return replay(stored.response);
    }
    const promise = fn();
    this.inflight.set(mkey, { fingerprint, promise });
    try {
      const r = await promise;
      if (opts.shouldStore(r)) {
        const created_at = Date.now();
        if (opts.sensitive) this.memory.set(mkey, { fingerprint, created_at, response: r });
        const rec: Record_ = { fingerprint, created_at, response: opts.sensitive ? null : r };
        await atomicWrite(this.fileFor(keyId, idemKey), JSON.stringify(rec), { mode: 0o600 });
      }
      return r;
    } finally {
      this.inflight.delete(mkey);
    }
  }

  async prune(): Promise<number> {
    let n = 0;
    const now = Date.now();
    for (const [k, v] of this.memory) if (now - v.created_at > this.ttlMs) this.memory.delete(k);
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const f = path.join(this.dir, name);
      try {
        const rec = JSON.parse(await fsp.readFile(f, "utf8")) as Record_;
        if (now - rec.created_at > this.ttlMs) {
          await fsp.rm(f, { force: true });
          n++;
        }
      } catch {
        await fsp.rm(f, { force: true }).catch(() => {});
      }
    }
    return n;
  }
}

function replay(r: StoredResponse): StoredResponse {
  return { ...r, headers: { ...r.headers, "idempotent-replay": "true" } };
}
