/**
 * Revalidation of impacted routes only (never the whole site).
 *  - in-app: call Next's revalidatePath directly (injected by createRouteHandlers)
 *  - sidecar: POST {paths} to the site's revalidate endpoint, signed with BRIDGE_REVALIDATE_SECRET
 */
import { BridgeError } from "./errors.js";
import { signRevalidate } from "../shared/revalidate-signing.js";

export type RevalidateFn = (paths: string[]) => Promise<void>;

export function createRevalidator(opts: {
  mode: "none" | "in-app" | "sidecar";
  internalUrl: string | null;
  endpointPath: string;
  secret: string | null;
  timeoutMs: number;
  revalidatePath?: (p: string) => void | Promise<void>;
  fetch?: typeof fetch;
}): { enabled: boolean; reason: string | null; run: RevalidateFn } {
  if (opts.mode === "in-app") {
    const rp = opts.revalidatePath;
    if (!rp) return { enabled: false, reason: "in-app revalidation needs revalidatePath (use createRouteHandlers)", run: async () => {} };
    return {
      enabled: true,
      reason: null,
      run: async (paths) => {
        for (const p of paths) await rp(p);
      },
    };
  }
  if (opts.mode === "sidecar") {
    if (!opts.internalUrl) return { enabled: false, reason: "site.internal_url is not configured", run: async () => {} };
    if (!opts.secret) return { enabled: false, reason: "BRIDGE_REVALIDATE_SECRET is not set", run: async () => {} };
    const f = opts.fetch ?? fetch;
    const url = new URL(opts.endpointPath, opts.internalUrl).toString();
    const secret = opts.secret;
    return {
      enabled: true,
      reason: null,
      run: async (paths) => {
        if (!paths.length) return;
        const ts = Math.floor(Date.now() / 1000);
        let res: Response;
        try {
          res = await f(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-revalidate-timestamp": String(ts),
              "x-revalidate-signature": signRevalidate(secret, ts, paths),
            },
            body: JSON.stringify({ paths }),
            redirect: "error",
            signal: AbortSignal.timeout(opts.timeoutMs),
          });
        } catch {
          throw new BridgeError("UPSTREAM_FAILED", "site revalidation request failed");
        }
        if (!res.ok) throw new BridgeError("UPSTREAM_FAILED", `site revalidation responded ${res.status}`);
      },
    };
  }
  return { enabled: false, reason: "revalidate.mode is none", run: async () => {} };
}
