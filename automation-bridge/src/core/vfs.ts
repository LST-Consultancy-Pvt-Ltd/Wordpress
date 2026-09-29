/**
 * Virtual file system for planning: reads fall through to disk (with path
 * safety), writes are staged in memory. `changes()` yields the net diff.
 */
import fsp from "node:fs/promises";
import type { ResolvedConfig, ResolvedRoot } from "./config.js";
import { rootById } from "./config.js";
import type { FileChange } from "./diff.js";
import { BridgeError } from "./errors.js";
import { isSymlink, resolveInRoot, validateRelPath } from "./paths.js";
import type { Vfs } from "./content/types.js";

export class ChangeVfs implements Vfs {
  private readonly originals = new Map<string, { root: string; path: string; before: Buffer | null }>();
  private readonly staged = new Map<string, Buffer | null>();
  private readonly cfg: ResolvedConfig;
  private readonly maxFileBytes: number;

  constructor(cfg: ResolvedConfig, opts: { maxFileBytes?: number } = {}) {
    this.cfg = cfg;
    this.maxFileBytes = opts.maxFileBytes ?? 8 * 1024 * 1024;
  }

  private root(id: string): ResolvedRoot {
    const r = rootById(this.cfg, id);
    if (!r) throw new BridgeError("NOT_FOUND", `unknown root "${id}"`);
    return r;
  }

  private key(root: string, rel: string): string {
    return `${root}\u0000${rel}`;
  }

  private async loadOriginal(root: ResolvedRoot, rel: string): Promise<Buffer | null> {
    const k = this.key(root.id, rel);
    const o = this.originals.get(k);
    if (o) return o.before;
    const abs = await resolveInRoot(root, rel);
    let before: Buffer | null = null;
    try {
      const st = await fsp.lstat(abs);
      if (st.isSymbolicLink()) {
        const real = await fsp.stat(abs).catch(() => null);
        before = real?.isFile() ? await fsp.readFile(abs) : null;
      } else if (st.isFile()) before = await fsp.readFile(abs);
      else if (st.isDirectory()) throw new BridgeError("OPERATION_NOT_ALLOWED", "path is a directory");
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
    }
    this.originals.set(k, { root: root.id, path: rel, before });
    return before;
  }

  async read(rootId: string, relPath: string): Promise<Buffer | null> {
    const root = this.root(rootId);
    const rel = validateRelPath(relPath);
    const k = this.key(root.id, rel);
    if (this.staged.has(k)) return this.staged.get(k)!;
    return this.loadOriginal(root, rel);
  }

  async write(rootId: string, relPath: string, content: Buffer | null): Promise<void> {
    const root = this.root(rootId);
    if (!root.writable) throw new BridgeError("OPERATION_NOT_ALLOWED", `root "${root.id}" is not writable`);
    const rel = validateRelPath(relPath);
    if (content && content.length > this.maxFileBytes) {
      throw new BridgeError("VALIDATION_FAILED", `file would exceed ${this.maxFileBytes} bytes`, { issues: [{ path: `${root.id}/${rel}`, message: "file too large" }] });
    }
    await this.loadOriginal(root, rel);
    const abs = await resolveInRoot(root, rel);
    if (await isSymlink(abs)) throw new BridgeError("OPERATION_NOT_ALLOWED", "symbolic links cannot be written");
    this.staged.set(this.key(root.id, rel), content);
  }

  changes(): FileChange[] {
    const out: FileChange[] = [];
    for (const [k, after] of this.staged) {
      const o = this.originals.get(k)!;
      const same = (o.before === null && after === null) || (o.before !== null && after !== null && o.before.equals(after));
      if (!same) out.push({ root: o.root, path: o.path, before: o.before, after });
    }
    return out;
  }
}
