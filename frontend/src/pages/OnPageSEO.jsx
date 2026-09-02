import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import {
  Gauge, Loader2, RefreshCw, ScanLine, AlertTriangle, ExternalLink, ChevronDown, Search, Save, Undo2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "../components/ui/table";
import {
  getSites, scanOnPageSEO, getOnPageAudit, listOnPagePages, setPageMeta, clearPageMeta, subscribeToTask,
} from "../lib/api";
import { toast } from "sonner";

const scoreTone = (s) =>
  s == null ? "bg-muted text-muted-foreground"
    : s >= 80 ? "bg-emerald-500/10 text-emerald-500"
    : s >= 60 ? "bg-yellow-500/10 text-yellow-500"
    : "bg-red-500/10 text-red-400";

const sevTone = {
  high: "bg-red-500/10 text-red-400",
  medium: "bg-yellow-500/10 text-yellow-500",
  low: "bg-muted text-muted-foreground",
};

function routePathOf(url) {
  try {
    const path = new URL(url).pathname || "/";
    return path.length > 1 ? path.replace(/\/+$/, "") : "/";
  } catch {
    return url || "/";
  }
}

function ScoreRing({ score }) {
  const pct = score == null ? 0 : score;
  const tone = score == null ? "#6b7280" : score >= 80 ? "#10b981" : score >= 60 ? "#eab308" : "#ef4444";
  return (
    <div className="relative w-28 h-28 shrink-0">
      <svg viewBox="0 0 36 36" className="w-28 h-28 -rotate-90">
        <circle cx="18" cy="18" r="15.5" fill="none" stroke="currentColor" strokeWidth="3" className="text-muted/30" />
        <circle cx="18" cy="18" r="15.5" fill="none" stroke={tone} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * 97.4} 97.4`} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold font-mono">{score ?? "—"}</span>
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">/ 100</span>
      </div>
    </div>
  );
}

export default function OnPageSEO() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState("");
  const [maxPages, setMaxPages] = useState("50");
  const [expanded, setExpanded] = useState({});
  const [query, setQuery] = useState("");
  const [pagesData, setPagesData] = useState(null);   // { pages, meta_editing_supported, ... }
  const [drafts, setDrafts] = useState({});         // path -> { title, description }
  const [savingPath, setSavingPath] = useState("");
  const [saveError, setSaveError] = useState({});

  useEffect(() => {
    getSites().then(r => { setSites(r.data); if (r.data.length) setSelectedSite(r.data[0].id); }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!selectedSite) return;
    setLoading(true);
    try { const r = await getOnPageAudit(selectedSite); setAudit(r.data); }
    catch { setAudit(null); } finally { setLoading(false); }
  }, [selectedSite]);

  const loadPages = useCallback(async () => {
    if (!selectedSite) return;
    try { const r = await listOnPagePages(selectedSite); setPagesData(r.data); }
    catch { setPagesData(null); }
  }, [selectedSite]);

  useEffect(() => { load(); loadPages(); }, [load, loadPages]);

  const overrideFor = (path) => pagesData?.pages?.find(p => p.path === path)?.override || null;

  const draftFor = (page) => {
    const d = drafts[page.path];
    if (d) return d;
    const ov = overrideFor(page.path) || {};
    return {
      title: ov.title ?? page.live_title ?? page.signals?.title ?? "",
      description: ov.description ?? page.live_description ?? page.signals?.description ?? "",
    };
  };

  // Layouts commonly append a site name to every title (e.g. " | LST
  // Consultancy"). The audit measures the RENDERED title, so the stored value
  // has to be shorter by that overhead — without showing this, a "56 char"
  // edit still fails the 50–60 check and looks broken.
  const titleOverhead = (page) => {
    const stored = overrideFor(page.path)?.title;
    const rendered = page.live_title || page.signals?.title || "";
    if (!stored || !rendered || rendered.length <= stored.length) return 0;
    return rendered.startsWith(stored) ? rendered.length - stored.length : 0;
  };

  const handleSaveMeta = async (page) => {
    const d = draftFor(page);
    setSavingPath(page.path);
    setSaveError(e => ({ ...e, [page.path]: null }));
    try {
      const r = await setPageMeta(selectedSite, { path: page.path, title: d.title, description: d.description });
      setDrafts(p => { const n = { ...p }; delete n[page.path]; return n; });
      await loadPages(); await load();
      const rs = r.data?.rescored;
      if (rs?.score != null) toast.success(`Saved — ${page.path} now scores ${rs.score}/100`);
      else toast.success(`Saved meta for ${page.path}`);
    } catch (e) {
      const msg = e.response?.data?.detail || "Could not save";
      // Inline as well as a toast: a save that looks fine but silently failed
      // is the worst outcome, and a toast is easy to miss.
      setSaveError(er => ({ ...er, [page.path]: msg }));
      toast.error(msg);
    } finally { setSavingPath(""); }
  };

  const handleClearMeta = async (page) => {
    setSavingPath(page.path);
    try {
      await clearPageMeta(selectedSite, page.path);
      setDrafts(p => { const n = { ...p }; delete n[page.path]; return n; });
      await loadPages();
      toast.success(`Override removed — your page's own metadata applies again`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not clear");
    } finally { setSavingPath(""); }
  };

  const handleScan = async () => {
    setScanning(true);
    setProgress("Starting audit…");
    try {
      const r = await scanOnPageSEO(selectedSite, { max_pages: Number(maxPages) });
      subscribeToTask(r.data.task_id, evt => {
        if (evt.type === "status") {
          const m = evt.data?.progress?.message;
          if (m) setProgress(m);
          if (evt.data?.status === "completed") {
            setScanning(false); setProgress(""); load(); loadPages();
            toast.success(evt.data?.result?.message || "Audit complete");
          } else if (evt.data?.status === "failed") {
            setScanning(false); setProgress("");
            toast.error(evt.data?.error || "Audit failed");
          }
        }
        if (evt.type === "error") { setScanning(false); setProgress(""); toast.error("Audit failed"); }
      });
    } catch (e) {
      setScanning(false); setProgress("");
      toast.error(e.response?.data?.detail || "Could not start the audit");
    }
  };

  // Both sources must yield the SAME row shape. Previously the fallback set
  // path to the full URL, which left the meta inputs empty and made saves
  // write the override under a mangled key, so edits silently did nothing.
  const rows = (pagesData?.pages?.length ? pagesData.pages : (audit?.pages || []).map(p => ({
    url: p.url,
    path: routePathOf(p.url),
    score: p.score,
    audited: true,
    ok: p.ok,
    error: p.error,
    signals: p.signals,
    issues: p.issues || [],
    issue_count: (p.issues || []).length,
    live_title: p.signals?.title || "",
    live_description: p.signals?.description || "",
  })));
  const pages = rows.filter(p =>
    !query.trim() || (p.url || "").toLowerCase().includes(query.trim().toLowerCase()));
  const canEditMeta = pagesData?.meta_editing_supported;

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Gauge size={24} />On-Page SEO</h1>
          <p className="page-description">
            Scores every page from its rendered HTML, so it works the same on WordPress, Next.js or any other stack
          </p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {progress && (
        <Card className="border-blue-500/30 bg-blue-500/5">
          <CardContent className="py-3 flex items-center gap-3">
            <Loader2 size={14} className="animate-spin text-blue-400" />
            <p className="text-sm text-blue-400">{progress}</p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3"><CardTitle className="text-base">Site score</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <ScoreRing score={audit?.site_score ?? null} />
              <div className="space-y-1 text-sm">
                <p className="text-muted-foreground">{audit?.pages_audited ?? 0} pages audited</p>
                {audit?.pages_failed > 0 && (
                  <p className="text-yellow-500 text-xs flex items-center gap-1">
                    <AlertTriangle size={11} />{audit.pages_failed} unreachable
                  </p>
                )}
                {audit?.url_source && (
                  <p className="text-xs text-muted-foreground">Pages from {audit.url_source}</p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Select value={maxPages} onValueChange={setMaxPages}>
                <SelectTrigger className="h-8 text-xs w-[110px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["10", "25", "50", "100"].map(n => <SelectItem key={n} value={n}>{n} pages</SelectItem>)}
                </SelectContent>
              </Select>
              <Button className="flex-1 h-8 text-xs" onClick={handleScan} disabled={scanning || !selectedSite}>
                {scanning ? <><Loader2 size={12} className="mr-1.5 animate-spin" />Auditing…</>
                          : <><ScanLine size={12} className="mr-1.5" />Run audit</>}
              </Button>
            </div>

            {pagesData && !pagesData.meta_editing_supported && pagesData.meta_editing_note && (
              <p className="text-xs text-muted-foreground border-l-2 border-muted pl-2">
                {pagesData.meta_editing_note}
              </p>
            )}

            {audit?.factor_summary?.length > 0 && (
              <div className="space-y-2 pt-1">
                <p className="text-xs font-medium text-muted-foreground">Weakest factors</p>
                {audit.factor_summary.slice(0, 6).map(f => (
                  <div key={f.key} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span>{f.label}</span>
                      <span className="font-mono text-muted-foreground">{f.average}</span>
                    </div>
                    <div className="h-1.5 rounded bg-muted overflow-hidden">
                      <div className="h-full rounded"
                        style={{ width: `${f.average}%`,
                                 background: f.average >= 80 ? "#10b981" : f.average >= 60 ? "#eab308" : "#ef4444" }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <div>
              <CardTitle className="text-base">Pages ({pages.length})</CardTitle>
              <CardDescription className="text-xs">Lowest scores first</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input className="h-8 text-xs pl-7 w-40" placeholder="Filter URL…"
                  value={query} onChange={e => setQuery(e.target.value)} />
              </div>
              <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
                <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {pages.length === 0 ? (
              <div className="text-center py-14">
                <Gauge size={32} className="mx-auto mb-2 text-muted-foreground opacity-40" />
                <p className="text-sm text-muted-foreground">
                  {audit?.message || "No pages audited yet — run an audit."}
                </p>
              </div>
            ) : (
              <div className="max-h-[560px] overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Page</TableHead>
                      <TableHead className="w-20">Score</TableHead>
                      <TableHead className="w-24">Issues</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pages.map((p, i) => (
                      <>
                        <TableRow key={p.url + i} className="cursor-pointer"
                          onClick={() => setExpanded(e => ({ ...e, [p.url]: !e[p.url] }))}>
                          <TableCell className="max-w-0">
                            <div className="flex items-center gap-1.5">
                              <ChevronDown size={11}
                                className={`shrink-0 transition-transform ${expanded[p.url] ? "" : "-rotate-90"}`} />
                              <span className="truncate text-xs">{p.url}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge className={`text-xs font-mono ${scoreTone(p.score)}`}>
                              {p.score ?? "n/a"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {p.audited === false ? "not audited"
                              : p.ok === false ? (p.error || "unreachable")
                              : `${p.issue_count ?? p.issues?.length ?? 0}`}
                          </TableCell>
                        </TableRow>
                        {expanded[p.url] && (
                          <TableRow key={p.url + i + "-detail"}>
                            <TableCell colSpan={3} className="bg-muted/20">
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
                                <div className="space-y-2 py-1">
                                  <a href={p.url} target="_blank" rel="noopener noreferrer"
                                     className="text-xs text-primary hover:underline flex items-center gap-1">
                                    <ExternalLink size={10} />Open page
                                  </a>
                                  {p.issues?.length ? p.issues.map((iss, k) => (
                                    <div key={k} className="flex items-start gap-2">
                                      <Badge className={`text-[10px] shrink-0 ${sevTone[iss.severity] || ""}`}>
                                        {iss.severity}
                                      </Badge>
                                      <span className="text-xs text-muted-foreground">{iss.message}</span>
                                    </div>
                                  )) : <p className="text-xs text-emerald-500">No issues found.</p>}
                                  {p.signals && (
                                    <p className="text-[11px] text-muted-foreground pt-1">
                                      {p.signals.word_count} words · {p.signals.h1_count} H1 ·{" "}
                                      {p.signals.h2_count} H2 · {p.signals.image_count} images ·{" "}
                                      {p.signals.schema_types?.length
                                        ? p.signals.schema_types.join(", ") : "no schema"}
                                    </p>
                                  )}

                                  {canEditMeta && p.path && (
                                    <div className="pt-2 mt-1 border-t space-y-2">
                                      <div className="flex items-center gap-2">
                                        <p className="text-xs font-medium">Meta title &amp; description</p>
                                        {overrideFor(p.path) && (
                                          <Badge className="text-[10px] bg-primary/10 text-primary">override active</Badge>
                                        )}
                                      </div>
                                      <div>
                                        <Input className="h-7 text-xs" placeholder="Meta title"
                                          value={draftFor(p).title}
                                          onChange={e => setDrafts(d => ({
                                            ...d, [p.path]: { ...draftFor(p), title: e.target.value } }))} />
                                        <p className="text-[10px] text-muted-foreground mt-0.5">
                                          {(() => {
                                            const oh = titleOverhead(p);
                                            const len = draftFor(p).title.length;
                                            return oh
                                              ? `${len} chars · your site appends ${oh} → renders as ${len + oh} · aim ${50 - oh}–${60 - oh} here`
                                              : `${len} chars · aim 50–60`;
                                          })()}
                                        </p>
                                      </div>
                                      <div>
                                        <Textarea rows={2} className="text-xs" placeholder="Meta description"
                                          value={draftFor(p).description}
                                          onChange={e => setDrafts(d => ({
                                            ...d, [p.path]: { ...draftFor(p), description: e.target.value } }))} />
                                        <p className="text-[10px] text-muted-foreground mt-0.5">
                                          {draftFor(p).description.length} chars · aim 150–160
                                        </p>
                                      </div>
                                      <div className="flex gap-2">
                                        <Button size="sm" className="h-7 text-xs"
                                          onClick={() => handleSaveMeta(p)} disabled={savingPath === p.path}>
                                          {savingPath === p.path
                                            ? <Loader2 size={11} className="mr-1 animate-spin" />
                                            : <Save size={11} className="mr-1" />}Save
                                        </Button>
                                        {overrideFor(p.path) && (
                                          <Button size="sm" variant="outline" className="h-7 text-xs"
                                            onClick={() => handleClearMeta(p)} disabled={savingPath === p.path}>
                                            <Undo2 size={11} className="mr-1" />Reset to page default
                                          </Button>
                                        )}
                                      </div>
                                      {saveError[p.path] && (
                                        <p className="text-[11px] text-red-400 border-l-2 border-red-400/50 pl-2">
                                          Save failed — {saveError[p.path]}
                                        </p>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        )}
                      </>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </motion.div>
  );
}
