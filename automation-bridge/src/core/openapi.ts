/** OpenAPI 3.1 document assembled from the endpoint table and its Zod schemas. */
import { z } from "zod";
import { ROUTES } from "./routes.js";
import { ErrorBody } from "./schemas.js";
import { BASE_PATH } from "./http.js";
import { VERSION } from "../version.js";

function schema(s: z.ZodTypeAny, io: "input" | "output"): Record<string, unknown> {
  try {
    const out = z.toJSONSchema(s, { io, unrepresentable: "any", target: "draft-2020-12" }) as Record<string, unknown>;
    delete out.$schema;
    return out;
  } catch {
    return {};
  }
}

export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const errorRef = { $ref: "#/components/schemas/Error" };
  const errorResponses = Object.fromEntries(
    ["400", "401", "403", "404", "409", "413", "422", "429", "500", "502"].map((c) => [c, { description: "Error", content: { "application/json": { schema: errorRef } } }]),
  );
  paths[`${BASE_PATH}/healthz`] = {
    get: {
      summary: "Unauthenticated liveness",
      security: [],
      responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { ok: { const: true } }, required: ["ok"] } } } } },
    },
  };
  paths[`${BASE_PATH}/openapi.json`] = {
    get: { summary: "This document", responses: { "200": { description: "OpenAPI 3.1", content: { "application/json": { schema: { type: "object" } } } }, ...errorResponses } },
  };
  for (const r of ROUTES) {
    const p = `${BASE_PATH}${r.path}`;
    const params: Record<string, unknown>[] = [];
    for (const m of r.path.matchAll(/\{([a-z_]+)\}/g)) params.push({ name: m[1], in: "path", required: true, schema: { type: "string" } });
    for (const [name, desc] of Object.entries(r.query ?? {})) params.push({ name, in: "query", required: name === "path" || name === "service", description: desc, schema: { type: "string" } });
    if (r.mutating) params.push({ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9_.:-]{8,128}$" } });
    const success = String(r.successStatus ?? 200);
    const op: Record<string, unknown> = {
      summary: r.summary,
      "x-bridge-scope": r.scope,
      parameters: params,
      responses: {
        [success]: r.path.endsWith("/events")
          ? { description: "text/event-stream", content: { "text/event-stream": { schema: { type: "string" } } } }
          : { description: "Success", content: { "application/json": { schema: r.response ? schema(r.response, "output") : { type: "object" } } } },
        ...errorResponses,
      },
    };
    if (r.request) op.requestBody = { required: true, content: { "application/json": { schema: schema(r.request, "input") } } };
    paths[p] ??= {};
    paths[p]![r.method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Automation Bridge",
      version: VERSION,
      description:
        "Automation Bridge protocol v1 (protocol/automation-bridge-v1.md). Every request except /healthz is HMAC-signed: " +
        "X-Bridge-Key-Id, X-Bridge-Timestamp, X-Bridge-Nonce, X-Bridge-Signature = hex HMAC-SHA256(secret, METHOD\\nPATH_WITH_QUERY\\nTIMESTAMP\\nNONCE\\nhex(sha256(body))).",
    },
    security: [{ bridgeHmac: [] }],
    components: {
      securitySchemes: { bridgeHmac: { type: "apiKey", in: "header", name: "X-Bridge-Signature", description: "HMAC request signing, see info.description" } },
      schemas: { Error: schema(ErrorBody, "output") },
    },
    paths,
  };
}
