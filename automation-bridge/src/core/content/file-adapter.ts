/**
 * File-backed content adapters:
 *  - `mdx` / `markdown`: `<dir>/<slug>.mdx|.md` with YAML front matter,
 *    drafts in `<dir>/_drafts/<slug>.<ext>` (never routed).
 *  - `json`: `<dir>/<slug>.json` = {"frontmatter": {…}, "body": "…"},
 *    drafts in `<dir>/_drafts/<slug>.json`.
 *
 * Bodies are stored verbatim (image references, HTML and MDX untouched). An
 * item with `frontmatter.content_format: "html"` carries an HTML body; the
 * site runtime renders it through the sanitiser (`renderContentHtml`)
 * instead of compiling it as MDX.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { CollectionConfigT, ResolvedRoot } from "../config.js";
import { BridgeError } from "../errors.js";
import { validateJsonSchema } from "../jsonschema.js";
import { resolveInRoot } from "../paths.js";
import { fillSlug } from "../route.js";
import { SLUG_RE } from "../schemas.js";
import { sha256Hex, stableStringify } from "../util.js";
import { joinFrontmatter, splitFrontmatter } from "./frontmatter.js";
import type { AdapterPlanResult, ContentAdapter, ContentAdapterDescriptorT, ContentItemSummaryT, ContentItemT, ContentStatusFilter, Vfs } from "./types.js";

type Status = "draft" | "published";

/** Lines that make MDX execute code at build/render time. */
const MDX_EXEC_RE = /^\s*(import|export)\s|\{[^}]*\}/m;

export class FileContentAdapter implements ContentAdapter {
  readonly descriptor: ContentAdapterDescriptorT;
  private readonly cfg: CollectionConfigT;
  private readonly root: ResolvedRoot;
  private readonly ext: string;

  constructor(cfg: CollectionConfigT, root: ResolvedRoot) {
    if (cfg.kind === "custom") throw new Error("FileContentAdapter cannot serve custom collections");
    this.cfg = cfg;
    this.root = root;
    this.ext = cfg.kind === "mdx" ? ".mdx" : cfg.kind === "markdown" ? ".md" : ".json";
    this.descriptor = {
      id: cfg.id,
      kind: cfg.kind,
      root: root.id,
      operations: root.writable ? ["read", "create", "update", "delete"] : ["read"],
      frontmatter_schema: cfg.frontmatter_schema,
      route_pattern: cfg.route_pattern,
    };
  }

  private dirRel(): string {
    return this.cfg.dir.replace(/^\/+|\/+$/g, "");
  }

  relPath(slug: string, status: Status): string {
    if (!SLUG_RE.test(slug)) throw new BridgeError("VALIDATION_FAILED", "invalid slug");
    const d = this.dirRel();
    const parts = [d, status === "draft" ? "_drafts" : "", `${slug}${this.ext}`].filter(Boolean);
    return parts.join("/");
  }

  serialize(frontmatter: Record<string, unknown>, body: string): Buffer {
    if (this.cfg.kind === "json") return Buffer.from(stableStringify({ frontmatter, body }) + "\n", "utf8");
    return Buffer.from(joinFrontmatter(frontmatter, body), "utf8");
  }

  parse(raw: Buffer): { frontmatter: Record<string, unknown>; body: string } {
    const text = raw.toString("utf8");
    if (this.cfg.kind === "json") {
      try {
        const v = JSON.parse(text) as { frontmatter?: unknown; body?: unknown };
        const fm = v.frontmatter && typeof v.frontmatter === "object" && !Array.isArray(v.frontmatter) ? (v.frontmatter as Record<string, unknown>) : {};
        return { frontmatter: fm, body: typeof v.body === "string" ? v.body : "" };
      } catch {
        return { frontmatter: {}, body: "" };
      }
    }
    return splitFrontmatter(text);
  }

  private titleOf(fm: Record<string, unknown>): string | null {
    const t = fm[this.cfg.title_field];
    return typeof t === "string" ? t : null;
  }

  private async readDisk(rel: string): Promise<{ buf: Buffer; mtime: Date } | null> {
    const abs = await resolveInRoot(this.root, rel);
    try {
      const st = await fsp.lstat(abs);
      if (!st.isFile()) return null;
      return { buf: await fsp.readFile(abs), mtime: st.mtime };
    } catch {
      return null;
    }
  }

  async list(status: ContentStatusFilter): Promise<ContentItemSummaryT[]> {
    const out: ContentItemSummaryT[] = [];
    const statuses: Status[] = status === "all" ? ["published", "draft"] : [status];
    for (const s of statuses) {
      const dirRel = [this.dirRel(), s === "draft" ? "_drafts" : ""].filter(Boolean).join("/");
      let abs: string;
      try {
        abs = dirRel ? await resolveInRoot(this.root, dirRel) : this.root.abs;
      } catch {
        continue;
      }
      let names: string[] = [];
      try {
        names = (await fsp.readdir(abs, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        if (!name.endsWith(this.ext)) continue;
        const slug = name.slice(0, -this.ext.length);
        if (!SLUG_RE.test(slug) || slug.length > 120) continue;
        const f = await this.readDisk(this.relPath(slug, s));
        if (!f) continue;
        const { frontmatter } = this.parse(f.buf);
        out.push({ slug, title: this.titleOf(frontmatter), status: s, updated_at: f.mtime.toISOString(), sha256: sha256Hex(f.buf) });
      }
    }
    return out;
  }

  async get(slug: string): Promise<ContentItemT | null> {
    for (const s of ["published", "draft"] as Status[]) {
      const rel = this.relPath(slug, s);
      const f = await this.readDisk(rel);
      if (!f) continue;
      const { frontmatter, body } = this.parse(f.buf);
      return { slug, status: s, frontmatter, body, sha256: sha256Hex(f.buf), path: { root: this.root.id, path: rel } };
    }
    return null;
  }

  private impacted(slug: string, wasPublished: boolean, isPublished: boolean): string[] {
    if (!wasPublished && !isPublished) return [];
    const r = new Set<string>(this.cfg.index_routes);
    if (this.cfg.route_pattern) r.add(fillSlug(this.cfg.route_pattern, slug));
    return [...r];
  }

  private async current(slug: string, vfs: Vfs): Promise<{ status: Status; buf: Buffer } | null> {
    const pub = await vfs.read(this.root.id, this.relPath(slug, "published"));
    if (pub) return { status: "published", buf: pub };
    const draft = await vfs.read(this.root.id, this.relPath(slug, "draft"));
    if (draft) return { status: "draft", buf: draft };
    return null;
  }

  async planUpsert(op: { slug: string; status: Status; frontmatter: Record<string, unknown>; body: string; base_sha256: string | null }, vfs: Vfs): Promise<AdapterPlanResult> {
    if (!this.root.writable) throw new BridgeError("CAPABILITY_UNSUPPORTED", `collection "${this.cfg.id}" is read-only`, { capability: "content.write" });
    if (this.cfg.frontmatter_schema) {
      const issues = validateJsonSchema(this.cfg.frontmatter_schema, op.frontmatter);
      if (issues.length) throw new BridgeError("VALIDATION_FAILED", `front matter invalid: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`, { issues });
    }
    const cur = await this.current(op.slug, vfs);
    if (op.base_sha256 === null && cur) throw new BridgeError("CONFLICT_REVISION", `item "${op.slug}" already exists (base_sha256 was null)`);
    if (op.base_sha256 !== null && (!cur || sha256Hex(cur.buf) !== op.base_sha256)) {
      throw new BridgeError("CONFLICT_REVISION", `item "${op.slug}" changed since base_sha256`);
    }
    const content = this.serialize(op.frontmatter, op.body);
    if (cur && cur.status !== op.status) await vfs.write(this.root.id, this.relPath(op.slug, cur.status), null);
    await vfs.write(this.root.id, this.relPath(op.slug, op.status), content);
    const warnings: { code: string; message: string }[] = [];
    const riskFlags: ("code-change" | "deletes-content")[] = [];
    if (this.cfg.kind === "mdx" && op.frontmatter.content_format !== "html" && MDX_EXEC_RE.test(op.body)) {
      warnings.push({ code: "MDX_EXECUTABLE_CONTENT", message: "MDX body contains import/export or {expressions}, which run as code when the site builds or renders it" });
      riskFlags.push("code-change");
    }
    if (cur?.status === "published" && op.status === "draft") riskFlags.push("deletes-content");
    return { impactedRoutes: this.impacted(op.slug, cur?.status === "published", op.status === "published"), warnings, riskFlags };
  }

  async planDelete(op: { slug: string; base_sha256: string }, vfs: Vfs): Promise<AdapterPlanResult> {
    if (!this.root.writable) throw new BridgeError("CAPABILITY_UNSUPPORTED", `collection "${this.cfg.id}" is read-only`, { capability: "content.write" });
    const cur = await this.current(op.slug, vfs);
    if (!cur) throw new BridgeError("NOT_FOUND", `item "${op.slug}" does not exist`);
    if (sha256Hex(cur.buf) !== op.base_sha256) throw new BridgeError("CONFLICT_REVISION", `item "${op.slug}" changed since base_sha256`);
    await vfs.write(this.root.id, this.relPath(op.slug, cur.status), null);
    return { impactedRoutes: this.impacted(op.slug, cur.status === "published", false), riskFlags: ["deletes-content"] };
  }

  async check(): Promise<{ ok: boolean; detail: string | null }> {
    try {
      const d = this.dirRel();
      const abs = d ? path.join(this.root.abs, ...d.split("/")) : this.root.abs;
      await fsp.access(abs);
      return { ok: true, detail: null };
    } catch {
      return { ok: false, detail: "collection directory missing" };
    }
  }
}
