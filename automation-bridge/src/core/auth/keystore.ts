/**
 * Key store: JSON file `<state>/keys.json`, mode 0600. Seeded from
 * BRIDGE_BOOTSTRAP_KEY_ID / BRIDGE_BOOTSTRAP_SECRET when the file does not
 * exist yet. Operators may edit the file; it is re-read whenever its
 * mtime/size/inode changes.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "../fsutil.js";
import { SECRET_RE, decodeSecret, generateKeyId, generateSecret } from "./signing.js";

export const SCOPES = ["read", "write", "deploy", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

const KeyEntrySchema = z.object({
  key_id: z.string().regex(/^[A-Za-z0-9_.-]{3,128}$/),
  secret: z.string().regex(SECRET_RE),
  scopes: z.array(z.enum(SCOPES)).min(1),
  created_at: z.string(),
  not_after: z.string().nullable().default(null),
  revoked_at: z.string().nullable().default(null),
});
export type KeyEntry = z.infer<typeof KeyEntrySchema>;

const KeyFileSchema = z.object({ version: z.literal(1).default(1), keys: z.array(KeyEntrySchema) });

export interface KeyStoreOptions {
  file: string;
  bootstrap?: { keyId: string | null; secret: string | null; scopes: string[] };
  onSecret?: (secret: string) => void;
  onError?: (msg: string) => void;
}

export class KeyStore {
  private keys: KeyEntry[] = [];
  private secretBytes = new Map<string, Buffer>();
  private sig = "";
  private readonly opts: KeyStoreOptions;

  constructor(opts: KeyStoreOptions) {
    this.opts = opts;
  }

  /** Create the file from bootstrap env if missing, then load it. */
  init(): void {
    fs.mkdirSync(path.dirname(this.opts.file), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.opts.file)) {
      const b = this.opts.bootstrap;
      const keys: KeyEntry[] = [];
      if (b?.keyId && b.secret) {
        decodeSecret(b.secret); // throws on malformed secret
        keys.push({
          key_id: b.keyId,
          secret: b.secret,
          scopes: b.scopes.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s)),
          created_at: new Date().toISOString(),
          not_after: null,
          revoked_at: null,
        });
      }
      const data = JSON.stringify({ version: 1, keys }, null, 2) + "\n";
      fs.writeFileSync(this.opts.file, data, { mode: 0o600, flag: "wx" });
    }
    try {
      fs.chmodSync(this.opts.file, 0o600);
    } catch {
      /* read-only fs: keep going */
    }
    this.reload(true);
  }

  private statSig(): string {
    try {
      const st = fs.statSync(this.opts.file);
      return `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return "missing";
    }
  }

  /** Re-read the file when it changed on disk. Invalid files keep the last good set. */
  reload(force = false): void {
    const sig = this.statSig();
    if (!force && sig === this.sig) return;
    this.sig = sig;
    try {
      const raw = JSON.parse(fs.readFileSync(this.opts.file, "utf8"));
      const parsed = KeyFileSchema.parse(raw);
      this.keys = parsed.keys;
      this.secretBytes = new Map(parsed.keys.map((k) => [k.key_id, decodeSecret(k.secret)]));
      for (const k of parsed.keys) this.opts.onSecret?.(k.secret);
    } catch {
      this.opts.onError?.("key store file is invalid; keeping the previously loaded keys");
      if (force) {
        this.keys = [];
        this.secretBytes = new Map();
      }
    }
  }

  get(keyId: string): { entry: KeyEntry; secret: Buffer } | null {
    this.reload();
    const entry = this.keys.find((k) => k.key_id === keyId);
    const secret = this.secretBytes.get(keyId);
    return entry && secret ? { entry, secret } : null;
  }

  list(): Omit<KeyEntry, "secret">[] {
    this.reload();
    return this.keys.map(({ secret: _s, ...rest }) => rest);
  }

  isActive(k: KeyEntry, now = Date.now()): boolean {
    if (k.revoked_at) return false;
    if (k.not_after && Date.parse(k.not_after) <= now) return false;
    return true;
  }

  private async persist(): Promise<void> {
    const data = JSON.stringify({ version: 1, keys: this.keys }, null, 2) + "\n";
    await atomicWrite(this.opts.file, data, { mode: 0o600 });
    this.sig = this.statSig();
    this.secretBytes = new Map(this.keys.map((k) => [k.key_id, decodeSecret(k.secret)]));
  }

  /** New key with the caller's scopes; the caller key expires after `graceSeconds`. */
  async rotate(callerKeyId: string, graceSeconds: number): Promise<KeyEntry> {
    this.reload();
    const caller = this.keys.find((k) => k.key_id === callerKeyId);
    if (!caller) throw new Error("caller key vanished");
    const secret = generateSecret();
    this.opts.onSecret?.(secret);
    const entry: KeyEntry = {
      key_id: generateKeyId(),
      secret,
      scopes: [...caller.scopes],
      created_at: new Date().toISOString(),
      not_after: null,
      revoked_at: null,
    };
    const graceEnd = new Date(Date.now() + graceSeconds * 1000).toISOString();
    if (!caller.not_after || Date.parse(caller.not_after) > Date.parse(graceEnd)) caller.not_after = graceEnd;
    this.keys.push(entry);
    await this.persist();
    return entry;
  }

  /** Returns false if the key does not exist or is already revoked. */
  async revoke(keyId: string, opts: { confirmLast: boolean }): Promise<"revoked" | "not_found" | "last_admin"> {
    this.reload();
    const k = this.keys.find((x) => x.key_id === keyId);
    if (!k || k.revoked_at) return "not_found";
    const activeAdmins = this.keys.filter((x) => this.isActive(x) && x.scopes.includes("admin"));
    if (k.scopes.includes("admin") && activeAdmins.length <= 1 && activeAdmins[0]?.key_id === keyId && !opts.confirmLast) {
      return "last_admin";
    }
    k.revoked_at = new Date().toISOString();
    await this.persist();
    return "revoked";
  }

  /** All secrets (for log redaction registration). */
  allSecrets(): string[] {
    return this.keys.map((k) => k.secret);
  }
}
