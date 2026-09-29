/**
 * Revisions (protocol §9): immutable records under `<state>/revisions/<id>/`
 * (record.json + before/ snapshot), with an append-only `index.jsonl` of
 * events ({type: "created"} and {type: "status"}). The current status of a
 * revision is the last status event for it.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { appendLine, atomicWrite, ensureDirSync, readIfExists } from "./fsutil.js";
import type { PlanFileT } from "./schemas.js";
import { newId, nowIso } from "./util.js";

export type RevisionStatus = "applied" | "rolled_back" | "reverted";
export type RevisionKind = "changeset" | "rollback" | "restore";

export interface RevisionRecordT {
  revision_id: string;
  change_id: string;
  kind: RevisionKind;
  reverts: string | null;
  parent_revision: string | null;
  operations: unknown[];
  file_changes: PlanFileT[];
  diff: string;
  impacted_routes: string[];
  created_at: string;
  key_id: string | null;
  reason: string | null;
}

export interface SnapshotEntry {
  root: string;
  path: string;
  absent: boolean;
  mode: number | null;
  sha256: string | null;
  /** File name inside before/ holding the content (absent → null). */
  blob: string | null;
}

interface IndexEvent {
  type: "created" | "status";
  revision_id: string;
  change_id?: string;
  parent_revision?: string | null;
  files?: number;
  created_at?: string;
  status?: RevisionStatus;
  at?: string;
  error?: string | null;
}

export interface RevisionSummaryT {
  revision_id: string;
  change_id: string;
  status: RevisionStatus;
  parent_revision: string | null;
  files: number;
  created_at: string;
}

export class RevisionStore {
  readonly dir: string;
  private readonly indexFile: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, "revisions");
    this.indexFile = path.join(this.dir, "index.jsonl");
    ensureDirSync(this.dir);
  }

  newId(): string {
    return newId("r");
  }

  private recDir(id: string): string {
    if (!/^r_[a-z0-9]+$/.test(id)) throw new Error("bad revision id");
    return path.join(this.dir, id);
  }

  private async appendEvent(ev: IndexEvent): Promise<void> {
    const p = this.chain.then(() => appendLine(this.indexFile, JSON.stringify(ev)));
    this.chain = p.catch(() => {});
    await p;
  }

  /** Persist the before-snapshot. Called BEFORE any file is written. */
  async writeSnapshot(id: string, entries: { root: string; path: string; content: Buffer | null; mode: number | null; sha256: string | null }[]): Promise<void> {
    const dir = path.join(this.recDir(id), "before");
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const meta: SnapshotEntry[] = [];
    for (const [i, e] of entries.entries()) {
      const blob = e.content === null ? null : `${i}.bin`;
      if (blob) await atomicWrite(path.join(dir, blob), e.content!, { mode: 0o600 });
      meta.push({ root: e.root, path: e.path, absent: e.content === null, mode: e.mode, sha256: e.sha256, blob });
    }
    await atomicWrite(path.join(dir, "manifest.json"), JSON.stringify(meta, null, 2), { mode: 0o600 });
  }

  async readSnapshot(id: string): Promise<{ entry: SnapshotEntry; content: Buffer | null }[] | null> {
    const dir = path.join(this.recDir(id), "before");
    const raw = await readIfExists(path.join(dir, "manifest.json"));
    if (!raw) return null;
    const meta = JSON.parse(raw.toString("utf8")) as SnapshotEntry[];
    const out: { entry: SnapshotEntry; content: Buffer | null }[] = [];
    for (const m of meta) {
      out.push({ entry: m, content: m.blob ? await fsp.readFile(path.join(dir, m.blob)) : null });
    }
    return out;
  }

  async writeRecord(rec: RevisionRecordT): Promise<void> {
    await fsp.mkdir(this.recDir(rec.revision_id), { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(this.recDir(rec.revision_id), "record.json"), JSON.stringify(rec, null, 2), { mode: 0o600 });
    await this.appendEvent({
      type: "created",
      revision_id: rec.revision_id,
      change_id: rec.change_id,
      parent_revision: rec.parent_revision,
      files: rec.file_changes.length,
      created_at: rec.created_at,
    });
  }

  async setStatus(id: string, status: RevisionStatus, error: string | null = null): Promise<void> {
    await this.appendEvent({ type: "status", revision_id: id, status, at: nowIso(), error });
  }

  private async events(): Promise<IndexEvent[]> {
    await this.chain;
    const raw = await readIfExists(this.indexFile);
    if (!raw) return [];
    const out: IndexEvent[] = [];
    for (const line of raw.toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as IndexEvent);
      } catch {
        /* torn tail line after a crash */
      }
    }
    return out;
  }

  /** Newest first. */
  async list(): Promise<(RevisionSummaryT & { error: string | null })[]> {
    const evs = await this.events();
    const map = new Map<string, RevisionSummaryT & { error: string | null }>();
    const order: string[] = [];
    for (const e of evs) {
      if (e.type === "created") {
        map.set(e.revision_id, {
          revision_id: e.revision_id,
          change_id: e.change_id ?? "",
          status: "applied",
          parent_revision: e.parent_revision ?? null,
          files: e.files ?? 0,
          created_at: e.created_at ?? "",
          error: null,
        });
        order.push(e.revision_id);
      } else if (e.type === "status" && e.status) {
        const r = map.get(e.revision_id);
        if (r) {
          r.status = e.status;
          if (e.error) r.error = e.error;
        }
      }
    }
    return order.reverse().map((id) => map.get(id)!);
  }

  async current(): Promise<string | null> {
    const all = await this.list();
    return all.find((r) => r.status !== "rolled_back")?.revision_id ?? null;
  }

  async get(id: string): Promise<(RevisionRecordT & { status: RevisionStatus; error: string | null; snapshot_available: boolean }) | null> {
    let recDir: string;
    try {
      recDir = this.recDir(id);
    } catch {
      return null;
    }
    const raw = await readIfExists(path.join(recDir, "record.json"));
    const summary = (await this.list()).find((r) => r.revision_id === id);
    if (!raw || !summary) return null;
    const rec = JSON.parse(raw.toString("utf8")) as RevisionRecordT;
    const snap = await readIfExists(path.join(recDir, "before", "manifest.json"));
    return { ...rec, status: summary.status, error: summary.error, snapshot_available: !!snap };
  }

  /** Latest applied revision that recorded this change id (for override metadata). */
  async byChangeId(): Promise<Map<string, RevisionSummaryT>> {
    const all = await this.list();
    const m = new Map<string, RevisionSummaryT>();
    for (const r of all) if (r.status === "applied" && !m.has(r.change_id)) m.set(r.change_id, r);
    return m;
  }

  /** Remove before/ snapshots older than `days`; index entries and records remain. */
  async prune(days: number): Promise<number> {
    const cutoff = Date.now() - days * 86400_000;
    let n = 0;
    for (const r of await this.list()) {
      if (Date.parse(r.created_at) < cutoff) {
        const dir = path.join(this.recDir(r.revision_id), "before");
        const exists = await readIfExists(path.join(dir, "manifest.json"));
        if (exists) {
          await fsp.rm(dir, { recursive: true, force: true });
          n++;
        }
      }
    }
    return n;
  }
}
