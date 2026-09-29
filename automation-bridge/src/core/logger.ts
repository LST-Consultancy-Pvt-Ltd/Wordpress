/**
 * Structured JSON logs (one object per line on stdout) with redaction:
 *  - values under secret-looking keys are replaced,
 *  - registered literal secrets (key store secrets, env secrets) are masked
 *    anywhere in strings,
 *  - registered absolute paths (roots, state dir) are replaced by `<root:id>`,
 *  - common token shapes (Bearer …, key=value secrets) are masked.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_RE = /(secret|signature|password|passwd|token|authorization|cookie|api[-_]?key|private[-_]?key|backup[-_]?key)/i;

const PATTERNS: [RegExp, string][] = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]"],
  // HMAC signatures (X-Bridge-Signature, X-Revalidate-Signature, "signature": "…").
  [/((?:signature|hmac)["']?\s*[:=]\s*["']?)[0-9a-fA-F]{32,}/gi, "$1[REDACTED]"],
  // Key-store entries ("secret": "<43-char base64url>").
  [/("secret"\s*:\s*")[A-Za-z0-9_-]{20,}(")/g, "$1[REDACTED]$2"],
  [/((?:secret|password|passwd|token|api[-_]?key)\s*[=:]\s*)("?)[^\s"',;]{4,}/gi, "$1$2[REDACTED]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
];

export class Redactor {
  private secrets = new Set<string>();
  private paths: [string, string][] = [];

  addSecret(s: string | null | undefined): void {
    if (s && s.length >= 6) this.secrets.add(s);
  }

  /** Replace an absolute path prefix by a stable label. Longest paths first. */
  addPath(abs: string, label: string): void {
    if (!abs || abs === "/") return;
    this.paths.push([abs, label]);
    this.paths.sort((a, b) => b[0].length - a[0].length);
  }

  redactString(s: string): string {
    let out = s;
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join("[REDACTED]");
    }
    for (const [abs, label] of this.paths) {
      if (out.includes(abs)) out = out.split(abs).join(label);
    }
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
    return out;
  }

  redact(value: unknown, depth = 0): unknown {
    if (depth > 8) return "[TRUNCATED]";
    if (typeof value === "string") return this.redactString(value);
    if (Array.isArray(value)) return value.map((v) => this.redact(v, depth + 1));
    if (value instanceof Error) return { name: value.name, message: this.redactString(value.message) };
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SECRET_KEY_RE.test(k) && k !== "key_id" ? "[REDACTED]" : this.redact(v, depth + 1);
      }
      return out;
    }
    return value;
  }
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export type LogSink = (line: string) => void;

export function createLogger(opts: {
  level?: LogLevel;
  redactor: Redactor;
  sink?: LogSink;
  base?: Record<string, unknown>;
}): Logger {
  const min = LEVELS[opts.level ?? "info"];
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + "\n"));
  const base = opts.base ?? {};
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < min) return;
    const rec = opts.redactor.redact({ time: new Date().toISOString(), level, msg, ...base, ...(fields ?? {}) });
    try {
      sink(JSON.stringify(rec));
    } catch {
      /* logging must never throw */
    }
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
