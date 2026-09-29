/**
 * Sidecar → site revalidation signing (separate secret BRIDGE_REVALIDATE_SECRET):
 *   canonical = TIMESTAMP + "\n" + paths.join("\n")
 *   X-Revalidate-Signature = hex HMAC-SHA256(utf8 secret, canonical)
 *   X-Revalidate-Timestamp = unix seconds (±300 s)
 * Body: {"paths": ["/", "/blog/hello"]}
 */
import crypto from "node:crypto";

export const REVALIDATE_MAX_SKEW_S = 300;
export const REVALIDATE_MAX_PATHS = 200;

export function revalidateCanonical(timestamp: string | number, paths: string[]): string {
  return `${timestamp}\n${paths.join("\n")}`;
}

export function signRevalidate(secret: string, timestamp: string | number, paths: string[]): string {
  return crypto.createHmac("sha256", secret).update(revalidateCanonical(timestamp, paths), "utf8").digest("hex");
}

export function verifyRevalidate(secret: string, timestamp: string | null, signature: string | null, paths: string[], nowS = Math.floor(Date.now() / 1000)): boolean {
  if (!secret || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(nowS - Number(timestamp)) > REVALIDATE_MAX_SKEW_S) return false;
  const expected = Buffer.from(signRevalidate(secret, timestamp, paths), "utf8");
  const got = Buffer.from(signature, "utf8");
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}
