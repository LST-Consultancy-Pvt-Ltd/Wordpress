import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedRoot } from "../../src/core/config.js";
import { BridgeError } from "../../src/core/errors.js";
import { checkFileOpPath, resolveInRoot, validateRelPath } from "../../src/core/paths.js";
import { makeBridge, tmpDir } from "../helpers.js";

function root(abs: string, extra: Partial<ResolvedRoot> = {}): ResolvedRoot {
  return { id: "code", kind: "code", path: abs, abs, writable: true, allow: ["app/**", "public/**", "components/**"], deny: ["app/secret/**"], ...extra };
}

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof BridgeError ? e.code : "OTHER";
  }
}

async function acode(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof BridgeError ? e.code : "OTHER";
  }
}

describe("validateRelPath", () => {
  it.each([
    ["../etc/passwd"],
    ["app/../../x"],
    ["/etc/passwd"],
    ["C:/Windows"],
    ["app\\x.ts"],
    ["app/%2e%2e/x"],
    ["app/%2E%2E%2Fx"],
    ["app/a%00b"],
    ["a\u0000b"],
    ["app//x"],
    ["./app/x"],
    ["app/x/"],
    [""],
    ["a/" + "x".repeat(250)],
    ["app/\u0007bell"],
  ])("rejects %j", (p) => {
    expect(code(() => validateRelPath(p))).toBe("PATH_INVALID");
  });
  it("NFC-normalises", () => {
    const decomposed = "app/cafe\u0301.ts";
    expect(validateRelPath(decomposed)).toBe("app/caf\u00e9.ts");
  });
});

describe("resolveInRoot", () => {
  it("detects symlink escapes (dir, file and dangling)", async () => {
    const dir = tmpDir();
    const outside = tmpDir();
    fs.mkdirSync(path.join(dir, "app"), { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.txt"), "x");
    fs.symlinkSync(outside, path.join(dir, "app", "link"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "app", "file-link.ts"));
    fs.symlinkSync(path.join(outside, "missing.txt"), path.join(dir, "app", "dangling.ts"));
    fs.mkdirSync(path.join(dir, "app", "inner"));
    fs.symlinkSync(path.join(dir, "app", "inner"), path.join(dir, "app", "ok-link"));
    const r = root(dir);
    expect(await acode(resolveInRoot(r, "app/link/secret.txt"))).toBe("PATH_SYMLINK_ESCAPE");
    expect(await acode(resolveInRoot(r, "app/link/new/file.ts"))).toBe("PATH_SYMLINK_ESCAPE");
    expect(await acode(resolveInRoot(r, "app/file-link.ts"))).toBe("PATH_SYMLINK_ESCAPE");
    expect(await acode(resolveInRoot(r, "app/dangling.ts"))).toBe("PATH_SYMLINK_ESCAPE");
    expect(await acode(resolveInRoot(r, "app/ok-link/x.ts"))).toBeNull();
    expect(await acode(resolveInRoot(r, "app/new/deep/file.ts"))).toBeNull();
  });
});

describe("allow/deny globs", () => {
  const r = root("/nonexistent");
  it.each([
    [".env"],
    [".env.local"],
    ["app/.env.production"],
    ["node_modules/x/index.js"],
    ["app/node_modules/x.ts"],
    [".git/config"],
    ["Dockerfile"],
    ["docker-compose.yml"],
    ["compose.yaml"],
    ["package-lock.json"],
    ["app/secret/x.ts"],
    ["automation-bridge.config.json"],
    ["app/api/automation-bridge/v1/[[...path]]/route.ts"],
    ["server.ts"],
    ["lib/x.ts"],
  ])("denies %j", (p) => {
    expect(code(() => checkFileOpPath(r, p))).toBe("OPERATION_NOT_ALLOWED");
  });
  it("allows allow-listed files", () => {
    expect(checkFileOpPath(r, "app/page.tsx")).toBe("app/page.tsx");
    expect(checkFileOpPath(r, "components/Button.tsx")).toBe("components/Button.tsx");
  });
});

describe("file operations through the API", () => {
  it("reports path errors as plan errors, never touching disk", async () => {
    const { client, f } = await makeBridge();
    const cases: [string, string][] = [
      ["../outside.ts", "PATH_INVALID"],
      ["app/%2e%2e/%2e%2e/x.ts", "PATH_INVALID"],
      ["/etc/passwd", "PATH_INVALID"],
      [".env", "OPERATION_NOT_ALLOWED"],
      ["package.json", "OPERATION_NOT_ALLOWED"],
    ];
    for (const [p, c] of cases) {
      const r = await client.post("/changesets/plan", { change_id: "cs_p", operations: [{ op: "file.write", root: "code", path: p, content: "x", base_sha256: null }] }, null);
      expect(r.status, p).toBe(200);
      expect(r.json.valid, p).toBe(false);
      expect(r.json.errors[0].code, p).toBe(c);
    }
    fs.symlinkSync(tmpDir(), path.join(f.repo, "app", "evil"));
    const s = await client.post("/changesets/plan", { change_id: "cs_p", operations: [{ op: "file.write", root: "code", path: "app/evil/x.ts", content: "x", base_sha256: null }] }, null);
    expect(s.json.errors[0].code).toBe("PATH_SYMLINK_ESCAPE");
    const nul = await client.post("/changesets/plan", { change_id: "cs_p", operations: [{ op: "file.write", root: "code", path: "app/a\u0000.ts", content: "x", base_sha256: null }] }, null);
    expect(nul.json.errors[0].code).toBe("PATH_INVALID");
  });

  it("file.write on a code root is planned with a code-change flag and applied", async () => {
    const { client, f } = await makeBridge();
    const { plan, apply } = await client.planAndApply([{ op: "file.write", root: "code", path: "app/new/page.tsx", content: "export default function N(){return null}\n", base_sha256: null }]);
    expect(plan.json.risk).toEqual({ level: "high", flags: ["code-change"] });
    expect(apply!.status).toBe(200);
    expect(fs.readFileSync(path.join(f.repo, "app/new/page.tsx"), "utf8")).toContain("function N");
    const read = await client.get("/files/code?path=app/new/page.tsx");
    expect(read.status).toBe(200);
    expect(read.json.content).toContain("function N");
    const env = await client.get("/files/code?path=.env");
    expect(env.json.error.code).toBe("OPERATION_NOT_ALLOWED");
  });

  it("refuses file.* on overrides/content roots", async () => {
    const { client } = await makeBridge();
    const r = await client.post("/changesets/plan", { change_id: "cs_p", operations: [{ op: "file.write", root: "overrides", path: "metadata.json", content: "{}", base_sha256: null }] }, null);
    expect(r.json.errors[0].code).toBe("OPERATION_NOT_ALLOWED");
  });
});
