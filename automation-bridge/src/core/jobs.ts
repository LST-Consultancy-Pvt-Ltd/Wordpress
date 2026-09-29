/**
 * Job registry (validation, preview, deployment) with an event history that
 * backs the SSE stream `GET /jobs/{id}/events` (`event: log|step|status`).
 * Finished jobs are persisted to `<state>/jobs/<id>.json`.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { atomicWrite, ensureDirSync } from "./fsutil.js";
import type { JobT } from "./schemas.js";
import { newId, nowIso } from "./util.js";

export type JobEvent = { event: "log" | "step" | "status"; data: unknown };
type Listener = (e: JobEvent | null) => void;

interface LiveJob {
  job: JobT;
  events: JobEvent[];
  listeners: Set<Listener>;
  logBytes: number;
}

const MAX_EVENT_LOG_BYTES = 2 * 1024 * 1024;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export class JobRegistry {
  private readonly live = new Map<string, LiveJob>();
  private readonly dir: string;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, "jobs");
    ensureDirSync(this.dir);
  }

  create(kind: JobT["kind"], stepNames: string[]): JobT {
    const job: JobT = {
      job_id: newId("j"),
      kind,
      status: "queued",
      steps: stepNames.map((name) => ({ name, status: "pending", exit_code: null, duration_ms: null, output_tail: "" })),
      result: null,
      error: null,
      created_at: nowIso(),
      finished_at: null,
    };
    this.live.set(job.job_id, { job, events: [], listeners: new Set(), logBytes: 0 });
    this.emit(job.job_id, { event: "status", data: { status: job.status } });
    return job;
  }

  private emit(id: string, e: JobEvent): void {
    const l = this.live.get(id);
    if (!l) return;
    if (e.event === "log") {
      const size = Buffer.byteLength(JSON.stringify(e.data));
      if (l.logBytes + size > MAX_EVENT_LOG_BYTES) return;
      l.logBytes += size;
    }
    l.events.push(e);
    for (const fn of l.listeners) fn(e);
  }

  log(id: string, step: string, chunk: string): void {
    this.emit(id, { event: "log", data: { step, chunk } });
  }

  update(id: string, mutate: (j: JobT) => void, event: "step" | "status" = "step"): void {
    const l = this.live.get(id);
    if (!l) return;
    mutate(l.job);
    if (event === "status") this.emit(id, { event: "status", data: { status: l.job.status, error: l.job.error } });
    if (TERMINAL.has(l.job.status)) {
      l.job.finished_at ??= nowIso();
      void atomicWrite(path.join(this.dir, `${id}.json`), JSON.stringify(l.job), { mode: 0o600 }).catch(() => {});
      for (const fn of l.listeners) fn(null);
      l.listeners.clear();
    }
  }

  stepUpdate(id: string, name: string, patch: Partial<JobT["steps"][number]>): void {
    this.update(id, (j) => {
      const s = j.steps.find((x) => x.name === name);
      if (s) Object.assign(s, patch);
    });
    const l = this.live.get(id);
    const s = l?.job.steps.find((x) => x.name === name);
    if (s) this.emit(id, { event: "step", data: s });
  }

  async get(id: string): Promise<JobT | null> {
    if (!/^j_[a-z0-9]+$/.test(id)) return null;
    const l = this.live.get(id);
    if (l) return structuredClone(l.job);
    try {
      return JSON.parse(await fsp.readFile(path.join(this.dir, `${id}.json`), "utf8")) as JobT;
    } catch {
      return null;
    }
  }

  /** SSE stream: history first, then live events until the job is terminal. */
  async *stream(id: string, signal?: AbortSignal): AsyncGenerator<string> {
    const l = this.live.get(id);
    if (!l) {
      const j = await this.get(id);
      if (j) yield sse({ event: "status", data: { status: j.status, error: j.error } });
      return;
    }
    const queue: (JobEvent | null)[] = [...l.events];
    let wake: (() => void) | null = null;
    const listener: Listener = (e) => {
      queue.push(e);
      wake?.();
    };
    const terminal = TERMINAL.has(l.job.status);
    if (!terminal) l.listeners.add(listener);
    else queue.push(null);
    const heartbeat = setInterval(() => {
      queue.push({ event: "log", data: { heartbeat: true } });
      wake?.();
    }, 15000);
    heartbeat.unref();
    try {
      for (;;) {
        if (signal?.aborted) return;
        const e = queue.shift();
        if (e === undefined) {
          await new Promise<void>((r) => {
            wake = r;
            signal?.addEventListener("abort", () => r(), { once: true });
          });
          wake = null;
          continue;
        }
        if (e === null) return;
        yield sse(e);
      }
    } finally {
      clearInterval(heartbeat);
      l.listeners.delete(listener);
    }
  }
}

function sse(e: JobEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}
