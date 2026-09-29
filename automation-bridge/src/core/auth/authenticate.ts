import crypto from "node:crypto";
import { BridgeError } from "../errors.js";
import type { KeyStore, Scope } from "./keystore.js";
import { NonceCache } from "./limits.js";
import { NONCE_RE, canonicalString, signCanonical, signaturesEqual } from "./signing.js";

export const MAX_SKEW_SECONDS = 300;

export interface AuthContext {
  keyId: string;
  scopes: Scope[];
}

const DUMMY_SECRET = crypto.randomBytes(32);

export class Authenticator {
  private readonly keys: KeyStore;
  private readonly nonces: NonceCache;
  private readonly now: () => number;

  constructor(keys: KeyStore, opts: { now?: () => number; nonces?: NonceCache } = {}) {
    this.keys = keys;
    this.nonces = opts.nonces ?? new NonceCache(600);
    this.now = opts.now ?? Date.now;
  }

  /**
   * Verify a signed request. Order: headers → nonce syntax → timestamp skew →
   * signature (constant time, also for unknown key ids) → revocation/expiry →
   * nonce replay. AUTH_REVOKED is only returned to a caller that proved
   * possession of that key's secret, so unknown and revoked ids are
   * indistinguishable to everyone else.
   */
  verify(input: { method: string; pathWithQuery: string; headers: Record<string, string | undefined>; body: Buffer }): AuthContext {
    const h = input.headers;
    const keyId = h["x-bridge-key-id"];
    const ts = h["x-bridge-timestamp"];
    const nonce = h["x-bridge-nonce"];
    const sig = h["x-bridge-signature"];
    if (!keyId || !ts || !nonce || !sig) throw new BridgeError("AUTH_MISSING", "missing authentication headers");
    if (!NONCE_RE.test(nonce) || !/^[0-9a-f]{64}$/.test(sig) || !/^\d{1,12}$/.test(ts) || keyId.length > 128) {
      throw new BridgeError("AUTH_INVALID", "authentication failed");
    }
    const nowS = Math.floor(this.now() / 1000);
    if (Math.abs(nowS - Number(ts)) > MAX_SKEW_SECONDS) throw new BridgeError("AUTH_EXPIRED", "request timestamp outside the allowed window");
    const found = this.keys.get(keyId);
    const canonical = canonicalString(input.method, input.pathWithQuery, ts, nonce, input.body);
    const expected = signCanonical(found ? found.secret : DUMMY_SECRET, canonical);
    const ok = signaturesEqual(expected, sig);
    if (!found || !ok) throw new BridgeError("AUTH_INVALID", "authentication failed");
    if (!this.keys.isActive(found.entry, this.now())) throw new BridgeError("AUTH_REVOKED", "credential is revoked or expired");
    if (!this.nonces.checkAndRemember(keyId, nonce, this.now())) throw new BridgeError("AUTH_REPLAY", "nonce already used");
    return { keyId, scopes: [...found.entry.scopes] };
  }
}
