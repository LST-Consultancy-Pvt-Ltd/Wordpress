/**
 * Durable file primitives: atomic write (temp in same dir → fsync → rename →
 * fsync dir), durable delete, and small helpers.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export async function fsyncDir(dir: string): Promise<void> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(dir, "r");
    await fh.sync();
  } catch (e) {
    // Some filesystems (and Windows) refuse fsync on directories; that is not fatal.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EISDIR" && code !== "EINVAL" && code !== "EPERM" && code !== "EBADF") throw e;
  } finally {
    await fh?.close().catch(() => {});
  }
}

export interface AtomicWriteOptions {
  mode?: number;
  /** Called after the temp file is durable and before rename (TOCTOU re-check hook). */
  beforeRename?: () => Promise<void>;
}

export async function atomicWrite(file: string, data: string | Buffer, opts: AtomicWriteOptions = {}): Promise<void> {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let mode = opts.mode;
  if (mode === undefined) {
    try {
      mode = (await fsp.stat(file)).mode & 0o777;
    } catch {
      mode = 0o644;
    }
  }
  const fh = await fsp.open(tmp, "wx", mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.chmod(tmp, mode);
    if (opts.beforeRename) await opts.beforeRename();
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  await fsyncDir(dir);
}

export async function durableDelete(file: string): Promise<void> {
  try {
    await fsp.unlink(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  await fsyncDir(path.dirname(file));
}

export async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}

export async function readJsonIfExists<T>(file: string): Promise<T | null> {
  const buf = await readIfExists(file);
  if (!buf) return null;
  return JSON.parse(buf.toString("utf8")) as T;
}

export async function ensureDir(dir: string, mode = 0o700): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode });
}

export function ensureDirSync(dir: string, mode = 0o700): void {
  fs.mkdirSync(dir, { recursive: true, mode });
}

export async function appendLine(file: string, line: string, mode = 0o600): Promise<void> {
  const fh = await fsp.open(file, "a", mode);
  try {
    await fh.appendFile(line.endsWith("\n") ? line : line + "\n");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursively list regular files under dir (relative POSIX paths), skipping
 *  names for which `skip(relPath, isDir)` returns true. Symlinks are not followed. */
export async function walkFiles(
  dir: string,
  skip: (rel: string, isDir: boolean) => boolean = () => false,
  limit = 100_000,
): Promise<string[]> {
  const out: string[] = [];
  async function rec(abs: string, rel: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (out.length >= limit) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skip(r, true)) await rec(path.join(abs, e.name), r);
      } else if (e.isFile()) {
        if (!skip(r, false)) out.push(r);
      }
    }
  }
  await rec(dir, "");
  return out;
}
