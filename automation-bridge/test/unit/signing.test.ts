import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalString, decodeSecret, sign, signaturesEqual } from "../../src/core/auth/signing.js";
import { signRevalidate, verifyRevalidate } from "../../src/shared/revalidate-signing.js";

const vectorsFile = path.resolve(__dirname, "../../../protocol/signing-test-vectors.json");
const vectors = JSON.parse(fs.readFileSync(vectorsFile, "utf8")) as {
  secret_b64url: string;
  cases: { method: string; path_with_query: string; timestamp: number; nonce: string; body_utf8: string; canonical: string; signature: string }[];
};

describe("signing test vectors (protocol/signing-test-vectors.json)", () => {
  it("decodes the secret to bytes 0x00..0x1f", () => {
    const b = decodeSecret(vectors.secret_b64url);
    expect([...b]).toEqual([...Array(32).keys()]);
  });
  for (const c of vectors.cases) {
    it(`reproduces ${c.method} ${c.path_with_query}`, () => {
      expect(canonicalString(c.method, c.path_with_query, c.timestamp, c.nonce, Buffer.from(c.body_utf8, "utf8"))).toBe(c.canonical);
      expect(sign(vectors.secret_b64url, c.method, c.path_with_query, c.timestamp, c.nonce, Buffer.from(c.body_utf8, "utf8"))).toBe(c.signature);
    });
  }
  it("rejects malformed secrets", () => {
    expect(() => decodeSecret("short")).toThrow();
    expect(() => decodeSecret(vectors.secret_b64url + "=")).toThrow();
  });
  it("compares in constant time and handles length mismatch", () => {
    expect(signaturesEqual("ab", "ab")).toBe(true);
    expect(signaturesEqual("ab", "abc")).toBe(false);
  });
});

describe("revalidate signing", () => {
  it("verifies and rejects tampering / skew", () => {
    const now = 1_790_000_000;
    const sig = signRevalidate("s3cret-value", now, ["/", "/blog"]);
    expect(verifyRevalidate("s3cret-value", String(now), sig, ["/", "/blog"], now)).toBe(true);
    expect(verifyRevalidate("s3cret-value", String(now), sig, ["/"], now)).toBe(false);
    expect(verifyRevalidate("other", String(now), sig, ["/", "/blog"], now)).toBe(false);
    expect(verifyRevalidate("s3cret-value", String(now), sig, ["/", "/blog"], now + 301)).toBe(false);
    expect(verifyRevalidate("s3cret-value", null, sig, ["/"], now)).toBe(false);
  });
});
