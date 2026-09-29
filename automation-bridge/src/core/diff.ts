import { createTwoFilesPatch } from "diff";
import type { PlanFileT } from "./schemas.js";
import { sha256Hex } from "./util.js";

/** A proposed change to one file, before/after contents (null = absent). */
export interface FileChange {
  root: string;
  path: string;
  before: Buffer | null;
  after: Buffer | null;
}

function isProbablyText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  return Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}

/** Unified diff of one change, paths shown as `<root>/<path>`. */
export function unifiedDiff(c: FileChange): string {
  const label = `${c.root}/${c.path}`;
  const a = c.before === null ? "/dev/null" : `a/${label}`;
  const b = c.after === null ? "/dev/null" : `b/${label}`;
  if ((c.before && !isProbablyText(c.before)) || (c.after && !isProbablyText(c.after))) {
    return `diff --bridge ${a} ${b}\nBinary files ${a} and ${b} differ\n`;
  }
  const patch = createTwoFilesPatch(a, b, c.before?.toString("utf8") ?? "", c.after?.toString("utf8") ?? "", "", "", { context: 3 });
  // Drop the "Index/====" preamble some versions emit; keep ---/+++ onwards.
  const idx = patch.indexOf("--- ");
  return idx > 0 ? patch.slice(idx) : patch;
}

export function sortChanges(changes: FileChange[]): FileChange[] {
  return [...changes].sort((x, y) => (x.root === y.root ? (x.path < y.path ? -1 : x.path > y.path ? 1 : 0) : x.root < y.root ? -1 : 1));
}

export function combinedDiff(changes: FileChange[]): string {
  return sortChanges(changes).map(unifiedDiff).join("");
}

export function planFiles(changes: FileChange[]): PlanFileT[] {
  return sortChanges(changes).map((c) => ({
    root: c.root,
    path: c.path,
    change: c.before === null ? "create" : c.after === null ? "delete" : "modify",
    before_sha256: c.before === null ? null : sha256Hex(c.before),
    after_sha256: c.after === null ? null : sha256Hex(c.after),
  }));
}
