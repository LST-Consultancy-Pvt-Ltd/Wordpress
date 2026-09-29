/** Route normalisation (protocol §8: `route` = path starting "/", no trailing
 *  slash except "/", no "..", no query/fragment). */
export const MAX_ROUTE_LENGTH = 512;
const ROUTE_CHARS = /^[A-Za-z0-9\-._~%/@!$&'()*+,;=:]*$/;

export type RouteCheck = { ok: true; route: string } | { ok: false; message: string };

export function checkRoute(input: unknown): RouteCheck {
  if (typeof input !== "string") return { ok: false, message: "route must be a string" };
  let r = input.trim();
  if (!r.startsWith("/")) return { ok: false, message: "route must start with '/'" };
  if (r.length > MAX_ROUTE_LENGTH) return { ok: false, message: `route longer than ${MAX_ROUTE_LENGTH} chars` };
  if (r.includes("?") || r.includes("#")) return { ok: false, message: "route must not contain a query or fragment" };
  if (!ROUTE_CHARS.test(r)) return { ok: false, message: "route contains characters that are not allowed" };
  if (r.startsWith("//")) return { ok: false, message: "route must not start with '//'" };
  if (r.length > 1) r = r.replace(/\/+$/, "");
  const segs = r.split("/").slice(1);
  for (const s of segs) {
    if (r !== "/" && s === "") return { ok: false, message: "route contains an empty segment" };
    let d = s;
    try {
      d = decodeURIComponent(s);
    } catch {
      return { ok: false, message: "route contains malformed percent-encoding" };
    }
    if (d === "." || d === ".." || d.includes("/") || d.includes("\\")) return { ok: false, message: "route must not contain '.' or '..' segments" };
  }
  return { ok: true, route: r || "/" };
}

export function normalizeRoute(input: string): string {
  const c = checkRoute(input);
  if (!c.ok) throw new Error(c.message);
  return c.route;
}

/** Match a concrete path against a Next.js route pattern ("/blog/[slug]",
 *  "/docs/[...parts]", "/shop/[[...parts]]"). */
export function matchRoutePattern(pattern: string, concrete: string): boolean {
  const p = pattern === "/" ? [] : pattern.split("/").slice(1);
  const c = concrete === "/" ? [] : concrete.split("/").slice(1);
  let i = 0;
  for (let j = 0; j < p.length; j++) {
    const seg = p[j]!;
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(seg)) return true; // optional catch-all
    if (/^\[\.\.\.[^\]]+\]$/.test(seg)) return c.length > i; // catch-all: ≥ 1 segment
    if (i >= c.length) return false;
    if (/^\[[^\]]+\]$/.test(seg)) {
      i++;
      continue;
    }
    if (seg !== c[i]) return false;
    i++;
  }
  return i === c.length;
}

export function isDynamicPattern(pattern: string): boolean {
  return /\[[^\]]+\]/.test(pattern);
}

/** Fill a pattern containing a single `[slug]` placeholder. */
export function fillSlug(pattern: string, slug: string): string {
  return pattern.replace(/\[\.{0,3}[^\]]+\]/, slug);
}
