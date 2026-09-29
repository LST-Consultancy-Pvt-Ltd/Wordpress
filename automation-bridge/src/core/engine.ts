/**
 * Change-set engine (protocol §8–9): typed operations → staged file changes
 * (plan), then snapshot → atomic write → verify → revalidate → route check,
 * restoring the snapshot on any failure (apply). Rollbacks and backup
 * restores reuse the same executor and become new revisions.
 */
import fsp from "node:fs/promises";
import { rootById } from "./config.js";
import type { BridgeContext } from "./context.js";
import { combinedDiff, planFiles, type FileChange } from "./diff.js";
import { BridgeError, ERROR_STATUS, type ErrorCode } from "./errors.js";
import { atomicWrite, durableDelete, pathExists } from "./fsutil.js";
import { findPageForRoute } from "./inventory.js";
import { checkFileOpPathReal, isSymlink, resolveInRoot } from "./paths.js";
import type { RevisionKind } from "./revisions.js";
import { isDynamicPattern } from "./route.js";
import { normalizePlainText, sanitizeRichText } from "./sanitize.js";
import { OP_CAPABILITY, type ApplyRequestT, type ApplyResponseT, type OperationT, type PlanIssueT, type PlanRequestT, type PlanResponseT } from "./schemas.js";
import { nowIso, sha256Hex, stableStringify } from "./util.js";
import { ChangeVfs } from "./vfs.js";
import { STORE_FILES, parseStore, type StoreKind, type StoreMap } from "../shared/stores.js";

export const MAX_CHANGESET_BYTES = 2 * 1024 * 1024;

type Flag = PlanResponseT["risk"]["flags"][number];

export interface PlanOutcome {
  response: PlanResponseT;
  changes: FileChange[];
  effective: boolean[];
}

async function readStore<K extends StoreKind>(vfs: ChangeVfs, rootId: string, kind: K): Promise<StoreMap[K]> {
  return parseStore(kind, await vfs.read(rootId, STORE_FILES[kind]));
}

async function writeStore<K extends StoreKind>(vfs: ChangeVfs, rootId: string, kind: K, store: StoreMap[K]): Promise<void> {
  await vfs.write(rootId, STORE_FILES[kind], Buffer.from(stableStringify(store) + "\n", "utf8"));
}

export async function planChangeSet(ctx: BridgeContext, req: PlanRequestT): Promise<PlanOutcome> {
  if (Buffer.byteLength(JSON.stringify(req.operations)) > MAX_CHANGESET_BYTES) {
    throw new BridgeError("PAYLOAD_TOO_LARGE", "change set exceeds 2 MiB");
  }
  if (req.operations.length > ctx.cfg.limits.max_operations) {
    throw new BridgeError("VALIDATION_FAILED", `at most ${ctx.cfg.limits.max_operations} operations per change set`, {
      issues: [{ path: "operations", message: "too many operations" }],
    });
  }
  const caps = await ctx.capabilities();
  const { manifest } = await ctx.loadManifest();
  const vfs = new ChangeVfs(ctx.cfg);
  const errors: PlanIssueT[] = [];
  const warnings: PlanIssueT[] = [];
  const impacted = new Set<string>();
  const flags = new Set<Flag>();
  const effective: boolean[] = req.operations.map(() => true);
  const ov = ctx.overridesRoot();
  let inventory: Awaited<ReturnType<BridgeContext["inventory"]>> | null = null;
  const inv = async () => (inventory ??= await ctx.inventory());

  const addRoute = (r: string, index: number) => {
    if (isDynamicPattern(r)) {
      warnings.push({ index, code: "REVALIDATE_DYNAMIC_ROUTE", message: `${r} is a dynamic pattern; its concrete pages are not revalidated individually` });
    } else impacted.add(r);
  };

  for (const [index, op] of req.operations.entries()) {
    const cap = OP_CAPABILITY[op.op] as keyof typeof caps.flags;
    if (!caps.flags[cap]) {
      errors.push({ index, code: "CAPABILITY_UNSUPPORTED", message: `capability ${cap} is not available: ${caps.reasons[cap] ?? "unsupported"}` });
      effective[index] = false;
      continue;
    }
    try {
      await planOne(op, index);
    } catch (e) {
      effective[index] = false;
      if (e instanceof BridgeError) errors.push({ index, code: e.code, message: e.message });
      else throw e;
    }
  }

  async function planOne(op: OperationT, index: number): Promise<void> {
    switch (op.op) {
      case "metadata.set":
      case "metadata.clear": {
        const store = await readStore(vfs, ov!.id, "metadata");
        if (op.op === "metadata.set") {
          store.routes[op.route] = { fields: op.fields, change_id: req.change_id };
          if (op.fields.robots && op.fields.robots.index === false) flags.add("robots-noindex");
        } else delete store.routes[op.route];
        await writeStore(vfs, ov!.id, "metadata", store);
        const page = findPageForRoute((await inv()).items, op.route);
        const optedIn = page?.metadata === "generateMetadata-optin";
        effective[index] = optedIn;
        if (!optedIn && op.op === "metadata.set") {
          const why = !page ? "no page in the route inventory serves this route" : `${page.source?.path ?? page.route} does not use withAutomationMetadata()`;
          warnings.push({ index, code: "METADATA_NOT_OPTED_IN", message: `metadata override for ${op.route} will not take effect: ${why}` });
        }
        addRoute(op.route, index);
        return;
      }
      case "block.set":
      case "block.clear": {
        const b = manifest.blocks.find((x) => x.id === op.block_id);
        if (!b) throw new BridgeError("UNREGISTERED_BLOCK", `block "${op.block_id}" is not registered in the manifest`);
        if (b.kind === "image") throw new BridgeError("OPERATION_NOT_ALLOWED", `block "${op.block_id}" is an image; use image.alt.*`);
        const store = await readStore(vfs, ov!.id, "blocks");
        if (op.op === "block.set") {
          if (op.format !== b.kind) throw new BridgeError("OPERATION_NOT_ALLOWED", `block "${op.block_id}" is registered as ${b.kind}, not ${op.format}`);
          const value = op.format === "rich-text" ? sanitizeRichText(op.value) : normalizePlainText(op.value);
          if (value !== op.value) warnings.push({ index, code: "VALUE_SANITIZED", message: "the value was changed by the sanitiser; the diff shows what will be stored" });
          store.blocks[op.block_id] = { value, format: op.format, change_id: req.change_id };
        } else delete store.blocks[op.block_id];
        await writeStore(vfs, ov!.id, "blocks", store);
        addRoute(b.route, index);
        return;
      }
      case "image.alt.set":
      case "image.alt.clear": {
        const b = manifest.blocks.find((x) => x.id === op.image_id);
        if (!b || b.kind !== "image") throw new BridgeError("UNREGISTERED_BLOCK", `image "${op.image_id}" is not registered in the manifest`);
        const store = await readStore(vfs, ov!.id, "images");
        if (op.op === "image.alt.set") store.images[op.image_id] = { alt: normalizePlainText(op.alt), change_id: req.change_id };
        else delete store.images[op.image_id];
        await writeStore(vfs, ov!.id, "images", store);
        addRoute(b.route, index);
        return;
      }
      case "redirect.upsert":
      case "redirect.delete": {
        const store = await readStore(vfs, ov!.id, "redirects");
        const existing = store.redirects.findIndex((r) => r.source === op.source);
        if (op.op === "redirect.upsert") {
          if (op.destination === op.source) throw new BridgeError("OPERATION_NOT_ALLOWED", "redirect destination equals its source");
          if (store.redirects.some((r) => r.source === op.destination && r.destination === op.source)) {
            throw new BridgeError("OPERATION_NOT_ALLOWED", "redirect would create a loop");
          }
          if (store.redirects.some((r) => r.source === op.destination)) warnings.push({ index, code: "REDIRECT_CHAIN", message: `${op.destination} is itself redirected` });
          const entry = { source: op.source, destination: op.destination, permanent: op.permanent, change_id: req.change_id };
          if (existing >= 0) store.redirects[existing] = entry;
          else store.redirects.push(entry);
          if (store.redirects.length > 5000) throw new BridgeError("OPERATION_NOT_ALLOWED", "too many redirects (max 5000)");
        } else {
          if (existing < 0) throw new BridgeError("NOT_FOUND", `no redirect from ${op.source}`);
          store.redirects.splice(existing, 1);
        }
        store.redirects.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
        await writeStore(vfs, ov!.id, "redirects", store);
        flags.add("redirect");
        addRoute(op.source, index);
        return;
      }
      case "content.upsert":
      case "content.delete": {
        const a = ctx.adapters.get(op.collection);
        if (!a) throw new BridgeError("NOT_FOUND", `unknown collection "${op.collection}"`);
        const needed = op.op === "content.delete" ? "delete" : op.base_sha256 === null ? "create" : "update";
        if (!a.descriptor.operations.includes(needed)) {
          throw new BridgeError("CAPABILITY_UNSUPPORTED", `collection "${op.collection}" does not support ${needed}`);
        }
        const r = op.op === "content.upsert" ? await a.planUpsert?.(op, vfs) : await a.planDelete?.(op, vfs);
        if (!r) throw new BridgeError("CAPABILITY_UNSUPPORTED", `collection "${op.collection}" cannot plan writes`);
        for (const route of r.impactedRoutes) addRoute(route, index);
        for (const w of r.warnings ?? []) warnings.push({ index, ...w });
        for (const f of r.riskFlags ?? []) flags.add(f);
        return;
      }
      case "file.write":
      case "file.delete": {
        const root = rootById(ctx.cfg, op.root);
        if (!root) throw new BridgeError("NOT_FOUND", `unknown root "${op.root}"`);
        if (root.kind !== "code" && root.kind !== "assets") throw new BridgeError("OPERATION_NOT_ALLOWED", `file operations are not allowed on ${root.kind} roots`);
        if (!root.writable) throw new BridgeError("OPERATION_NOT_ALLOWED", `root "${root.id}" is not writable`);
        const rel = await checkFileOpPathReal(root, op.path);
        const cur = await vfs.read(root.id, rel);
        if (op.op === "file.write") {
          if (Buffer.byteLength(op.content, "utf8") > ctx.cfg.limits.max_file_bytes) {
            throw new BridgeError("VALIDATION_FAILED", `file content exceeds ${ctx.cfg.limits.max_file_bytes} bytes`, { issues: [{ path: "content", message: "too large" }] });
          }
          if (op.base_sha256 === null && cur !== null) throw new BridgeError("CONFLICT_REVISION", `${root.id}/${rel} already exists (base_sha256 was null)`);
          if (op.base_sha256 !== null && (cur === null || sha256Hex(cur) !== op.base_sha256)) throw new BridgeError("CONFLICT_REVISION", `${root.id}/${rel} changed since base_sha256`);
          await vfs.write(root.id, rel, Buffer.from(op.content, "utf8"));
        } else {
          if (cur === null) throw new BridgeError("NOT_FOUND", `${root.id}/${rel} does not exist`);
          if (sha256Hex(cur) !== op.base_sha256) throw new BridgeError("CONFLICT_REVISION", `${root.id}/${rel} changed since base_sha256`);
          await vfs.write(root.id, rel, null);
          if (root.kind === "assets") flags.add("deletes-content");
        }
        if (root.kind === "code") flags.add("code-change");
        return;
      }
    }
  }

  const current = await ctx.revisions.current();
  if (req.base_revision && req.base_revision !== current) {
    errors.push({ index: -1, code: "CONFLICT_REVISION", message: `base_revision ${req.base_revision} is not the current revision` });
  }
  const changes = vfs.changes();
  const diff = combinedDiff(changes);
  const fl = [...flags].sort() as Flag[];
  const level = fl.includes("code-change") ? "high" : fl.length ? "medium" : "low";
  return {
    response: {
      valid: errors.length === 0,
      errors,
      warnings,
      diff,
      files: planFiles(changes),
      impacted_routes: [...impacted].sort(),
      risk: { level, flags: fl },
      current_revision: current,
    },
    changes,
    effective,
  };
}

/** Map the first plan error to an HTTP error for apply. */
function planError(errors: PlanIssueT[]): BridgeError {
  const first = errors[0]!;
  const code = (first.code in ERROR_STATUS ? first.code : "VALIDATION_FAILED") as ErrorCode;
  return new BridgeError(code, first.message, { errors, ...(code === "CAPABILITY_UNSUPPORTED" ? { capability: /capability (\S+)/.exec(first.message)?.[1] ?? null } : {}) });
}

export interface ExecuteInput {
  kind: RevisionKind;
  changeId: string;
  changes: FileChange[];
  operations: unknown[];
  impactedRoutes: string[];
  diff: string;
  keyId: string | null;
  reason: string | null;
  reverts: string | null;
}

export interface ExecuteResult {
  revisionId: string;
  revalidated: string[];
  verification: ApplyResponseT["verification"];
  appliedAt: string;
}

async function currentMode(abs: string): Promise<number | null> {
  try {
    return (await fsp.stat(abs)).mode & 0o777;
  } catch {
    return null;
  }
}

/** Snapshot → write → verify → revalidate → route check; restore on failure. Caller holds the site lock. */
export async function executeChanges(ctx: BridgeContext, input: ExecuteInput): Promise<ExecuteResult> {
  const revisionId = ctx.revisions.newId();
  const parent = await ctx.revisions.current();
  // Resolve (and re-check) every target path before touching anything.
  const targets: { change: FileChange; abs: string; mode: number | null }[] = [];
  for (const c of input.changes) {
    const root = rootById(ctx.cfg, c.root);
    if (!root || !root.writable) throw new BridgeError("OPERATION_NOT_ALLOWED", `root "${c.root}" is not writable`);
    const abs = await resolveInRoot(root, c.path);
    if (await isSymlink(abs)) throw new BridgeError("OPERATION_NOT_ALLOWED", "symbolic links cannot be written");
    const disk = await fsp.readFile(abs).catch(() => null);
    const same = (disk === null && c.before === null) || (disk !== null && c.before !== null && disk.equals(c.before));
    if (!same) throw new BridgeError("CONFLICT_REVISION", `${c.root}/${c.path} changed while the change set was being applied`);
    targets.push({ change: c, abs, mode: await currentMode(abs) });
  }
  // Pre-apply status of each impacted route (max 20): only routes that answered
  // < 500 before are required to answer < 500 afterwards.
  const checkRoutes: string[] = [];
  if (ctx.cfg.site.internal_url) {
    for (const r of input.impactedRoutes.slice(0, 20)) {
      const s = await ctx.siteStatus(r, 5000);
      if (s !== null && s < 500) checkRoutes.push(r);
    }
  }
  await ctx.revisions.writeSnapshot(
    revisionId,
    targets.map((t) => ({ root: t.change.root, path: t.change.path, content: t.change.before, mode: t.mode, sha256: t.change.before ? sha256Hex(t.change.before) : null })),
  );
  const createdAt = nowIso();
  await ctx.revisions.writeRecord({
    revision_id: revisionId,
    change_id: input.changeId,
    kind: input.kind,
    reverts: input.reverts,
    parent_revision: parent,
    operations: input.operations,
    file_changes: planFiles(input.changes),
    diff: input.diff,
    impacted_routes: input.impactedRoutes,
    created_at: createdAt,
    key_id: input.keyId,
    reason: input.reason,
  });
  const marker = `${ctx.revisions.dir}/${revisionId}/IN_PROGRESS`;
  await fsp.writeFile(marker, "", { mode: 0o600 });
  let step = "write";
  const revalidated: string[] = [];
  const routes: { route: string; status: number }[] = [];
  try {
    for (const t of targets) {
      const root = rootById(ctx.cfg, t.change.root)!;
      if (t.change.after === null) await durableDelete(t.abs);
      else {
        await atomicWrite(t.abs, t.change.after, {
          mode: t.mode ?? undefined,
          beforeRename: async () => {
            await resolveInRoot(root, t.change.path); // TOCTOU re-check of the parent chain
          },
        });
      }
    }
    step = "verify";
    for (const t of targets) {
      const disk = await fsp.readFile(t.abs).catch(() => null);
      const ok = t.change.after === null ? disk === null : disk !== null && sha256Hex(disk) === sha256Hex(t.change.after);
      if (!ok) throw new BridgeError("VERIFY_FAILED", `hash verification failed for ${t.change.root}/${t.change.path}`);
    }
    ctx.invalidateCaches();
    if (ctx.revalidator.enabled && input.impactedRoutes.length) {
      step = "revalidate";
      await ctx.revalidator.run(input.impactedRoutes);
      revalidated.push(...input.impactedRoutes);
    }
    if (checkRoutes.length) {
      step = "route-check";
      for (const r of checkRoutes) {
        const status = await ctx.siteStatus(r, 10_000);
        routes.push({ route: r, status: status ?? 0 });
        if (status === null || status >= 500) throw new BridgeError("VERIFY_FAILED", `route ${r} responded ${status ?? "no response"} after apply`);
      }
    }
  } catch (e) {
    ctx.logger.warn("apply failed; restoring snapshot", { revision_id: revisionId, step, err: e });
    await restoreSnapshot(ctx, revisionId);
    await ctx.revisions.setStatus(revisionId, "rolled_back", `failed at ${step}`);
    await fsp.rm(marker, { force: true });
    ctx.invalidateCaches();
    if (ctx.revalidator.enabled && revalidated.length) await ctx.revalidator.run(revalidated).catch(() => {});
    throw new BridgeError("VERIFY_FAILED", `apply failed at step "${step}"; the previous state was restored`, { revision_id: revisionId, step });
  }
  await fsp.rm(marker, { force: true });
  return { revisionId, revalidated, verification: { hashes_ok: true, routes }, appliedAt: nowIso() };
}

export async function restoreSnapshot(ctx: BridgeContext, revisionId: string): Promise<void> {
  const snap = await ctx.revisions.readSnapshot(revisionId);
  if (!snap) throw new Error("snapshot missing");
  for (const { entry, content } of snap) {
    const root = rootById(ctx.cfg, entry.root);
    if (!root) continue;
    const abs = await resolveInRoot(root, entry.path);
    if (entry.absent || content === null) await durableDelete(abs);
    else await atomicWrite(abs, content, { mode: entry.mode ?? undefined });
  }
}

/** Crash recovery: revisions left IN_PROGRESS are restored and marked rolled_back. */
export async function recoverInterrupted(ctx: BridgeContext): Promise<string[]> {
  const recovered: string[] = [];
  for (const r of await ctx.revisions.list()) {
    const marker = `${ctx.revisions.dir}/${r.revision_id}/IN_PROGRESS`;
    if (await pathExists(marker)) {
      try {
        await restoreSnapshot(ctx, r.revision_id);
        await ctx.revisions.setStatus(r.revision_id, "rolled_back", "interrupted; restored on startup");
        await fsp.rm(marker, { force: true });
        recovered.push(r.revision_id);
      } catch (e) {
        ctx.logger.error("could not recover interrupted revision", { revision_id: r.revision_id, err: e });
      }
    }
  }
  return recovered;
}

export async function applyChangeSet(ctx: BridgeContext, req: ApplyRequestT, keyId: string): Promise<ApplyResponseT> {
  return ctx.lock.withLock("site", async () => {
    const plan = await planChangeSet(ctx, req);
    const p = plan.response;
    if (req.base_revision && p.current_revision !== req.base_revision) {
      throw new BridgeError("CONFLICT_REVISION", "base_revision is not the current revision", { current_revision: p.current_revision });
    }
    if (!p.valid) throw planError(p.errors);
    if (sha256Hex(p.diff) !== req.expected_plan_sha256) {
      throw new BridgeError("CONFLICT_REVISION", "the plan changed since it was approved (diff hash mismatch)", { current_revision: p.current_revision, plan_sha256: sha256Hex(p.diff) });
    }
    const r = await executeChanges(ctx, {
      kind: "changeset",
      changeId: req.change_id,
      changes: plan.changes,
      operations: req.operations,
      impactedRoutes: p.impacted_routes,
      diff: p.diff,
      keyId,
      reason: null,
      reverts: null,
    });
    return {
      revision_id: r.revisionId,
      change_id: req.change_id,
      status: "applied",
      operations: plan.effective.map((effective, index) => ({ index, effective })),
      files: p.files,
      revalidated: r.revalidated,
      verification: r.verification,
      applied_at: r.appliedAt,
    };
  });
}

export async function rollbackRevision(ctx: BridgeContext, id: string, opts: { reason: string; force: boolean; keyId: string }) {
  return ctx.lock.withLock("site", async () => {
    const rec = await ctx.revisions.get(id);
    if (!rec) throw new BridgeError("NOT_FOUND", "revision not found");
    if (rec.status !== "applied") throw new BridgeError("CONFLICT_REVISION", `revision is ${rec.status}; only applied revisions can be rolled back`);
    const snap = await ctx.revisions.readSnapshot(id);
    if (!snap) throw new BridgeError("OPERATION_NOT_ALLOWED", "the snapshot of this revision was pruned by retention");
    const changes: FileChange[] = [];
    const conflicts: { root: string; path: string }[] = [];
    for (const { entry, content } of snap) {
      const root = rootById(ctx.cfg, entry.root);
      if (!root) throw new BridgeError("OPERATION_NOT_ALLOWED", `root "${entry.root}" no longer exists`);
      const abs = await resolveInRoot(root, entry.path);
      const disk = await fsp.readFile(abs).catch(() => null);
      const planned = rec.file_changes.find((f) => f.root === entry.root && f.path === entry.path);
      const expected = planned?.after_sha256 ?? null;
      const actual = disk ? sha256Hex(disk) : null;
      if (actual !== expected) conflicts.push({ root: entry.root, path: entry.path });
      const same = (disk === null && content === null) || (disk !== null && content !== null && disk.equals(content));
      if (!same) changes.push({ root: entry.root, path: entry.path, before: disk, after: content });
    }
    if (conflicts.length && !opts.force) {
      throw new BridgeError("CONFLICT_REVISION", "files changed since this revision; pass force (deploy scope) to overwrite", { files: conflicts });
    }
    const diff = combinedDiff(changes);
    const r = await executeChanges(ctx, {
      kind: "rollback",
      changeId: `rollback-${id}`,
      changes,
      operations: [],
      impactedRoutes: rec.impacted_routes,
      diff,
      keyId: opts.keyId,
      reason: opts.reason || null,
      reverts: id,
    });
    await ctx.revisions.setStatus(id, "reverted");
    return {
      revision_id: r.revisionId,
      reverts: id,
      change_id: `rollback-${id}`,
      status: "applied" as const,
      forced: conflicts.length > 0,
      files: planFiles(changes),
      revalidated: r.revalidated,
      verification: r.verification,
      applied_at: r.appliedAt,
    };
  });
}
