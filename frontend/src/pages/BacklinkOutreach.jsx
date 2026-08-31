import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import {
  Link2, Loader2, RefreshCw, Mail, Shield, TrendingUp, Copy, Check, Download,
  UserCheck, ExternalLink, ListChecks, Building2, Filter, Search, Sparkles, CheckCircle2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Badge } from "../components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { toast } from "sonner";
import {
  getSites, findBacklinkOpportunities, listBacklinkOpportunities, listBacklinkSearches,
  generateOutreachEmail, updateBacklinkStatus, generateDisavow, getDisavow,
  exportBacklinkOutreachExcel, subscribeToTask,
  getDirectories, prepareDirectoryListing, updateDirectorySubmission,
  verifyDirectoryListing, verifyAllDirectoryListings,
} from "../lib/api";

const statusColors = {
  new: "bg-muted text-muted-foreground",
  contacted: "bg-blue-500/10 text-blue-400",
  replied: "bg-yellow-500/10 text-yellow-400",
  acquired: "bg-emerald-500/10 text-emerald-500",
  rejected: "bg-red-500/10 text-red-400",
};
const typeColors = {
  "resource page": "bg-purple-500/10 text-purple-400",
  "broken link": "bg-orange-500/10 text-orange-400",
  "skyscraper": "bg-blue-500/10 text-blue-400",
  "guest post": "bg-emerald-500/10 text-emerald-400",
  "competitor_backlink": "bg-cyan-500/10 text-cyan-400",
};
const dirStatusColors = {
  not_started: "bg-muted text-muted-foreground",
  prepared: "bg-blue-500/10 text-blue-400",
  submitted: "bg-yellow-500/10 text-yellow-400",
  live: "bg-emerald-500/10 text-emerald-500",
  rejected: "bg-red-500/10 text-red-400",
};
const OPP_TYPES = ["competitor_backlink", "resource page", "broken link", "skyscraper", "guest post"];

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0" onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); toast.success("Copied"); }}>
      {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
    </Button>
  );
}

function Field({ label, value }) {
  if (!value) return null;
  const text = Array.isArray(value) ? value.join(", ") : String(value);
  return (
    <div className="flex items-start gap-2 p-2 rounded bg-muted/30">
      <div className="flex-1 min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="text-xs mt-0.5 break-words">{text}</p>
      </div>
      <CopyBtn text={text} />
    </div>
  );
}

export default function BacklinkOutreach() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [opportunities, setOpportunities] = useState([]);
  const [searches, setSearches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState("");
  const [disavow, setDisavow] = useState(null);
  const [emailDialog, setEmailDialog] = useState(null);
  const [generatingEmail, setGeneratingEmail] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [expanded, setExpanded] = useState({});

  // Filters (server-side, except the status tabs which filter the loaded set)
  const [activeSearch, setActiveSearch] = useState("all");
  const [fType, setFType] = useState("all");
  const [fMinDa, setFMinDa] = useState("all");
  const [fContact, setFContact] = useState("all");
  const [fSort, setFSort] = useState("created_desc");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // Directories tab
  const [dirData, setDirData] = useState(null);
  const [dirLoading, setDirLoading] = useState(false);
  const [busyDir, setBusyDir] = useState("");
  const [verifyingAll, setVerifyingAll] = useState(false);
  const [openDir, setOpenDir] = useState(null);

  const [form, setForm] = useState({ competitor_urls: "", your_domain: "", niche: "" });

  useEffect(() => {
    getSites().then(r => { setSites(r.data); if (r.data.length > 0) setSelectedSite(r.data[0].id); }).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 350);
    return () => clearTimeout(t);
  }, [query]);

  const loadOpportunities = useCallback(async () => {
    if (!selectedSite) return;
    setLoading(true);
    try {
      const params = { limit: 500, sort: fSort };
      if (activeSearch !== "all") params.search_id = activeSearch;
      if (fType !== "all") params.opportunity_type = fType;
      if (fMinDa !== "all") params.min_da = Number(fMinDa);
      if (fContact !== "all") params.has_contact = fContact === "yes";
      if (debouncedQuery.trim()) params.q = debouncedQuery.trim();
      const r = await listBacklinkOpportunities(selectedSite, params);
      setOpportunities(r.data);
    } catch { setOpportunities([]); } finally { setLoading(false); }
  }, [selectedSite, activeSearch, fType, fMinDa, fContact, fSort, debouncedQuery]);

  const loadSearches = useCallback(async () => {
    if (!selectedSite) return;
    try { const r = await listBacklinkSearches(selectedSite); setSearches(r.data || []); } catch { setSearches([]); }
  }, [selectedSite]);

  const loadDirectories = useCallback(async () => {
    if (!selectedSite) return;
    setDirLoading(true);
    try { const r = await getDirectories(selectedSite); setDirData(r.data); }
    catch { setDirData(null); } finally { setDirLoading(false); }
  }, [selectedSite]);

  useEffect(() => { loadOpportunities(); }, [loadOpportunities]);
  useEffect(() => { loadSearches(); loadDirectories(); }, [loadSearches, loadDirectories]);
  useEffect(() => {
    if (selectedSite) getDisavow(selectedSite).then(r => setDisavow(r.data)).catch(() => {});
  }, [selectedSite]);

  const handleScan = async () => {
    const urls = form.competitor_urls.split("\n").map(u => u.trim()).filter(Boolean);
    if (!form.your_domain.trim()) return toast.error("Enter your domain");
    setScanning(true);
    setProgress(urls.length ? "Starting analysis…" : "Starting analysis — no competitors given, will auto-discover them from your site…");
    try {
      const r = await findBacklinkOpportunities(selectedSite, { competitor_urls: urls, your_domain: form.your_domain, niche: form.niche });
      const newSearchId = r.data.search_id;
      // subscribeToTask only ever emits {type: "status", data} (plus {type:"error"}
      // on a transport failure) — it polls GET /api/tasks/{id} and mirrors whatever
      // the backend's task_status_store/db.task_runs record says.
      subscribeToTask(r.data.task_id, evt => {
        if (evt.type === "status") {
          const message = evt.data?.progress?.message;
          if (message) setProgress(message);
          if (evt.data?.status === "completed") {
            setScanning(false); setProgress("");
            loadSearches();
            // Jump straight to just this search's results, so a new "salesforce"
            // run doesn't disappear into the previous "netsuite" one.
            if (newSearchId) setActiveSearch(newSearchId); else loadOpportunities();
            const count = evt.data?.result?.count ?? evt.data?.progress?.count ?? 0;
            toast.success(`Found ${count} opportunities in this search`);
          } else if (evt.data?.status === "failed") {
            setScanning(false); setProgress("");
            loadSearches();
            toast.error(evt.data?.error || "Scan failed");
          }
        }
        if (evt.type === "error") { setScanning(false); setProgress(""); toast.error(evt.data?.message || "Scan failed"); }
      });
    } catch (e) { setScanning(false); setProgress(""); toast.error(e.response?.data?.detail || "Failed"); }
  };

  const handleExportExcel = async () => {
    setExporting(true);
    try {
      const r = await exportBacklinkOutreachExcel(selectedSite);
      const url = window.URL.createObjectURL(new Blob([r.data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `backlink-outreach-${selectedSite}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success("Excel report downloaded");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Export failed");
    } finally { setExporting(false); }
  };

  const handleGenerateEmail = async (opp) => {
    if (opp.email_content) { setEmailDialog({ ...opp, email: opp.email_content }); return; }
    setGeneratingEmail(true);
    try {
      const r = await generateOutreachEmail(selectedSite, opp.id);
      setEmailDialog({ ...opp, email: r.data });
      toast.success("Email generated");
    } catch { toast.error("Failed to generate email"); }
    finally { setGeneratingEmail(false); }
  };

  const handleStatusChange = async (oppId, status) => {
    try {
      await updateBacklinkStatus(selectedSite, oppId, { status });
      setOpportunities(prev => prev.map(o => o.id === oppId ? { ...o, status } : o));
      toast.success("Status updated");
    } catch { toast.error("Failed"); }
  };

  const handleGenerateDisavow = async () => {
    try { const r = await generateDisavow(selectedSite); setDisavow(r.data); toast.success(`Disavow file generated (${r.data.domain_count} domains)`); }
    catch { toast.error("Failed"); }
  };

  // --- Directories ---
  const handlePrepare = async (dirId) => {
    setBusyDir(dirId);
    try {
      await prepareDirectoryListing(selectedSite, dirId);
      await loadDirectories();
      toast.success("Listing copy prepared");
    } catch (e) { toast.error(e.response?.data?.detail || "Could not prepare listing"); }
    finally { setBusyDir(""); }
  };

  const handleDirStatus = async (dirId, status) => {
    setBusyDir(dirId);
    try {
      await updateDirectorySubmission(selectedSite, dirId, { status });
      await loadDirectories();
      toast.success(`Marked ${status.replace("_", " ")}`);
    } catch (e) { toast.error(e.response?.data?.detail || "Failed"); }
    finally { setBusyDir(""); }
  };

  const handleVerify = async (dirId) => {
    setBusyDir(dirId);
    try {
      const r = await verifyDirectoryListing(selectedSite, dirId);
      await loadDirectories();
      if (r.data.found === true) toast.success("Listing confirmed live");
      else if (r.data.found === false) toast.info(r.data.note);
      else toast.warning(r.data.note);
    } catch (e) { toast.error(e.response?.data?.detail || "Verification failed"); }
    finally { setBusyDir(""); }
  };

  const handleVerifyAll = async () => {
    setVerifyingAll(true);
    try {
      const r = await verifyAllDirectoryListings(selectedSite);
      subscribeToTask(r.data.task_id, evt => {
        if (evt.type === "status") {
          const message = evt.data?.progress?.message;
          if (message) setProgress(message);
          if (evt.data?.status === "completed") {
            setVerifyingAll(false); setProgress(""); loadDirectories();
            toast.success(evt.data?.result?.message || "Verification complete");
          } else if (evt.data?.status === "failed") {
            setVerifyingAll(false); setProgress("");
            toast.error(evt.data?.error || "Verification failed");
          }
        }
        if (evt.type === "error") { setVerifyingAll(false); setProgress(""); toast.error("Verification failed"); }
      });
    } catch (e) { setVerifyingAll(false); toast.error(e.response?.data?.detail || "Failed"); }
  };

  const acquired = opportunities.filter(o => o.status === "acquired").length;
  const activeSearchMeta = searches.find(s => s.id === activeSearch);
  const filtersActive = activeSearch !== "all" || fType !== "all" || fMinDa !== "all" || fContact !== "all" || !!debouncedQuery.trim();

  const searchLabel = (s) => {
    const when = s.created_at ? new Date(s.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
    return `${s.label || "Search"} · ${when}${s.status === "running" ? " (running…)" : s.status === "failed" ? " (failed)" : ""}`;
  };

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Link2 size={24} />Backlink Outreach</h1>
          <p className="page-description">Competitor gap analysis, personalised outreach, and direct-posting directory listings</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {progress && <Card className="border-blue-500/30 bg-blue-500/5"><CardContent className="py-3 flex items-center gap-3"><Loader2 size={14} className="animate-spin text-blue-400" /><p className="text-sm text-blue-400">{progress}</p></CardContent></Card>}

      <Tabs defaultValue="outreach">
        <TabsList className="mb-4">
          <TabsTrigger value="outreach"><Mail size={14} className="mr-1.5" />Outreach</TabsTrigger>
          <TabsTrigger value="directories"><Building2 size={14} className="mr-1.5" />Directories</TabsTrigger>
        </TabsList>

        {/* ───────────────── OUTREACH ───────────────── */}
        <TabsContent value="outreach">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="space-y-4">
              <Card>
                <CardHeader><CardTitle className="text-base">New Search</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Your Domain *</label><Input placeholder="example.com" value={form.your_domain} onChange={e => setForm(p => ({ ...p, your_domain: e.target.value }))} /></div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Niche</label>
                    <Input placeholder="NetSuite, Salesforce, etc." value={form.niche} onChange={e => setForm(p => ({ ...p, niche: e.target.value }))} />
                    <p className="text-xs text-muted-foreground mt-1">Names this search so you can tell it apart from your other searches later.</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Competitor URLs (one per line)</label>
                    <Textarea rows={4} placeholder={"https://competitor1.com\nhttps://competitor2.com"} value={form.competitor_urls} onChange={e => setForm(p => ({ ...p, competitor_urls: e.target.value }))} />
                    <p className="text-xs text-muted-foreground mt-1">Leave blank to auto-discover competitors from your own website instead.</p>
                  </div>
                  <Button className="w-full" onClick={handleScan} disabled={scanning || !selectedSite}>
                    {scanning ? <><Loader2 size={14} className="mr-2 animate-spin" />Scanning…</> : <><TrendingUp size={14} className="mr-2" />Run Search</>}
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><Shield size={16} />Disavow File</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-muted-foreground">Auto-generate a disavow file for all low-DA (&lt;20) domains.</p>
                  <Button variant="outline" className="w-full" onClick={handleGenerateDisavow}>Generate Disavow</Button>
                  {disavow?.content && (
                    <div className="relative">
                      <Textarea rows={6} readOnly value={disavow.content} className="font-mono text-xs" />
                      <CopyBtn text={disavow.content} />
                      <p className="text-xs text-muted-foreground mt-1">{disavow.domain_count} domains</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="lg:col-span-2 space-y-4">
              {/* Search picker + filters */}
              <Card>
                <CardContent className="pt-4 space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Filter size={13} className="text-muted-foreground shrink-0" />
                    <Select value={activeSearch} onValueChange={setActiveSearch}>
                      <SelectTrigger className="h-8 text-xs w-[230px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All searches ({searches.length})</SelectItem>
                        {searches.map(s => <SelectItem key={s.id} value={s.id}>{searchLabel(s)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <div className="relative flex-1 min-w-[150px]">
                      <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input className="h-8 text-xs pl-7" placeholder="Filter by domain…" value={query} onChange={e => setQuery(e.target.value)} />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Select value={fType} onValueChange={setFType}>
                      <SelectTrigger className="h-8 text-xs w-[165px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All types</SelectItem>
                        {OPP_TYPES.map(t => <SelectItem key={t} value={t}>{t.replace("_", " ")}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Select value={fMinDa} onValueChange={setFMinDa}>
                      <SelectTrigger className="h-8 text-xs w-[120px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Any DA</SelectItem>
                        <SelectItem value="20">DA 20+</SelectItem>
                        <SelectItem value="40">DA 40+</SelectItem>
                        <SelectItem value="60">DA 60+</SelectItem>
                        <SelectItem value="80">DA 80+</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={fContact} onValueChange={setFContact}>
                      <SelectTrigger className="h-8 text-xs w-[150px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Any contact</SelectItem>
                        <SelectItem value="yes">Has contact email</SelectItem>
                        <SelectItem value="no">No contact yet</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={fSort} onValueChange={setFSort}>
                      <SelectTrigger className="h-8 text-xs w-[150px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="created_desc">Newest first</SelectItem>
                        <SelectItem value="created_asc">Oldest first</SelectItem>
                        <SelectItem value="da_desc">Highest DA</SelectItem>
                        <SelectItem value="da_asc">Lowest DA</SelectItem>
                        <SelectItem value="relevance_desc">Most relevant</SelectItem>
                        <SelectItem value="domain_asc">Domain A–Z</SelectItem>
                      </SelectContent>
                    </Select>
                    {filtersActive && (
                      <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => {
                        setActiveSearch("all"); setFType("all"); setFMinDa("all"); setFContact("all"); setQuery("");
                      }}>Clear</Button>
                    )}
                  </div>
                  {activeSearchMeta && (
                    <p className="text-xs text-muted-foreground">
                      Showing the <span className="text-foreground font-medium">{activeSearchMeta.label}</span> search
                      {activeSearchMeta.competitor_urls?.length ? ` · ${activeSearchMeta.competitor_urls.length} competitor(s)` : ""}
                      {typeof activeSearchMeta.discovered_count === "number" ? ` · ${activeSearchMeta.discovered_count} found, ${activeSearchMeta.processed_count ?? 0} processed` : ""}
                      {activeSearchMeta.duplicate_count ? ` · ${activeSearchMeta.duplicate_count} already tracked from an earlier search` : ""}
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-3">
                  <CardTitle className="text-base">Opportunities ({opportunities.length})</CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge className="bg-emerald-500/10 text-emerald-400 text-xs">{acquired} acquired</Badge>
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleExportExcel} disabled={exporting || !selectedSite}>
                      {exporting ? <Loader2 size={12} className="mr-1 animate-spin" /> : <Download size={12} className="mr-1" />}Export
                    </Button>
                    <Button variant="ghost" size="sm" onClick={loadOpportunities} disabled={loading}><RefreshCw size={12} className={loading ? "animate-spin" : ""} /></Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <Tabs defaultValue="all">
                    <TabsList className="mb-3">
                      {["all", "new", "contacted", "replied", "acquired"].map(t => (
                        <TabsTrigger key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</TabsTrigger>
                      ))}
                    </TabsList>
                    {["all", "new", "contacted", "replied", "acquired"].map(tab => (
                      <TabsContent key={tab} value={tab}>
                        <div className="space-y-2 max-h-[520px] overflow-y-auto">
                          {opportunities.filter(o => tab === "all" || o.status === tab).map(opp => (
                            <div key={opp.id} className="p-3 rounded-lg border hover:bg-muted/20">
                              <div className="flex items-start gap-3">
                                <div className="flex-1 min-w-0">
                                  <p className="font-medium text-sm truncate">{opp.prospect_domain}</p>
                                  <p className="text-xs text-muted-foreground mt-0.5">{opp.reason}</p>
                                  {opp.backlink_url && (
                                    <a href={opp.backlink_url} target="_blank" rel="noopener noreferrer"
                                       className="text-xs text-primary hover:underline flex items-center gap-1 mt-0.5 truncate">
                                      <Link2 size={10} className="shrink-0" />{opp.backlink_url}
                                    </a>
                                  )}
                                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                    <Badge className={`text-xs ${typeColors[opp.opportunity_type] || ""}`}>{(opp.opportunity_type || "").replace("_", " ")}</Badge>
                                    <span className="text-xs text-muted-foreground">DA ~{opp.estimated_da}</span>
                                    <span className="text-xs text-muted-foreground">Relevance: {opp.relevance_score}/10</span>
                                    {(opp.search_ids?.length > 1) && (
                                      <Badge className="text-[10px] bg-muted text-muted-foreground">in {opp.search_ids.length} searches</Badge>
                                    )}
                                  </div>
                                  <div className="mt-1">
                                    {opp.recipient_email ? (
                                      <span className="text-xs text-amber-500/90 flex items-center gap-1">
                                        <UserCheck size={10} />Suggested: {opp.recipient_email}
                                        {opp.recipient_email_confidence != null && ` (${opp.recipient_email_confidence}%)`}
                                      </span>
                                    ) : (
                                      <span className="text-xs text-muted-foreground">No contact found — add one in Outreach Approvals</span>
                                    )}
                                  </div>
                                  {opp.approach_steps?.length > 0 && (
                                    <div className="mt-2">
                                      <button
                                        className="text-xs text-primary hover:underline flex items-center gap-1"
                                        onClick={() => setExpanded(p => ({ ...p, [opp.id]: !p[opp.id] }))}
                                      >
                                        <ListChecks size={11} />{expanded[opp.id] ? "Hide" : "How to approach this"}
                                      </button>
                                      {expanded[opp.id] && (
                                        <ol className="mt-2 space-y-1.5 pl-1">
                                          {opp.approach_steps.map((step, i) => (
                                            <li key={i} className="text-xs text-muted-foreground flex gap-2">
                                              <span className="shrink-0 w-4 h-4 rounded-full bg-muted text-[9px] flex items-center justify-center mt-0.5">{i + 1}</span>
                                              <span>{step}</span>
                                            </li>
                                          ))}
                                        </ol>
                                      )}
                                    </div>
                                  )}
                                </div>
                                <div className="flex flex-col items-end gap-2 shrink-0">
                                  <Badge className={`text-xs ${statusColors[opp.status]}`}>{opp.status}</Badge>
                                  <div className="flex gap-1">
                                    <Button variant="outline" size="sm" className="h-6 text-xs px-2" onClick={() => handleGenerateEmail(opp)} disabled={generatingEmail}>
                                      <Mail size={10} className="mr-1" />{opp.email_content ? "View Email" : "Draft Email"}
                                    </Button>
                                    <Select value={opp.status} onValueChange={val => handleStatusChange(opp.id, val)}>
                                      <SelectTrigger className="h-6 text-xs px-2 w-28"><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        {["new","contacted","replied","acquired","rejected"].map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                          {opportunities.filter(o => tab === "all" || o.status === tab).length === 0 && (
                            <div className="text-center py-8">
                              <Link2 size={32} className="mx-auto mb-2 text-muted-foreground opacity-40" />
                              <p className="text-sm text-muted-foreground">No {tab === "all" ? "" : tab} opportunities {filtersActive ? "match these filters" : "yet"}</p>
                            </div>
                          )}
                        </div>
                      </TabsContent>
                    ))}
                  </Tabs>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* ───────────────── DIRECTORIES ───────────────── */}
        <TabsContent value="directories">
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><ListChecks size={16} />How this works</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  These directories list you when you sign up yourself — no outreach email, no editor to convince.
                  Everything except the final click on their form is automated here: the listing copy, the deep link,
                  status tracking, and a real Google check that your listing actually went live.
                </p>
                <ol className="space-y-1.5">
                  {(dirData?.steps || []).map((step, i) => (
                    <li key={i} className="text-xs text-muted-foreground flex gap-2">
                      <span className="shrink-0 w-4 h-4 rounded-full bg-muted text-[9px] flex items-center justify-center mt-0.5">{i + 1}</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
                {dirData && !dirData.profile_ready && (
                  <div className="p-2 rounded border border-amber-500/30 bg-amber-500/5">
                    <p className="text-xs text-amber-500">
                      No verified Company Profile yet. Fill it in under Local SEO → Company Profile and mark it verified —
                      listing copy is generated only from confirmed facts, so nothing can be prepared until then.
                    </p>
                  </div>
                )}
                {dirData && !dirData.verification_available && (
                  <p className="text-xs text-muted-foreground">
                    Google Custom Search isn't configured, so listings can be tracked but not automatically verified as live.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <CardTitle className="text-base">Directories ({dirData?.directories?.length || 0})</CardTitle>
                  {dirData?.counts && (
                    <>
                      <Badge className={`text-xs ${dirStatusColors.live}`}>{dirData.counts.live || 0} live</Badge>
                      <Badge className={`text-xs ${dirStatusColors.submitted}`}>{dirData.counts.submitted || 0} submitted</Badge>
                      <Badge className={`text-xs ${dirStatusColors.prepared}`}>{dirData.counts.prepared || 0} prepared</Badge>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleVerifyAll} disabled={verifyingAll || !selectedSite}>
                    {verifyingAll ? <Loader2 size={12} className="mr-1 animate-spin" /> : <CheckCircle2 size={12} className="mr-1" />}Verify all
                  </Button>
                  <Button variant="ghost" size="sm" onClick={loadDirectories} disabled={dirLoading}><RefreshCw size={12} className={dirLoading ? "animate-spin" : ""} /></Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {(dirData?.directories || []).map(d => (
                    <div key={d.id} className="p-3 rounded-lg border hover:bg-muted/20">
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-medium text-sm">{d.name}</p>
                            <Badge className="text-[10px] bg-muted text-muted-foreground">DA ~{d.approx_da} (est.)</Badge>
                            <span className="text-xs text-muted-foreground">{d.category}</span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">{d.notes}</p>
                          {d.listing_url && (
                            <a href={d.listing_url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1 mt-1 truncate">
                              <ExternalLink size={10} className="shrink-0" />{d.listing_url}
                            </a>
                          )}
                          {d.last_verify_result?.note && (
                            <p className="text-[11px] text-muted-foreground mt-1 italic">{d.last_verify_result.note}</p>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-2 shrink-0">
                          <Badge className={`text-xs ${dirStatusColors[d.status] || ""}`}>{(d.status || "").replace("_", " ")}</Badge>
                          <div className="flex gap-1 flex-wrap justify-end">
                            <Button variant="outline" size="sm" className="h-6 text-xs px-2"
                              onClick={() => d.listing_content ? setOpenDir(d) : handlePrepare(d.id)}
                              disabled={busyDir === d.id || (dirData && !dirData.profile_ready)}>
                              {busyDir === d.id ? <Loader2 size={10} className="mr-1 animate-spin" /> : <Sparkles size={10} className="mr-1" />}
                              {d.listing_content ? "View copy" : "Prepare"}
                            </Button>
                            <Button variant="outline" size="sm" className="h-6 text-xs px-2" asChild>
                              <a href={d.submission_url} target="_blank" rel="noopener noreferrer">
                                <ExternalLink size={10} className="mr-1" />Open
                              </a>
                            </Button>
                            <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={() => handleVerify(d.id)} disabled={busyDir === d.id}>
                              <CheckCircle2 size={10} className="mr-1" />Verify
                            </Button>
                            <Select value={d.status} onValueChange={val => handleDirStatus(d.id, val)}>
                              <SelectTrigger className="h-6 text-xs px-2 w-28"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {["not_started","prepared","submitted","live","rejected"].map(s => (
                                  <SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {!dirLoading && !(dirData?.directories || []).length && (
                    <div className="text-center py-8">
                      <Building2 size={32} className="mx-auto mb-2 text-muted-foreground opacity-40" />
                      <p className="text-sm text-muted-foreground">No directories loaded</p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={!!emailDialog} onOpenChange={() => setEmailDialog(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Outreach Email — {emailDialog?.prospect_domain}</DialogTitle></DialogHeader>
          {emailDialog?.email && (
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Subject</label>
                <div className="flex gap-2 items-center p-2 rounded bg-muted/30">
                  <p className="text-sm flex-1">{emailDialog.email.subject}</p>
                  <CopyBtn text={emailDialog.email.subject} />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Body</label>
                <div className="relative">
                  <Textarea rows={10} readOnly value={emailDialog.email.body} />
                  <div className="absolute top-2 right-2"><CopyBtn text={emailDialog.email.body} /></div>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!openDir} onOpenChange={() => setOpenDir(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Listing copy — {openDir?.name}</DialogTitle></DialogHeader>
          {openDir?.listing_content && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Generated from your verified Company Profile only — no invented services, clients or numbers.
                Paste these into {openDir.name}'s form, keeping name/address/phone identical across every directory.
              </p>
              <Field label="Business name" value={openDir.listing_content.business_name} />
              <Field label="Website" value={openDir.listing_content.website} />
              <Field label="Tagline" value={openDir.listing_content.tagline} />
              <Field label="Short description" value={openDir.listing_content.short_description} />
              <Field label="Medium description" value={openDir.listing_content.medium_description} />
              <Field label="Long description" value={openDir.listing_content.long_description} />
              <Field label="Categories" value={openDir.listing_content.categories} />
              <Field label="Tags" value={openDir.listing_content.tags} />
              <Field label="Address" value={openDir.listing_content.address} />
              <Field label="Phone" value={openDir.listing_content.phone} />
              <div className="flex gap-2 pt-2">
                <Button size="sm" className="flex-1" asChild>
                  <a href={openDir.submission_url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink size={12} className="mr-1.5" />Open submission page
                  </a>
                </Button>
                <Button size="sm" variant="outline" className="flex-1" onClick={() => { handleDirStatus(openDir.id, "submitted"); setOpenDir(null); }}>
                  Mark submitted
                </Button>
                <Button size="sm" variant="ghost" onClick={() => handlePrepare(openDir.id)} disabled={busyDir === openDir.id}>
                  {busyDir === openDir.id ? <Loader2 size={12} className="animate-spin" /> : "Regenerate"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
