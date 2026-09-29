import { Fragment, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Loader2, Save, Undo2, ExternalLink, ChevronDown, Search, Target, Image as ImageIcon, RefreshCw,
  FileText, Link as LinkIcon, ArrowRight, Copy,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../ui/card";
import { Button } from "../ui/button";
import GatedButton from "../sa/GatedButton";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Badge } from "../ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { scoreChip, sevChip } from "./shared";
import { cn } from "../../lib/utils";
import { toast } from "sonner";
import { movePage, apiErrorMessage } from "../../lib/api";
import { notifyChangeSetCreated } from "../../lib/changesets";

const INTENTS = ["", "informational", "commercial", "transactional", "navigational"];


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
  siteId, siteBaseUrl, writeBlocked = null,
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState({});
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState({});      // path -> {title, description, ogImage}
  const [kwDrafts, setKwDrafts] = useState({});  // path -> {keyword, secondary, intent}
  const [busy, setBusy] = useState("");
  const [errors, setErrors] = useState({});

  // Moving a page's stored SEO data to a new route path. The route itself is
  // a folder name compiled into the Next.js build, so this can only carry the
  // bridge-stored data over and hand back the code change that makes the new
  // URL live — see the note in PUT .../move-page.
  const [moveDrafts, setMoveDrafts] = useState({});   // path -> new path
  const [moving, setMoving] = useState("");
  const [moveResults, setMoveResults] = useState({}); // path -> API response

  const pages = pagesData?.pages || [];
  const canEdit = pagesData?.meta_editing_supported !== false;
  const supports = () => true;

  const overrideFor = (p) => p.override || null;

  const storedLabel = "override stored";
  const resetLabel = "Propose clearing override";

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
      setErrors((er) => ({ ...er, [p.path]: apiErrorMessage(e, "Could not save") }));
    } finally { setBusy(""); }
  };

  const handleMove = async (p) => {
    const to = (moveDrafts[p.path] || "").trim();
    if (!to) return;
    setMoving(p.path);
    try {
      const r = await movePage(siteId, p.path, to);
      setMoveResults((m) => ({ ...m, [p.path]: r.data }));
      if (r.data?.changeset) notifyChangeSetCreated(r.data.changeset, navigate, { title: `Move to ${r.data.to_path}: change set created` });
      else toast.success(`Nothing stored to move — make the code change to serve ${r.data?.to_path || to}`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Move failed"));
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
                              onClick={() => setExpanded((e) => ({ ...e, [p.path]: !e[p.path] }))}
                              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded((x) => ({ ...x, [p.path]: !x[p.path] })); } }}
                              tabIndex={0} aria-expanded={!!expanded[p.path]}>
                      <TableCell className="max-w-0">
                        <div className="flex items-center gap-1.5">
                          <ChevronDown size={11}
                            className={cn("shrink-0 transition-transform", !expanded[p.path] && "-rotate-90")} />
                          <span className="truncate text-xs">{p.url}</span>
                          {overrideFor(p) && (
                            <Badge className="text-[9px] bg-primary/10 text-primary shrink-0">
                              override
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
                                  <GatedButton minRole="editor" size="sm" className="h-7 text-xs"
                                          disabled={busy === p.path + "-kw" || !kwDraftFor(p).keyword.trim()}
                                          onClick={() => handleSaveKeyword(p)}>
                                    {busy === p.path + "-kw"
                                      ? <Loader2 size={11} className="mr-1 animate-spin" />
                                      : <Target size={11} className="mr-1" />}Save keyword
                                  </GatedButton>
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
                                      <Input className="h-7 text-xs" placeholder={`${siteBaseUrl || ""}${p.path}`}
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
                                    <GatedButton minRole="editor" blocked={writeBlocked} size="sm" className="h-7 text-xs"
                                            onClick={() => handleSave(p)} disabled={busy === p.path}>
                                      {busy === p.path
                                        ? <Loader2 size={11} className="mr-1 animate-spin" />
                                        : <Save size={11} className="mr-1" />}Create change set
                                    </GatedButton>
                                    {overrideFor(p) && (
                                      <GatedButton minRole="editor" blocked={writeBlocked} size="sm" variant="outline" className="h-7 text-xs"
                                              onClick={() => onClearMeta(p.path)} disabled={busy === p.path}>
                                        <Undo2 size={11} className="mr-1" />{resetLabel}
                                      </GatedButton>
                                    )}
                                  </div>
                                  {errors[p.path] && (
                                    <p className="text-[11px] text-red-400 border-l-2 border-red-400/50 pl-2">
                                      Change set not created — {errors[p.path]}
                                    </p>
                                  )}
                                </div>
                              )}

                              {(
                                <div className="border-t pt-2.5 space-y-2">
                                  <p className="text-xs font-medium flex items-center gap-1.5">
                                    <LinkIcon size={11} />Move / rename this page
                                  </p>
                                  <p className="text-[11px] text-muted-foreground">
                                    Proposes a change set that carries the metadata override stored for this
                                    page over to a new path (the focus keyword moves immediately). The route
                                    itself is a folder in your repository, so the URL changes only with the
                                    code change described below.
                                  </p>
                                  <div className="flex gap-2">
                                    <Input className="h-7 text-xs" placeholder="/new-path"
                                      value={moveDrafts[p.path] ?? ""}
                                      onChange={(e) => setMoveDrafts((d) => ({ ...d, [p.path]: e.target.value }))} />
                                    <GatedButton minRole="editor" size="sm" className="h-7 text-xs shrink-0"
                                      disabled={moving === p.path || !(moveDrafts[p.path] || "").trim()}
                                      onClick={() => handleMove(p)}>
                                      {moving === p.path
                                        ? <Loader2 size={11} className="mr-1 animate-spin" />
                                        : <ArrowRight size={11} className="mr-1" />}
                                      Move
                                    </GatedButton>
                                  </div>
                                  {moveResults[p.path] && (
                                    <div className="rounded-md border border-border/40 p-2 space-y-1.5">
                                      {moveResults[p.path].changeset ? (
                                        <p className="text-[11px] text-emerald-500">
                                          Change set created —{" "}
                                          <Link className="underline" to={`/changesets/${moveResults[p.path].changeset.id}`}>review it in Change Sets</Link>
                                        </p>
                                      ) : (
                                        <p className="text-[11px] text-muted-foreground">No stored metadata to move.</p>
                                      )}
                                      {moveResults[p.path].focus_keyword_moved && (
                                        <p className="text-[11px] text-muted-foreground">Focus keyword moved.</p>
                                      )}
                                      <ol className="text-[11px] text-muted-foreground list-decimal list-inside space-y-0.5">
                                        {moveResults[p.path].instructions?.map((ins, i) => <li key={i}>{ins}</li>)}
                                      </ol>
                                      {moveResults[p.path].redirect_snippet && (
                                        <>
                                          <pre className="text-[10px] bg-muted/30 rounded p-2 overflow-x-auto whitespace-pre-wrap">
                                            {moveResults[p.path].redirect_snippet}
                                          </pre>
                                          <Button variant="outline" size="sm" className="h-6 text-[10px]"
                                            onClick={() => copySnippet(moveResults[p.path].redirect_snippet)}>
                                            <Copy size={10} className="mr-1" />Copy snippet
                                          </Button>
                                        </>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}

                              <div className="border-t pt-2.5 space-y-1">
                                <p className="text-xs font-medium flex items-center gap-1.5">
                                  <FileText size={11} />Page copy &amp; images
                                </p>
                                <p className="text-[11px] text-muted-foreground">
                                  Registered text blocks and image alt text are edited in the site's content editor, as change sets.
                                </p>
                                <div className="flex flex-wrap gap-3 text-[11px]">
                                  <Link className="text-primary hover:underline" to={`/sites/${siteId}/content?tab=blocks`}>Edit blocks</Link>
                                  <Link className="text-primary hover:underline" to={`/sites/${siteId}/content?tab=images`}>Edit image alt text</Link>
                                  <Link className="text-primary hover:underline" to={`/sites/${siteId}/content?tab=metadata&route=${encodeURIComponent(p.path)}`}>Full metadata editor (robots, JSON-LD)</Link>
                                </div>
                              </div>
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
