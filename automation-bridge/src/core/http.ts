/** Framework-agnostic request/response types used by createBridge().handle(). */
export interface BridgeRequest {
  method: string;
  /** Raw request target (path + query as sent), e.g. "/api/automation-bridge/v1/capabilities". A full URL is accepted too. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** Aborted when the client disconnects (used to end SSE streams). */
  signal?: AbortSignal;
  /** Remote address, for logs only. */
  remoteAddress?: string;
}

export interface BridgeResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | AsyncIterable<string>;
}

export const BASE_PATH = "/api/automation-bridge/v1";

export function lowerHeaders(h: BridgeRequest["headers"]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  return out;
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): BridgeResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
    body: Buffer.from(JSON.stringify(body), "utf8"),
  };
}
