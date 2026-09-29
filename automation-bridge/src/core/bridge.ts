/**
 * createBridge(config) → { handle(req) → res }: the framework-agnostic entry
 * point used by the sidecar HTTP server and the Next.js route handlers.
 *
 * Pipeline per request: correlation id → size limit → /healthz shortcut →
 * HMAC auth → route match → scope → rate limit → Idempotency-Key (mutations)
 * → handler → audit.
 */
import crypto from "node:crypto";
import { resolveConfig, type BridgeConfigInput, type ResolvedConfig } from "./config.js";
import { BridgeContext, type BridgeOptions } from "./context.js";
import { recoverInterrupted } from "./engine.js";
import { BridgeError, isBridgeError, type ErrorCode } from "./errors.js";
import { BASE_PATH, jsonResponse, lowerHeaders, type BridgeRequest, type BridgeResponse } from "./http.js";
import { IDEMPOTENCY_KEY_RE, IdempotencyStore, type StoredResponse } from "./idempotency.js";
import { buildOpenApi } from "./openapi.js";
import { matchRoute, type HandlerResult } from "./routes.js";
import type { AuditEntryT } from "./schemas.js";

export interface Bridge {
  handle(req: BridgeRequest): Promise<BridgeResponse>;
  readonly ctx: BridgeContext;
  openapi(): Record<string, unknown>;
  close(): Promise<void>;
}

const CORRELATION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const NOT_STORED: ErrorCode[] = ["LOCKED", "INTERNAL", "RATE_LIMITED", "PAYLOAD_TOO_LARGE", "IDEMPOTENCY_MISMATCH", "IDEMPOTENCY_KEY_REQUIRED"];

function isResolved(c: unknown): c is ResolvedConfig {
  return !!c && typeof c === "object" && "secrets" in (c as Record<string, unknown>) && Array.isArray((c as ResolvedConfig).roots) && "abs" in ((c as ResolvedConfig).roots[0] ?? {});
}

export async function createBridge(config: ResolvedConfig | (BridgeConfigInput & { baseDir?: string }), options: BridgeOptions = {}): Promise<Bridge> {
  let cfg: ResolvedConfig;
  if (isResolved(config)) cfg = config;
  else {
    const { baseDir, ...raw } = config as BridgeConfigInput & { baseDir?: string };
    cfg = resolveConfig(raw, { baseDir: baseDir ?? process.cwd() });
  }
  const ctx = new BridgeContext(cfg, options);
  const recovered = await recoverInterrupted(ctx);
  if (recovered.length) ctx.logger.warn("recovered interrupted revisions", { revisions: recovered });
  await ctx.idem.prune().catch(() => 0);
  await ctx.revisions.prune(cfg.revisionRetentionDays).catch(() => 0);
  const maintenance = setInterval(() => {
    void ctx.idem.prune().catch(() => 0);
    void ctx.revisions.prune(cfg.revisionRetentionDays).catch(() => 0);
  }, 3600_000);
  maintenance.unref();
  let openapiCache: Record<string, unknown> | null = null;
  const openapi = () => (openapiCache ??= buildOpenApi());

  function errorResponse(e: BridgeError, cid: string): BridgeResponse {
    const body: { error: Record<string, unknown> } = { error: { code: e.code, message: e.message, correlation_id: cid } };
    if (e.details) body.error.details = ctx.redactor.redact(e.details);
    return jsonResponse(e.status, body, { "x-correlation-id": cid, ...(e.headers ?? {}) });
  }

  async function handle(req: BridgeRequest): Promise<BridgeResponse> {
    const h = lowerHeaders(req.headers);
    const cidIn = h["x-correlation-id"];
    const cid = cidIn && CORRELATION_RE.test(cidIn) ? cidIn : `c_${crypto.randomBytes(8).toString("hex")}`;
    const method = req.method.toUpperCase();
    let target = req.url;
    if (/^https?:\/\//i.test(target)) {
      const u = new URL(target);
      target = u.pathname + u.search;
    }
    const qIdx = target.indexOf("?");
    const pathOnly = qIdx >= 0 ? target.slice(0, qIdx) : target;
    const query = new URLSearchParams(qIdx >= 0 ? target.slice(qIdx + 1) : "");
    const audit: AuditEntryT = { at: new Date().toISOString(), correlation_id: cid, key_id: null, method, path: pathOnly.slice(0, 512), outcome: "ok" };
    const log = ctx.logger.child({ correlation_id: cid });
    const finish = (res: BridgeResponse, outcome?: AuditEntryT["outcome"], code?: string): BridgeResponse => {
      audit.outcome = outcome ?? (res.status < 400 ? "ok" : res.status === 401 || res.status === 403 || res.status === 429 ? "denied" : "error");
      if (code) audit.code = code;
      void ctx.audit.write(audit);
      log.info("request", { method, path: audit.path, status: res.status, key_id: audit.key_id, code: audit.code });
      return res;
    };

    if (method === "GET" && (pathOnly === "/healthz" || pathOnly === `${BASE_PATH}/healthz`)) {
      return jsonResponse(200, { ok: true }, { "x-correlation-id": cid });
    }
    try {
      if (!pathOnly.startsWith(BASE_PATH + "/") && pathOnly !== BASE_PATH) throw new BridgeError("NOT_FOUND", "not found");
      const declared = Number(h["content-length"] ?? "0");
      if (req.body.length > cfg.limits.max_body_bytes || declared > cfg.limits.max_body_bytes) {
        throw new BridgeError("PAYLOAD_TOO_LARGE", `request body exceeds ${cfg.limits.max_body_bytes} bytes`);
      }
      const auth = ctx.auth.verify({ method, pathWithQuery: target, headers: h, body: req.body });
      audit.key_id = auth.keyId;
      const rel = pathOnly.slice(BASE_PATH.length) || "/";
      if (method === "GET" && rel === "/openapi.json") {
        if (!auth.scopes.includes("read")) throw new BridgeError("AUTH_SCOPE", "missing scope read");
        return finish(jsonResponse(200, openapi(), { "x-correlation-id": cid }));
      }
      const m = matchRoute(method, rel);
      if (!m || m === "method") throw new BridgeError("NOT_FOUND", "not found");
      if (!auth.scopes.includes(m.def.scope)) throw new BridgeError("AUTH_SCOPE", `missing scope ${m.def.scope}`);
      const retry = ctx.rate.hit(`all:${auth.keyId}`, cfg.limits.rate_per_minute) || (m.def.mutating ? ctx.rate.hit(`mut:${auth.keyId}`, cfg.limits.mutations_per_minute) : 0);
      if (retry) throw new BridgeError("RATE_LIMITED", "rate limit exceeded", undefined, { "retry-after": String(retry) });

      const run = async (): Promise<StoredResponse | BridgeResponse> => {
        let body: unknown = undefined;
        if (method === "POST") {
          if (req.body.length === 0) body = {};
          else {
            try {
              body = JSON.parse(req.body.toString("utf8"));
            } catch {
              throw new BridgeError("VALIDATION_FAILED", "request body is not valid JSON", { issues: [{ path: "(root)", message: "invalid JSON" }] });
            }
          }
        }
        const result: HandlerResult = await m.def.handler({ ctx, params: m.params, query, body, keyId: auth.keyId, scopes: auth.scopes, signal: req.signal });
        if ("stream" in result) {
          return { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", "x-correlation-id": cid }, body: result.stream };
        }
        if (result.audit) Object.assign(audit, Object.fromEntries(Object.entries(result.audit).filter(([, v]) => v !== undefined)));
        return { status: result.status ?? m.def.successStatus ?? 200, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(result.body) };
      };

      const toResponse = (r: StoredResponse | BridgeResponse): BridgeResponse => {
        if (typeof r.body === "string") return { status: r.status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...r.headers, "x-correlation-id": cid }, body: Buffer.from(r.body, "utf8") };
        return r as BridgeResponse;
      };

      if (!m.def.mutating) return finish(toResponse(await run()));

      const idemKey = h["idempotency-key"];
      if (!idemKey || !IDEMPOTENCY_KEY_RE.test(idemKey)) throw new BridgeError("IDEMPOTENCY_KEY_REQUIRED", "mutations require an Idempotency-Key header (8-128 chars)");
      const fp = IdempotencyStore.fingerprint(method, pathOnly, req.body);
      const stored = await ctx.idem.run(
        auth.keyId,
        idemKey,
        fp,
        async () => {
          try {
            return (await run()) as StoredResponse;
          } catch (e) {
            if (!isBridgeError(e)) throw e;
            const body: { error: Record<string, unknown> } = { error: { code: e.code, message: e.message, correlation_id: cid } };
            if (e.details) body.error.details = ctx.redactor.redact(e.details);
            return { status: e.status, headers: { "content-type": "application/json; charset=utf-8", ...(e.headers ?? {}), "x-bridge-error-code": e.code }, body: JSON.stringify(body) };
          }
        },
        { sensitive: m.def.sensitive, shouldStore: (r) => !NOT_STORED.includes(r.headers["x-bridge-error-code"] as ErrorCode) },
      );
      const { "x-bridge-error-code": errCode, ...hdrs } = stored.headers;
      return finish(toResponse({ ...stored, headers: hdrs }), undefined, errCode);
    } catch (e) {
      if (isBridgeError(e)) return finish(errorResponse(e, cid), undefined, e.code);
      log.error("unhandled error", { err: e, stack: e instanceof Error ? e.stack : undefined });
      return finish(errorResponse(new BridgeError("INTERNAL", "internal error"), cid), "error", "INTERNAL");
    }
  }

  return {
    handle,
    ctx,
    openapi,
    async close() {
      clearInterval(maintenance);
      await ctx.audit.flush();
    },
  };
}
