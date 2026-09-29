/**
 * Sidecar HTTP server: exposes the bridge at /api/automation-bridge/v1 and an
 * unauthenticated liveness probe at /healthz. Intended to listen on a private
 * Docker network only (see README: never publish its port to the internet;
 * put TLS + an allow-list reverse proxy in front if it must cross hosts).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createBridge, type Bridge } from "../core/bridge.js";
import type { BridgeConfigInput, ResolvedConfig } from "../core/config.js";
import type { BridgeOptions } from "../core/context.js";
import { BASE_PATH } from "../core/http.js";

export interface SidecarServer {
  server: http.Server;
  bridge: Bridge;
  url: string;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | "too_large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        return;
      }
      if (!over) chunks.push(c);
    });
    req.on("end", () => resolve(over ? "too_large" : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startSidecar(
  config: ResolvedConfig | (BridgeConfigInput & { baseDir?: string }),
  opts: BridgeOptions & { host?: string; port?: number } = {},
): Promise<SidecarServer> {
  const bridge = await createBridge(config, opts);
  const cfg = bridge.ctx.cfg;
  const maxBody = cfg.limits.max_body_bytes;
  const inflight = new Set<http.ServerResponse>();

  const server = http.createServer(async (req, res) => {
    inflight.add(res);
    res.on("close", () => inflight.delete(res));
    const url = req.url ?? "/";
    const pathOnly = url.split("?")[0]!;
    if (pathOnly !== "/healthz" && !pathOnly.startsWith(BASE_PATH + "/")) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found", correlation_id: "c_none" } }));
      return;
    }
    const declared = Number(req.headers["content-length"] ?? "0");
    let body: Buffer;
    if (declared > maxBody) {
      body = Buffer.alloc(maxBody + 1); // handled as 413 by the bridge (after draining)
      req.resume();
    } else {
      const b = await readBody(req, maxBody).catch(() => Buffer.alloc(0));
      body = b === "too_large" ? Buffer.alloc(maxBody + 1) : b;
    }
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    try {
      const out = await bridge.handle({ method: req.method ?? "GET", url, headers: req.headers, body, signal: ac.signal, remoteAddress: req.socket.remoteAddress });
      if (Buffer.isBuffer(out.body)) {
        res.writeHead(out.status, { ...out.headers, "content-length": String(out.body.length) });
        res.end(out.body);
      } else {
        res.writeHead(out.status, out.headers);
        res.flushHeaders();
        for await (const chunk of out.body) {
          if (ac.signal.aborted) break;
          res.write(chunk);
        }
        res.end();
      }
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "INTERNAL", message: "internal error", correlation_id: "c_none" } }));
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  const host = opts.host ?? cfg.server.host;
  const port = opts.port ?? cfg.server.port;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const shownHost = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  bridge.ctx.logger.info("sidecar listening", { host: addr.address, port: addr.port, mode: cfg.mode });
  let closing: Promise<void> | null = null;
  return {
    server,
    bridge,
    url: `http://${shownHost === "0.0.0.0" ? "127.0.0.1" : shownHost}:${addr.port}`,
    close() {
      closing ??= (async () => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
          const t = setTimeout(() => {
            for (const r of inflight) r.destroy();
            server.closeAllConnections();
          }, 10_000);
          t.unref();
        });
        await bridge.close();
      })();
      return closing;
    },
  };
}
