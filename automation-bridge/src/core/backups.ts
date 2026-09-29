/**
 * Backups (protocol §12): tar.gz of writable roots
 *   overrides → roots of kind "overrides"
 *   content   → roots of kind "content"
 *   full      → every writable root (code roots only for their allow-listed files)
 * Layout inside the archive: `manifest.json` + `roots/<root-id>/<relpath>`.
 * Deny-listed paths (.env*, node_modules, .git, …) are never included.
 * With BRIDGE_BACKUP_KEY set the archive is AES-256-GCM encrypted:
 *   "LSTB1" | iv (12) | ciphertext | tag (16)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import type { ResolvedConfig, ResolvedRoot } from "./config.js";
import type { FileChange } from "./diff.js";
import { BridgeError } from "./errors.js";
import { atomicWrite, ensureDirSync, walkFiles } from "./fsutil.js";
import { isAllowed, isDenied, resolveInRoot, validateRelPath } from "./paths.js";
import { newId, nowIso, sha256Hex } from "./util.js";

const MAGIC = Buffer.from("LSTB1");

export type BackupKindT = "overrides" | "content" | "full";

export interface BackupMeta {
  backup_id: string;
  kind: BackupKindT;
  bytes: number;
  sha256: string;
  encrypted: boolean;
  created_at: string;
  revision_id: string | null;
  files: number;
  roots: string[];
}

interface ManifestFile {
  root: string;
  path: string;
  sha256: string;
  bytes: number;
  mode: number;
}

export class BackupStore {
  readonly dir: string;
  private readonly cfg: ResolvedConfig;

  constructor(cfg: ResolvedConfig) {
    this.cfg = cfg;
    this.dir = path.join(cfg.state_dir, "backups");
    ensureDirSync(this.dir);
  }

  rootsFor(kind: BackupKindT): ResolvedRoot[] {
    return this.cfg.roots.filter((r) => {
      if (!r.writable) return false;
      if (kind === "overrides") return r.kind === "overrides";
      if (kind === "content") return r.kind === "content";
      return r.kind !== "code" || r.allow.length > 0;
    });
  }

  /** Files of a root that belong in a backup (and may be touched by a restore). */
  private includes(root: ResolvedRoot, rel: string): boolean {
    if (isDenied(root, rel)) return false;
    if (root.kind === "code") return isAllowed(root, rel);
    return true;
  }

  private async listRootFiles(root: ResolvedRoot): Promise<string[]> {
    const files = await walkFiles(root.abs, (rel, isDir) => (isDir ? isDenied(root, rel) || isDenied(root, rel + "/x") : false));
    return files.filter((f) => {
      try {
        validateRelPath(f);
      } catch {
        return false;
      }
      return this.includes(root, f) && !/^\..+\.[0-9a-f]{12}\.tmp$/.test(path.basename(f));
    });
  }

  private metaFile(id: string): string {
    if (!/^b_[a-z0-9]+$/.test(id)) throw new BridgeError("NOT_FOUND", "backup not found");
    return path.join(this.dir, `${id}.json`);
  }

  private dataFile(id: string, encrypted: boolean): string {
    return path.join(this.dir, `${id}.tar.gz${encrypted ? ".enc" : ""}`);
  }

  async list(): Promise<BackupMeta[]> {
    const names = (await fsp.readdir(this.dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    const out: BackupMeta[] = [];
    for (const n of names) {
      try {
        out.push(JSON.parse(await fsp.readFile(path.join(this.dir, n), "utf8")) as BackupMeta);
      } catch {
        /* skip */
      }
    }
    return out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.backup_id < b.backup_id ? 1 : -1));
  }

  async get(id: string): Promise<BackupMeta | null> {
    try {
      return JSON.parse(await fsp.readFile(this.metaFile(id), "utf8")) as BackupMeta;
    } catch {
      return null;
    }
  }

  async create(kind: BackupKindT, revisionId: string | null): Promise<BackupMeta> {
    const roots = this.rootsFor(kind);
    if (!roots.length) throw new BridgeError("OPERATION_NOT_ALLOWED", `no writable roots for backup kind "${kind}"`);
    const id = newId("b");
    const staging = path.join(this.dir, `.staging-${id}`);
    await fsp.mkdir(path.join(staging, "roots"), { recursive: true, mode: 0o700 });
    const files: ManifestFile[] = [];
    try {
      for (const root of roots) {
        for (const rel of await this.listRootFiles(root)) {
          const abs = await resolveInRoot(root, rel);
          const st = await fsp.lstat(abs);
          if (!st.isFile()) continue;
          const buf = await fsp.readFile(abs);
          const dest = path.join(staging, "roots", root.id, ...rel.split("/"));
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.writeFile(dest, buf, { mode: 0o600 });
          files.push({ root: root.id, path: rel, sha256: sha256Hex(buf), bytes: buf.length, mode: st.mode & 0o777 });
        }
      }
      const manifest = { version: 1, backup_id: id, kind, roots: roots.map((r) => r.id), created_at: nowIso(), revision_id: revisionId, files };
      await fsp.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      const tgz = path.join(this.dir, `.${id}.tar.gz.tmp`);
      await tar.create({ gzip: true, cwd: staging, file: tgz, portable: true, noMtime: false }, ["manifest.json", "roots"]);
      const key = this.cfg.secrets.backupKey;
      const final = this.dataFile(id, !!key);
      if (key) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        const out = fs.createWriteStream(final + ".part", { mode: 0o600 });
        out.write(Buffer.concat([MAGIC, iv]));
        await pipeline(fs.createReadStream(tgz), cipher, out);
        await fsp.appendFile(final + ".part", cipher.getAuthTag());
        await fsp.rename(final + ".part", final);
        await fsp.rm(tgz, { force: true });
      } else {
        await fsp.rename(tgz, final);
        await fsp.chmod(final, 0o600);
      }
      const data = await fsp.readFile(final);
      const meta: BackupMeta = {
        backup_id: id,
        kind,
        bytes: data.length,
        sha256: sha256Hex(data),
        encrypted: !!key,
        created_at: manifest.created_at,
        revision_id: revisionId,
        files: files.length,
        roots: manifest.roots,
      };
      await atomicWrite(this.metaFile(id), JSON.stringify(meta, null, 2), { mode: 0o600 });
      await this.applyRetention(kind);
      return meta;
    } finally {
      await fsp.rm(staging, { recursive: true, force: true });
    }
  }

  async applyRetention(kind: BackupKindT): Promise<void> {
    const all = (await this.list()).filter((b) => b.kind === kind);
    for (const b of all.slice(this.cfg.backupRetention)) {
      await fsp.rm(this.dataFile(b.backup_id, b.encrypted), { force: true });
      await fsp.rm(this.metaFile(b.backup_id), { force: true });
    }
  }

  /** Decrypt/verify/extract and compute the file changes a restore would make. */
  async restoreChanges(id: string): Promise<{ meta: BackupMeta; changes: FileChange[] }> {
    const meta = await this.get(id);
    if (!meta) throw new BridgeError("NOT_FOUND", "backup not found");
    const data = await fsp.readFile(this.dataFile(id, meta.encrypted)).catch(() => null);
    if (!data) throw new BridgeError("NOT_FOUND", "backup archive missing");
    if (sha256Hex(data) !== meta.sha256) throw new BridgeError("VERIFY_FAILED", "backup archive checksum mismatch");
    let tgz = data;
    if (meta.encrypted) {
      const key = this.cfg.secrets.backupKey;
      if (!key) throw new BridgeError("OPERATION_NOT_ALLOWED", "backup is encrypted and BRIDGE_BACKUP_KEY is not set");
      if (!data.subarray(0, MAGIC.length).equals(MAGIC)) throw new BridgeError("VERIFY_FAILED", "not a bridge backup");
      const iv = data.subarray(MAGIC.length, MAGIC.length + 12);
      const tag = data.subarray(data.length - 16);
      const ct = data.subarray(MAGIC.length + 12, data.length - 16);
      try {
        const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
        d.setAuthTag(tag);
        tgz = Buffer.concat([d.update(ct), d.final()]);
      } catch {
        throw new BridgeError("VERIFY_FAILED", "backup could not be decrypted (wrong key or tampered archive)");
      }
    }
    const extract = path.join(this.dir, `.extract-${newId("x")}`);
    await fsp.mkdir(extract, { recursive: true, mode: 0o700 });
    try {
      const tgzFile = path.join(extract, "archive.tar.gz");
      await fsp.writeFile(tgzFile, tgz, { mode: 0o600 });
      const out = path.join(extract, "out");
      await fsp.mkdir(out);
      await tar.extract({
        file: tgzFile,
        cwd: out,
        strict: true,
        preservePaths: false,
        filter: (p, entry) => {
          const type = (entry as { type?: string }).type;
          return (type === "File" || type === "Directory") && !p.includes("..");
        },
      });
      const manifest = JSON.parse(await fsp.readFile(path.join(out, "manifest.json"), "utf8")) as { roots: string[]; files: ManifestFile[] };
      const changes: FileChange[] = [];
      for (const rootId of manifest.roots) {
        const root = this.cfg.roots.find((r) => r.id === rootId);
        if (!root || !root.writable) throw new BridgeError("OPERATION_NOT_ALLOWED", `root "${rootId}" in the backup is not writable here`);
        const wanted = new Map<string, Buffer>();
        for (const f of manifest.files.filter((x) => x.root === rootId)) {
          const rel = validateRelPath(f.path);
          if (!this.includes(root, rel)) continue;
          const buf = await fsp.readFile(path.join(out, "roots", rootId, ...rel.split("/")));
          if (sha256Hex(buf) !== f.sha256) throw new BridgeError("VERIFY_FAILED", "backup file checksum mismatch");
          wanted.set(rel, buf);
        }
        const current = new Set(await this.listRootFiles(root));
        for (const rel of new Set([...current, ...wanted.keys()])) {
          const abs = await resolveInRoot(root, rel);
          const before = current.has(rel) ? await fsp.readFile(abs) : null;
          const after = wanted.get(rel) ?? null;
          if (before === null && after === null) continue;
          if (before && after && before.equals(after)) continue;
          changes.push({ root: rootId, path: rel, before, after });
        }
      }
      return { meta, changes };
    } finally {
      await fsp.rm(extract, { recursive: true, force: true });
    }
  }
}
