import crypto from "node:crypto";

export function sha256Hex(data: string | Buffer | Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Time-sortable id with a prefix: `r_`, `j_`, `d_`, `b_`, `c_`. */
export function newId(prefix: string): string {
  const t = Date.now().toString(36).padStart(9, "0");
  const r = crypto.randomBytes(6).toString("hex");
  return `${prefix}_${t}${r}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** JSON with recursively sorted object keys: deterministic file content, so a
 *  plan and its later apply produce byte-identical files and diffs. */
export function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}

export function decodeCursor(cursor: string | undefined | null): number {
  if (!cursor) return 0;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown };
    if (typeof v.o === "number" && Number.isInteger(v.o) && v.o >= 0) return v.o;
  } catch {
    /* fallthrough */
  }
  return -1;
}

export function paginate<T>(all: T[], cursor: string | undefined, limit: number): { items: T[]; next_cursor: string | null } {
  const offset = decodeCursor(cursor);
  if (offset < 0) return { items: [], next_cursor: null };
  const items = all.slice(offset, offset + limit);
  const next = offset + limit < all.length ? encodeCursor(offset + limit) : null;
  return { items, next_cursor: next };
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
