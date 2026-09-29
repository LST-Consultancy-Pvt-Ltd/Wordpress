/**
 * Stable error codes (protocol §2). Every failure that leaves the bridge is a
 * BridgeError; anything else is mapped to INTERNAL with a generic message.
 */
export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  PATH_INVALID: 400,
  PATH_OUTSIDE_ROOT: 400,
  PATH_SYMLINK_ESCAPE: 400,
  OPERATION_NOT_ALLOWED: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  AUTH_MISSING: 401,
  AUTH_INVALID: 401,
  AUTH_EXPIRED: 401,
  AUTH_REPLAY: 401,
  AUTH_REVOKED: 401,
  AUTH_SCOPE: 403,
  NOT_FOUND: 404,
  CONFLICT_REVISION: 409,
  IDEMPOTENCY_MISMATCH: 409,
  LOCKED: 409,
  PAYLOAD_TOO_LARGE: 413,
  CAPABILITY_UNSUPPORTED: 422,
  UNREGISTERED_BLOCK: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UPSTREAM_FAILED: 502,
  DEPLOY_FAILED: 502,
  VERIFY_FAILED: 502,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCode[];

export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
    this.headers = headers;
  }
}

export function isBridgeError(e: unknown): e is BridgeError {
  return e instanceof BridgeError;
}

/** Zod-style issue list for VALIDATION_FAILED details. */
export interface Issue {
  path: string;
  message: string;
}

export function validationError(issues: Issue[], message = "request validation failed"): BridgeError {
  return new BridgeError("VALIDATION_FAILED", message, { issues });
}
