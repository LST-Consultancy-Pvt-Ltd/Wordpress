/**
 * Audit log (protocol §13): JSONL at `<state>/audit/audit.jsonl`, rotated at
 * 10 MiB, 10 files kept (audit.jsonl + audit.1.jsonl … audit.9.jsonl).
 * Entries never contain query values, signatures or secrets.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AuditEntryT } from "./schemas.js";
import { decodeCursor, encodeCursor } from "./util.js";

export interface AuditOptions {
  dir: string;
  maxBytes?: number;
  keep?: number;
}

export class AuditLog {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: AuditOptions) {
    this.dir = opts.dir;
    this.maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    this.keep = opts.keep ?? 10;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private file(i: number): string {
    return path.join(this.dir, i === 0 ? "audit.jsonl" : `audit.${i}.jsonl`);
  }

  write(entry: AuditEntryT): Promise<void> {
    const line = JSON.stringify(entry) + "\n";
    this.chain = this.chain.then(() => this.writeNow(line)).catch(() => {});
    return this.chain;
  }

  private async writeNow(line: string): Promise<void> {
    const cur = this.file(0);
    try {
      const st = await fsp.stat(cur);
      if (st.size + Buffer.byteLength(line) > this.maxBytes) await this.rotate();
    } catch {
      /* no current file */
    }
    await fsp.appendFile(cur, line, { mode: 0o600 });
  }

  private async rotate(): Promise<void> {
    await fsp.rm(this.file(this.keep - 1), { force: true });
    for (let i = this.keep - 2; i >= 0; i--) {
      try {
        await fsp.rename(this.file(i), this.file(i + 1));
      } catch {
        /* missing generation */
      }
    }
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  /** Newest first, paginated across rotated files. */
  async list(cursor: string | undefined, limit: number): Promise<{ items: AuditEntryT[]; next_cursor: string | null }> {
    await this.flush();
    const offset = decodeCursor(cursor);
    if (offset < 0) return { items: [], next_cursor: null };
    const items: AuditEntryT[] = [];
    let skipped = 0;
    let more = false;
    outer: for (let i = 0; i < this.keep; i++) {
      let raw: string;
      try {
        raw = await fsp.readFile(this.file(i), "utf8");
      } catch {
        continue;
      }
      const lines = raw.split("\n").filter(Boolean).reverse();
      for (const l of lines) {
        if (skipped < offset) {
          skipped++;
          continue;
        }
        if (items.length >= limit) {
          more = true;
          break outer;
        }
        try {
          items.push(JSON.parse(l) as AuditEntryT);
        } catch {
          /* torn line */
        }
      }
    }
    return { items, next_cursor: more ? encodeCursor(offset + items.length) : null };
  }
}
