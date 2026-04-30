import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Search, TrendingUp, TrendingDown, Eye, MousePointer,
  Loader2, AlertCircle, Sparkles, RefreshCw, CheckCircle2, XCircle,
  BarChart3, Globe, Link2, ArrowRight, Trophy, Gauge, Zap, Clock, Activity,
  ImageIcon, Plus, Trash2, ExternalLink
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
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
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "../components/ui/table";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "../components/ui/accordion";
import { getSites, getSEOMetrics, analyzeSEO, selfHealSEO, refreshSEOFromGoogle, bulkSEOAudit,
  suggestInternalLinks, getInternalLinkSuggestions, applyInternalLink,
  analyzeCompetitor, getCompetitorAnalyses,
  analyzePageSpeed, getPageSpeedResults,
  getImageAudit, auditImages, generateAltText, generateAllAltTexts,
  getRankTrackerData, saveTrackedKeywords, getTrackedKeywords,
  triggerAutoSEOScan, getAutoSEOSuggestions, applyMetaTags, applyOGTags, applySchema, applyBulkSEO,
  downloadMetaFixerPlugin, downloadBridgePlugin, fullPageSEOAudit, submitSitemapToGSC,
} from "../lib/api";
import SSEProgressDrawer, { useSSETask } from "../components/SSEProgressDrawer";
import ImpactBadge from "../components/ImpactBadge";
import ManualApplySheet from "../components/ManualApplySheet";
import { useApplyMode } from "../hooks/useApplyMode";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { toast } from "sonner";

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
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [metrics, setMetrics] = useState([]);
  const [loading, setLoading] = useState(false);
  const [analyzeDialogOpen, setAnalyzeDialogOpen] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [healing, setHealing] = useState(false);
  const [pageUrl, setPageUrl] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [selectedRows, setSelectedRows] = useState([]);
  const { tasks, startTask, dismissTask } = useSSETask();

  // Apply Mode
  const { isManual } = useApplyMode();
  const [manualSheet, setManualSheet] = useState({ open: false, title: "", wpAdminUrl: "", fields: [], instructions: "" });
  const openManualSheet = (config) => setManualSheet({ open: true, ...config });
  const closeManualSheet = () => setManualSheet((prev) => ({ ...prev, open: false }));

  // Internal Links state
  const [linkSuggestions, setLinkSuggestions] = useState([]);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [finding, setFinding] = useState(false);
  const [applying, setApplying] = useState({});

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

  // Images / Alt Text state
  const [imageAudit, setImageAudit] = useState(null);
  const [loadingImages, setLoadingImages] = useState(false);
  const [generatingAlt, setGeneratingAlt] = useState({});
  const [generatingAllAlts, setGeneratingAllAlts] = useState(false);

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

  // Auto-SEO state
  const [autoSuggestions, setAutoSuggestions] = useState([]);
  const [autoLoading, setAutoLoading] = useState(false); // eslint-disable-line
  const [scanning, setScanning] = useState(false);
  const [autoTab, setAutoTab] = useState("meta");
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [autoApplying, setAutoApplying] = useState({});
  const [metaFixerDialogOpen, setMetaFixerDialogOpen] = useState(false);
  const [metaFixerWarning, setMetaFixerWarning] = useState("");
  const [downloadingPlugin, setDownloadingPlugin] = useState(false);
  const [downloadingBridge, setDownloadingBridge] = useState(false);

  // Full Page SEO state
  const [fpDialogOpen, setFpDialogOpen] = useState(false);
  const [fpStep, setFpStep] = useState(1);
  const [fpSelectedPage, setFpSelectedPage] = useState(null);
  const [fpAudit, setFpAudit] = useState(null);
  const [fpApproved, setFpApproved] = useState(new Set(["meta_title", "meta_description", "og_title", "og_description", "schema_markup"]));
  const [fpApplying, setFpApplying] = useState(false);
  const [fpStatusMsg, setFpStatusMsg] = useState("Fetching page content...");
  const [fpProgress, setFpProgress] = useState(0);
  const [fpSearch, setFpSearch] = useState("");
  const [fpSitemapUrl, setFpSitemapUrl] = useState("");
  const [fpSubmittingSitemap, setFpSubmittingSitemap] = useState(false);
  const [bulkReportOpen, setBulkReportOpen] = useState(false);
  const [bulkReporting, setBulkReporting] = useState(false);

  useEffect(() => { loadSites(); }, []);
  useEffect(() => { if (selectedSite) { loadMetrics(); loadLinkSuggestions(); loadCompetitorResults(); loadPageSpeedResults(); loadCachedImageAudit(); loadTrackedKeywords(); loadAutoSEOSuggestions(); } }, [selectedSite]); // eslint-disable-line

  // Prefill PageSpeed URL from selected site
  useEffect(() => {
    if (selectedSite && sites.length) {
      const s = sites.find((x) => x.id === selectedSite);
      if (s?.url && !psUrl) setPsUrl(s.url);
    }
  }, [selectedSite, sites]); // eslint-disable-line

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    } catch { toast.error("Failed to load sites"); }
  };

  const loadMetrics = async () => {
    setLoading(true);
    try {
      const r = await getSEOMetrics(selectedSite);
      setMetrics(r.data);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };

  const handleAnalyze = async (e) => {
    e.preventDefault();
    setAnalyzing(true);
    setAnalysis(null);
    try {
      const r = await analyzeSEO(selectedSite, pageUrl);
      setAnalysis(r.data);
      toast.success("Analysis complete!");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Analysis failed");
    } finally { setAnalyzing(false); }
  };

  const handleSelfHeal = async () => {
    setHealing(true);
    try {
      const r = await selfHealSEO(selectedSite);
      const { pages_checked, actions_taken } = r.data;
      setHealResult({ pages_checked, actions_taken });
      setHealImpact(r.data.impact_estimate || null);
      setHealDialogOpen(true);
      loadMetrics();
    } catch (err) { toast.error(err.response?.data?.detail || "Self-heal failed"); }
    finally { setHealing(false); }
  };

  const handleRefreshGoogle = async () => {
    try {
      const r = await refreshSEOFromGoogle(selectedSite);
      startTask(r.data.task_id, "Refreshing from Google");
      toast.info("Pulling live data from Google...");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Google refresh failed â€” check credentials in Settings");
    }
  };

  const handleBulkAudit = async () => {
    try {
      const siteIds = sites.map((s) => s.id);
      if (!siteIds.length) { toast.warning("No sites to audit"); return; }
      const r = await bulkSEOAudit(siteIds);
      startTask(r.data.task_id, "Bulk SEO Audit");
      setBulkReporting(true);
      setBulkReportOpen(true);
      try {
        const scanR = await triggerAutoSEOScan(selectedSite);
        setAutoSuggestions(scanR.data || []);
      } catch { /* scan errors shouldn't block the report dialog */ }
      setBulkReporting(false);
      setTimeout(() => loadMetrics(), 4000);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Bulk audit failed");
      setBulkReporting(false);
    }
  };

  // Internal Links handlers
  const loadLinkSuggestions = async () => {
    setLoadingLinks(true);
    try {
      const r = await getInternalLinkSuggestions(selectedSite);
      setLinkSuggestions(r.data || []);
    } catch { /* ignore */ }
    finally { setLoadingLinks(false); }
  };

  const handleFindLinks = async () => {
    setFinding(true);
    try {
      const r = await suggestInternalLinks(selectedSite);
      startTask(r.data.task_id, "Finding internal link opportunities");
      // Reload suggestions after a short delay to pick up results for small sites
      setTimeout(loadLinkSuggestions, 4000);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to start suggestion scan");
    } finally {
      setFinding(false);
    }
  };

  const handleApplyLink = async (suggestion) => {
    const siteData = sites.find((s) => s.id === selectedSite);
    const siteUrl = siteData?.url || "";
    if (isManual) {
      openManualSheet({
        title: "Apply Internal Link",
        wpAdminUrl: `${siteUrl}/wp-admin/post.php?post=${suggestion.source_wp_id || suggestion.id}&action=edit`,
        fields: [
          { label: "Anchor Text", value: suggestion.anchor_text, type: "text" },
          { label: "Target Post Title", value: suggestion.target_post_title, type: "text" },
          { label: "Target URL", value: suggestion.target_url || "", type: "url" },
          { label: "Source Post", value: suggestion.source_post_title || "", type: "text" },
        ],
        instructions: "In your WordPress editor, find the source post, locate the anchor text, and wrap it in a link pointing to the target URL.",
      });
      return;
    }
    setApplying((prev) => ({ ...prev, [suggestion.id]: true }));
    try {
      await applyInternalLink(selectedSite, suggestion.id);
      toast.success(`Applied: "${suggestion.anchor_text}" → ${suggestion.target_post_title}`);
      setLinkSuggestions((prev) =>
        prev.map((s) => s.id === suggestion.id ? { ...s, applied: true } : s)
      );
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to apply link");
    } finally {
      setApplying((prev) => ({ ...prev, [suggestion.id]: false }));
    }
  };

  const loadCompetitorResults = async () => {
    if (!selectedSite) return;
    setLoadingCompetitor(true);
    try {
      const r = await getCompetitorAnalyses(selectedSite);
      setCompetitorResults(r.data || []);
    } catch { /* ignore */ }
    finally { setLoadingCompetitor(false); }
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
      toast.error(err.response?.data?.detail || "Analysis failed");
    } finally { setAnalyzingCompetitor(false); }
  };

  const loadPageSpeedResults = async () => {
    if (!selectedSite) return;
    setLoadingPs(true);
    try {
      const r = await getPageSpeedResults(selectedSite);
      const list = r.data || [];
      setPsResults(list);
      if (list.length > 0) setPsLatest(list[0]);
    } catch { /* ignore */ }
    finally { setLoadingPs(false); }
  };

  const handleAnalyzePageSpeed = async (e) => {
    e.preventDefault();
    if (!psUrl.trim()) return;
    setAnalyzingPs(true);
    try {
      const r = await analyzePageSpeed(selectedSite, { url: psUrl });
      setPsLatest(r.data);
      setPsResults((prev) => [r.data, ...prev]);
      if (r.data.psi_warning) {
        toast.warning(r.data.psi_warning);
      } else {
        toast.success("PageSpeed analysis complete!");
      }
    } catch (err) {
      const detail = err.response?.data?.detail || "";
      if (detail.includes("rate limit") || detail.includes("429")) {
        toast.error("Google PageSpeed API rate limit hit. Add a free API key in Settings → API Configuration.");
      } else {
        toast.error(detail || "PageSpeed analysis failed");
      }
    } finally { setAnalyzingPs(false); }
  };

  const toggleRow = (id) => {
    setSelectedRows((prev) => prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]);
  };

  const loadImageAudit = async () => {
    if (!selectedSite) return;
    setLoadingImages(true);
    try {
      const r = await auditImages(selectedSite);
      setImageAudit(r.data);
    } catch { setImageAudit(null); }
    finally { setLoadingImages(false); }
  };

  const loadCachedImageAudit = async () => {
    if (!selectedSite) return;
    try {
      const r = await getImageAudit(selectedSite);
      setImageAudit(r.data);
    } catch { /* no cached audit yet, that's fine */ }
  };

  const handleGenerateSingleAlt = async (mediaId) => {
    const siteData = sites.find((s) => s.id === selectedSite);
    const siteUrl = siteData?.url || "";
    if (isManual) {
      // Still call API to get the generated alt text, but show it in the panel instead of applying
      setGeneratingAlt((prev) => ({ ...prev, [mediaId]: true }));
      try {
        const r = await generateAltText(selectedSite, mediaId);
        const img = imageAudit?.images?.find((i) => i.id === mediaId);
        openManualSheet({
          title: "Generate & Apply Single Alt Text",
          wpAdminUrl: `${siteUrl}/wp-admin/upload.php`,
          fields: [
            { label: "Image Filename", value: img?.filename || img?.title || `Media #${mediaId}`, type: "text" },
            { label: "Generated Alt Text", value: r.data.alt_text, type: "text" },
          ],
          instructions: "In Media Library, find this image and paste the alt text into the Alt Text field.",
        });
      } catch (err) {
        toast.error(err.response?.data?.detail || "Failed to generate alt text");
      } finally {
        setGeneratingAlt((prev) => ({ ...prev, [mediaId]: false }));
      }
      return;
    }
    setGeneratingAlt((prev) => ({ ...prev, [mediaId]: true }));
    try {
      const r = await generateAltText(selectedSite, mediaId);
      setImageAudit((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          images: prev.images.map((img) =>
            img.id === mediaId ? { ...img, alt_text: r.data.alt_text, missing_alt: false } : img
          ),
          missing_alt: prev.missing_alt - 1,
        };
      });
      toast.success("Alt text generated");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to generate alt text");
    } finally {
      setGeneratingAlt((prev) => ({ ...prev, [mediaId]: false }));
    }
  };

  const handleGenerateAllAlts = async () => {
    setGeneratingAllAlts(true);
    try {
      const r = await generateAllAltTexts(selectedSite);
      startTask(r.data.task_id, "Generating alt texts for all images");
      toast.info("Bulk alt text generation started…");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to start bulk generation");
    } finally { setGeneratingAllAlts(false); }
  };

  const loadTrackedKeywords = async () => {
    try {
      const r = await getTrackedKeywords(selectedSite);
      setTrackedKeywords(r.data?.keywords || []);
    } catch { /* ignore */ }
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
    } catch { toast.error("Failed to save keywords"); }
    finally { setSavingKeywords(false); }
  };

  const addKeyword = () => {
    const kw = newKeyword.trim();
    if (!kw || trackedKeywords.includes(kw)) return;
    setTrackedKeywords((prev) => [...prev, kw]);
    setNewKeyword("");
  };

  // ── Auto-SEO handlers ──
  const loadAutoSEOSuggestions = async () => {
    setAutoLoading(true);
    try {
      const r = await getAutoSEOSuggestions(selectedSite);
      setAutoSuggestions(r.data || []);
    } catch { /* ignore — no scan run yet */ }
    finally { setAutoLoading(false); }
  };

  const handleAutoScan = async () => {
    setScanning(true);
    try {
      const r = await triggerAutoSEOScan(selectedSite);
      setAutoSuggestions(r.data || []);
      toast.success(`Scan complete — ${(r.data || []).length} pages checked`);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Scan failed");
    } finally { setScanning(false); }
  };

  const handleApplyMeta = async (s) => {
    const siteData = sites.find((x) => x.id === selectedSite);
    const siteUrl = siteData?.url || "";
    if (isManual) {
      openManualSheet({
        title: "Apply Meta Tags (Auto SEO)",
        wpAdminUrl: `${siteUrl}/wp-admin/post.php?post=${s.wp_id}&action=edit`,
        fields: [
          { label: "Title Tag", value: s.ai_title || "", type: "text" },
          { label: "Meta Description", value: s.ai_desc || "", type: "text" },
          { label: "Content Type", value: s.content_type || "", type: "text" },
        ],
        instructions: "In the WordPress editor for this post/page, find the SEO plugin panel (Yoast/RankMath) and paste the title and meta description values.",
      });
      return;
    }
    setAutoApplying(prev => ({ ...prev, [s.wp_id]: true }));
    try {
      const res = await applyMetaTags(selectedSite, s.wp_id, {
        content_type: s.content_type, ai_title: s.ai_title, ai_desc: s.ai_desc,
      });
      setAutoSuggestions(prev => prev.map(x => x.wp_id === s.wp_id ? { ...x, status: "applied" } : x));
      if (res.data?.warning) {
        setMetaFixerWarning(res.data.warning);
        setMetaFixerDialogOpen(true);
        toast.warning("Meta fields not writable — see Fix instructions");
      } else {
        toast.success(`✓ Meta tags applied via ${(res.data?.updated_fields || []).join(", ") || "Yoast"}`);
      }
    } catch (err) {
      toast.error(err.response?.data?.detail || "Apply failed");
    } finally { setAutoApplying(prev => ({ ...prev, [s.wp_id]: false })); }
  };

  const handleDownloadMetaFixer = async () => {
    setDownloadingPlugin(true);
    try {
      const res = await downloadMetaFixerPlugin(selectedSite);
      const url = URL.createObjectURL(new Blob([res.data], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "lst-seo-meta-fixer.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error("Download failed");
    } finally { setDownloadingPlugin(false); }
  };

  const handleDownloadBridgePlugin = async () => {
    setDownloadingBridge(true);
    try {
      const res = await downloadBridgePlugin(selectedSite);
      const url = URL.createObjectURL(new Blob([res.data], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "wp-manager-bridge.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error("Bridge plugin download failed");
    } finally { setDownloadingBridge(false); }
  };

  const handleApplyOG = async (s) => {
    const siteData = sites.find((x) => x.id === selectedSite);
    const siteUrl = siteData?.url || "";
    const key = s.wp_id + "_og";
    if (isManual) {
      openManualSheet({
        title: "Apply OG Tags",
        wpAdminUrl: `${siteUrl}/wp-admin/post.php?post=${s.wp_id}&action=edit`,
        fields: [
          { label: "OG Title", value: s.og_title || "", type: "text" },
          { label: "OG Description", value: s.og_desc || "", type: "text" },
          { label: "OG Image URL", value: s.og_image || "", type: "url" },
          { label: "OG Type", value: s.og_type || "article", type: "text" },
        ],
        instructions: "In the WordPress editor for this post/page, find the SEO plugin panel (Yoast/RankMath) → Social tab and paste the OG values.",
      });
      return;
    }
    setAutoApplying(prev => ({ ...prev, [key]: true }));
    try {
      await applyOGTags(selectedSite, s.wp_id, {
        content_type: s.content_type,
        og_title: s.og_title, og_desc: s.og_desc,
        og_image: s.og_image, og_type: s.og_type,
      });
      setAutoSuggestions(prev => prev.map(x => x.wp_id === s.wp_id ? { ...x, status: "applied" } : x));
      toast.success("✓ Open Graph tags applied to WordPress");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Apply failed");
    } finally { setAutoApplying(prev => ({ ...prev, [key]: false })); }
  };

  const handleApplySchema = async (s) => {
    const key = s.wp_id + "_schema";
    setAutoApplying(prev => ({ ...prev, [key]: true }));
    try {
      await applySchema(selectedSite, s.wp_id, {
        content_type: s.content_type, schema_markup: s.schema_json,
      });
      setAutoSuggestions(prev => prev.map(x => x.wp_id === s.wp_id ? { ...x, status: "applied" } : x));
      toast.success("✓ Schema JSON-LD injected");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Apply failed");
    } finally { setAutoApplying(prev => ({ ...prev, [key]: false })); }
  };

  const handleBulkApply = async (applyType) => {
    const ids = Array.from(selectedIds);
    try {
      const r = await applyBulkSEO(selectedSite, { wp_ids: ids, apply_type: applyType });
      setAutoSuggestions(prev => prev.map(x => ids.includes(x.wp_id) ? { ...x, status: "applied" } : x));
      setSelectedIds(new Set());
      toast.success(`Applied ${r.data.applied} pages${r.data.failed > 0 ? `, ${r.data.failed} failed` : ""}`);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Bulk apply failed");
    }
  };

  // ── Full Page SEO handlers ──
  const handleFullPageAudit = async () => {
    if (!fpSelectedPage) return;
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
      const r = await fullPageSEOAudit(selectedSite, {
        wp_id: fpSelectedPage.wp_id,
        content_type: fpSelectedPage.content_type,
      });
      clearInterval(interval);
      setFpProgress(100);
      setFpStatusMsg("Audit complete!");
      setFpAudit(r.data);
      setFpApproved(new Set(["meta_title", "meta_description", "og_title", "og_description", "schema_markup"]));
      setTimeout(() => setFpStep(3), 500);
    } catch (err) {
      clearInterval(interval);
      toast.error(err.response?.data?.detail || "Full SEO audit failed");
      setFpStep(1);
    }
  };

  const handleSubmitSitemap = async () => {
    const url = fpSitemapUrl.trim();
    if (!url) return;
    setFpSubmittingSitemap(true);
    try {
      await submitSitemapToGSC(selectedSite, { sitemap_url: url });
      toast.success(`✓ Sitemap submitted to Google Search Console`);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Sitemap submission failed — check GSC credentials in Settings");
    } finally {
      setFpSubmittingSitemap(false);
    }
  };

  const handleApplyAllApproved = async () => {
    if (!fpAudit || !fpSelectedPage) return;
    setFpApplying(true);
    const warnings = [];
    const written = [];
    try {
      if (fpApproved.has("meta_title") || fpApproved.has("meta_description")) {
        const res = await applyMetaTags(selectedSite, fpSelectedPage.wp_id, {
          content_type: fpSelectedPage.content_type,
          ai_title: fpAudit.meta_title?.after || "",
          ai_desc: fpAudit.meta_description?.after || "",
        });
        (res.data?.updated_fields || []).forEach(f => written.push(f));
        if (res.data?.warning) warnings.push(res.data.warning);
      }
      if (fpApproved.has("og_title") || fpApproved.has("og_description")) {
        const res = await applyOGTags(selectedSite, fpSelectedPage.wp_id, {
          content_type: fpSelectedPage.content_type,
          og_title: fpAudit.og_title?.after || "",
          og_desc: fpAudit.og_description?.after || "",
          og_image: "",
          og_type: "article",
        });
        (res.data?.updated_fields || []).forEach(f => written.push(f));
        if (res.data?.warning) warnings.push(res.data.warning);
      }
      if (fpApproved.has("schema_markup") && fpAudit.schema_markup?.after) {
        const res = await applySchema(selectedSite, fpSelectedPage.wp_id, {
          content_type: fpSelectedPage.content_type,
          schema_markup: fpAudit.schema_markup.after,
        });
        written.push(res.data?.injected_via_content ? "schema (content injection)" : "schema (meta field)");
      }
      if (warnings.length > 0) {
        warnings.forEach(w => toast.warning(w, { duration: 8000 }));
      }
      if (written.length > 0) {
        toast.success(`✓ Applied to WordPress: ${written.join(", ")}`);
      } else if (warnings.length === 0) {
        toast.warning("No fields were written. Ensure Yoast SEO or RankMath is installed and active.");
      }
      setFpDialogOpen(false);
      setFpStep(1);
      setFpAudit(null);
      setFpSelectedPage(null);
      loadAutoSEOSuggestions();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Apply failed");
    } finally {
      setFpApplying(false);
    }
  };

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
            Live metrics from Google + AI-powered optimization
          </motion.p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[200px]" data-testid="site-select">
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
              <TabsTrigger value="internal-links" data-testid="internal-links-tab"><Link2 size={14} className="mr-1.5" />Internal Links</TabsTrigger>
              <TabsTrigger value="competitor" data-testid="competitor-tab"><Trophy size={14} className="mr-1.5" />Competitor Analysis</TabsTrigger>
              <TabsTrigger value="performance" data-testid="performance-tab"><Gauge size={14} className="mr-1.5" />Performance</TabsTrigger>
              <TabsTrigger value="images"><ImageIcon size={14} className="mr-1.5" />Images</TabsTrigger>
              <TabsTrigger value="rankings"><TrendingUp size={14} className="mr-1.5" />Rankings</TabsTrigger>
              <TabsTrigger value="auto-seo"><Sparkles size={14} className="mr-1.5" />Auto-SEO</TabsTrigger>
            </TabsList>

            {/* ── SEO METRICS TAB ── */}
            <TabsContent value="metrics" className="space-y-6">
          {/* Action Bar */}
          <Card className="content-card">
            <CardContent className="p-4">
              <div className="flex flex-wrap gap-3">
                <Button className="btn-primary" onClick={handleRefreshGoogle}>
                  <RefreshCw size={14} className="mr-2" />
                  Refresh from Google
                </Button>
                {/* ── FULL PAGE SEO OPTIMIZER ── */}
                <Dialog
                  open={fpDialogOpen}
                  onOpenChange={(o) => {
                    setFpDialogOpen(o);
                    if (!o) { setFpStep(1); setFpAudit(null); setFpSelectedPage(null); setFpSearch(""); }
                  }}
                >
                  <DialogTrigger asChild>
                    <Button variant="outline" data-testid="analyze-seo-btn">
                      <Sparkles size={14} className="mr-2" />
                      Full Page SEO
                    </Button>
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
                            Select a page to run a deep AI audit with before/after suggestions for every SEO element.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-3 py-4">
                          <Input
                            placeholder="Search pages by title or URL..."
                            value={fpSearch}
                            onChange={(e) => setFpSearch(e.target.value)}
                          />
                          {autoSuggestions.length === 0 ? (
                            <div className="text-center py-10">
                              <AlertCircle size={32} className="mx-auto text-muted-foreground/40 mb-3" />
                              <p className="text-sm text-muted-foreground mb-4">
                                No pages scanned yet. Run the Auto-SEO scan first to populate this list.
                              </p>
                              <Button onClick={handleAutoScan} disabled={scanning}>
                                {scanning ? <Loader2 size={14} className="mr-2 animate-spin" /> : <RefreshCw size={14} className="mr-2" />}
                                Scan Site Now
                              </Button>
                            </div>
                          ) : (
                            <ScrollArea className="h-[360px]">
                              <div className="space-y-1.5 pr-2">
                                {autoSuggestions
                                  .filter((s) =>
                                    !fpSearch ||
                                    s.current_title?.toLowerCase().includes(fpSearch.toLowerCase()) ||
                                    s.url?.toLowerCase().includes(fpSearch.toLowerCase())
                                  )
                                  .map((s) => {
                                    const score = Math.round(((s.title_score || 0) + (s.desc_score || 0)) / 2);
                                    const needsSEO = score < 60;
                                    const isSelected = fpSelectedPage?.wp_id === s.wp_id;
                                    return (
                                      <div
                                        key={s.wp_id}
                                        className={`p-3 rounded-lg border cursor-pointer transition-all ${
                                          isSelected
                                            ? "border-primary bg-primary/5"
                                            : "border-border hover:border-primary/40 hover:bg-muted/30"
                                        }`}
                                        onClick={() => setFpSelectedPage(s)}
                                      >
                                        <div className="flex items-start justify-between gap-2">
                                          <div className="min-w-0">
                                            <p className="text-sm font-medium truncate">{s.current_title || s.url}</p>
                                            <p className="text-xs text-muted-foreground truncate mt-0.5">{s.url}</p>
                                          </div>
                                          <div className="flex items-center gap-1.5 flex-shrink-0">
                                            {needsSEO && (
                                              <Badge variant="destructive" className="text-xs py-0 px-1.5">
                                                Needs SEO
                                              </Badge>
                                            )}
                                            <Badge
                                              variant={score >= 80 ? "default" : score >= 60 ? "secondary" : "outline"}
                                              className="text-xs py-0 px-1.5"
                                            >
                                              {score}/100
                                            </Badge>
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                              </div>
                            </ScrollArea>
                          )}
                        </div>
                        <DialogFooter>
                          <Button variant="outline" onClick={() => setFpDialogOpen(false)}>Cancel</Button>
                          <Button onClick={handleFullPageAudit} disabled={!fpSelectedPage || scanning}>
                            <Sparkles size={14} className="mr-2" />
                            Run Full SEO Audit
                          </Button>
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
                            Analyzing: {fpSelectedPage?.current_title}
                          </DialogDescription>
                        </DialogHeader>
                        <div className="py-10 space-y-6">
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
                            <span className="truncate">{fpSelectedPage?.current_title}</span>
                            {fpSelectedPage?.url && (
                              <a
                                href={fpSelectedPage.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline flex-shrink-0 font-medium"
                              >
                                <ExternalLink size={11} />
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
                                        checked={fpApproved.has(key)}
                                        onCheckedChange={(checked) =>
                                          setFpApproved((prev) => {
                                            const next = new Set(prev);
                                            checked ? next.add(key) : next.delete(key);
                                            return next;
                                          })
                                        }
                                      />
                                      <span className="text-sm font-semibold">{label}</span>
                                    </div>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 text-xs"
                                      onClick={async () => {
                                        try {
                                          if (key === "meta_title" || key === "meta_description") {
                                            await applyMetaTags(selectedSite, fpSelectedPage.wp_id, {
                                              content_type: fpSelectedPage.content_type,
                                              ai_title: fpAudit.meta_title?.after || "",
                                              ai_desc: fpAudit.meta_description?.after || "",
                                            });
                                          } else if (key === "og_title" || key === "og_description") {
                                            await applyOGTags(selectedSite, fpSelectedPage.wp_id, {
                                              content_type: fpSelectedPage.content_type,
                                              og_title: fpAudit.og_title?.after || "",
                                              og_desc: fpAudit.og_description?.after || "",
                                              og_image: "",
                                              og_type: "article",
                                            });
                                          } else if (key === "schema_markup") {
                                            await applySchema(selectedSite, fpSelectedPage.wp_id, {
                                              content_type: fpSelectedPage.content_type,
                                              schema_markup: field.after,
                                            });
                                          }
                                          toast.success(`✓ ${label} applied to WordPress`);
                                        } catch (err) {
                                          toast.error(err.response?.data?.detail || "Apply failed");
                                        }
                                      }}
                                    >
                                      Apply to WordPress
                                    </Button>
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
                                  placeholder={`${sites.find(s => s.id === selectedSite)?.url || "https://yoursite.com"}/sitemap.xml`}
                                  value={fpSitemapUrl}
                                  onChange={(e) => setFpSitemapUrl(e.target.value)}
                                  onFocus={() => {
                                    if (!fpSitemapUrl) {
                                      const site = sites.find(s => s.id === selectedSite);
                                      if (site?.url) setFpSitemapUrl(`${site.url.replace(/\/$/, "")}/sitemap.xml`);
                                    }
                                  }}
                                />
                                <Button
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
                                </Button>
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

                        <DialogFooter className="mt-4 gap-2">
                          <Button variant="outline" onClick={() => { setFpStep(1); setFpAudit(null); }}>
                            ← Back
                          </Button>
                          <Button
                            onClick={handleApplyAllApproved}
                            disabled={fpApplying || fpApproved.size === 0}
                          >
                            {fpApplying ? (
                              <Loader2 size={14} className="mr-2 animate-spin" />
                            ) : (
                              <CheckCircle2 size={14} className="mr-2" />
                            )}
                            Apply All Approved to WordPress ({fpApproved.size})
                          </Button>
                        </DialogFooter>
                      </>
                    )}
                  </DialogContent>
                </Dialog>
                <Button variant="outline" onClick={handleSelfHeal} disabled={healing}>
                  {healing ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Sparkles size={14} className="mr-2" />}
                  Self-Heal SEO
                </Button>

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
                {/* Bulk Audit Report Dialog */}
                <Dialog open={bulkReportOpen} onOpenChange={setBulkReportOpen}>
                  <DialogContent className="sm:max-w-[800px] max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                      <DialogTitle className="flex items-center gap-2">
                        <BarChart3 size={16} className="text-primary" />
                        Bulk SEO Audit Report
                      </DialogTitle>
                      <DialogDescription>
                        Issues found across your site — click <strong>Fix Now</strong> to run a full AI audit and apply fixes to any page.
                      </DialogDescription>
                    </DialogHeader>
                    {bulkReporting ? (
                      <div className="flex flex-col items-center py-12 gap-4">
                        <Loader2 size={32} className="animate-spin text-primary" />
                        <p className="text-sm text-muted-foreground">Scanning all pages for SEO issues...</p>
                        <Progress value={undefined} className="w-48 h-1.5" />
                      </div>
                    ) : (
                      <Tabs defaultValue="critical" className="mt-2">
                        <TabsList className="w-full">
                          <TabsTrigger value="critical" className="flex-1">
                            <span className="mr-1.5">🔴</span>
                            Critical ({autoSuggestions.filter(s => Math.round(((s.title_score||0)+(s.desc_score||0))/2) < 60).length})
                          </TabsTrigger>
                          <TabsTrigger value="warning" className="flex-1">
                            <span className="mr-1.5">🟡</span>
                            Warning ({autoSuggestions.filter(s => { const sc=Math.round(((s.title_score||0)+(s.desc_score||0))/2); return sc>=60 && sc<80; }).length})
                          </TabsTrigger>
                          <TabsTrigger value="good" className="flex-1">
                            <span className="mr-1.5">🟢</span>
                            Good ({autoSuggestions.filter(s => Math.round(((s.title_score||0)+(s.desc_score||0))/2) >= 80).length})
                          </TabsTrigger>
                        </TabsList>
                        {["critical","warning","good"].map((tier) => (
                          <TabsContent key={tier} value={tier} className="mt-3">
                            {autoSuggestions.length === 0 ? (
                              <div className="text-center py-10">
                                <AlertCircle size={32} className="mx-auto text-muted-foreground/30 mb-3" />
                                <p className="text-sm text-muted-foreground">No scan data yet. The scan is running in the background — reopen this dialog in a moment.</p>
                                <Button className="mt-4" onClick={handleAutoScan} disabled={scanning}>
                                  {scanning ? <Loader2 size={14} className="mr-2 animate-spin" /> : <RefreshCw size={14} className="mr-2" />}
                                  Scan Now
                                </Button>
                              </div>
                            ) : (
                              <ScrollArea className="h-[400px]">
                                <div className="space-y-2 pr-2">
                                  {autoSuggestions
                                    .filter(s => {
                                      const sc = Math.round(((s.title_score||0)+(s.desc_score||0))/2);
                                      if (tier === "critical") return sc < 60;
                                      if (tier === "warning") return sc >= 60 && sc < 80;
                                      return sc >= 80;
                                    })
                                    .sort((a,b) => {
                                      const sa = Math.round(((a.title_score||0)+(a.desc_score||0))/2);
                                      const sb = Math.round(((b.title_score||0)+(b.desc_score||0))/2);
                                      return sa - sb;
                                    })
                                    .map(s => {
                                      const score = Math.round(((s.title_score||0)+(s.desc_score||0))/2);
                                      const issues = [];
                                      if (!s.current_title || (s.title_score||0) < 30) issues.push("Missing title");
                                      else if ((s.title_score||0) < 70) issues.push("Weak title");
                                      if (!s.current_desc || (s.desc_score||0) < 30) issues.push("Missing meta description");
                                      else if ((s.desc_score||0) < 70) issues.push("Short/weak description");
                                      return (
                                        <div key={s.wp_id} className="rounded-lg border p-3 space-y-2.5 hover:bg-muted/20 transition-colors">
                                          <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0 flex-1">
                                              <p className="text-sm font-medium truncate">{s.current_title || "(no title)"}</p>
                                              <p className="text-xs text-muted-foreground truncate mt-0.5">{s.url}</p>
                                            </div>
                                            <Badge
                                              variant={score < 60 ? "destructive" : score < 80 ? "secondary" : "default"}
                                              className="text-xs flex-shrink-0"
                                            >
                                              {score}/100
                                            </Badge>
                                          </div>
                                          {issues.length > 0 && (
                                            <div className="flex flex-wrap gap-1.5">
                                              {issues.map((iss, i) => (
                                                <span key={i} className="text-xs bg-red-100 dark:bg-red-950/40 text-red-600 dark:text-red-400 px-2 py-0.5 rounded-full">
                                                  ⚠ {iss}
                                                </span>
                                              ))}
                                            </div>
                                          )}
                                          <div className="flex items-center gap-3">
                                            {s.url && (
                                              <a
                                                href={s.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
                                              >
                                                <ExternalLink size={11} />
                                                View Page
                                              </a>
                                            )}
                                            <Button
                                              size="sm"
                                              className="h-7 text-xs ml-auto"
                                              onClick={() => {
                                                setFpSelectedPage(s);
                                                setBulkReportOpen(false);
                                                setFpStep(1);
                                                setFpAudit(null);
                                                setFpDialogOpen(true);
                                              }}
                                            >
                                              <Sparkles size={11} className="mr-1.5" />
                                              Fix Now
                                            </Button>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  {autoSuggestions.filter(s => {
                                    const sc = Math.round(((s.title_score||0)+(s.desc_score||0))/2);
                                    if (tier === "critical") return sc < 60;
                                    if (tier === "warning") return sc >= 60 && sc < 80;
                                    return sc >= 80;
                                  }).length === 0 && (
                                    <div className="text-center py-8 text-muted-foreground text-sm">
                                      <CheckCircle2 size={28} className="mx-auto text-emerald-500 mb-2" />
                                      No {tier} issues found.
                                    </div>
                                  )}
                                </div>
                              </ScrollArea>
                            )}
                          </TabsContent>
                        ))}
                      </Tabs>
                    )}
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setBulkReportOpen(false)}>Close</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                <Button variant="outline" onClick={handleBulkAudit} disabled={bulkReporting}>
                  {bulkReporting ? <Loader2 size={14} className="mr-2 animate-spin" /> : <BarChart3 size={14} className="mr-2" />}
                  Bulk Audit All Sites
                </Button>
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
                        <th className="p-3 text-left w-8">
                          <Checkbox
                            checked={selectedRows.length === metrics.length}
                            onCheckedChange={(v) => setSelectedRows(v ? metrics.map((m) => m.id) : [])}
                          />
                        </th>
                        <th className="p-3 text-left">Page / Keyword</th>
                        <th className="p-3 text-right">Impressions</th>
                        <th className="p-3 text-right">Clicks</th>
                        <th className="p-3 text-right">CTR</th>
                        <th className="p-3 text-right">Position</th>
                        <th className="p-3 text-center">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.map((m) => (
                        <tr key={m.id} className="border-b border-border/20 hover:bg-muted/10 transition-colors">
                          <td className="p-3">
                            <Checkbox checked={selectedRows.includes(m.id)} onCheckedChange={() => toggleRow(m.id)} />
                          </td>
                          <td className="p-3">
                            <div className="text-xs font-medium truncate max-w-[200px]">{m.page_url || "â€”"}</div>
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
                            ) : "â€”"}
                          </td>
                          <td className="p-3 text-center">
                            <Badge variant="outline" className={`text-xs ${m.source === "google" ? "border-blue-500/30 text-blue-400" : ""}`}>
                              {m.source || "manual"}
                            </Badge>
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

            {/* ── INTERNAL LINKS TAB ── */}
            <TabsContent value="internal-links" className="space-y-6">
              {/* Action bar */}
              <Card className="content-card">
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      className="btn-primary"
                      onClick={handleFindLinks}
                      disabled={finding}
                      data-testid="find-links-btn"
                    >
                      {finding
                        ? <Loader2 size={14} className="mr-2 animate-spin" />
                        : <Sparkles size={14} className="mr-2" />}
                      Find Suggestions
                    </Button>
                    <Button variant="outline" size="sm" onClick={loadLinkSuggestions} disabled={loadingLinks}>
                      <RefreshCw size={14} className={loadingLinks ? "animate-spin" : ""} />
                    </Button>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {linkSuggestions.length} suggestion{linkSuggestions.length !== 1 ? "s" : ""}
                      {linkSuggestions.filter((s) => s.applied).length > 0 &&
                        ` · ${linkSuggestions.filter((s) => s.applied).length} applied`}
                    </span>
                  </div>
                </CardContent>
              </Card>

              {/* Suggestions table */}
              <Card className="content-card">
                <CardHeader>
                  <CardTitle className="font-heading flex items-center gap-2">
                    <Link2 size={18} className="text-primary" />
                    Link Suggestions
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {loadingLinks ? (
                    <div className="flex justify-center py-12">
                      <Loader2 size={24} className="animate-spin text-primary" />
                    </div>
                  ) : linkSuggestions.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12">
                      <Link2 size={40} className="text-muted-foreground/20 mb-3" />
                      <p className="text-muted-foreground text-sm">No suggestions yet.</p>
                      <p className="text-xs text-muted-foreground mt-1">Click "Find Suggestions" to analyse your posts.</p>
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Source Post</TableHead>
                          <TableHead className="text-center w-8"></TableHead>
                          <TableHead>Anchor Text</TableHead>
                          <TableHead className="text-center w-8"></TableHead>
                          <TableHead>Target Post</TableHead>
                          <TableHead>Context</TableHead>
                          <TableHead className="text-right">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {linkSuggestions.map((s) => (
                          <TableRow key={s.id} className={s.applied ? "opacity-60" : ""}>
                            <TableCell className="max-w-[140px] truncate font-medium text-sm">
                              {s.source_post_title || `#${s.source_post_id}`}
                            </TableCell>
                            <TableCell className="text-center text-muted-foreground">
                              <ArrowRight size={14} />
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-primary border-primary/30 font-mono text-xs">
                                {s.anchor_text}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-center text-muted-foreground">
                              <ArrowRight size={14} />
                            </TableCell>
                            <TableCell className="max-w-[140px] truncate text-sm">
                              <a
                                href={s.target_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:text-primary"
                              >
                                {s.target_post_title || `#${s.target_post_id}`}
                              </a>
                            </TableCell>
                            <TableCell className="max-w-[220px]">
                              <p className="text-xs text-muted-foreground truncate" title={s.context_sentence}>
                                {s.context_sentence}
                              </p>
                            </TableCell>
                            <TableCell className="text-right">
                              {s.applied ? (
                                <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
                                  <CheckCircle2 size={11} className="mr-1" />Applied
                                </Badge>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs"
                                  onClick={() => handleApplyLink(s)}
                                  disabled={!!applying[s.id]}
                                  data-testid={`apply-${s.id}`}
                                >
                                  {applying[s.id]
                                    ? <Loader2 size={12} className="mr-1 animate-spin" />
                                    : <Link2 size={12} className="mr-1" />}
                                  Apply
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
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
                      placeholder="Enter keyword to analyze (e.g. best wordpress plugins)"
                      value={competitorKeyword}
                      onChange={(e) => setCompetitorKeyword(e.target.value)}
                      className="flex-1"
                      data-testid="competitor-keyword-input"
                    />
                    <Button type="submit" className="btn-primary" disabled={analyzingCompetitor || !competitorKeyword.trim()}>
                      {analyzingCompetitor
                        ? <Loader2 size={14} className="mr-2 animate-spin" />
                        : <Sparkles size={14} className="mr-2" />}
                      Analyze
                    </Button>
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
                      value={psUrl}
                      onChange={(e) => setPsUrl(e.target.value)}
                      className="flex-1"
                      data-testid="pagespeed-url-input"
                    />
                    <Button type="submit" className="btn-primary" disabled={analyzingPs || !psUrl.trim()} data-testid="pagespeed-analyze-btn">
                      {analyzingPs
                        ? <Loader2 size={14} className="mr-2 animate-spin" />
                        : <Zap size={14} className="mr-2" />}
                      Analyze
                    </Button>
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
                                  {key === "cls" ? value.toFixed(3) : Math.round(value)}<span className="text-sm font-normal ml-0.5">{unit}</span>
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
                          <CardTitle className="font-heading text-sm flex items-center gap-2">
                            <Sparkles size={16} className="text-primary" />AI Recommendations
                          </CardTitle>
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

            {/* ── IMAGES TAB ── */}
            <TabsContent value="images" className="space-y-4">
              <Card className="content-card">
                <CardHeader>
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <ImageIcon size={16} className="text-primary" />Image Alt Text Audit
                    </CardTitle>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={loadImageAudit} disabled={loadingImages}>
                        {loadingImages ? <Loader2 size={13} className="animate-spin mr-1" /> : <RefreshCw size={13} className="mr-1" />}Scan
                      </Button>
                      {imageAudit?.missing_alt > 0 && (
                        <Button size="sm" onClick={handleGenerateAllAlts} disabled={generatingAllAlts}>
                          {generatingAllAlts ? <Loader2 size={13} className="animate-spin mr-1" /> : <Sparkles size={13} className="mr-1" />}
                          Generate All ({imageAudit.missing_alt} missing)
                        </Button>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  {loadingImages ? (
                    <div className="flex justify-center py-10"><Loader2 size={24} className="animate-spin text-primary" /></div>
                  ) : !imageAudit ? (
                    <div className="flex flex-col items-center justify-center py-10">
                      <ImageIcon size={36} className="text-muted-foreground/30 mb-3" />
                      <p className="text-muted-foreground text-sm">Click "Scan" to audit images</p>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-3 gap-3 p-4 border-b border-border/30">
                        <div className="text-center"><p className="text-2xl font-bold">{imageAudit.total_images}</p><p className="text-xs text-muted-foreground">Total Images</p></div>
                        <div className="text-center"><p className="text-2xl font-bold text-red-500">{imageAudit.missing_alt}</p><p className="text-xs text-muted-foreground">Missing Alt</p></div>
                        <div className="text-center"><p className="text-2xl font-bold text-emerald-500">{imageAudit.total_images - imageAudit.missing_alt}</p><p className="text-xs text-muted-foreground">Have Alt</p></div>
                      </div>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Image</TableHead>
                            <TableHead>Alt Text</TableHead>
                            <TableHead className="text-right">Action</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {imageAudit.images.filter((img) => img.missing_alt).slice(0, 50).map((img) => (
                            <TableRow key={img.id}>
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  <img src={img.url} alt="" className="w-10 h-10 object-cover rounded-md border border-border/30" onError={(e) => { e.target.style.display = "none"; }} />
                                  <span className="text-xs text-muted-foreground truncate max-w-[200px]">{img.title || img.filename || `ID ${img.id}`}</span>
                                </div>
                              </TableCell>
                              <TableCell>
                                {img.alt_text ? (
                                  <span className="text-sm">{img.alt_text}</span>
                                ) : (
                                  <Badge variant="destructive" className="text-xs">Missing</Badge>
                                )}
                              </TableCell>
                              <TableCell className="text-right">
                                <Button size="sm" variant="outline" disabled={generatingAlt[img.id]} onClick={() => handleGenerateSingleAlt(img.id)}>
                                  {generatingAlt[img.id] ? <Loader2 size={12} className="animate-spin mr-1" /> : <Sparkles size={12} className="mr-1" />}
                                  Generate
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </>
                  )}
                </CardContent>
              </Card>
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
                    <Input placeholder="Add keyword to track…" value={newKeyword}
                      onChange={(e) => setNewKeyword(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addKeyword(); } }} />
                    <Button variant="outline" size="sm" onClick={addKeyword} disabled={!newKeyword.trim()}>
                      <Plus size={14} />
                    </Button>
                    <Button size="sm" onClick={handleSaveKeywords} disabled={savingKeywords || !trackedKeywords.length}>
                      {savingKeywords ? <Loader2 size={13} className="animate-spin mr-1" /> : null}Save & Refresh
                    </Button>
                  </div>
                  {trackedKeywords.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {trackedKeywords.map((kw) => (
                        <Badge key={kw} variant="secondary" className="gap-1">
                          {kw}
                          <button onClick={() => setTrackedKeywords((prev) => prev.filter((k) => k !== kw))} className="hover:text-destructive ml-0.5">
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

            {/* ── AUTO-SEO TAB ── */}
            <TabsContent value="auto-seo" className="space-y-6">
              {/* Scan trigger */}
              <Card className="content-card">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <p className="font-medium">AI-Powered SEO Optimizer</p>
                      <p className="text-sm text-muted-foreground">
                        Generates optimized meta titles, descriptions, Open Graph tags and Schema markup for every page
                      </p>
                    </div>
                    <Button className="btn-primary" onClick={handleAutoScan} disabled={scanning}>
                      {scanning
                        ? <Loader2 size={14} className="mr-2 animate-spin" />
                        : <Sparkles size={14} className="mr-2" />}
                      {scanning ? "Scanning…" : "Run AI Scan"}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Summary cards */}
              {autoSuggestions.length > 0 && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <Card className="content-card">
                    <CardContent className="p-4">
                      <p className="text-2xl font-bold">{autoSuggestions.length}</p>
                      <p className="text-xs text-muted-foreground mt-1">Total pages</p>
                    </CardContent>
                  </Card>
                  <Card className="content-card">
                    <CardContent className="p-4">
                      <p className="text-2xl font-bold text-red-500">
                        {autoSuggestions.filter(s => s.title_score === 0 || s.desc_score === 0).length}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">Missing meta</p>
                    </CardContent>
                  </Card>
                  <Card className="content-card">
                    <CardContent className="p-4">
                      <p className="text-2xl font-bold text-yellow-500">
                        {autoSuggestions.filter(s => s.title_score > 0 && s.title_score < 80).length}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">Weak titles</p>
                    </CardContent>
                  </Card>
                  <Card className="content-card">
                    <CardContent className="p-4">
                      <p className="text-2xl font-bold text-emerald-500">
                        {autoSuggestions.filter(s => s.status === "applied").length}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">Applied</p>
                    </CardContent>
                  </Card>
                </div>
              )}

              {/* Inner tabs */}
              {autoSuggestions.length > 0 && (
                <Tabs value={autoTab} onValueChange={setAutoTab}>
                  <TabsList className="mb-4">
                    <TabsTrigger value="meta">Meta Tags</TabsTrigger>
                    <TabsTrigger value="og">Open Graph</TabsTrigger>
                    <TabsTrigger value="schema">Schema Markup</TabsTrigger>
                  </TabsList>

                  {/* META TAGS */}
                  <TabsContent value="meta" className="space-y-3">
                    {selectedIds.size > 0 && (
                      <div className="flex items-center gap-3 p-3 bg-primary/10 rounded-lg border border-primary/20">
                        <span className="text-sm font-medium">{selectedIds.size} selected</span>
                        <Button size="sm" onClick={() => handleBulkApply("meta")}>Apply all selected</Button>
                        <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>Clear</Button>
                      </div>
                    )}
                    {autoSuggestions.map(s => (
                      <Card key={s.wp_id} className="content-card">
                        <CardContent className="p-4 space-y-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              {s.status !== "applied" && (
                                <Checkbox
                                  checked={selectedIds.has(s.wp_id)}
                                  onCheckedChange={checked => {
                                    setSelectedIds(prev => {
                                      const next = new Set(prev);
                                      checked ? next.add(s.wp_id) : next.delete(s.wp_id);
                                      return next;
                                    });
                                  }}
                                />
                              )}
                              <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:text-primary truncate max-w-xs underline underline-offset-2">{s.url}</a>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <Badge variant="outline" className="text-xs">{s.content_type}</Badge>
                              {s.status === "applied" && (
                                <Badge className="bg-emerald-600 text-white text-xs">Applied ✓</Badge>
                              )}
                              <div className="flex items-center gap-1 text-xs">
                                <span className={
                                  s.title_score >= 80 ? "text-emerald-500" :
                                  s.title_score >= 50 ? "text-yellow-500" : "text-red-500"
                                }>{s.title_score}</span>
                                <ArrowRight size={10} className="text-muted-foreground" />
                                <span className="text-emerald-500">94</span>
                              </div>
                            </div>
                          </div>
                          <div className="space-y-2 text-sm">
                            <div>
                              <p className="text-xs text-muted-foreground mb-0.5">Title</p>
                              {s.current_title && (
                                <p className="line-through text-muted-foreground text-xs">{s.current_title}</p>
                              )}
                              <p className="font-medium">
                                {s.ai_title}
                                <span className="text-muted-foreground font-normal text-xs ml-1">({s.ai_title_len} chars)</span>
                              </p>
                            </div>
                            <div>
                              <p className="text-xs text-muted-foreground mb-0.5">Description</p>
                              {s.current_desc && (
                                <p className="line-through text-muted-foreground text-xs">{s.current_desc}</p>
                              )}
                              <p className="text-sm">
                                {s.ai_desc}
                                <span className="text-muted-foreground text-xs ml-1">({s.ai_desc_len} chars)</span>
                              </p>
                            </div>
                          </div>
                          <div className="flex justify-end">
                            <Button
                              size="sm"
                              disabled={s.status === "applied" || autoApplying[s.wp_id]}
                              onClick={() => handleApplyMeta(s)}
                            >
                              {autoApplying[s.wp_id]
                                ? <Loader2 size={12} className="mr-1.5 animate-spin" />
                                : <CheckCircle2 size={12} className="mr-1.5" />}
                              {s.status === "applied" ? "Applied ✓" : "Apply to site"}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </TabsContent>

                  {/* OPEN GRAPH */}
                  <TabsContent value="og" className="space-y-3">
                    {autoSuggestions.map(s => (
                      <Card key={s.wp_id} className="content-card">
                        <CardContent className="p-4 space-y-3">
                          <div className="flex items-start justify-between gap-2">
                            <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:text-primary truncate max-w-xs underline underline-offset-2">{s.url}</a>
                            <div className="flex items-center gap-2 shrink-0">
                              <Badge variant="outline" className="text-xs">{s.content_type}</Badge>
                              {s.status === "applied" && (
                                <Badge className="bg-emerald-600 text-white text-xs">Applied ✓</Badge>
                              )}
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-3 text-sm">
                            <div>
                              <p className="text-xs text-muted-foreground">og:title</p>
                              <p className="font-medium">{s.og_title}</p>
                            </div>
                            <div>
                              <p className="text-xs text-muted-foreground">og:type</p>
                              <Badge variant="secondary" className="text-xs">{s.og_type}</Badge>
                            </div>
                            <div className="col-span-2">
                              <p className="text-xs text-muted-foreground">og:description</p>
                              <p>{s.og_desc}</p>
                            </div>
                            <div className="col-span-2">
                              <p className="text-xs text-muted-foreground">og:image</p>
                              {s.og_image
                                ? <p className="text-xs text-emerald-500 truncate">{s.og_image}</p>
                                : <p className="text-xs text-yellow-500">⚠ No featured image — set one in WordPress</p>}
                            </div>
                          </div>
                          <div className="flex justify-end">
                            <Button
                              size="sm"
                              disabled={s.status === "applied" || autoApplying[s.wp_id + "_og"]}
                              onClick={() => handleApplyOG(s)}
                            >
                              {autoApplying[s.wp_id + "_og"]
                                ? <Loader2 size={12} className="mr-1.5 animate-spin" />
                                : <CheckCircle2 size={12} className="mr-1.5" />}
                              {s.status === "applied" ? "Applied ✓" : "Apply Open Graph"}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </TabsContent>

                  {/* SCHEMA MARKUP */}
                  <TabsContent value="schema" className="space-y-3">
                    {autoSuggestions.map(s => (
                      <Card key={s.wp_id} className="content-card">
                        <CardContent className="p-4 space-y-3">
                          <div className="flex items-start justify-between gap-2">
                            <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:text-primary truncate max-w-xs underline underline-offset-2">{s.url}</a>
                            <div className="flex items-center gap-2 shrink-0">
                              <Badge variant="outline" className="text-xs">{s.content_type}</Badge>
                              {s.schema_json && (() => {
                                try {
                                  const t = JSON.parse(s.schema_json)["@type"];
                                  return t ? <Badge variant="secondary" className="text-xs">{t}</Badge> : null;
                                } catch { return null; }
                              })()}
                              {s.status === "applied" && (
                                <Badge className="bg-emerald-600 text-white text-xs">Injected ✓</Badge>
                              )}
                            </div>
                          </div>
                          {s.schema_json
                            ? (
                              <ScrollArea className="h-[120px] rounded border bg-muted/40">
                                <pre className="p-2 text-xs whitespace-pre-wrap font-mono">{s.schema_json}</pre>
                              </ScrollArea>
                            ) : (
                              <p className="text-xs text-muted-foreground italic">No schema generated for this page</p>
                            )}
                          <div className="flex justify-end">
                            <Button
                              size="sm"
                              disabled={!s.schema_json || s.status === "applied" || autoApplying[s.wp_id + "_schema"]}
                              onClick={() => handleApplySchema(s)}
                            >
                              {autoApplying[s.wp_id + "_schema"]
                                ? <Loader2 size={12} className="mr-1.5 animate-spin" />
                                : <CheckCircle2 size={12} className="mr-1.5" />}
                              {s.status === "applied" ? "Injected ✓" : "Inject JSON-LD"}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </TabsContent>
                </Tabs>
              )}

              {autoSuggestions.length === 0 && !scanning && (
                <Card className="content-card">
                  <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
                    <Sparkles size={48} className="text-muted-foreground/30" />
                    <p className="text-muted-foreground">Run an AI scan to generate SEO suggestions for all your pages</p>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

          </Tabs>
        </div>
      )}

      <SSEProgressDrawer tasks={tasks} dismissTask={dismissTask} />

      <ManualApplySheet
        open={manualSheet.open}
        onClose={closeManualSheet}
        title={manualSheet.title}
        wpAdminUrl={manualSheet.wpAdminUrl}
        fields={manualSheet.fields}
        instructions={manualSheet.instructions}
      />

      {/* Meta Fixer Plugin Dialog */}
      <Dialog open={metaFixerDialogOpen} onOpenChange={setMetaFixerDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-yellow-500" />
              SEO Meta Fields Not Written to WordPress
            </DialogTitle>
            <DialogDescription>
              WordPress blocked the SEO write. This happens because Yoast/RankMath meta fields
              require a bridge plugin that writes directly via PHP — the REST API and XML-RPC
              both have restrictions on underscore-prefixed meta keys.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">{metaFixerWarning}</p>

            <div className="rounded-md border border-blue-200 bg-blue-50 p-3 space-y-2">
              <p className="font-semibold text-blue-900">Recommended Fix: Install the WP Manager Bridge Plugin</p>
              <p className="text-blue-800 text-xs">This plugin writes SEO meta directly via PHP — no REST API or XML-RPC restrictions.</p>
              <ol className="list-decimal list-inside space-y-1 text-blue-800">
                <li>Click <strong>Download Bridge Plugin</strong> below.</li>
                <li>In WordPress Admin go to <strong>Plugins → Add New → Upload Plugin</strong>.</li>
                <li>Upload <code>wp-manager-bridge.zip</code> and click <strong>Install Now → Activate</strong>.</li>
                <li>Come back here and re-apply — changes will reflect immediately.</li>
              </ol>
            </div>

            <div className="rounded-md border bg-muted/50 p-3 space-y-2">
              <p className="font-medium">Alternative: LST SEO Meta Fixer (lighter plugin)</p>
              <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                <li>Click <strong>Download Meta Fixer</strong> below.</li>
                <li>Install via <strong>Plugins → Add New → Upload Plugin</strong>.</li>
                <li>Activate, then go to <strong>Settings → Permalinks → Save Changes</strong>.</li>
                <li>Re-apply meta tags here.</li>
              </ol>
            </div>
          </div>

          <DialogFooter className="gap-2 flex-wrap">
            <Button variant="outline" onClick={() => setMetaFixerDialogOpen(false)}>Close</Button>
            <Button variant="outline" onClick={handleDownloadMetaFixer} disabled={downloadingPlugin}>
              {downloadingPlugin ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Download Meta Fixer
            </Button>
            <Button onClick={handleDownloadBridgePlugin} disabled={downloadingBridge}>
              {downloadingBridge ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Download Bridge Plugin
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

