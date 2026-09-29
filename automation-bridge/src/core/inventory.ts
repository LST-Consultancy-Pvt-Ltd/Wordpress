/**
 * Read-only route inventory for App Router and Pages Router projects, by
 * static scan of the code root. Metadata opt-in is detected by searching the
 * page source for `withAutomationMetadata`.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { InventoryRouteT } from "./schemas.js";
import { walkFiles } from "./fsutil.js";
import { isDynamicPattern, matchRoutePattern } from "./route.js";
import type { Manifest } from "../shared/stores.js";

const APP_PAGE = /^page\.(tsx|jsx|ts|js|mdx)$/;
const APP_ROUTE = /^route\.(ts|js|tsx|jsx)$/;
const APP_LAYOUT = /^layout\.(tsx|jsx|ts|js)$/;
const PAGES_FILE = /\.(tsx|jsx|ts|js|mdx)$/;
const OPTIN_RE = /\bwithAutomationMetadata\s*\(/;
const STATIC_META_RE = /export\s+(const\s+metadata\b|(async\s+)?function\s+generateMetadata\b|const\s+generateMetadata\b)/;

export interface RouteInventory {
  items: InventoryRouteT[];
  unsupported: { route: string; reason: string }[];
  router: "app" | "pages" | "mixed" | "unknown";
}

function skipDir(rel: string, isDir: boolean): boolean {
  const base = rel.split("/").pop() ?? "";
  if (isDir) return base === "node_modules" || base.startsWith(".") || base === "dist" || base === "build";
  return false;
}

interface Collected {
  file: string; // relative to code root
  kind: "page" | "route-handler" | "layout";
  router: "app" | "pages";
  route: string;
  unsupported?: string;
}

function appRouteFor(dirSegs: string[]): { route: string; unsupported?: string; skip?: boolean } {
  const out: string[] = [];
  for (const s of dirSegs) {
    if (s.startsWith("_")) return { route: "", skip: true }; // private folder
    if (s.startsWith("@")) return { route: "/" + [...out, s].join("/"), unsupported: "parallel route (@slot) is not supported" };
    if (/^\((\.{1,3}|\.\.\)\(\.\.)\)/.test(s)) return { route: "/" + [...out, s].join("/"), unsupported: "intercepting route is not supported" };
    if (/^\(.*\)$/.test(s)) continue; // route group
    out.push(s);
  }
  return { route: "/" + out.join("/") };
}

async function collectApp(codeRoot: string, appDir: string): Promise<Collected[]> {
  const files = await walkFiles(path.join(codeRoot, appDir), skipDir, 20_000);
  const out: Collected[] = [];
  for (const rel of files) {
    const segs = rel.split("/");
    const name = segs.pop()!;
    let kind: Collected["kind"] | null = null;
    if (APP_PAGE.test(name)) kind = "page";
    else if (APP_ROUTE.test(name)) kind = "route-handler";
    else if (APP_LAYOUT.test(name)) kind = "layout";
    if (!kind) continue;
    const r = appRouteFor(segs);
    if (r.skip) continue;
    out.push({ file: `${appDir}/${rel}`, kind, router: "app", route: r.route, unsupported: r.unsupported });
  }
  return out;
}

async function collectPages(codeRoot: string, pagesDir: string): Promise<Collected[]> {
  const files = await walkFiles(path.join(codeRoot, pagesDir), skipDir, 20_000);
  const out: Collected[] = [];
  for (const rel of files) {
    if (!PAGES_FILE.test(rel)) continue;
    const noExt = rel.replace(PAGES_FILE, "");
    const segs = noExt.split("/");
    const last = segs[segs.length - 1]!;
    if (segs.length === 1 && ["_app", "_document", "_error", "404", "500"].includes(last)) continue;
    if (last === "index") segs.pop();
    const route = "/" + segs.join("/");
    const kind = segs[0] === "api" ? "route-handler" : "page";
    out.push({ file: `${pagesDir}/${rel}`, kind, router: "pages", route: route === "/" ? "/" : route.replace(/\/$/, "") });
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function scanRoutes(opts: {
  codeRoot: string | null;
  codeRootId: string | null;
  manifest: Manifest;
  collections: { id: string; route_pattern: string | null }[];
}): Promise<RouteInventory> {
  const items: InventoryRouteT[] = [];
  const unsupported: { route: string; reason: string }[] = [];
  let hasApp = false;
  let hasPages = false;
  const collected: Collected[] = [];
  if (opts.codeRoot) {
    for (const d of ["app", "src/app"]) {
      if (await exists(path.join(opts.codeRoot, d))) {
        hasApp = true;
        collected.push(...(await collectApp(opts.codeRoot, d)));
      }
    }
    for (const d of ["pages", "src/pages"]) {
      if (await exists(path.join(opts.codeRoot, d))) {
        hasPages = true;
        collected.push(...(await collectPages(opts.codeRoot, d)));
      }
    }
  }
  const asserted = new Set(opts.manifest.metadata_routes ?? []);
  for (const c of collected) {
    if (c.unsupported) {
      unsupported.push({ route: c.route, reason: c.unsupported });
      continue;
    }
    let src = "";
    try {
      const abs = path.join(opts.codeRoot!, ...c.file.split("/"));
      const st = await fsp.lstat(abs);
      if (st.isFile() && st.size < 2 * 1024 * 1024) src = await fsp.readFile(abs, "utf8");
    } catch {
      /* unreadable */
    }
    let metadata: InventoryRouteT["metadata"] = "none";
    if (c.kind === "route-handler") metadata = "none";
    else if (OPTIN_RE.test(src) || asserted.has(c.route)) metadata = "generateMetadata-optin";
    else if (c.router === "pages" || c.file.endsWith(".mdx")) metadata = src ? "unknown" : "unknown";
    else if (STATIC_META_RE.test(src)) metadata = "static";
    const blocks = c.kind === "page" ? opts.manifest.blocks.filter((b) => b.route === c.route || matchRoutePattern(c.route, b.route)).map((b) => b.id) : [];
    const adapter = c.kind === "page" ? (opts.collections.find((col) => col.route_pattern === c.route)?.id ?? null) : null;
    items.push({
      route: c.route,
      kind: c.kind,
      router: c.router,
      source: opts.codeRootId ? { root: opts.codeRootId, path: c.file } : null,
      dynamic: isDynamicPattern(c.route),
      metadata,
      blocks,
      adapter,
    });
  }
  // Routes asserted by the manifest but not found in source (e.g. in-app mode without source).
  for (const r of asserted) {
    if (!items.some((i) => i.kind === "page" && (i.route === r || matchRoutePattern(i.route, r)))) {
      items.push({ route: r, kind: "page", router: "app", source: null, dynamic: isDynamicPattern(r), metadata: "generateMetadata-optin", blocks: opts.manifest.blocks.filter((b) => b.route === r).map((b) => b.id), adapter: null });
    }
  }
  items.sort((a, b) => (a.route === b.route ? a.kind.localeCompare(b.kind) : a.route.localeCompare(b.route)));
  const router = hasApp && hasPages ? "mixed" : hasApp ? "app" : hasPages ? "pages" : "unknown";
  return { items, unsupported, router };
}

/** Find the page entry serving a concrete route (static patterns win over dynamic). */
export function findPageForRoute(items: InventoryRouteT[], route: string): InventoryRouteT | null {
  const pages = items.filter((i) => i.kind === "page");
  const exact = pages.find((p) => p.route === route);
  if (exact) return exact;
  const dyn = pages.filter((p) => p.dynamic && matchRoutePattern(p.route, route));
  dyn.sort((a, b) => b.route.split("/").length - a.route.split("/").length || a.route.length - b.route.length);
  return dyn[0] ?? null;
}

export function unsupportedFeatures(inv: RouteInventory): { feature: string; reason: string }[] {
  const out: { feature: string; reason: string }[] = [];
  for (const i of inv.items) {
    if (i.kind !== "page") continue;
    const where = i.source ? i.source.path : i.route;
    if (i.metadata === "static") out.push({ feature: `static metadata in ${where}`, reason: "not opted in: wrap generateMetadata with withAutomationMetadata() to make metadata overrides effective" });
    else if (i.metadata === "none") out.push({ feature: `no metadata in ${where}`, reason: "not opted in: add generateMetadata using withAutomationMetadata() to make metadata overrides effective" });
    else if (i.metadata === "unknown") out.push({ feature: `metadata in ${where}`, reason: i.router === "pages" ? "Pages Router metadata overrides are not supported" : "metadata opt-in could not be detected" });
  }
  for (const u of inv.unsupported) out.push({ feature: `route ${u.route}`, reason: u.reason });
  return out;
}
