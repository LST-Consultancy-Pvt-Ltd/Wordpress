import { useState, useEffect, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Search, TrendingUp, Eye, MousePointer,
  Loader2, AlertCircle, Sparkles, RefreshCw, CheckCircle2, XCircle,
  BarChart3, Globe, Link2, ArrowRight, Trophy, Gauge, Zap, Clock, Activity,
  Plus, Trash2, ExternalLink, PencilLine, FileCode, GitPullRequest,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Progress } from "../components/ui/progress";
import { Checkbox } from "../components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from "../components/ui/dialog";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "../components/ui/accordion";
import {
  getSites, getSEOMetrics, selfHealSEO, refreshSEOFromGoogle, bulkSEOAudit,
  analyzeCompetitor, getCompetitorAnalyses,
  analyzePageSpeed, getPageSpeedResults,
  getRankTrackerData, saveTrackedKeywords, getTrackedKeywords,
  fullPageSEOAudit, submitSitemapToGSC, setPageMeta,
  listItems, apiErrorMessage,
} from "../lib/api";
import { extractChangeSet, notifyChangeSetCreated } from "../lib/changesets";
import { writeBlockedReason } from "../lib/capabilities";
import GatedButton from "../components/sa/GatedButton";
import SSEProgressDrawer, { useSSETask } from "../components/SSEProgressDrawer";
import ImpactBadge from "../components/ImpactBadge";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { toast } from "sonner";

const DEFAULT_APPROVED = ["meta_title", "meta_description", "og_title", "og_description"];

/** Route path ("/blog/post") of an absolute or relative URL. */
function routeOf(url) {
  if (!url) return "/";
  try {
    return new URL(url, "http://placeholder.local").pathname || "/";
  } catch {
    return "/";
  }
}

/** Metadata editor for one route of a site. */
function metadataEditorUrl(siteId, pageUrl) {
  return `/sites/${siteId}/content?tab=metadata&route=${encodeURIComponent(routeOf(pageUrl))}`;
}

const ScoreIndicator = ({ score, label }) => {
  const getColor = () => {
    if (score >= 80) return "text-emerald-500";
    if (score >= 60) return "text-yellow-500";
    return "text-red-500";
  };
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className={`font-medium ${getColor()}`}>{score}/100</span>
      </div>
      <Progress value={score} className="h-1.5" />
    </div>
  );
};

export default function SEO() {
  const navigate = useNavigate();
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [metrics, setMetrics] = useState([]);
  const [loading, setLoading] = useState(false);
  const [healing, setHealing] = useState(false);
  const [bulkAuditing, setBulkAuditing] = useState(false);
  const { tasks, startTask, dismissTask } = useSSETask();

  // Competitor Analysis state
  const [competitorKeyword, setCompetitorKeyword] = useState("");
  const [analyzingCompetitor, setAnalyzingCompetitor] = useState(false);
  const [competitorResults, setCompetitorResults] = useState([]);
  const [loadingCompetitor, setLoadingCompetitor] = useState(false);

  // PageSpeed state
  const [psUrl, setPsUrl] = useState("");
  const [analyzingPs, setAnalyzingPs] = useState(false);
  const [psResults, setPsResults] = useState([]);
  const [loadingPs, setLoadingPs] = useState(false);
  const [psLatest, setPsLatest] = useState(null);

  // Self-Heal result state
  const [healResult, setHealResult] = useState(null);
  const [healImpact, setHealImpact] = useState(null);
  const [healDialogOpen, setHealDialogOpen] = useState(false);

  // Rank Tracker state
  const [rankSeries, setRankSeries] = useState([]);
  const [loadingRank, setLoadingRank] = useState(false);
  const [trackedKeywords, setTrackedKeywords] = useState([]);
  const [newKeyword, setNewKeyword] = useState("");
  const [savingKeywords, setSavingKeywords] = useState(false);

  // Full Page SEO state
  const [fpDialogOpen, setFpDialogOpen] = useState(false);
  const [fpStep, setFpStep] = useState(1);
  const [fpPageUrl, setFpPageUrl] = useState("");
  const [fpAudit, setFpAudit] = useState(null);
  const [fpApproved, setFpApproved] = useState(new Set(DEFAULT_APPROVED));
  const [fpCreating, setFpCreating] = useState(false);
  const [fpStatusMsg, setFpStatusMsg] = useState("Fetching page content...");
  const [fpProgress, setFpProgress] = useState(0);
  const [fpSearch, setFpSearch] = useState("");
  const [fpSitemapUrl, setFpSitemapUrl] = useState("");
  const [fpSubmittingSitemap, setFpSubmittingSitemap] = useState(false);

  const site = sites.find((s) => s.id === selectedSite) || null;
  const baseUrl = (site?.base_url || "").replace(/\/+$/, "");
  const defaultSitemapUrl = baseUrl ? `${baseUrl}/sitemap.xml` : "";
  const metadataBlocked = writeBlockedReason(site, "metadata.write");

  useEffect(() => {
    getSites()
      .then((r) => {
        const list = listItems(r.data);
        setSites(list);
        if (list.length > 0) setSelectedSite(list[0].id);
      })
      .catch(() => toast.error("Failed to load sites"));
  }, []);

  const loadMetrics = useCallback(async () => {
    if (!selectedSite) return;
    setLoading(true);
    try {
      const r = await getSEOMetrics(selectedSite);
      setMetrics(listItems(r.data));
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [selectedSite]);

  const loadCompetitorResults = useCallback(async () => {
    if (!selectedSite) return;
    setLoadingCompetitor(true);
    try {
      const r = await getCompetitorAnalyses(selectedSite);
      setCompetitorResults(listItems(r.data));
    } catch { /* ignore */ }
    finally { setLoadingCompetitor(false); }
  }, [selectedSite]);

  const loadPageSpeedResults = useCallback(async () => {
    if (!selectedSite) return;
    setLoadingPs(true);
    try {
      const r = await getPageSpeedResults(selectedSite);
      const list = listItems(r.data);
      setPsResults(list);
      setPsLatest(list[0] || null);
    } catch { /* ignore */ }
    finally { setLoadingPs(false); }
  }, [selectedSite]);

  const loadTrackedKeywords = useCallback(async () => {
    if (!selectedSite) return;
    try {
      const r = await getTrackedKeywords(selectedSite);
      setTrackedKeywords(r.data?.keywords || []);
    } catch { setTrackedKeywords([]); }
  }, [selectedSite]);

  useEffect(() => {
    setRankSeries([]);
    loadMetrics();
    loadCompetitorResults();
    loadPageSpeedResults();
    loadTrackedKeywords();
  }, [loadMetrics, loadCompetitorResults, loadPageSpeedResults, loadTrackedKeywords]);

  // Prefill PageSpeed URL from the selected site's public URL
  useEffect(() => {
    setPsUrl(site?.base_url || "");
  }, [site?.base_url]);

  const handleSelfHeal = async () => {
    setHealing(true);
    try {
      const r = await selfHealSEO(selectedSite);
      const { pages_checked, actions_taken } = r.data || {};
      setHealResult({ pages_checked, actions_taken: actions_taken || [] });
      setHealImpact(r.data?.impact_estimate || null);
      setHealDialogOpen(true);
      loadMetrics();
    } catch (err) { toast.error(apiErrorMessage(err, "Self-heal check failed")); }
    finally { setHealing(false); }
  };

  const handleRefreshGoogle = async () => {
    try {
      const r = await refreshSEOFromGoogle(selectedSite);
      startTask(r.data.task_id, "Refreshing from Google");
      toast.info("Pulling live data from Google...");
    } catch (err) {
      toast.error(apiErrorMessage(err, "Google refresh failed — check credentials in Settings"));
    }
  };

  const handleBulkAudit = async () => {
    const siteIds = sites.map((s) => s.id);
    if (!siteIds.length) { toast.warning("No sites to audit"); return; }
    setBulkAuditing(true);
    try {
      const r = await bulkSEOAudit(siteIds);
      startTask(r.data.task_id, "Bulk SEO Audit");
      setTimeout(() => loadMetrics(), 4000);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Bulk audit failed"));
    } finally {
      setBulkAuditing(false);
    }
  };

  const handleAnalyzeCompetitor = async (e) => {
    e.preventDefault();
    if (!competitorKeyword.trim()) return;
    setAnalyzingCompetitor(true);
    try {
      const r = await analyzeCompetitor(selectedSite, { keyword: competitorKeyword });
      setCompetitorResults((prev) => [r.data, ...prev]);
      toast.success("Competitor analysis complete!");
    } catch (err) {
      toast.error(apiErrorMessage(err, "Analysis failed"));
    } finally { setAnalyzingCompetitor(false); }
  };

  const handleAnalyzePageSpeed = async (e) => {
    e.preventDefault();
    if (!psUrl.trim()) return;
    setAnalyzingPs(true);
    try {
      const r = await analyzePageSpeed(selectedSite, { url: psUrl });
      setPsLatest(r.data);
      setPsResults((prev) => [r.data, ...prev]);
      if (r.data?.psi_warning) {
        toast.warning(r.data.psi_warning);
      } else {
        toast.success("PageSpeed analysis complete!");
      }
    } catch (err) {
      const detail = apiErrorMessage(err, "PageSpeed analysis failed");
      if (detail.includes("rate limit") || detail.includes("429")) {
        toast.error("Google PageSpeed API rate limit hit. Add a free API key in Settings → API Configuration.");
      } else {
        toast.error(detail);
      }
    } finally { setAnalyzingPs(false); }
  };

  const loadRankData = async () => {
    setLoadingRank(true);
    try {
      const r = await getRankTrackerData(selectedSite, trackedKeywords);
      setRankSeries(r.data?.series || []);
    } catch { /* ignore */ }
    finally { setLoadingRank(false); }
  };

  const handleSaveKeywords = async () => {
    setSavingKeywords(true);
    try {
      await saveTrackedKeywords(selectedSite, { keywords: trackedKeywords });
      toast.success("Keywords saved");
      loadRankData();
    } catch (err) { toast.error(apiErrorMessage(err, "Failed to save keywords")); }
    finally { setSavingKeywords(false); }
  };

  const addKeyword = () => {
    const kw = newKeyword.trim();
    if (!kw || trackedKeywords.includes(kw)) return;
    setTrackedKeywords((prev) => [...prev, kw]);
    setNewKeyword("");
  };

  // ── Full Page SEO handlers ──
  const resetFullPage = () => {
    setFpStep(1);
    setFpAudit(null);
    setFpPageUrl("");
    setFpSearch("");
  };

  const handleFullPageAudit = async () => {
    const url = fpPageUrl.trim();
    if (!url) return;
    setFpStep(2);
    setFpProgress(0);
    const stages = [
      { msg: "Fetching page content...", pct: 15 },
      { msg: "Auditing keywords...", pct: 35 },
      { msg: "Generating schema...", pct: 55 },
      { msg: "Analyzing off-page signals...", pct: 75 },
      { msg: "Building action plan...", pct: 90 },
    ];
    setFpStatusMsg(stages[0].msg);
    setFpProgress(stages[0].pct);
    let stageIdx = 0;
    const interval = setInterval(() => {
      stageIdx = Math.min(stageIdx + 1, stages.length - 1);
      setFpStatusMsg(stages[stageIdx].msg);
      setFpProgress(stages[stageIdx].pct);
    }, 2500);
    try {
      const r = await fullPageSEOAudit(selectedSite, { url, route: routeOf(url) });
      clearInterval(interval);
      setFpProgress(100);
      setFpStatusMsg("Audit complete!");
      setFpAudit(r.data);
      setFpApproved(new Set(DEFAULT_APPROVED));
      setTimeout(() => setFpStep(3), 500);
    } catch (err) {
      clearInterval(interval);
      toast.error(apiErrorMessage(err, "Full SEO audit failed"));
      setFpStep(1);
    }
  };

  const handleSubmitSitemap = async () => {
    const url = fpSitemapUrl.trim() || defaultSitemapUrl;
    if (!url) return;
    setFpSubmittingSitemap(true);
    try {
      await submitSitemapToGSC(selectedSite, { sitemap_url: url });
      toast.success("Sitemap submitted to Google Search Console");
    } catch (err) {
      toast.error(apiErrorMessage(err, "Sitemap submission failed — check Search Console credentials in Settings"));
    } finally {
      setFpSubmittingSitemap(false);
    }
  };

  /** Propose the approved metadata suggestions as one metadata change set. */
  const handleCreateMetaChangeSet = async () => {
    if (!fpAudit || !fpPageUrl) return;
    const data = { path: routeOf(fpPageUrl) };
    if (fpApproved.has("meta_title") && fpAudit.meta_title?.after) data.title = fpAudit.meta_title.after;
    if (fpApproved.has("meta_description") && fpAudit.meta_description?.after) data.description = fpAudit.meta_description.after;
    if (fpApproved.has("og_title") && fpAudit.og_title?.after) data.ogTitle = fpAudit.og_title.after;
    if (fpApproved.has("og_description") && fpAudit.og_description?.after) data.ogDescription = fpAudit.og_description.after;
    if (Object.keys(data).length === 1) {
      toast.warning("None of the approved fields has a suggested value.");
      return;
    }
    setFpCreating(true);
    try {
      const r = await setPageMeta(selectedSite, data);
      notifyChangeSetCreated(extractChangeSet(r.data), navigate, {
        title: "Change set created → review in Change Sets",
      });
      setFpDialogOpen(false);
      resetFullPage();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to create change set"));
    } finally {
      setFpCreating(false);
    }
  };

  const fpApprovedCount = [...fpApproved].filter((k) => k !== "schema_markup").length;
  const fpPageOptions = [...new Set(metrics.map((m) => m.page_url).filter(Boolean))]
    .filter((u) => !fpSearch || u.toLowerCase().includes(fpSearch.toLowerCase()));

  const avgImpressions = metrics.length
    ? Math.round(metrics.reduce((s, m) => s + (m.impressions || 0), 0) / metrics.length)
    : 0;
  const avgCTR = metrics.length
    ? (metrics.reduce((s, m) => s + (m.ctr || 0), 0) / metrics.length).toFixed(2)
    : "0.00";
  const avgClicks = metrics.length
    ? Math.round(metrics.reduce((s, m) => s + (m.clicks || 0), 0) / metrics.length)
    : 0;

  return (
    <div className="page-container" data-testid="seo-page">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
            SEO Dashboard
          </motion.h1>
          <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
            Live metrics from Google + AI-powered optimization. Suggested edits become change sets for review.
          </motion.p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[200px]" data-testid="site-select" aria-label="Site">
            <SelectValue placeholder="Select a site" />
          </SelectTrigger>
          <SelectContent>
            {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {!selectedSite ? (
        <Card className="content-card">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <AlertCircle size={48} className="text-muted-foreground/30 mb-4" />
            <p className="text-muted-foreground">Please select a site to view SEO data</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <Tabs defaultValue="metrics">
            <TabsList className="mb-4">
              <TabsTrigger value="metrics"><BarChart3 size={14} className="mr-1.5" />SEO Metrics</TabsTrigger>
              <TabsTrigger value="competitor" data-testid="competitor-tab"><Trophy size={14} className="mr-1.5" />Competitor Analysis</TabsTrigger>
              <TabsTrigger value="performance" data-testid="performance-tab"><Gauge size={14} className="mr-1.5" />Performance</TabsTrigger>
              <TabsTrigger value="rankings"><TrendingUp size={14} className="mr-1.5" />Rankings</TabsTrigger>
            </TabsList>

            {/* ── SEO METRICS TAB ── */}
            <TabsContent value="metrics" className="space-y-6">
          {/* Action Bar */}
          <Card className="content-card">
            <CardContent className="p-4">
              <div className="flex flex-wrap gap-3">
                <GatedButton minRole="editor" className="btn-primary" onClick={handleRefreshGoogle}>
                  <RefreshCw size={14} className="mr-2" />
                  Refresh from Google
                </GatedButton>
                {/* ── FULL PAGE SEO OPTIMIZER ── */}
                <Dialog
                  open={fpDialogOpen}
                  onOpenChange={(o) => {
                    setFpDialogOpen(o);
                    if (!o) resetFullPage();
                  }}
                >
                  <DialogTrigger asChild>
                    <GatedButton minRole="editor" variant="outline" data-testid="analyze-seo-btn">
                      <Sparkles size={14} className="mr-2" />
                      Full Page SEO
                    </GatedButton>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-[860px] max-h-[90vh] overflow-y-auto">

                    {/* STEP 1 — Page Selector */}
                    {fpStep === 1 && (
                      <>
                        <DialogHeader>
                          <DialogTitle className="flex items-center gap-2">
                            <Sparkles size={16} className="text-primary" />
                            Full Page SEO Optimizer
                          </DialogTitle>
                          <DialogDescription>
                            Enter or pick a page URL to run a deep AI audit with before/after suggestions for every SEO element.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-3 py-4">
                          <Input
                            aria-label="Page URL to audit"
                            placeholder={baseUrl ? `${baseUrl}/about` : "https://example.com/about"}
                            value={fpPageUrl}
                            onChange={(e) => setFpPageUrl(e.target.value)}
                          />
                          {metrics.length > 0 && (
                            <>
                              <Input
                                aria-label="Filter tracked pages"
                                placeholder="Filter tracked pages..."
                                value={fpSearch}
                                onChange={(e) => setFpSearch(e.target.value)}
                              />
                              <ScrollArea className="h-[300px]">
                                <div className="space-y-1.5 pr-2" role="listbox" aria-label="Tracked pages">
                                  {fpPageOptions.map((u) => {
                                    const isSelected = fpPageUrl === u;
                                    return (
                                      <button
                                        type="button"
                                        key={u}
                                        role="option"
                                        aria-selected={isSelected}
                                        className={`w-full text-left p-3 rounded-lg border transition-all ${
                                          isSelected
                                            ? "border-primary bg-primary/5"
                                            : "border-border hover:border-primary/40 hover:bg-muted/30"
                                        }`}
                                        onClick={() => setFpPageUrl(u)}
                                      >
                                        <p className="text-sm font-medium truncate">{routeOf(u)}</p>
                                        <p className="text-xs text-muted-foreground truncate mt-0.5">{u}</p>
                                      </button>
                                    );
                                  })}
                                  {fpPageOptions.length === 0 && (
                                    <p className="text-center py-6 text-sm text-muted-foreground">No tracked pages match.</p>
                                  )}
                                </div>
                              </ScrollArea>
                            </>
                          )}
                        </div>
                        <DialogFooter>
                          <Button variant="outline" onClick={() => setFpDialogOpen(false)}>Cancel</Button>
                          <GatedButton minRole="editor" onClick={handleFullPageAudit} disabled={!fpPageUrl.trim()}>
                            <Sparkles size={14} className="mr-2" />
                            Run Full SEO Audit
                          </GatedButton>
                        </DialogFooter>
                      </>
                    )}

                    {/* STEP 2 — Loading */}
                    {fpStep === 2 && (
                      <>
                        <DialogHeader>
                          <DialogTitle className="flex items-center gap-2">
                            <Loader2 size={16} className="text-primary animate-spin" />
                            Running Full SEO Audit
                          </DialogTitle>
                          <DialogDescription>
                            Analyzing: {fpPageUrl}
                          </DialogDescription>
                        </DialogHeader>
                        <div className="py-10 space-y-6" role="status" aria-live="polite">
                          <div className="space-y-2">
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">{fpStatusMsg}</span>
                              <span className="font-medium">{fpProgress}%</span>
                            </div>
                            <Progress value={fpProgress} className="h-2" />
                          </div>
                          <div className="space-y-2.5">
                            {[
                              "Fetching page content",
                              "Auditing keywords",
                              "Generating schema",
                              "Building action plan",
                            ].map((stage, i) => (
                              <div key={i} className="flex items-center gap-2.5 text-sm">
                                {fpProgress >= (i + 1) * 25 ? (
                                  <CheckCircle2 size={14} className="text-emerald-500 flex-shrink-0" />
                                ) : fpProgress >= i * 25 ? (
                                  <Loader2 size={14} className="text-primary animate-spin flex-shrink-0" />
                                ) : (
                                  <div className="w-3.5 h-3.5 rounded-full border border-muted-foreground/30 flex-shrink-0" />
                                )}
                                <span className={fpProgress > i * 25 ? "text-foreground" : "text-muted-foreground"}>
                                  {stage}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}

                    {/* STEP 3 — Report */}
                    {fpStep === 3 && fpAudit && (
                      <>
                        <DialogHeader>
                          <DialogTitle className="flex items-center gap-2">
                            <CheckCircle2 size={16} className="text-emerald-500" />
                            SEO Audit Report
                          </DialogTitle>
                          <DialogDescription className="flex items-center gap-2 flex-wrap">
                            <span className="truncate">{routeOf(fpPageUrl)}</span>
                            {fpPageUrl && (
                              <a
                                href={fpPageUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline flex-shrink-0 font-medium"
                              >
                                <ExternalLink size={11} aria-hidden="true" />
                                View Live Page
                              </a>
                            )}
                          </DialogDescription>
                        </DialogHeader>

                        {/* Overall Score Strip */}
                        <div className="flex items-center gap-4 p-4 rounded-lg bg-muted/30 border my-3">
                          <div className="text-center min-w-[56px]">
                            <div
                              className={`text-4xl font-bold ${
                                fpAudit.overall_score >= 80
                                  ? "text-emerald-500"
                                  : fpAudit.overall_score >= 60
                                  ? "text-yellow-500"
                                  : "text-red-500"
                              }`}
                            >
                              {fpAudit.overall_score}
                            </div>
                            <p className="text-xs text-muted-foreground">SEO Score</p>
                          </div>
                          <div className="flex-1 space-y-1.5">
                            {fpAudit.score_breakdown &&
                              Object.entries(fpAudit.score_breakdown).map(([k, v]) => (
                                <ScoreIndicator key={k} label={k.replace(/_/g, " ")} score={Number(v)} />
                              ))}
                          </div>
                          <div className="text-right text-xs space-y-1.5 flex-shrink-0">
                            <div>
                              <span className="text-muted-foreground">Intent: </span>
                              <Badge variant="secondary" className="text-xs capitalize">{fpAudit.search_intent}</Badge>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Primary KW: </span>
                              <span className="font-medium text-primary">{fpAudit.primary_keyword}</span>
                            </div>
                          </div>
                        </div>

                        <Tabs defaultValue="onpage">
                          <TabsList className="w-full">
                            <TabsTrigger value="onpage" className="flex-1">On-Page</TabsTrigger>
                            <TabsTrigger value="technical" className="flex-1">Technical</TabsTrigger>
                            <TabsTrigger value="offpage" className="flex-1">Off-Page</TabsTrigger>
                            <TabsTrigger value="actionplan" className="flex-1">Action Plan</TabsTrigger>
                          </TabsList>

                          {/* ── ON-PAGE TAB ── */}
                          <TabsContent value="onpage" className="space-y-4 mt-4">
                            {/* Keywords */}
                            <div className="space-y-2">
                              <h4 className="text-sm font-semibold">Keywords</h4>
                              <div className="flex flex-wrap gap-1.5">
                                {fpAudit.secondary_keywords?.map((kw, i) => (
                                  <Badge key={i} variant="secondary" className="text-xs">{kw}</Badge>
                                ))}
                                {fpAudit.missing_keywords?.map((kw, i) => (
                                  <Badge key={i} variant="outline" className="text-xs text-red-500 border-red-300">
                                    {kw} (missing)
                                  </Badge>
                                ))}
                              </div>
                            </div>

                            {/* Before/After Change Cards */}
                            {[
                              { key: "meta_title",       label: "Meta Title",       field: fpAudit.meta_title },
                              { key: "meta_description", label: "Meta Description", field: fpAudit.meta_description },
                              { key: "og_title",         label: "OG Title",         field: fpAudit.og_title },
                              { key: "og_description",   label: "OG Description",   field: fpAudit.og_description },
                              { key: "schema_markup",    label: "Schema Markup",    field: fpAudit.schema_markup },
                            ].map(({ key, label, field }) =>
                              field ? (
                                <div
                                  key={key}
                                  className={`rounded-lg border p-4 space-y-3 transition-colors ${
                                    fpApproved.has(key) ? "border-primary/50 bg-primary/5" : "border-border"
                                  }`}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-2">
                                      <Checkbox
                                        id={`fp-approve-${key}`}
                                        disabled={key === "schema_markup"}
                                        checked={key !== "schema_markup" && fpApproved.has(key)}
                                        onCheckedChange={(checked) =>
                                          setFpApproved((prev) => {
                                            const next = new Set(prev);
                                            checked ? next.add(key) : next.delete(key);
                                            return next;
                                          })
                                        }
                                      />
                                      <label htmlFor={`fp-approve-${key}`} className="text-sm font-semibold">{label}</label>
                                    </div>
                                    {key === "schema_markup" && (
                                      <Link
                                        to={metadataEditorUrl(selectedSite, fpPageUrl)}
                                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                      >
                                        <PencilLine size={11} aria-hidden="true" />
                                        Edit JSON-LD in metadata editor
                                      </Link>
                                    )}
                                  </div>
                                  <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1">
                                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Before</p>
                                      <div className="p-2 rounded bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 text-xs font-mono break-all whitespace-pre-wrap">
                                        {field.before || "(empty)"}
                                      </div>
                                    </div>
                                    <div className="space-y-1">
                                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">After</p>
                                      <div className="p-2 rounded bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900 text-xs font-mono break-all whitespace-pre-wrap">
                                        {field.after || "(no change)"}
                                      </div>
                                    </div>
                                  </div>
                                  {field.reason && (
                                    <div className="flex gap-2 text-xs text-muted-foreground bg-muted/50 rounded p-2">
                                      <AlertCircle size={12} className="text-primary flex-shrink-0 mt-0.5" />
                                      {field.reason}
                                    </div>
                                  )}
                                </div>
                              ) : null
                            )}
                          </TabsContent>

                          {/* ── TECHNICAL TAB ── */}
                          <TabsContent value="technical" className="space-y-4 mt-4">
                            {fpAudit.technical_issues?.length > 0 && (
                              <div className="space-y-2">
                                <h4 className="text-sm font-semibold">Technical Issues</h4>
                                {fpAudit.technical_issues.map((issue, i) => (
                                  <div key={i} className="rounded-lg border p-3 space-y-1.5">
                                    <div className="flex items-center gap-2">
                                      <Badge
                                        variant={issue.priority === "high" ? "destructive" : issue.priority === "medium" ? "secondary" : "outline"}
                                        className="text-xs"
                                      >
                                        {issue.priority}
                                      </Badge>
                                      <span className="text-sm font-medium">{issue.issue}</span>
                                    </div>
                                    <p className="text-xs text-muted-foreground pl-1">{issue.fix}</p>
                                  </div>
                                ))}
                              </div>
                            )}
                            {fpAudit.heading_issues?.length > 0 && (
                              <div className="space-y-2">
                                <h4 className="text-sm font-semibold">Heading Structure</h4>
                                {fpAudit.heading_issues.map((h, i) => (
                                  <div key={i} className="rounded-lg border p-3 space-y-1">
                                    <p className="text-sm font-medium">{h.issue}</p>
                                    <p className="text-xs text-primary">{h.suggestion}</p>
                                  </div>
                                ))}
                              </div>
                            )}
                            {fpAudit.image_seo_issues?.length > 0 && (
                              <div className="space-y-2">
                                <h4 className="text-sm font-semibold">Image SEO</h4>
                                {fpAudit.image_seo_issues.map((img, i) => (
                                  <div key={i} className="rounded-lg border p-3 space-y-1">
                                    <p className="text-sm font-medium">{img.issue}</p>
                                    <p className="text-xs text-muted-foreground">{img.fix}</p>
                                  </div>
                                ))}
                              </div>
                            )}
                            {fpAudit.internal_link_opportunities?.length > 0 && (
                              <div className="space-y-2">
                                <h4 className="text-sm font-semibold">Internal Link Opportunities</h4>
                                {fpAudit.internal_link_opportunities.map((link, i) => (
                                  <div key={i} className="rounded-lg border p-3 space-y-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <Link2 size={12} className="text-primary flex-shrink-0" />
                                      <span className="text-sm font-medium">&ldquo;{link.anchor_text}&rdquo;</span>
                                      <ArrowRight size={12} className="text-muted-foreground" />
                                      <span className="text-sm text-muted-foreground truncate">{link.target_title}</span>
                                    </div>
                                    <p className="text-xs text-muted-foreground">{link.reason}</p>
                                  </div>
                                ))}
                              </div>
                            )}
                            {fpAudit.content_recommendations?.length > 0 && (
                              <div className="space-y-2">
                                <h4 className="text-sm font-semibold">Content Recommendations</h4>
                                {fpAudit.content_recommendations.map((rec, i) => (
                                  <div key={i} className="rounded-lg border p-3 flex items-start gap-2">
                                    <Badge
                                      variant={rec.priority === "high" ? "destructive" : rec.priority === "medium" ? "secondary" : "outline"}
                                      className="text-xs flex-shrink-0"
                                    >
                                      {rec.priority}
                                    </Badge>
                                    <p className="text-sm text-muted-foreground">{rec.recommendation}</p>
                                  </div>
                                ))}
                              </div>
                            )}
                          </TabsContent>

                          {/* ── OFF-PAGE TAB ── */}
                          <TabsContent value="offpage" className="space-y-4 mt-4">
                            {fpAudit.off_page_strategy?.backlink_opportunities?.length > 0 && (
                              <div className="space-y-2">
                                <h4 className="text-sm font-semibold">Backlink Opportunities</h4>
                                <ul className="space-y-1.5">
                                  {fpAudit.off_page_strategy.backlink_opportunities.map((opp, i) => (
                                    <li key={i} className="flex gap-2 text-sm text-muted-foreground">
                                      <CheckCircle2 size={14} className="text-primary flex-shrink-0 mt-0.5" />
                                      {opp}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {fpAudit.off_page_strategy?.guest_posting_sites?.length > 0 && (
                              <div className="space-y-2">
                                <h4 className="text-sm font-semibold">Guest Posting Sites</h4>
                                <div className="flex flex-wrap gap-1.5">
                                  {fpAudit.off_page_strategy.guest_posting_sites.map((site, i) => (
                                    <Badge key={i} variant="secondary" className="text-xs">{site}</Badge>
                                  ))}
                                </div>
                              </div>
                            )}
                            {fpAudit.off_page_strategy?.outreach_email_template && (
                              <div className="space-y-2">
                                <h4 className="text-sm font-semibold">Outreach Email Template</h4>
                                <div className="p-3 rounded-lg border bg-muted/30 text-xs font-mono whitespace-pre-wrap">
                                  {fpAudit.off_page_strategy.outreach_email_template}
                                </div>
                              </div>
                            )}
                            {fpAudit.off_page_strategy?.social_signal_ideas?.length > 0 && (
                              <div className="space-y-2">
                                <h4 className="text-sm font-semibold">Social Signal Ideas</h4>
                                <ul className="space-y-1.5">
                                  {fpAudit.off_page_strategy.social_signal_ideas.map((idea, i) => (
                                    <li key={i} className="flex gap-2 text-sm text-muted-foreground">
                                      <Zap size={14} className="text-yellow-500 flex-shrink-0 mt-0.5" />
                                      {idea}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </TabsContent>

                          {/* ── ACTION PLAN TAB ── */}
                          <TabsContent value="actionplan" className="space-y-3 mt-4">
                            {/* Sitemap Submission Card */}
                            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
                              <div className="flex items-center gap-2">
                                <Globe size={15} className="text-primary flex-shrink-0" />
                                <span className="text-sm font-semibold">Submit XML Sitemap to Google Search Console</span>
                                <Badge variant="secondary" className="text-xs ml-auto">Quick Win</Badge>
                              </div>
                              <p className="text-xs text-muted-foreground">
                                Submitting your sitemap helps Google discover and index your pages faster. Defaults to <code className="bg-muted px-1 rounded">/sitemap.xml</code> — change if your site uses a custom sitemap URL.
                              </p>
                              <div className="flex gap-2">
                                <Input
                                  className="h-8 text-xs"
                                  aria-label="Sitemap URL"
                                  placeholder={defaultSitemapUrl || "https://yoursite.com/sitemap.xml"}
                                  value={fpSitemapUrl}
                                  onChange={(e) => setFpSitemapUrl(e.target.value)}
                                  onFocus={() => {
                                    if (!fpSitemapUrl && defaultSitemapUrl) setFpSitemapUrl(defaultSitemapUrl);
                                  }}
                                />
                                <GatedButton
                                  minRole="editor"
                                  size="sm"
                                  className="h-8 text-xs flex-shrink-0"
                                  onClick={handleSubmitSitemap}
                                  disabled={fpSubmittingSitemap}
                                >
                                  {fpSubmittingSitemap ? (
                                    <Loader2 size={12} className="mr-1.5 animate-spin" />
                                  ) : (
                                    <ArrowRight size={12} className="mr-1.5" />
                                  )}
                                  Submit to GSC
                                </GatedButton>
                              </div>
                            </div>

                            {fpAudit.action_plan?.map((item, i) => (
                              <div key={i} className="rounded-lg border p-3 flex items-start gap-3">
                                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 text-xs font-bold text-primary">
                                  {item.priority ?? i + 1}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium">{item.task}</p>
                                </div>
                                <div className="flex items-center gap-1.5 flex-shrink-0">
                                  <Badge
                                    variant={item.type === "quick_win" ? "default" : "secondary"}
                                    className="text-xs"
                                  >
                                    {item.type === "quick_win" ? (
                                      <><Zap size={10} className="mr-1" />Quick Win</>
                                    ) : (
                                      <><Clock size={10} className="mr-1" />Long Term</>
                                    )}
                                  </Badge>
                                  <Badge
                                    variant={item.impact === "high" ? "destructive" : item.impact === "medium" ? "secondary" : "outline"}
                                    className="text-xs"
                                  >
                                    {item.impact}
                                  </Badge>
                                </div>
                              </div>
                            ))}
                          </TabsContent>
                        </Tabs>

                        <DialogFooter className="mt-4 gap-2 flex-wrap">
                          <Button variant="outline" onClick={() => { setFpStep(1); setFpAudit(null); }}>
                            ← Back
                          </Button>
                          <Button asChild variant="outline">
                            <Link to={metadataEditorUrl(selectedSite, fpPageUrl)}>
                              <PencilLine size={14} className="mr-2" aria-hidden="true" />
                              Edit metadata
                            </Link>
                          </Button>
                          <GatedButton
                            minRole="editor"
                            blocked={metadataBlocked}
                            onClick={handleCreateMetaChangeSet}
                            disabled={fpCreating || fpApprovedCount === 0}
                          >
                            {fpCreating ? (
                              <Loader2 size={14} className="mr-2 animate-spin" />
                            ) : (
                              <GitPullRequest size={14} className="mr-2" />
                            )}
                            Create change set ({fpApprovedCount})
                          </GatedButton>
                        </DialogFooter>
                      </>
                    )}
                  </DialogContent>
                </Dialog>
                <GatedButton minRole="editor" variant="outline" onClick={handleSelfHeal} disabled={healing}>
                  {healing ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Sparkles size={14} className="mr-2" />}
                  Self-Heal SEO
                </GatedButton>

                {/* Self-Heal Results Dialog */}
                <Dialog open={healDialogOpen} onOpenChange={setHealDialogOpen}>
                  <DialogContent className="sm:max-w-[620px]">
                    <DialogHeader>
                      <DialogTitle className="font-heading flex items-center gap-2">
                        <Sparkles size={16} className="text-primary" /> Self-Heal SEO Report
                      </DialogTitle>
                      <DialogDescription>
                        Scanned {healResult?.pages_checked ?? 0} pages for SEO issues.
                      </DialogDescription>
                    </DialogHeader>
                    {healResult?.actions_taken?.length === 0 ? (
                      <div className="flex flex-col items-center py-8 gap-3">
                        <CheckCircle2 size={40} className="text-emerald-500" />
                        <p className="font-medium text-lg">Everything looks healthy!</p>
                        <p className="text-muted-foreground text-sm text-center">No SEO issues were detected across {healResult.pages_checked} pages.</p>
                      </div>
                    ) : (
                      <ScrollArea className="max-h-[420px] pr-2">
                        <div className="space-y-2 py-2">
                          {healResult?.actions_taken?.map((item, i) => (
                            <div key={i} className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5">
                              <p className="text-xs text-muted-foreground truncate" title={item.page}>{item.page}</p>
                              <div className="flex items-start gap-2">
                                <AlertCircle size={14} className="text-amber-400 mt-0.5 flex-shrink-0" />
                                <span className="text-sm font-medium text-foreground">{item.issue}</span>
                              </div>
                              <div className="flex items-start gap-2">
                                <ArrowRight size={14} className="text-primary mt-0.5 flex-shrink-0" />
                                <span className="text-sm text-muted-foreground">{item.action}</span>
                              </div>
                              {item.page && (
                                <Link
                                  to={metadataEditorUrl(selectedSite, item.page)}
                                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                >
                                  <PencilLine size={11} aria-hidden="true" />
                                  Edit metadata
                                </Link>
                              )}
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    )}
                    <DialogFooter>
                      <ImpactBadge impact={healImpact} className="w-full" />
                      <Button onClick={() => setHealDialogOpen(false)}>Close</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                <GatedButton minRole="editor" variant="outline" onClick={handleBulkAudit} disabled={bulkAuditing}>
                  {bulkAuditing ? <Loader2 size={14} className="mr-2 animate-spin" /> : <BarChart3 size={14} className="mr-2" />}
                  Bulk Audit All Sites
                </GatedButton>
                <Button variant="outline" onClick={loadMetrics}>
                  <RefreshCw size={14} className="mr-2" />
                  Reload
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Summary Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: "Tracked Pages", value: metrics.length, icon: Globe, suffix: "" },
              { label: "Avg Impressions", value: avgImpressions.toLocaleString(), icon: Eye, suffix: "" },
              { label: "Avg Clicks", value: avgClicks.toLocaleString(), icon: MousePointer, suffix: "" },
              { label: "Avg CTR", value: avgCTR, icon: TrendingUp, suffix: "%" },
            ].map((stat, i) => (
              <motion.div key={stat.label} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
                <Card className="stat-card">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="stat-value">{stat.value}{stat.suffix}</p>
                      <p className="stat-label">{stat.label}</p>
                    </div>
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                      <stat.icon size={20} className="text-primary" />
                    </div>
                  </div>
                </Card>
              </motion.div>
            ))}
          </div>

          {/* Metrics Table */}
          <Card className="content-card">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="font-heading">Keyword Rankings & Metrics</CardTitle>
              <div className="flex items-center gap-2">
                {metrics.some((m) => m.source === "google") && (
                  <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-xs">
                    Live Google Data
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">{metrics.length} rows</span>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-primary" /></div>
              ) : metrics.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <BarChart3 size={40} className="text-muted-foreground/20 mb-3" />
                  <p className="text-muted-foreground">No SEO data yet.</p>
                  <p className="text-xs text-muted-foreground mt-1">Click "Refresh from Google" to pull live data.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/30 text-muted-foreground text-xs">
                        <th className="p-3 text-left">Page / Keyword</th>
                        <th className="p-3 text-right">Impressions</th>
                        <th className="p-3 text-right">Clicks</th>
                        <th className="p-3 text-right">CTR</th>
                        <th className="p-3 text-right">Position</th>
                        <th className="p-3 text-center">Source</th>
                        <th className="p-3 text-right"><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.map((m) => (
                        <tr key={m.id} className="border-b border-border/20 hover:bg-muted/10 transition-colors">
                          <td className="p-3">
                            <div className="text-xs font-medium truncate max-w-[200px]">{m.page_url || "—"}</div>
                            {m.keyword && <div className="text-xs text-muted-foreground mt-0.5">{m.keyword}</div>}
                          </td>
                          <td className="p-3 text-right">{(m.impressions || 0).toLocaleString()}</td>
                          <td className="p-3 text-right">{(m.clicks || 0).toLocaleString()}</td>
                          <td className="p-3 text-right">
                            <span className={`font-medium ${(m.ctr || 0) >= 5 ? "text-emerald-500" : (m.ctr || 0) >= 2 ? "text-yellow-500" : "text-red-500"}`}>
                              {(m.ctr || 0).toFixed(1)}%
                            </span>
                          </td>
                          <td className="p-3 text-right">
                            {m.ranking !== null && m.ranking !== undefined ? (
                              <span className={`font-medium ${m.ranking <= 10 ? "text-emerald-500" : m.ranking <= 20 ? "text-yellow-500" : "text-red-500"}`}>
                                #{typeof m.ranking === "number" ? Math.round(m.ranking) : m.ranking}
                              </span>
                            ) : "—"}
                          </td>
                          <td className="p-3 text-center">
                            <Badge variant="outline" className={`text-xs ${m.source === "google" ? "border-blue-500/30 text-blue-400" : ""}`}>
                              {m.source || "manual"}
                            </Badge>
                          </td>
                          <td className="p-3 text-right">
                            {m.page_url && (
                              <Link
                                to={metadataEditorUrl(selectedSite, m.page_url)}
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline whitespace-nowrap"
                              >
                                <PencilLine size={11} aria-hidden="true" />
                                Edit metadata
                              </Link>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
            </TabsContent>

            {/* ── COMPETITOR ANALYSIS TAB ── */}
            <TabsContent value="competitor" className="space-y-6">
              {/* Keyword input */}
              <Card className="content-card">
                <CardHeader>
                  <CardTitle className="font-heading flex items-center gap-2">
                    <Trophy size={18} className="text-primary" />
                    Competitor SEO Analysis
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleAnalyzeCompetitor} className="flex gap-3">
                    <Input
                      placeholder="Enter keyword to analyze (e.g. best project management software)"
                      aria-label="Keyword to analyze"
                      value={competitorKeyword}
                      onChange={(e) => setCompetitorKeyword(e.target.value)}
                      className="flex-1"
                      data-testid="competitor-keyword-input"
                    />
                    <GatedButton minRole="editor" type="submit" className="btn-primary" disabled={analyzingCompetitor || !competitorKeyword.trim()}>
                      {analyzingCompetitor
                        ? <Loader2 size={14} className="mr-2 animate-spin" />
                        : <Sparkles size={14} className="mr-2" />}
                      Analyze
                    </GatedButton>
                  </form>
                  <p className="text-xs text-muted-foreground mt-2">
                    Requires Google Custom Search API credentials in Settings. Without them, an AI analysis is still generated.
                  </p>
                </CardContent>
              </Card>

              {/* Results */}
              {loadingCompetitor ? (
                <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-primary" /></div>
              ) : competitorResults.length === 0 ? (
                <Card className="content-card">
                  <CardContent className="flex flex-col items-center justify-center py-12">
                    <Trophy size={40} className="text-muted-foreground/20 mb-3" />
                    <p className="text-muted-foreground text-sm">No analyses yet. Enter a keyword above.</p>
                  </CardContent>
                </Card>
              ) : (
                competitorResults.map((result) => (
                  <Card key={result.id} className="content-card">
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <CardTitle className="font-heading text-base flex items-center gap-2">
                          <Search size={15} className="text-primary" />
                          "{result.target_keyword}"
                        </CardTitle>
                        <div className="flex items-center gap-3 text-sm">
                          {result.our_position ? (
                            <Badge className={`${result.our_position <= 3 ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : result.our_position <= 10 ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" : "bg-red-500/15 text-red-400 border-red-500/30"} border`}>
                              Our position: #{result.our_position}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-muted-foreground">Not ranking</Badge>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {new Date(result.created_at).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {result.analysis_text && (
                        <div className="p-3 rounded-lg bg-muted/30 text-sm text-muted-foreground">
                          {result.analysis_text}
                        </div>
                      )}

                      {/* Competitors table */}
                      {result.competitors?.length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Top Results</p>
                          <div className="space-y-1.5">
                            {result.competitors.slice(0, 10).map((c) => (
                              <div key={c.url} className="flex items-start gap-3 p-2 rounded-md hover:bg-muted/20 transition-colors">
                                <span className={`text-xs font-mono w-5 text-center shrink-0 pt-0.5 ${c.estimated_position <= 3 ? "text-emerald-400" : "text-muted-foreground"}`}>
                                  {c.estimated_position}
                                </span>
                                <div className="min-w-0">
                                  <a href={c.url} target="_blank" rel="noopener noreferrer"
                                    className="text-sm font-medium hover:text-primary leading-tight line-clamp-1">
                                    {c.title}
                                  </a>
                                  <p className="text-xs text-muted-foreground truncate">{c.domain}</p>
                                  {c.meta_description && (
                                    <p className="text-xs text-muted-foreground/70 mt-0.5 line-clamp-2">{c.meta_description}</p>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Recommendations */}
                      {result.recommendations?.length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">AI Recommendations</p>
                          <ul className="space-y-2">
                            {result.recommendations.map((rec, i) => (
                              <li key={i} className="flex items-start gap-2 text-sm">
                                <CheckCircle2 size={14} className="text-primary shrink-0 mt-0.5" />
                                <span>{rec}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))
              )}
            </TabsContent>

            {/* ── PERFORMANCE TAB ── */}
            <TabsContent value="performance" className="space-y-6">
              {/* URL input */}
              <Card className="content-card">
                <CardHeader>
                  <CardTitle className="font-heading flex items-center gap-2">
                    <Gauge size={18} className="text-primary" />PageSpeed Insights
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleAnalyzePageSpeed} className="flex gap-3">
                    <Input
                      placeholder="https://example.com/"
                      aria-label="Page URL to analyze"
                      value={psUrl}
                      onChange={(e) => setPsUrl(e.target.value)}
                      className="flex-1"
                      data-testid="pagespeed-url-input"
                    />
                    <GatedButton minRole="editor" type="submit" className="btn-primary" disabled={analyzingPs || !psUrl.trim()} data-testid="pagespeed-analyze-btn">
                      {analyzingPs
                        ? <Loader2 size={14} className="mr-2 animate-spin" />
                        : <Zap size={14} className="mr-2" />}
                      Analyze
                    </GatedButton>
                  </form>
                  <p className="text-xs text-muted-foreground mt-2">
                    Uses Google PageSpeed Insights (mobile). Add <code className="text-primary">PAGESPEED_API_KEY</code> in Settings for higher rate limits.
                  </p>
                  {psLatest?.psi_warning && (
                    <div className="mt-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400 flex items-start gap-2">
                      <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
                      <span>{psLatest.psi_warning}</span>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Loading state */}
              {(analyzingPs || loadingPs) && !psLatest && (
                <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-primary" /></div>
              )}

              {/* Empty state */}
              {!analyzingPs && !loadingPs && !psLatest && (
                <Card className="content-card">
                  <CardContent className="flex flex-col items-center justify-center py-12">
                    <Gauge size={40} className="text-muted-foreground/20 mb-3" />
                    <p className="text-muted-foreground text-sm">No analyses yet. Enter a URL above to get started.</p>
                  </CardContent>
                </Card>
              )}

              {/* Result */}
              {psLatest && (() => {
                const score = psLatest.performance_score ?? 0;
                const scoreColor = score > 90
                  ? "text-emerald-500 stroke-emerald-500"
                  : score > 50
                  ? "text-yellow-500 stroke-yellow-500"
                  : "text-red-500 stroke-red-500";
                const scoreBg = score > 90
                  ? "bg-emerald-500/10 border-emerald-500/20"
                  : score > 50
                  ? "bg-yellow-500/10 border-yellow-500/20"
                  : "bg-red-500/10 border-red-500/20";

                // CWV pass/fail thresholds
                const cwvPass = (metric, val) => {
                  if (metric === "fcp")  return val <= 1800;
                  if (metric === "lcp")  return val <= 2500;
                  if (metric === "tbt")  return val <= 200;
                  if (metric === "cls")  return val <= 0.1;
                  return true;
                };

                return (
                  <div className="space-y-6">
                    {/* Score card */}
                    <Card className="content-card">
                      <CardContent className="p-6">
                        <div className="flex flex-col sm:flex-row items-center gap-6">
                          {/* Circular score */}
                          <div className={`relative flex items-center justify-center w-28 h-28 rounded-full border-4 shrink-0 ${scoreBg}`}>
                            <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 100 100">
                              <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeOpacity="0.1" strokeWidth="8" />
                              <circle
                                cx="50" cy="50" r="42" fill="none"
                                className={scoreColor}
                                strokeWidth="8"
                                strokeLinecap="round"
                                strokeDasharray={`${(score / 100) * 264} 264`}
                              />
                            </svg>
                            <div className="relative text-center">
                              <span className={`text-3xl font-bold ${scoreColor.split(" ")[0]}`}>{score}</span>
                              <p className="text-[10px] text-muted-foreground -mt-1">/ 100</p>
                            </div>
                          </div>
                          <div className="flex-1">
                            <p className="font-semibold text-sm mb-1 truncate">{psLatest.url}</p>
                            <p className="text-xs text-muted-foreground mb-3">
                              Analyzed {new Date(psLatest.fetched_at).toLocaleString()} · Mobile
                            </p>
                            <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium border ${scoreBg} ${scoreColor.split(" ")[0]}`}>
                              {score > 90 ? <CheckCircle2 size={13} /> : score > 50 ? <AlertCircle size={13} /> : <XCircle size={13} />}
                              {score > 90 ? "Good" : score > 50 ? "Needs Improvement" : "Poor"}
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    {/* Core Web Vitals */}
                    <Card className="content-card">
                      <CardHeader>
                        <CardTitle className="font-heading text-sm flex items-center gap-2">
                          <Activity size={16} className="text-primary" />Core Web Vitals
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          {[
                            { key: "fcp",  label: "FCP",  value: psLatest.fcp,  unit: "ms",  hint: "First Contentful Paint" },
                            { key: "lcp",  label: "LCP",  value: psLatest.lcp,  unit: "ms",  hint: "Largest Contentful Paint" },
                            { key: "tbt",  label: "TBT",  value: psLatest.tbt,  unit: "ms",  hint: "Total Blocking Time" },
                            { key: "cls",  label: "CLS",  value: psLatest.cls,  unit: "",    hint: "Cumulative Layout Shift" },
                          ].map(({ key, label, value, unit, hint }) => {
                            const pass = cwvPass(key, value);
                            return (
                              <div key={key} className="p-4 rounded-lg border bg-muted/20 space-y-2 text-center">
                                <p className="text-xs text-muted-foreground">{hint}</p>
                                <p className={`text-2xl font-bold ${pass ? "text-emerald-500" : "text-red-500"}`}>
                                  {key === "cls" ? Number(value || 0).toFixed(3) : Math.round(value || 0)}<span className="text-sm font-normal ml-0.5">{unit}</span>
                                </p>
                                <Badge className={pass
                                  ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20 border text-xs"
                                  : "bg-red-500/10 text-red-500 border-red-500/20 border text-xs"}>
                                  {pass ? "Pass" : "Fail"}
                                </Badge>
                                <p className="text-xs font-medium text-muted-foreground">{label}</p>
                              </div>
                            );
                          })}
                        </div>
                      </CardContent>
                    </Card>

                    {/* Opportunities */}
                    {psLatest.opportunities?.length > 0 && (
                      <Card className="content-card">
                        <CardHeader>
                          <CardTitle className="font-heading text-sm flex items-center gap-2">
                            <Clock size={16} className="text-primary" />Opportunities
                            <span className="text-xs text-muted-foreground font-normal ml-1">Estimated time savings</span>
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="p-0">
                          <Accordion type="single" collapsible className="px-4">
                            {psLatest.opportunities.map((opp, i) => (
                              <AccordionItem key={i} value={`opp-${i}`}>
                                <AccordionTrigger className="text-sm hover:no-underline py-3">
                                  <div className="flex items-center gap-3 text-left flex-1 mr-3">
                                    <span className="flex-1">{opp.title}</span>
                                    {opp.savings_ms > 0 && (
                                      <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20 border text-xs shrink-0">
                                        -{Math.round(opp.savings_ms)}ms
                                      </Badge>
                                    )}
                                  </div>
                                </AccordionTrigger>
                                <AccordionContent className="text-xs text-muted-foreground pb-3">
                                  {opp.description || "No additional details."}
                                </AccordionContent>
                              </AccordionItem>
                            ))}
                          </Accordion>
                        </CardContent>
                      </Card>
                    )}

                    {/* Diagnostics */}
                    {psLatest.diagnostics?.length > 0 && (
                      <Card className="content-card">
                        <CardHeader>
                          <CardTitle className="font-heading text-sm flex items-center gap-2">
                            <AlertCircle size={16} className="text-primary" />Diagnostics
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2">
                          {psLatest.diagnostics.map((d, i) => (
                            <div key={i} className="flex items-start gap-2 text-sm p-2 rounded-md bg-muted/20">
                              <XCircle size={14} className="text-orange-400 shrink-0 mt-0.5" />
                              <div>
                                <p className="font-medium">{d.title}</p>
                                {d.description && <p className="text-xs text-muted-foreground mt-0.5">{d.description}</p>}
                              </div>
                            </div>
                          ))}
                        </CardContent>
                      </Card>
                    )}

                    {/* AI Recommendations */}
                    {psLatest.ai_recommendations?.length > 0 && (
                      <Card className="content-card">
                        <CardHeader>
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <CardTitle className="font-heading text-sm flex items-center gap-2">
                              <Sparkles size={16} className="text-primary" />AI Recommendations
                            </CardTitle>
                            <Button asChild variant="outline" size="sm">
                              <Link to={`/sites/${selectedSite}/code`}>
                                <FileCode size={13} className="mr-1" aria-hidden="true" /> Implement in Code workspace
                              </Link>
                            </Button>
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          {psLatest.ai_recommendations.map((rec, i) => {
                            const priorityClass =
                              rec.priority === "high"
                                ? "bg-red-500/10 text-red-500 border-red-500/20 border"
                                : rec.priority === "low"
                                ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20 border"
                                : "bg-yellow-500/10 text-yellow-500 border-yellow-500/20 border";
                            return (
                              <div key={i} className="p-3 rounded-lg border bg-muted/10 space-y-2">
                                <div className="flex items-start justify-between gap-3">
                                  <p className="text-sm font-medium flex-1">{rec.recommendation}</p>
                                  <Badge className={`${priorityClass} text-xs shrink-0 capitalize`}>{rec.priority}</Badge>
                                </div>
                                {rec.implementation_steps?.length > 0 && (
                                  <ol className="space-y-1 ml-3">
                                    {rec.implementation_steps.map((step, si) => (
                                      <li key={si} className="text-xs text-muted-foreground flex items-start gap-1.5">
                                        <span className="text-primary font-mono shrink-0">{si + 1}.</span>
                                        {step}
                                      </li>
                                    ))}
                                  </ol>
                                )}
                              </div>
                            );
                          })}
                        </CardContent>
                      </Card>
                    )}

                    {/* History */}
                    {psResults.length > 1 && (
                      <Card className="content-card">
                        <CardHeader>
                          <CardTitle className="font-heading text-sm flex items-center gap-2">
                            <RefreshCw size={16} className="text-primary" />History
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="p-0">
                          <div className="divide-y divide-border/50">
                            {psResults.slice(0, 10).map((r, i) => {
                              const s = r.performance_score ?? 0;
                              const c = s > 90 ? "text-emerald-500" : s > 50 ? "text-yellow-500" : "text-red-500";
                              return (
                                <button
                                  type="button"
                                  key={r.id || i}
                                  className="w-full flex items-center justify-between px-4 py-2.5 text-sm hover:bg-muted/20 transition-colors text-left"
                                  onClick={() => setPsLatest(r)}
                                >
                                  <span className="text-muted-foreground text-xs truncate flex-1">{new Date(r.fetched_at).toLocaleString()}</span>
                                  <span className={`font-bold ml-3 ${c}`}>{s}</span>
                                </button>
                              );
                            })}
                          </div>
                        </CardContent>
                      </Card>
                    )}
                  </div>
                );
              })()}
              </TabsContent>

            {/* ── RANKINGS TAB ── */}
            <TabsContent value="rankings" className="space-y-4">
              <Card className="content-card">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <TrendingUp size={16} className="text-primary" />Keyword Rank Tracker
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Keyword input */}
                  <div className="flex gap-2">
                    <Input placeholder="Add keyword to track…" aria-label="Keyword to track" value={newKeyword}
                      onChange={(e) => setNewKeyword(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addKeyword(); } }} />
                    <Button variant="outline" size="sm" onClick={addKeyword} disabled={!newKeyword.trim()} aria-label="Add keyword">
                      <Plus size={14} />
                    </Button>
                    <GatedButton minRole="editor" size="sm" onClick={handleSaveKeywords} disabled={savingKeywords || !trackedKeywords.length}>
                      {savingKeywords ? <Loader2 size={13} className="animate-spin mr-1" /> : null}Save & Refresh
                    </GatedButton>
                  </div>
                  {trackedKeywords.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {trackedKeywords.map((kw) => (
                        <Badge key={kw} variant="secondary" className="gap-1">
                          {kw}
                          <button type="button" aria-label={`Remove ${kw}`} onClick={() => setTrackedKeywords((prev) => prev.filter((k) => k !== kw))} className="hover:text-destructive ml-0.5">
                            <Trash2 size={10} />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                  {/* Chart */}
                  {loadingRank ? (
                    <div className="flex justify-center py-10"><Loader2 size={24} className="animate-spin text-primary" /></div>
                  ) : rankSeries.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-10 text-center">
                      <TrendingUp size={36} className="text-muted-foreground/30 mb-3" />
                      <p className="text-muted-foreground text-sm">Add keywords and click "Save & Refresh" to track rankings over time.</p>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      {/* Average position chart */}
                      <div>
                        <p className="text-sm font-medium mb-3">Average Position (lower is better)</p>
                        <ResponsiveContainer width="100%" height={260}>
                          <LineChart data={(() => {
                            const allDates = [...new Set(rankSeries.flatMap((s) => s.data.map((d) => d.date)))].sort();
                            return allDates.map((date) => {
                              const pt = { date };
                              rankSeries.forEach((s) => {
                                const found = s.data.find((d) => d.date === date);
                                pt[s.keyword] = found?.avg_position ?? null;
                              });
                              return pt;
                            });
                          })()}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                            <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#94a3b8" }} />
                            <YAxis reversed tick={{ fontSize: 10, fill: "#94a3b8" }} />
                            <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8 }} />
                            <Legend />
                            {rankSeries.map((s, i) => (
                              <Line key={s.keyword} type="monotone" dataKey={s.keyword} stroke={["#818cf8","#34d399","#f59e0b","#f87171","#38bdf8"][i % 5]} strokeWidth={2} dot={false} connectNulls />
                            ))}
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

          </Tabs>
        </div>
      )}

      <SSEProgressDrawer tasks={tasks} dismissTask={dismissTask} />
    </div>
  );
}
