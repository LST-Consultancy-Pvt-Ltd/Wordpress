/**
 * Minimal unified-diff parser and side-by-side row builder (no dependencies).
 * Input: the `plan.diff` text produced by the bridge (git-style unified diff,
 * paths shown as `<root>/<path>`).
 */

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function stripPrefix(p) {
  if (!p || p === "/dev/null") return null;
  const t = p.split("\t")[0].trim();
  return t.replace(/^[ab]\//, "");
}

/** Parse a unified diff into files → hunks → lines. */
export function parseUnifiedDiff(text) {
  const files = [];
  if (!text || typeof text !== "string") return files;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;

  const startFile = (header = null) => {
    file = { oldPath: null, newPath: null, header, hunks: [], additions: 0, deletions: 0 };
    files.push(file);
    hunk = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      startFile(line);
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (m) {
        file.oldPath = m[1];
        file.newPath = m[2];
      }
      continue;
    }
    if (line.startsWith("--- ") && (!hunk || lines[i + 1]?.startsWith("+++ "))) {
      if (!file || file.hunks.length) startFile();
      file.oldPath = stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ") && file && !hunk) {
      file.newPath = stripPrefix(line.slice(4));
      continue;
    }
    const hm = line.match(HUNK_RE);
    if (hm) {
      if (!file) startFile();
      oldNo = parseInt(hm[1], 10);
      newNo = parseInt(hm[3], 10);
      hunk = { header: line, context: hm[5].trim(), oldStart: oldNo, newStart: newNo, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const tag = line[0];
    const body = line.slice(1);
    if (tag === "+") {
      hunk.lines.push({ type: "add", oldNo: null, newNo: newNo++, text: body });
      file.additions += 1;
    } else if (tag === "-") {
      hunk.lines.push({ type: "del", oldNo: oldNo++, newNo: null, text: body });
      file.deletions += 1;
    } else if (tag === " " || line === "") {
      // A trailing empty line at the very end of the text is not context.
      if (line === "" && i === lines.length - 1) continue;
      hunk.lines.push({ type: "context", oldNo: oldNo++, newNo: newNo++, text: body });
    }
  }
  return files.map((f) => ({ ...f, path: f.newPath || f.oldPath || "(unknown file)" }));
}

/**
 * Pair a hunk's lines into side-by-side rows: runs of deletions followed by
 * additions are zipped so a changed line appears on one row.
 */
export function toSideBySideRows(hunk) {
  const rows = [];
  const ls = hunk.lines;
  let i = 0;
  while (i < ls.length) {
    const l = ls[i];
    if (l.type === "context") {
      rows.push({ left: l, right: l });
      i += 1;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < ls.length && ls[i].type === "del") dels.push(ls[i++]);
    while (i < ls.length && ls[i].type === "add") adds.push(ls[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k += 1) rows.push({ left: dels[k] || null, right: adds[k] || null });
  }
  return rows;
}

/** Build a unified diff for one file from before/after text (for local previews). */
export function simpleFileDiff(path, before, after) {
  const a = (before ?? "").split("\n");
  const b = (after ?? "").split("\n");
  // LCS table (fine for the file sizes the bridge allows: ≤ 512 KiB).
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    return `--- a/${path}\n+++ b/${path}\n@@ -1,${n} +1,${m} @@\n${a.map((x) => `-${x}`).join("\n")}\n${b.map((x) => `+${x}`).join("\n")}\n`;
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push(`+${b[j]}`);
      j += 1;
    } else {
      out.push(`-${a[i]}`);
      i += 1;
    }
  }
  if (!out.some((l) => l[0] !== " ")) return "";
  return `--- a/${path}\n+++ b/${path}\n@@ -1,${n} +1,${m} @@\n${out.join("\n")}\n`;
}
