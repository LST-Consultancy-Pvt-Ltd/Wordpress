/** Minimal front matter handling on top of `yaml` (core schema: dates stay strings). */
import { parse, stringify } from "yaml";

const FM_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = FM_RE.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  let fm: unknown = {};
  try {
    fm = m[1] ? parse(m[1], { schema: "core", prettyErrors: false }) : {};
  } catch {
    fm = {};
  }
  const body = raw.slice(m[0].length).replace(/^\r?\n/, "");
  return { frontmatter: fm && typeof fm === "object" && !Array.isArray(fm) ? (fm as Record<string, unknown>) : {}, body };
}

export function joinFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  const keys = Object.keys(frontmatter);
  const yamlText = keys.length ? stringify(frontmatter, { schema: "core", lineWidth: 0, sortMapEntries: false }) : "";
  return `---\n${yamlText}---\n\n${body}`;
}
