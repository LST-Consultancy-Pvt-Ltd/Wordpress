import { useState, useEffect, useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import {
  Gauge, Loader2, ScanLine, LayoutDashboard, FileText, Code2, ChevronRight,
  Search, Link2, Image as ImageIcon, Braces, Map, Bot, Anchor, Radar, GitBranch,
  Zap, Smartphone, MapPin, Share2, ShieldCheck, Unlink, LineChart, Activity, ClipboardCheck,
} from "lucide-react";
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Switch } from "../components/ui/switch";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import {
  getSites, scanOnPageSEO, getOnPageSummary, getOnPageCategory, getOnPageHistory,
  listOnPagePages, setPageMeta, clearPageMeta, setFocusKeyword, clearFocusKeyword,
  getNextjsSnippets, exportOnPageAudit, subscribeToTask,
} from "../lib/api";
import { toast } from "sonner";
import { cn } from "../lib/utils";
import { scoreChip } from "../components/onpage/shared";
import CategoryPanel from "../components/onpage/CategoryPanel";
import PagesEditor from "../components/onpage/PagesEditor";
import OverviewPanel from "../components/onpage/OverviewPanel";
import SnippetsPanel from "../components/onpage/SnippetsPanel";

/* The twenty areas, in the order they are worked through: what you write,
   then how it is marked up, then how it is served, then how it is measured.
   Icons are here rather than on the server — the API returns data, not
   presentation. */
const CATEGORY_ICONS = {
  keyword_content: Search,
  on_page: FileText,
  technical: Braces,
  images: ImageIcon,
  internal_linking: Link2,
  schema: Braces,
  sitemap: Map,
  robots: Bot,
  canonical: Anchor,
  indexing: Radar,
  redirects: GitBranch,
  performance: Zap,
  mobile: Smartphone,
  local: MapPin,
  social: Share2,
  security: ShieldCheck,
  broken_links: Unlink,
  gsc_analytics: LineChart,
  monitoring: Activity,
  reporting: ClipboardCheck,
};

export default function OnPageSEO() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [summary, setSummary] = useState(null);
  const [history, setHistory] = useState([]);
  const [pagesData, setPagesData] = useState(null);
  const [report, setReport] = useState(null);          // the "reporting" category
  const [snippets, setSnippets] = useState(null);
  const [categoryCache, setCategoryCache] = useState({});
  const [view, setView] = useState("overview");        // overview | pages | code | <category key>
  const [loading, setLoading] = useState(false);
  const [catLoading, setCatLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState("");
  const [maxPages, setMaxPages] = useState("25");
  const [checkLinks, setCheckLinks] = useState(true);
  const [measureCwv, setMeasureCwv] = useState(false);

  useEffect(() => {
    getSites()
      .then((r) => { setSites(r.data); if (r.data.length) setSelectedSite(r.data[0].id); })
      .catch(() => toast.error("Could not load your sites"));
  }, []);

  const site = useMemo(() => sites.find((s) => s.id === selectedSite), [sites, selectedSite]);

  const loadAll = useCallback(async () => {
    if (!selectedSite) return;
    setLoading(true);
    setCategoryCache({});
    try {
      const [s, h, p] = await Promise.all([
        getOnPageSummary(selectedSite).catch(() => ({ data: null })),
        getOnPageHistory(selectedSite).catch(() => ({ data: [] })),
        listOnPagePages(selectedSite).catch(() => ({ data: null })),
      ]);
      setSummary(s.data);
      setHistory(h.data || []);
      setPagesData(p.data);
      if (s.data?.categories?.length) {
        const r = await getOnPageCategory(selectedSite, "reporting").catch(() => ({ data: null }));
        setReport(r.data);
      } else {
        setReport(null);
      }
    } finally { setLoading(false); }
  }, [selectedSite]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const loadPages = useCallback(async () => {
    if (!selectedSite) return;
    try { const r = await listOnPagePages(selectedSite); setPagesData(r.data); }
    catch { /* the table keeps what it has rather than blanking */ }
  }, [selectedSite]);

  // Categories are fetched one at a time. A full audit of 50 pages with every
  // per-page row attached is megabytes; shipping all twenty to render one is
  // the difference between an instant tab and a spinner.
  const openCategory = useCallback(async (key) => {
    setView(key);
    if (categoryCache[key]) return;
    setCatLoading(true);
    try {
      const r = await getOnPageCategory(selectedSite, key);
      setCategoryCache((c) => ({ ...c, [key]: r.data }));
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not load that section");
    } finally { setCatLoading(false); }
  }, [selectedSite, categoryCache]);

  const openCode = useCallback(async () => {
    setView("code");
    if (snippets) return;
    try { const r = await getNextjsSnippets(selectedSite); setSnippets(r.data); }
    catch (e) { toast.error(e.response?.data?.detail || "Could not build the snippets"); }
  }, [selectedSite, snippets]);

  const handleScan = async () => {
    setScanning(true);
    setProgress("Starting the audit…");
    try {
      const r = await scanOnPageSEO(selectedSite, {
        max_pages: Number(maxPages),
        check_links: checkLinks,
        measure_cwv: measureCwv,
        psi_sample: 3,
      });
      subscribeToTask(r.data.task_id, (evt) => {
        if (evt.type === "status") {
          const m = evt.data?.progress?.message;
          if (m) setProgress(m);
          if (evt.data?.status === "completed") {
            setScanning(false); setProgress("");
            setSnippets(null);
            loadAll();
            toast.success(evt.data?.result?.message || "Audit complete");
          } else if (evt.data?.status === "failed") {
            setScanning(false); setProgress("");
            toast.error(evt.data?.error || "Audit failed");
          }
        }
        if (evt.type === "error") {
          setScanning(false); setProgress("");
          toast.error(evt.data?.message || "Audit failed");
        }
      });
    } catch (e) {
      setScanning(false); setProgress("");
      toast.error(e.response?.data?.detail || "Could not start the audit");
    }
  };

  const handleSaveMeta = async (body) => {
    const r = await setPageMeta(selectedSite, body);
    await loadPages();
    const rs = r.data?.rescored;
    const unsupported = r.data?.unsupported_fields || [];
    if (unsupported.length) {
      toast.warning(
        `Saved ${(r.data.applied_fields || []).join(", ") || "nothing"} — this bridge cannot store ` +
        `${unsupported.join(", ")}. Use the Fix code tab for those.`
      );
    } else if (rs?.score != null) {
      toast.success(`Saved — ${body.path} now scores ${rs.score}/100 live`);
    } else if (rs?.error) {
      toast.warning(`Saved, but the live page could not be re-checked: ${rs.error}`);
    } else {
      toast.success(`Saved meta for ${body.path}`);
    }
    return r;
  };

  const handleClearMeta = async (path) => {
    try {
      await clearPageMeta(selectedSite, path);
      await loadPages();
      toast.success("Cleared — the page's own metadata applies again");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not clear the override");
    }
  };

  const handleSaveKeyword = async (body) => {
    const r = await setFocusKeyword(selectedSite, body);
    await loadPages();
    const ka = r.data?.keyword_analysis;
    if (ka?.score != null) {
      toast.success(`Focus keyword set — “${body.keyword}” placed in ${ka.passed}/${ka.total} positions`);
    } else {
      toast.success(`Focus keyword set for ${body.path}`);
    }
    return r;
  };

  const handleClearKeyword = async (path) => {
    try {
      await clearFocusKeyword(selectedSite, path);
      await loadPages();
      toast.success("Focus keyword cleared");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not clear the keyword");
    }
  };

  const handleExport = async (kind) => {
    try {
      const r = await exportOnPageAudit(selectedSite, kind);
      const url = URL.createObjectURL(new Blob([r.data], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `seo-audit-${kind}-${(summary?.created_at || "").slice(0, 10) || "latest"}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Nothing to export yet — run an audit first");
    }
  };

  const cats = (summary?.categories || []).filter((c) => c.key !== "reporting");
  const activeCategory = categoryCache[view];

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="page-title flex items-center gap-2 mb-1"><Gauge size={24} />On-Page SEO</h1>
          <p className="text-muted-foreground text-sm">
            Every SEO area, scored from the rendered HTML of your live pages — so it works the same on
            Next.js, WordPress or any other stack.
            {site && <span className="ml-1 font-mono text-xs">{site.url}</span>}
          </p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-56"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>
            {sites.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}{s.platform && s.platform !== "wordpress" ? ` · ${s.platform}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card className="mb-4">
        <CardContent className="py-3 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Pages</Label>
            <Select value={maxPages} onValueChange={setMaxPages}>
              <SelectTrigger className="h-8 text-xs w-[100px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["10", "25", "50", "100", "200"].map((n) => (
                  <SelectItem key={n} value={n}>{n} pages</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="links" checked={checkLinks} onCheckedChange={setCheckLinks} />
            <Label htmlFor="links" className="text-xs cursor-pointer">
              Verify links &amp; images
              <span className="text-muted-foreground ml-1">(broken-link check)</span>
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="cwv" checked={measureCwv} onCheckedChange={setMeasureCwv} />
            <Label htmlFor="cwv" className="text-xs cursor-pointer">
              Core Web Vitals
              <span className="text-muted-foreground ml-1">(PageSpeed, ~40s per URL)</span>
            </Label>
          </div>
          <Button className="h-8 text-xs ml-auto" onClick={handleScan}
                  disabled={scanning || !selectedSite}>
            {scanning
              ? <><Loader2 size={12} className="mr-1.5 animate-spin" />Auditing…</>
              : <><ScanLine size={12} className="mr-1.5" />Run full audit</>}
          </Button>
        </CardContent>
      </Card>

      {progress && (
        <Card className="border-blue-500/30 bg-blue-500/5 mb-4">
          <CardContent className="py-3 flex items-center gap-3">
            <Loader2 size={14} className="animate-spin text-blue-400 shrink-0" />
            <p className="text-sm text-blue-400 truncate">{progress}</p>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col lg:flex-row gap-4">
        {/* Twenty areas do not fit a horizontal tab strip legibly, so the rail
            is vertical and scores sit beside each name — the point of the list
            is to see at a glance where the problems are. */}
        <nav className="lg:w-64 shrink-0 space-y-1">
          {[
            ["overview", "Overview", LayoutDashboard],
            ["pages", "Pages & editing", FileText],
            ["code", "Fix code", Code2],
          ].map(([key, label, Icon]) => (
            <button key={key}
                    onClick={() => (key === "code" ? openCode() : setView(key))}
                    className={cn("w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-sm transition-colors",
                      view === key ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/50")}>
              <Icon size={14} className="shrink-0" />
              <span className="flex-1 text-left">{label}</span>
              {key === "pages" && pagesData?.pages?.length > 0 && (
                <span className="text-[10px] font-mono text-muted-foreground">
                  {pagesData.pages.length}
                </span>
              )}
              <ChevronRight size={12} className="opacity-40" />
            </button>
          ))}

          <p className="text-[10px] uppercase tracking-wide text-muted-foreground px-2.5 pt-3 pb-1">
            SEO areas {cats.length ? `(${cats.length})` : ""}
          </p>

          {cats.length === 0 && (
            <p className="text-xs text-muted-foreground px-2.5 py-2">
              Run an audit to populate every area.
            </p>
          )}

          <div className="space-y-0.5 max-h-[520px] overflow-y-auto pr-1">
            {cats.map((c) => {
              const Icon = CATEGORY_ICONS[c.key] || Braces;
              return (
                <button key={c.key} onClick={() => openCategory(c.key)}
                        className={cn("w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs transition-colors",
                          view === c.key ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/50")}>
                  <Icon size={13} className="shrink-0 opacity-70" />
                  <span className="flex-1 text-left truncate">{c.label}</span>
                  {c.failing > 0 && (
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" title={`${c.failing} failing`} />
                  )}
                  <Badge className={cn("text-[9px] font-mono px-1 py-0 shrink-0", scoreChip(c.score))}>
                    {c.score ?? "—"}
                  </Badge>
                </button>
              );
            })}
          </div>

          <button onClick={() => openCategory("reporting")}
                  className={cn("w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs transition-colors mt-1",
                    view === "reporting" ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/50")}>
            <ClipboardCheck size={13} className="shrink-0 opacity-70" />
            <span className="flex-1 text-left">SEO audit &amp; reporting</span>
            <Badge className={cn("text-[9px] font-mono px-1 py-0", scoreChip(summary?.overall_score))}>
              {summary?.overall_score ?? "—"}
            </Badge>
          </button>
        </nav>

        <div className="flex-1 min-w-0">
          {loading && !summary ? (
            <Card><CardContent className="py-16 text-center">
              <Loader2 size={20} className="animate-spin mx-auto text-muted-foreground" />
            </CardContent></Card>
          ) : view === "overview" ? (
            <OverviewPanel summary={summary} report={report} history={history}
                           onOpenCategory={openCategory} onExport={handleExport} />
          ) : view === "pages" ? (
            <PagesEditor pagesData={pagesData} loading={loading}
                         onSaveMeta={handleSaveMeta} onClearMeta={handleClearMeta}
                         onSaveKeyword={handleSaveKeyword} onClearKeyword={handleClearKeyword}
                         onReload={loadPages} siteId={selectedSite}
                         platform={site?.platform} siteUrl={site?.url} />
          ) : view === "code" ? (
            <SnippetsPanel snippets={snippets?.snippets} note={snippets?.note}
                           platform={snippets?.platform} />
          ) : catLoading && !activeCategory ? (
            <Card><CardContent className="py-16 text-center">
              <Loader2 size={20} className="animate-spin mx-auto text-muted-foreground" />
            </CardContent></Card>
          ) : activeCategory ? (
            <CategoryPanel category={activeCategory} />
          ) : (
            <Card><CardContent className="py-16 text-center">
              <Gauge size={30} className="mx-auto mb-2 text-muted-foreground opacity-40" />
              <p className="text-sm text-muted-foreground">
                {summary?.message || "Run an audit to see this section."}
              </p>
            </CardContent></Card>
          )}
        </div>
      </div>
    </motion.div>
  );
}
