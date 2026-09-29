/**
 * Next.js App Router integration.
 *
 * In-app mode — app/api/automation-bridge/v1/[[...path]]/route.ts:
 *
 *   import { revalidatePath } from "next/cache";
 *   import { createRouteHandlers } from "@lst/automation-bridge/next/server";
 *   export const runtime = "nodejs";
 *   export const dynamic = "force-dynamic";
 *   export const { GET, POST } = createRouteHandlers({ configPath: "automation-bridge.config.json", revalidatePath });
 *
 * Sidecar mode — app/api/automation-revalidate/route.ts:
 *
 *   import { revalidatePath } from "next/cache";
 *   import { createRevalidateHandler } from "@lst/automation-bridge/next/server";
 *   export const runtime = "nodejs";
 *   export const { POST } = createRevalidateHandler({ revalidatePath });
 */
import { createBridge, type Bridge } from "../core/bridge.js";
import { loadConfigFile, type BridgeConfigInput, type ResolvedConfig } from "../core/config.js";
import type { BridgeOptions } from "../core/context.js";
import { checkRoute } from "../core/route.js";
import { REVALIDATE_MAX_PATHS, verifyRevalidate } from "../shared/revalidate-signing.js";

type RevalidatePath = (p: string) => void | Promise<void>;

export interface RouteHandlerOptions extends Omit<BridgeOptions, "revalidatePath"> {
  config?: ResolvedConfig | (BridgeConfigInput & { baseDir?: string });
  configPath?: string;
  revalidatePath?: RevalidatePath;
}

const GLOBAL_KEY = Symbol.for("lst.automation-bridge.instance");

function getBridge(opts: RouteHandlerOptions): Promise<Bridge> {
  const g = globalThis as unknown as Record<symbol, Promise<Bridge> | undefined>;
  if (!g[GLOBAL_KEY]) {
    const cfg = opts.config ?? loadConfigFile(opts.configPath ?? process.env.BRIDGE_CONFIG ?? "automation-bridge.config.json");
    g[GLOBAL_KEY] = createBridge(cfg, { ...opts, revalidatePath: opts.revalidatePath }).catch((e) => {
      g[GLOBAL_KEY] = undefined;
      throw e;
    });
  }
  return g[GLOBAL_KEY]!;
}

async function readLimited(req: Request, max: number): Promise<Buffer> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) return Buffer.alloc(max + 1);
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return Buffer.alloc(max + 1);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function createRouteHandlers(opts: RouteHandlerOptions): { GET: (req: Request) => Promise<Response>; POST: (req: Request) => Promise<Response> } {
  const handler = async (req: Request): Promise<Response> => {
    let bridge: Bridge;
    try {
      bridge = await getBridge(opts);
    } catch {
      return Response.json({ error: { code: "INTERNAL", message: "bridge is not configured", correlation_id: "c_none" } }, { status: 500 });
    }
    const u = new URL(req.url);
    const body = await readLimited(req, bridge.ctx.cfg.limits.max_body_bytes);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const out = await bridge.handle({ method: req.method, url: u.pathname + u.search, headers, body, signal: req.signal });
    if (Buffer.isBuffer(out.body)) return new Response(new Uint8Array(out.body), { status: out.status, headers: out.headers });
    const iter = out.body[Symbol.asyncIterator]();
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await iter.next();
        if (done) controller.close();
        else controller.enqueue(enc.encode(value));
      },
      async cancel() {
        await iter.return?.(undefined);
      },
    });
    return new Response(stream, { status: out.status, headers: out.headers });
  };
  return { GET: handler, POST: handler };
}

/** The site-side endpoint the sidecar calls after an apply (only the impacted paths). */
export function createRevalidateHandler(opts: { revalidatePath: RevalidatePath; secret?: string }): { POST: (req: Request) => Promise<Response> } {
  return {
    async POST(req: Request): Promise<Response> {
      const secret = opts.secret ?? process.env.BRIDGE_REVALIDATE_SECRET ?? "";
      if (!secret) return Response.json({ error: "revalidation is not configured" }, { status: 503 });
      const raw = await readLimited(req, 64 * 1024);
      let paths: unknown;
      try {
        paths = (JSON.parse(raw.toString("utf8")) as { paths?: unknown }).paths;
      } catch {
        return Response.json({ error: "invalid body" }, { status: 400 });
      }
      if (!Array.isArray(paths) || paths.length > REVALIDATE_MAX_PATHS || !paths.every((p) => typeof p === "string")) {
        return Response.json({ error: "invalid paths" }, { status: 400 });
      }
      if (!verifyRevalidate(secret, req.headers.get("x-revalidate-timestamp"), req.headers.get("x-revalidate-signature"), paths as string[])) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const clean: string[] = [];
      for (const p of paths as string[]) {
        const c = checkRoute(p);
        if (!c.ok) return Response.json({ error: "invalid path" }, { status: 400 });
        clean.push(c.route);
      }
      for (const p of clean) await opts.revalidatePath(p);
      return Response.json({ revalidated: clean });
    },
  };
}
