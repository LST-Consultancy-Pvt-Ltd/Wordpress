import { Fragment, useState } from "react";
import {
  Loader2, Save, Undo2, ExternalLink, ChevronDown, Search, Target, Image as ImageIcon, RefreshCw,
  Sparkles, FileText, Link as LinkIcon, ArrowRight, Copy,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Badge } from "../ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { scoreChip, sevChip } from "./shared";
import { cn } from "../../lib/utils";
import { toast } from "sonner";
import {
  editorAIAssist, nextjsGetPageContent, nextjsGetPageImages,
  nextjsSetPageContent, nextjsSetImageAlt, nextjsGenerateImageAlt, movePage,
} from "../../lib/api";

const INTENTS = ["", "informational", "commercial", "transactional", "navigational"];

// Same five actions as the WordPress content editor — kept here so a Next.js
// page's body copy gets the same rewrite options, not a reduced set.
const AI_ACTIONS = [
  { action: "improve_writing", label: "Improve" },
  { action: "seo_friendly", label: "SEO-Friendly" },
  { action: "add_internal_links", label: "Internal Links" },
  { action: "summarize", label: "Summarize" },
  { action: "expand", label: "Expand" },
];

/** How close a value is to its target band, as a bar. Character counts are the
 *  one place in SEO where a number really is the whole story, so showing it as
 *  a length rather than a digit is worth the space. */
function LengthMeter({ length, min, max, overhead = 0 }) {
  const effective = length + overhead;
  const ideal = effective >= min && effective <= max;
  const pct = Math.min(100, (effective / (max * 1.35)) * 100);
  return (
    <div className="space-y-1">
      <div className="h-1 rounded bg-muted overflow-hidden">
        <div className={cn("h-full rounded transition-all",
          ideal ? "bg-emerald-500" : effective > max ? "bg-red-500" : "bg-yellow-500")}
          style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[10px] text-muted-foreground">
        {overhead
          ? `${length} chars · your layout appends ${overhead} → renders as ${effective} · aim ${min - overhead}–${max - overhead} here`
          : `${length} chars · aim ${min}–${max}`}
      </p>
    </div>
  );
}

export default function PagesEditor({
  pagesData, onSaveMeta, onClearMeta, onSaveKeyword, onClearKeyword, onReload, loading,
  siteId, platform, siteUrl,
}) {
  const [expanded, setExpanded] = useState({});
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState({});      // path -> {title, description, ogImage}
  const [kwDrafts, setKwDrafts] = useState({});  // path -> {keyword, secondary, intent}
  const [busy, setBusy] = useState("");
  const [errors, setErrors] = useState({});

  // Next.js body-copy blocks + image alt text, keyed by page path — lazily
  // fetched the first time a row expands, same pattern as the parent's
  // per-category cache.
  const [contentCache, setContentCache] = useState({});   // path -> { blocks, loading }
  const [blockDrafts, setBlockDrafts] = useState({});      // path -> { key: value }
  const [savingBlock, setSavingBlock] = useState(null);    // "path:key"
  const [blockAiBusy, setBlockAiBusy] = useState(null);    // "path:key:action"
  const [imagesCache, setImagesCache] = useState({});      // path -> { images, loading }
  const [imageDrafts, setImageDrafts] = useState({});      // path -> { key: alt }
  const [savingImage, setSavingImage] = useState(null);    // "path:key"
  const [generatingImage, setGeneratingImage] = useState(null); // "path:key"

  // Moving a page's stored SEO data to a new route path. The route itself is
  // a folder name compiled into the Next.js build, so this can only carry the
  // bridge-stored data over and hand back the code change that makes the new
  // URL live — see the note in PUT .../move-page.
  const [moveDrafts, setMoveDrafts] = useState({});   // path -> new path
  const [moving, setMoving] = useState("");
  const [moveResults, setMoveResults] = useState({}); // path -> API response

  const isNextjs = platform === "nextjs";

  const resolveImageUrl = (src) => {
    if (!src) return "";
    if (/^https?:\/\//i.test(src)) return src;
    const base = (siteUrl || "").replace(/\/+$/, "");
    return `${base}${src.startsWith("/") ? "" : "/"}${src}`;
  };

  const toggleExpand = async (p) => {
    const willExpand = !expanded[p.path];
    setExpanded((e) => ({ ...e, [p.path]: willExpand }));
    if (!willExpand || !isNextjs || contentCache[p.path]) return;
    setContentCache((c) => ({ ...c, [p.path]: { blocks: {}, loading: true } }));
    setImagesCache((c) => ({ ...c, [p.path]: { images: {}, loading: true } }));

    // Fetched independently — a bridge that doesn't implement one of these
    // (yet) shouldn't hide a real error behind the other's result, and the
    // error message itself (surfaced from the backend, which already
    // distinguishes "bridge not deployed" from "bridge doesn't implement
    // this endpoint") is the actionable diagnostic, not a generic blank.
    try {
      const cRes = await nextjsGetPageContent(siteId, p.path);
      setContentCache((c) => ({ ...c, [p.path]: { blocks: cRes.data.blocks || {}, loading: false } }));
      setBlockDrafts((d) => ({ ...d, [p.path]: cRes.data.blocks || {} }));
    } catch (e) {
      setContentCache((c) => ({
        ...c, [p.path]: { blocks: {}, loading: false, error: e.response?.data?.detail || "Could not load page content" },
      }));
    }

    try {
      const iRes = await nextjsGetPageImages(siteId, p.path);
      setImagesCache((c) => ({ ...c, [p.path]: { images: iRes.data.images || {}, loading: false } }));
      setImageDrafts((d) => ({
        ...d,
        [p.path]: Object.fromEntries(Object.entries(iRes.data.images || {}).map(([k, v]) => [k, v?.alt || ""])),
      }));
    } catch (e) {
      setImagesCache((c) => ({
        ...c, [p.path]: { images: {}, loading: false, error: e.response?.data?.detail || "Could not load images" },
      }));
    }
  };

  const saveBlock = async (path, key) => {
    setSavingBlock(`${path}:${key}`);
    try {
      await nextjsSetPageContent(siteId, path, key, (blockDrafts[path] || {})[key] ?? "");
      toast.success(`Saved "${key}" — live now`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setSavingBlock(null); }
  };

  const aiAssistBlock = async (path, key, action) => {
    const text = (blockDrafts[path] || {})[key] || "";
    if (!text.trim()) { toast.error("Nothing to rewrite yet"); return; }
    const busyKey = `${path}:${key}:${action}`;
    setBlockAiBusy(busyKey);
    try {
      const r = await editorAIAssist({ text, action, site_id: siteId });
      setBlockDrafts((d) => ({ ...d, [path]: { ...d[path], [key]: r.data.result } }));
      toast.success("AI edit applied — review and Save");
    } catch (e) {
      toast.error(e.response?.data?.detail || "AI assist failed");
    } finally { setBlockAiBusy(null); }
  };

  const saveImageAlt = async (path, key) => {
    setSavingImage(`${path}:${key}`);
    try {
      await nextjsSetImageAlt(siteId, path, key, (imageDrafts[path] || {})[key] ?? "");
      toast.success(`Saved alt text for "${key}"`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setSavingImage(null); }
  };

  const generateImageAlt = async (path, key, src) => {
    setGeneratingImage(`${path}:${key}`);
    try {
      const r = await nextjsGenerateImageAlt(siteId, path, key, src);
      setImageDrafts((d) => ({ ...d, [path]: { ...d[path], [key]: r.data.image?.alt ?? (d[path] || {})[key] } }));
      toast.success("AI alt text generated — review and Save");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Generation failed");
    } finally { setGeneratingImage(null); }
  };

  const pages = pagesData?.pages || [];
  const caps = pagesData?.meta_capabilities || {};
  const canEdit = pagesData?.meta_editing_supported;
  const supports = (field) => !caps.supported_fields || caps.supported_fields.includes(field);

  const overrideFor = (p) => p.override || null;

  // The word "override" is only accurate for a bridge that layers a store on
  // top of the page's own generateMetadata(). A slug-keyed bridge holds the
  // page's SEO fields outright, so labelling those as overrides implies a
  // code default that is being shadowed when there isn't one.
  const isOverrideStore = caps.dialect !== "pages";
  const storedLabel = isOverrideStore ? "override active" : "stored in bridge";
  const resetLabel = isOverrideStore ? "Reset to page default" : "Clear stored values";

  /** What the page currently renders (or has stored), which is both what the
   *  inputs start from and the baseline a save is diffed against. */
  const initialFor = (p) => {
    const ov = overrideFor(p) || {};
    return {
      title: ov.title ?? p.live_title ?? p.signals?.title ?? "",
      description: ov.description ?? p.live_description ?? p.signals?.description ?? "",
      canonical: ov.canonical ?? p.signals?.canonical ?? "",
      ogImage: ov.ogImage ?? p.signals?.og_image ?? "",
    };
  };

  const draftFor = (p) => drafts[p.path] || initialFor(p);

  const kwDraftFor = (p) => kwDrafts[p.path] || {
    keyword: p.focus_keyword || "",
    secondary: (p.secondary_keywords || []).join(", "),
    intent: p.search_intent || "",
  };

  // Layouts commonly append a site name to every title (e.g. " | LST
  // Consultancy"). The audit measures the RENDERED title, so the stored value
  // has to be shorter by that overhead — without showing this, a "56 char"
  // edit still fails the 50–60 check and looks broken.
  const titleOverhead = (p) => {
    const stored = overrideFor(p)?.title;
    const rendered = p.live_title || p.signals?.title || "";
    if (!stored || !rendered || rendered.length <= stored.length) return 0;
    return rendered.startsWith(stored) ? rendered.length - stored.length : 0;
  };

  const handleSave = async (p) => {
    setBusy(p.path);
    setErrors((e) => ({ ...e, [p.path]: null }));
    try {
      // Only the fields that actually changed. The inputs pre-fill from the
      // LIVE page when no override exists, and the live og:image is absolute
      // while the stored one is often relative — sending it unconditionally
      // would rewrite a field nobody touched.
      const d = draftFor(p);
      const base = initialFor(p);
      const body = { path: p.path };
      if (d.title !== base.title) body.title = d.title;
      if (d.description !== base.description) body.description = d.description;
      if (supports("canonical") && d.canonical !== base.canonical) body.canonical = d.canonical;
      if (supports("ogImage") && d.ogImage !== base.ogImage) body.ogImage = d.ogImage;
      if (Object.keys(body).length === 1) {
        setErrors((er) => ({ ...er, [p.path]: "Nothing changed yet." }));
        return;
      }
      await onSaveMeta(body);
      setDrafts((prev) => { const n = { ...prev }; delete n[p.path]; return n; });
    } catch (e) {
      // Inline as well as a toast: a save that looks fine but silently failed
      // is the worst outcome, and a toast is easy to miss.
      setErrors((er) => ({ ...er, [p.path]: e.response?.data?.detail || "Could not save" }));
    } finally { setBusy(""); }
  };

  const handleMove = async (p) => {
    const to = (moveDrafts[p.path] || "").trim();
    if (!to) return;
    setMoving(p.path);
    try {
      const r = await movePage(siteId, p.path, to);
      setMoveResults((m) => ({ ...m, [p.path]: r.data }));
      toast.success(`Data moved to ${r.data.to_path} — deploy the code change to make the URL live`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Move failed");
    } finally { setMoving(""); }
  };

  const copySnippet = (text) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied");
  };

  const handleSaveKeyword = async (p) => {
    const d = kwDraftFor(p);
    if (!d.keyword.trim()) return;
    setBusy(p.path + "-kw");
    try {
      await onSaveKeyword({
        path: p.path, keyword: d.keyword.trim(),
        secondary: d.secondary.split(",").map((s) => s.trim()).filter(Boolean),
        intent: d.intent,
      });
      setKwDrafts((prev) => { const n = { ...prev }; delete n[p.path]; return n; });
    } finally { setBusy(""); }
  };

  const filtered = pages.filter(
    (p) => !query.trim() ||
      `${p.url} ${p.focus_keyword || ""} ${p.live_title || ""}`.toLowerCase()
        .includes(query.trim().toLowerCase())
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between pb-3 gap-4">
        <div className="min-w-0">
          <CardTitle className="text-base">Pages ({filtered.length})</CardTitle>
          <CardDescription className="text-xs">
            Lowest score first. Expand a page to edit its SEO title, description and focus keyword.
          </CardDescription>
          {!canEdit && pagesData?.meta_editing_note && (
            <p className="text-xs text-yellow-500 border-l-2 border-yellow-500/50 pl-2 mt-2">
              {pagesData.meta_editing_note}
            </p>
          )}
          {canEdit && caps.unsupported_fields?.length > 0 && (
            <p className="text-[11px] text-muted-foreground border-l-2 border-muted pl-2 mt-2">
              This site's bridge stores <span className="font-mono">
                {caps.supported_fields.join(", ")}</span>. <span className="font-mono">
                {caps.unsupported_fields.join(", ")}</span> live in the page's own code — the
              Fix code tab generates it.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="h-8 text-xs pl-7 w-44" placeholder="Filter URL or keyword…"
                   value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <Button variant="ghost" size="sm" onClick={onReload} disabled={loading}>
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-14">
            No pages yet — run an audit, or check the site has a sitemap.
          </p>
        ) : (
          <div className="max-h-[640px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Page</TableHead>
                  <TableHead className="w-20">Score</TableHead>
                  <TableHead className="w-24">Keyword</TableHead>
                  <TableHead className="w-20">Issues</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((p) => (
                  <Fragment key={p.path + p.url}>
                    <TableRow className="cursor-pointer"
                              onClick={() => toggleExpand(p)}>
                      <TableCell className="max-w-0">
                        <div className="flex items-center gap-1.5">
                          <ChevronDown size={11}
                            className={cn("shrink-0 transition-transform", !expanded[p.path] && "-rotate-90")} />
                          <span className="truncate text-xs">{p.url}</span>
                          {overrideFor(p) && (
                            <Badge className="text-[9px] bg-primary/10 text-primary shrink-0">
                              {isOverrideStore ? "override" : "in bridge"}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge className={cn("text-xs font-mono", scoreChip(p.score))}>
                          {p.score ?? "n/a"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {p.focus_keyword
                          ? <Badge className="text-[10px] bg-emerald-500/10 text-emerald-500">set</Badge>
                          : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {p.audited === false ? "not audited"
                          : p.ok === false ? (p.error || "unreachable")
                          : `${p.issue_count ?? 0}`}
                      </TableCell>
                    </TableRow>

                    {expanded[p.path] && (
                      <TableRow>
                        <TableCell colSpan={4} className="bg-muted/20">
                          {p.audited === false ? (
                            <p className="text-xs text-muted-foreground py-1">
                              Not audited yet — run an audit to score this page.
                            </p>
                          ) : p.ok === false ? (
                            <p className="text-xs text-yellow-500 py-1">
                              Could not fetch this page{p.error ? ` (${p.error})` : ""}. Not scored —
                              a network or firewall problem isn't an SEO problem.
                            </p>
                          ) : (
                            <div className="space-y-3 py-1">
                              <a href={p.url} target="_blank" rel="noopener noreferrer"
                                 className="text-xs text-primary hover:underline inline-flex items-center gap-1">
                                <ExternalLink size={10} />Open page
                              </a>

                              {p.issues?.length ? (
                                <div className="space-y-1">
                                  {p.issues.map((iss, k) => (
                                    <div key={k} className="flex items-start gap-2">
                                      <Badge className={cn("text-[10px] shrink-0", sevChip[iss.severity] || "")}>
                                        {iss.severity}
                                      </Badge>
                                      <span className="text-xs text-muted-foreground">{iss.message}</span>
                                    </div>
                                  ))}
                                </div>
                              ) : <p className="text-xs text-emerald-500">No issues found.</p>}

                              {p.signals && (
                                <p className="text-[11px] text-muted-foreground">
                                  {p.signals.word_count} words · {p.signals.h1_count} H1 ·{" "}
                                  {p.signals.h2_count} H2 · {p.signals.image_count} images
                                  {p.signals.images_missing_alt > 0 &&
                                    ` (${p.signals.images_missing_alt} without alt)`} ·{" "}
                                  {p.signals.schema_types?.length
                                    ? p.signals.schema_types.join(", ") : "no schema"}
                                </p>
                              )}

                              {/* Focus keyword — a decision no crawl can read
                                  off the page, so it is asked for explicitly. */}
                              <div className="border-t pt-2.5 space-y-2">
                                <p className="text-xs font-medium flex items-center gap-1.5">
                                  <Target size={11} />Focus keyword
                                  {p.focus_keyword ? null : (
                                    <span className="text-[10px] text-yellow-500 font-normal">
                                      not set — analysis falls back to a guess from the H1
                                    </span>
                                  )}
                                </p>
                                <div className="grid sm:grid-cols-3 gap-2">
                                  <Input className="h-7 text-xs" placeholder="Primary keyword"
                                    value={kwDraftFor(p).keyword}
                                    onChange={(e) => setKwDrafts((d) => ({
                                      ...d, [p.path]: { ...kwDraftFor(p), keyword: e.target.value } }))} />
                                  <Input className="h-7 text-xs"
                                    placeholder="Secondary / long-tail, comma separated"
                                    value={kwDraftFor(p).secondary}
                                    onChange={(e) => setKwDrafts((d) => ({
                                      ...d, [p.path]: { ...kwDraftFor(p), secondary: e.target.value } }))} />
                                  <select
                                    className="h-7 text-xs rounded-md border border-input bg-background px-2"
                                    value={kwDraftFor(p).intent}
                                    onChange={(e) => setKwDrafts((d) => ({
                                      ...d, [p.path]: { ...kwDraftFor(p), intent: e.target.value } }))}>
                                    {INTENTS.map((i) => (
                                      <option key={i} value={i}>{i || "search intent…"}</option>
                                    ))}
                                  </select>
                                </div>
                                <div className="flex gap-2">
                                  <Button size="sm" className="h-7 text-xs"
                                          disabled={busy === p.path + "-kw" || !kwDraftFor(p).keyword.trim()}
                                          onClick={() => handleSaveKeyword(p)}>
                                    {busy === p.path + "-kw"
                                      ? <Loader2 size={11} className="mr-1 animate-spin" />
                                      : <Target size={11} className="mr-1" />}Save keyword
                                  </Button>
                                  {p.focus_keyword && (
                                    <Button size="sm" variant="outline" className="h-7 text-xs"
                                            onClick={() => onClearKeyword(p.path)}>
                                      Clear
                                    </Button>
                                  )}
                                </div>
                                {p.keyword_analysis?.checks?.length > 0 && (
                                  <div className="grid sm:grid-cols-2 gap-x-6 gap-y-0.5 pt-1">
                                    {p.keyword_analysis.checks.map((c) => (
                                      <div key={c.id} className="flex items-center gap-2">
                                        <span className={cn("text-[10px] font-mono",
                                          c.passed ? "text-emerald-500" : "text-red-400")}>
                                          {c.passed ? "PASS" : "FAIL"}
                                        </span>
                                        <span className="text-[11px] text-muted-foreground">{c.label}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>

                              {canEdit && (
                                <div className="border-t pt-2.5 space-y-2">
                                  <div className="flex items-center gap-2">
                                    <p className="text-xs font-medium">SEO title &amp; description</p>
                                    {overrideFor(p) && (
                                      <Badge className="text-[10px] bg-primary/10 text-primary">
                                        {storedLabel}
                                      </Badge>
                                    )}
                                  </div>
                                  <div>
                                    <Input className="h-7 text-xs" placeholder="SEO title"
                                      value={draftFor(p).title}
                                      onChange={(e) => setDrafts((d) => ({
                                        ...d, [p.path]: { ...draftFor(p), title: e.target.value } }))} />
                                    <LengthMeter length={draftFor(p).title.length} min={50} max={60}
                                                 overhead={titleOverhead(p)} />
                                  </div>
                                  <div>
                                    <Textarea rows={2} className="text-xs" placeholder="Meta description"
                                      value={draftFor(p).description}
                                      onChange={(e) => setDrafts((d) => ({
                                        ...d, [p.path]: { ...draftFor(p), description: e.target.value } }))} />
                                    <LengthMeter length={draftFor(p).description.length} min={150} max={160} />
                                  </div>
                                  {supports("canonical") && (
                                    <div>
                                      <div className="flex items-center gap-1.5 mb-1">
                                        <LinkIcon size={11} className="text-muted-foreground" />
                                        <span className="text-[11px] text-muted-foreground">
                                          Canonical URL
                                        </span>
                                      </div>
                                      <Input className="h-7 text-xs" placeholder={`${siteUrl || ""}${p.path}`}
                                        value={draftFor(p).canonical}
                                        onChange={(e) => setDrafts((d) => ({
                                          ...d, [p.path]: { ...draftFor(p), canonical: e.target.value } }))} />
                                    </div>
                                  )}
                                  {supports("ogImage") && (
                                    <div>
                                      <div className="flex items-center gap-1.5 mb-1">
                                        <ImageIcon size={11} className="text-muted-foreground" />
                                        <span className="text-[11px] text-muted-foreground">
                                          Social share image (og:image) — 1200×630
                                        </span>
                                      </div>
                                      <Input className="h-7 text-xs" placeholder="/og/page-image.png"
                                        value={draftFor(p).ogImage}
                                        onChange={(e) => setDrafts((d) => ({
                                          ...d, [p.path]: { ...draftFor(p), ogImage: e.target.value } }))} />
                                    </div>
                                  )}
                                  <div className="flex gap-2">
                                    <Button size="sm" className="h-7 text-xs"
                                            onClick={() => handleSave(p)} disabled={busy === p.path}>
                                      {busy === p.path
                                        ? <Loader2 size={11} className="mr-1 animate-spin" />
                                        : <Save size={11} className="mr-1" />}Save
                                    </Button>
                                    {overrideFor(p) && (
                                      <Button size="sm" variant="outline" className="h-7 text-xs"
                                              onClick={() => onClearMeta(p.path)} disabled={busy === p.path}>
                                        <Undo2 size={11} className="mr-1" />{resetLabel}
                                      </Button>
                                    )}
                                  </div>
                                  {errors[p.path] && (
                                    <p className="text-[11px] text-red-400 border-l-2 border-red-400/50 pl-2">
                                      Save failed — {errors[p.path]}
                                    </p>
                                  )}
                                </div>
                              )}

                              {isNextjs && (
                                <div className="border-t pt-2.5 space-y-2">
                                  <p className="text-xs font-medium flex items-center gap-1.5">
                                    <LinkIcon size={11} />Move / rename this page
                                  </p>
                                  <p className="text-[11px] text-muted-foreground">
                                    Carries the SEO title/description/canonical, body-copy blocks, image
                                    alt text and focus keyword stored for this page over to a new path.
                                    The route itself is a folder name compiled into your build, so the
                                    URL doesn't change until you make the code change this generates.
                                  </p>
                                  <div className="flex gap-2">
                                    <Input className="h-7 text-xs" placeholder="/new-path"
                                      value={moveDrafts[p.path] ?? ""}
                                      onChange={(e) => setMoveDrafts((d) => ({ ...d, [p.path]: e.target.value }))} />
                                    <Button size="sm" className="h-7 text-xs shrink-0"
                                      disabled={moving === p.path || !(moveDrafts[p.path] || "").trim()}
                                      onClick={() => handleMove(p)}>
                                      {moving === p.path
                                        ? <Loader2 size={11} className="mr-1 animate-spin" />
                                        : <ArrowRight size={11} className="mr-1" />}
                                      Move
                                    </Button>
                                  </div>
                                  {moveResults[p.path] && (
                                    <div className="rounded-md border border-border/40 p-2 space-y-1.5">
                                      {moveResults[p.path].moved?.length > 0 && (
                                        <p className="text-[11px] text-emerald-500">
                                          Moved: {moveResults[p.path].moved.join(", ")}
                                        </p>
                                      )}
                                      {moveResults[p.path].errors?.length > 0 && (
                                        <p className="text-[11px] text-yellow-500">
                                          {moveResults[p.path].errors.join(" · ")}
                                        </p>
                                      )}
                                      <ol className="text-[11px] text-muted-foreground list-decimal list-inside space-y-0.5">
                                        {moveResults[p.path].instructions?.map((ins, i) => <li key={i}>{ins}</li>)}
                                      </ol>
                                      <pre className="text-[10px] bg-muted/30 rounded p-2 overflow-x-auto whitespace-pre-wrap">
                                        {moveResults[p.path].redirect_snippet}
                                      </pre>
                                      <Button variant="outline" size="sm" className="h-6 text-[10px]"
                                        onClick={() => copySnippet(moveResults[p.path].redirect_snippet)}>
                                        <Copy size={10} className="mr-1" />Copy snippet
                                      </Button>
                                    </div>
                                  )}
                                </div>
                              )}

                              {isNextjs && (
                                <div className="border-t pt-2.5 space-y-2">
                                  <p className="text-xs font-medium flex items-center gap-1.5">
                                    <FileText size={11} />Page content
                                  </p>
                                  {contentCache[p.path]?.loading ? (
                                    <Loader2 size={14} className="animate-spin text-muted-foreground" />
                                  ) : contentCache[p.path]?.error ? (
                                    <p className="text-[11px] text-yellow-500 border-l-2 border-yellow-500/50 pl-2">
                                      {contentCache[p.path].error}
                                    </p>
                                  ) : Object.keys(blockDrafts[p.path] || {}).length === 0 ? (
                                    <p className="text-[11px] text-muted-foreground">
                                      No editable blocks found yet — wrap this page's copy in{" "}
                                      <code>&lt;Editable&gt;</code> or <code>&lt;EditableHtml&gt;</code>{" "}
                                      (see nextjs-bridge/README.md).
                                    </p>
                                  ) : (
                                    Object.entries(blockDrafts[p.path]).map(([key, value]) => (
                                      <div key={key} className="space-y-1.5 rounded-md border border-border/40 p-2">
                                        <div className="flex items-center justify-between gap-2 flex-wrap">
                                          <span className="text-[11px] font-mono text-muted-foreground">{key}</span>
                                          <div className="flex gap-1 flex-wrap">
                                            {AI_ACTIONS.map(({ action, label }) => (
                                              <Button key={action} variant="outline" size="sm"
                                                className="h-6 text-[10px] px-1.5"
                                                disabled={blockAiBusy !== null}
                                                onClick={() => aiAssistBlock(p.path, key, action)}>
                                                {blockAiBusy === `${p.path}:${key}:${action}`
                                                  ? <Loader2 size={10} className="mr-1 animate-spin" />
                                                  : <Sparkles size={10} className="mr-1" />}
                                                {label}
                                              </Button>
                                            ))}
                                          </div>
                                        </div>
                                        <Textarea rows={3} className="text-xs font-mono"
                                          value={value}
                                          onChange={(e) => setBlockDrafts((d) => ({
                                            ...d, [p.path]: { ...d[p.path], [key]: e.target.value } }))} />
                                        <div className="flex justify-end">
                                          <Button size="sm" className="h-6 text-[10px]"
                                            disabled={savingBlock === `${p.path}:${key}`}
                                            onClick={() => saveBlock(p.path, key)}>
                                            {savingBlock === `${p.path}:${key}`
                                              ? <Loader2 size={10} className="mr-1 animate-spin" />
                                              : <Save size={10} className="mr-1" />}
                                            Save &amp; publish
                                          </Button>
                                        </div>
                                      </div>
                                    ))
                                  )}
                                </div>
                              )}

                              {isNextjs && (
                                <div className="border-t pt-2.5 space-y-2">
                                  <p className="text-xs font-medium flex items-center gap-1.5">
                                    <ImageIcon size={11} />Image alt text
                                  </p>
                                  {(() => {
                                    // The crawl counts every real <img> on the rendered page — compare
                                    // that against what the bridge actually registered so a page with
                                    // some, but not all, of its images wrapped in <EditableImg> says so
                                    // instead of just looking like it only has two images.
                                    const registered = Object.keys(imagesCache[p.path]?.images || {}).length;
                                    const total = p.signals?.image_count;
                                    if (imagesCache[p.path]?.loading || imagesCache[p.path]?.error) return null;
                                    if (typeof total !== "number" || total <= registered || registered === 0) return null;
                                    return (
                                      <p className="text-[11px] text-yellow-500 border-l-2 border-yellow-500/50 pl-2">
                                        This page has {total} images, but only {registered} {registered === 1 ? "is" : "are"}{" "}
                                        editable here — the other {total - registered} {total - registered === 1 ? "is" : "are"}{" "}
                                        still plain <code>&lt;img&gt;</code> tags in the Next.js code. Wrap them in{" "}
                                        <code>&lt;EditableImg&gt;</code> too (see nextjs-bridge/README.md) to bring them in.
                                      </p>
                                    );
                                  })()}
                                  {imagesCache[p.path]?.loading ? (
                                    <Loader2 size={14} className="animate-spin text-muted-foreground" />
                                  ) : imagesCache[p.path]?.error ? (
                                    <p className="text-[11px] text-yellow-500 border-l-2 border-yellow-500/50 pl-2">
                                      {imagesCache[p.path].error}
                                    </p>
                                  ) : Object.keys(imagesCache[p.path]?.images || {}).length === 0 ? (
                                    <p className="text-[11px] text-muted-foreground">
                                      No editable images found yet — wrap this page's images in{" "}
                                      <code>&lt;EditableImg&gt;</code> (see nextjs-bridge/README.md).
                                      {typeof p.signals?.image_count === "number" && p.signals.image_count > 0 &&
                                        ` This page has ${p.signals.image_count} image(s) that could be.`}
                                    </p>
                                  ) : (
                                  Object.entries(imagesCache[p.path].images).map(([key, img]) => (
                                    <div key={key} className="flex gap-2 items-start rounded-md border border-border/40 p-2">
                                      {img?.src && (
                                        <img src={resolveImageUrl(img.src)} alt=""
                                          className="w-14 h-14 object-cover rounded border border-border/40 flex-shrink-0 bg-muted/20"
                                          onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
                                      )}
                                      <div className="flex-1 min-w-0 space-y-1.5">
                                        <span className="text-[11px] font-mono text-muted-foreground">{key}</span>
                                        <Textarea rows={2} className="text-xs"
                                          value={(imageDrafts[p.path] || {})[key] ?? ""}
                                          onChange={(e) => setImageDrafts((d) => ({
                                            ...d, [p.path]: { ...d[p.path], [key]: e.target.value } }))}
                                          placeholder="Alt text…" />
                                        <div className="flex justify-end gap-2">
                                          <Button variant="outline" size="sm" className="h-6 text-[10px]"
                                            disabled={generatingImage !== null || !img?.src}
                                            onClick={() => generateImageAlt(p.path, key, img.src)}>
                                            {generatingImage === `${p.path}:${key}`
                                              ? <Loader2 size={10} className="mr-1 animate-spin" />
                                              : <Sparkles size={10} className="mr-1" />}
                                            Generate with AI
                                          </Button>
                                          <Button size="sm" className="h-6 text-[10px]"
                                            disabled={savingImage === `${p.path}:${key}`}
                                            onClick={() => saveImageAlt(p.path, key)}>
                                            {savingImage === `${p.path}:${key}`
                                              ? <Loader2 size={10} className="mr-1 animate-spin" />
                                              : <Save size={10} className="mr-1" />}
                                            Save
                                          </Button>
                                        </div>
                                      </div>
                                    </div>
                                  ))
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
