/**
 * A deliberately small JSON-Schema subset validator for front matter:
 * type (string|number|integer|boolean|array|object|null, or an array of
 * types), required, properties, additionalProperties (boolean), enum,
 * minLength/maxLength, minimum/maximum, items, maxItems, format
 * (date | date-time | uri). Unsupported keywords are ignored.
 */
import type { Issue } from "./errors.js";

type Schema = Record<string, unknown>;

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(expected: string, actual: string): boolean {
  return expected === actual || (expected === "number" && actual === "integer");
}

export function validateJsonSchema(schema: Schema, value: unknown, at = ""): Issue[] {
  const issues: Issue[] = [];
  const p = at || "(root)";
  const t = schema.type;
  if (t !== undefined) {
    const types = Array.isArray(t) ? (t as string[]) : [t as string];
    if (!types.some((x) => typeMatches(x, typeOf(value)))) {
      issues.push({ path: p, message: `expected ${types.join("|")}, got ${typeOf(value)}` });
      return issues;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    issues.push({ path: p, message: "value is not one of the allowed values" });
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) issues.push({ path: p, message: `shorter than ${schema.minLength}` });
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) issues.push({ path: p, message: `longer than ${schema.maxLength}` });
    if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) issues.push({ path: p, message: "expected a YYYY-MM-DD date" });
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) issues.push({ path: p, message: "expected an RFC 3339 date-time" });
    if (schema.format === "uri") {
      try {
        new URL(value);
      } catch {
        issues.push({ path: p, message: "expected an absolute URI" });
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) issues.push({ path: p, message: `below ${schema.minimum}` });
    if (typeof schema.maximum === "number" && value > schema.maximum) issues.push({ path: p, message: `above ${schema.maximum}` });
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) issues.push({ path: p, message: `more than ${schema.maxItems} items` });
    if (schema.items && typeof schema.items === "object") {
      value.forEach((v, i) => issues.push(...validateJsonSchema(schema.items as Schema, v, `${at}[${i}]`)));
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    if (Array.isArray(schema.required)) {
      for (const r of schema.required as string[]) if (!(r in obj)) issues.push({ path: at ? `${at}.${r}` : r, message: "is required" });
    }
    for (const [k, v] of Object.entries(obj)) {
      const child = at ? `${at}.${k}` : k;
      if (props[k]) issues.push(...validateJsonSchema(props[k]!, v, child));
      else if (schema.additionalProperties === false) issues.push({ path: child, message: "is not an allowed property" });
    }
  }
  return issues;
}
