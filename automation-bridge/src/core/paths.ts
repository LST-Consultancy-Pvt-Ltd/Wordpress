/**
 * Path safety (protocol §8 "Path rules"). Every `{root, path}` that reaches
 * the filesystem goes through `validateRelPath` + `resolveInRoot`.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import { BridgeError } from "./errors.js";
import type { ResolvedRoot } from "./config.js";

export const MAX_PATH_BYTES = 240;

/** Always denied for file operations, in every root, regardless of config. */
export const BUILTIN_DENY = [
  ".env",
  ".env*",
  "**/.env",
  "**/.env*",
  "**/node_modules",
  "**/node_modules/**",
  ".git",
  ".git/**",
  "**/.git/**",
  "Dockerfile*",
  "**/Dockerfile*",
  "docker-compose*",
  "**/docker-compose*",
  "compose.y*ml",
  "**/compose.y*ml",
  "compose.*.y*ml",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
  "**/npm-shrinkwrap.json",
  "**/.npmrc",
  "**/automation-bridge.config.json",
  "**/automation.manifest.json",
  "**/api/automation-bridge/**",
  "**/api/automation-revalidate/**",
  "**/automation-bridge/**",
  "**/*.pem",
  "**/*.key",
  "**/.next/**",
];

const ENCODED_TRAVERSAL = /%(2e|2f|5c|00)/i;

/**
 * Syntactic validation. Returns the NFC-normalised relative path or throws
 * PATH_INVALID. Does not touch the filesystem.
 */
export function validateRelPath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) throw new BridgeError("PATH_INVALID", "path must be a non-empty string");
  if (input.includes("\0")) throw new BridgeError("PATH_INVALID", "path contains NUL");
  const p = input.normalize("NFC");
  if (Buffer.byteLength(p, "utf8") > MAX_PATH_BYTES) throw new BridgeError("PATH_INVALID", `path longer than ${MAX_PATH_BYTES} bytes`);
  if (p.includes("\\")) throw new BridgeError("PATH_INVALID", "path must use POSIX separators");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw new BridgeError("PATH_INVALID", "path must be relative");
  if (ENCODED_TRAVERSAL.test(p)) throw new BridgeError("PATH_INVALID", "percent-encoded separators or dots are not allowed");
  // Control characters are never legitimate in repository paths.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) throw new BridgeError("PATH_INVALID", "path contains control characters");
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "") throw new BridgeError("PATH_INVALID", "empty path segment");
    if (s === "." || s === "..") throw new BridgeError("PATH_INVALID", "'.' and '..' segments are not allowed");
  }
  return p;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve a validated relative path inside a root, following symlinks with
 * realpath. Throws PATH_OUTSIDE_ROOT if the lexical result escapes, and
 * PATH_SYMLINK_ESCAPE if a symlink along the way points outside the root.
 * Returns the absolute (lexical) path to operate on.
 */
export async function resolveInRoot(root: ResolvedRoot, rel: string): Promise<string> {
  const clean = validateRelPath(rel);
  let rootReal: string;
  try {
    rootReal = await fsp.realpath(root.abs);
  } catch {
    throw new BridgeError("NOT_FOUND", `root "${root.id}" is not available`);
  }
  const lexical = path.resolve(root.abs, ...clean.split("/"));
  if (!isInside(path.resolve(root.abs), lexical)) throw new BridgeError("PATH_OUTSIDE_ROOT", "path resolves outside its root");
  // Walk from the target up to the deepest existing ancestor and realpath it.
  let probe = lexical;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await fsp.realpath(probe);
      const full = path.join(real, ...tail.reverse());
      if (!isInside(rootReal, full)) throw new BridgeError("PATH_SYMLINK_ESCAPE", "a symbolic link in the path points outside its root");
      break;
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ELOOP") throw new BridgeError("PATH_SYMLINK_ESCAPE", "symbolic link loop");
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      // A dangling symlink at this level: lstat succeeds but realpath fails.
      try {
        const st = await fsp.lstat(probe);
        if (st.isSymbolicLink()) {
          const target = await fsp.readlink(probe);
          const resolved = path.resolve(path.dirname(probe), target);
          if (!isInside(rootReal, resolved) && !isInside(path.resolve(root.abs), resolved)) {
            throw new BridgeError("PATH_SYMLINK_ESCAPE", "a symbolic link in the path points outside its root");
          }
        }
      } catch (e2) {
        if (e2 instanceof BridgeError) throw e2;
      }
      tail.push(path.basename(probe));
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return lexical;
}

/** True when the final path component is a symlink (writes refuse those). */
export async function isSymlink(abs: string): Promise<boolean> {
  try {
    return (await fsp.lstat(abs)).isSymbolicLink();
  } catch {
    return false;
  }
}

const matcherCache = new Map<string, (p: string) => boolean>();
function matcher(globs: string[]): (p: string) => boolean {
  const key = globs.join("\u0000");
  let m = matcherCache.get(key);
  if (!m) {
    m = globs.length ? picomatch(globs, { dot: true }) : () => false;
    matcherCache.set(key, m);
  }
  return m;
}

export function isDenied(root: Pick<ResolvedRoot, "deny">, rel: string): boolean {
  return matcher([...BUILTIN_DENY, ...root.deny])(rel);
}

export function isAllowed(root: Pick<ResolvedRoot, "allow">, rel: string): boolean {
  return root.allow.length > 0 && matcher(root.allow)(rel);
}

/** For `file.*` and `files.read`: syntax + allow-list + deny-list. */
export function checkFileOpPath(root: ResolvedRoot, rel: string): string {
  const clean = validateRelPath(rel);
  if (isDenied(root, clean)) throw new BridgeError("OPERATION_NOT_ALLOWED", "path matches a deny rule");
  if (!isAllowed(root, clean)) throw new BridgeError("OPERATION_NOT_ALLOWED", "path is not in the root's allow-list");
  return clean;
}

/** Validate a single URL path segment taken from the request target. */
export function safeSegment(raw: string, re: RegExp, what: string): string {
  let s: string;
  try {
    s = decodeURIComponent(raw);
  } catch {
    throw new BridgeError("VALIDATION_FAILED", `malformed ${what}`, { issues: [{ path: what, message: "malformed percent-encoding" }] });
  }
  if (!re.test(s)) throw new BridgeError("VALIDATION_FAILED", `invalid ${what}`, { issues: [{ path: what, message: `must match ${re.source}` }] });
  return s;
}
