/**
 * Request signing (protocol §1):
 *   canonical = METHOD \n PATH_WITH_QUERY \n TIMESTAMP \n NONCE \n hex(sha256(body))
 *   signature = lowercase hex HMAC-SHA256(decoded 32-byte secret, canonical)
 */
import crypto from "node:crypto";

export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

export function decodeSecret(secretB64url: string): Buffer {
  if (!SECRET_RE.test(secretB64url)) throw new Error("secret must be 32 bytes base64url without padding");
  const buf = Buffer.from(secretB64url, "base64url");
  if (buf.length !== 32) throw new Error("secret must decode to 32 bytes");
  return buf;
}

export function generateSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function generateKeyId(): string {
  return `k_${crypto.randomBytes(8).toString("hex")}`;
}

export function bodySha256(body: Buffer | string | Uint8Array): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}

export function canonicalString(method: string, pathWithQuery: string, timestamp: string | number, nonce: string, body: Buffer | string | Uint8Array): string {
  return `${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${bodySha256(body)}`;
}

export function signCanonical(secret: Buffer, canonical: string): string {
  return crypto.createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

export function sign(secretB64url: string, method: string, pathWithQuery: string, timestamp: string | number, nonce: string, body: Buffer | string | Uint8Array = ""): string {
  return signCanonical(decodeSecret(secretB64url), canonicalString(method, pathWithQuery, timestamp, nonce, body));
}

/** Constant-time comparison of two lowercase hex signatures. */
export function signaturesEqual(expectedHex: string, providedHex: string): boolean {
  const a = Buffer.from(expectedHex, "utf8");
  const b = Buffer.from(providedHex, "utf8");
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a); // keep timing roughly uniform
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/** Headers for a signed request (used by tests, the CLI and the revalidate client). */
export function signedHeaders(opts: {
  keyId: string;
  secret: string;
  method: string;
  pathWithQuery: string;
  body?: Buffer | string;
  timestamp?: number;
  nonce?: string;
}): Record<string, string> {
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? crypto.randomBytes(16).toString("base64url");
  return {
    "x-bridge-key-id": opts.keyId,
    "x-bridge-timestamp": String(ts),
    "x-bridge-nonce": nonce,
    "x-bridge-signature": sign(opts.secret, opts.method, opts.pathWithQuery, ts, nonce, opts.body ?? ""),
  };
}
