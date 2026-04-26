import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Hash, Plus, Trash2, RefreshCw, Sparkles, Loader2,
  TrendingUp, TrendingDown, Minus, ChevronUp, ChevronDown,
  AlertTriangle, DollarSign, Target, ArrowUp, ArrowDown, ArrowRight
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "../components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "../components/ui/dialog";
import { Label } from "../components/ui/label";
import { toast } from "sonner";
import {
  getSites, getTrackedKeywordsV2, addTrackedKeyword, deleteTrackedKeyword,
  suggestKeywords, refreshKeywordRankings, subscribeToTask, categorizeKeywords,
  detectCannibalization, getKeywordROI, getRankPredictions, checkLiveRankings,
} from "../lib/api";

const DiffBadge = ({ difficulty }) => {
  const map = { low: "bg-emerald-500/10 text-emerald-500", medium: "bg-yellow-500/10 text-yellow-500", high: "bg-red-500/10 text-red-500" };
  return <Badge className={`text-xs ${map[difficulty] || map.medium}`}>{difficulty}</Badge>;
};

const IntentBadge = ({ intent }) => {
  const map = {
    informational: "bg-blue-500/10 text-blue-500 border-blue-500/20",
    navigational: "bg-slate-500/10 text-slate-400 border-slate-500/20",
    transactional: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
    commercial: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  };
  if (!intent) return <span className="text-xs text-muted-foreground">—</span>;
  return <Badge className={`text-[10px] px-1.5 capitalize ${map[intent] || "bg-muted text-muted-foreground"}`}>{intent}</Badge>;
};

const RankChange = ({ current, previous }) => {
  if (current == null) return <span className="text-muted-foreground text-xs">–</span>;
  if (previous == null) return <span className="text-xs text-muted-foreground">New</span>;
  const diff = previous - current; // positive = improved (rank went down number-wise)
  if (diff > 0) return <span className="flex items-center gap-1 text-xs text-emerald-500"><TrendingUp size={12} />+{diff}</span>;
  if (diff < 0) return <span className="flex items-center gap-1 text-xs text-red-500"><TrendingDown size={12} />{diff}</span>;
  return <span className="flex items-center gap-1 text-xs text-muted-foreground"><Minus size={12} />–</span>;
};

export default function KeywordTracking() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [keywords, setKeywords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [addOpen, setAddOpen] = useState(false);
  const [newKw, setNewKw] = useState({ keyword: "", difficulty: "medium", search_volume: "" });
  const [adding, setAdding] = useState(false);
  const [categorizing, setCategorizing] = useState(false);
  const [intentFilter, setIntentFilter] = useState("all");
  const [activeTab, setActiveTab] = useState("tracking");

  // Cannibalization
  const [cannibLoading, setCannibLoading] = useState(false);
  const [cannibResults, setCannibResults] = useState(null);
  // Keyword ROI
  const [roiLoading, setRoiLoading] = useState(false);
  const [roiData, setRoiData] = useState(null);
  // Rank Predictions
  const [predLoading, setPredLoading] = useState(false);
  const [predictions, setPredictions] = useState(null);
  // Live Rank Check (DataForSEO)
  const [liveChecking, setLiveChecking] = useState(false);
  const [liveRankResults, setLiveRankResults] = useState(null);

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSite) loadKeywords();
  }, [selectedSite]);

  const loadKeywords = async () => {
    setLoading(true);
    try {
      const r = await getTrackedKeywordsV2(selectedSite);
      setKeywords(r.data);
    } catch { setKeywords([]); }
    finally { setLoading(false); }
  };

  const handleAdd = async () => {
    if (!newKw.keyword.trim()) return;
    setAdding(true);
    try {
      const r = await addTrackedKeyword(selectedSite, {
        keyword: newKw.keyword.trim(),
        difficulty: newKw.difficulty,
        search_volume: newKw.search_volume ? parseInt(newKw.search_volume) : null,
      });
      setKeywords(prev => [...prev, r.data]);
      setAddOpen(false);
      setNewKw({ keyword: "", difficulty: "medium", search_volume: "" });
      toast.success("Keyword added");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to add keyword");
    } finally { setAdding(false); }
  };

  const handleDelete = async (kw) => {
    try {
      await deleteTrackedKeyword(selectedSite, kw.id);
      setKeywords(prev => prev.filter(k => k.id !== kw.id));
      toast.success("Keyword removed");
    } catch { toast.error("Failed to remove keyword"); }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    toast.info("Refreshing keyword rankings…");
    try {
      const r = await refreshKeywordRankings(selectedSite);
      const unsub = subscribeToTask(r.data.task_id, (ev) => {
        if (ev.type === "status" && ev.data?.step === ev.data?.total && ev.data?.total > 0) {
          unsub(); setRefreshing(false); loadKeywords(); toast.success("Rankings refreshed!");
        }
        if (ev.type === "error") { unsub(); setRefreshing(false); toast.error(ev.data?.message || "Refresh failed"); }
      });
    } catch (e) { toast.error(e.response?.data?.detail || "Refresh failed"); setRefreshing(false); }
  };

  const handleCategorize = async () => {
    setCategorizing(true);
    toast.info("Categorising keywords by intent…");
    try {
      const r = await categorizeKeywords(selectedSite, {});
      const unsub = subscribeToTask(r.data.task_id, (ev) => {
        if (ev.type === "status" && ev.data?.step === ev.data?.total && ev.data?.total > 0) {
          unsub(); setCategorizing(false); loadKeywords(); toast.success("Keywords categorised!");
        }
        if (ev.type === "error") { unsub(); setCategorizing(false); toast.error(ev.data?.message || "Categorisation failed"); }
      });
    } catch (e) { toast.error(e.response?.data?.detail || "Failed"); setCategorizing(false); }
  };

  const handleSuggest = async () => {
    setSuggesting(true);
    try {
      const r = await suggestKeywords(selectedSite, {});
      setSuggestions(r.data.keywords || []);
    } catch (e) { toast.error(e.response?.data?.detail || "Failed to get suggestions"); }
    finally { setSuggesting(false); }
  };

  const addSuggested = async (kw) => {
    try {
      const r = await addTrackedKeyword(selectedSite, kw);
      setKeywords(prev => [...prev, r.data]);
      setSuggestions(prev => prev.filter(s => s.keyword !== kw.keyword));
      toast.success("Keyword added");
    } catch (e) { toast.error(e.response?.data?.detail || "Already tracked"); }
  };

  const handleLiveCheck = async () => {
    if (!selectedSite || keywords.length === 0) return;
    setLiveChecking(true);
    try {
      const site = sites.find(s => s.id === selectedSite);
      const domain = site?.url ? new URL(site.url.startsWith('http') ? site.url : `https://${site.url}`).hostname : '';
      const r = await checkLiveRankings(selectedSite, {
        keywords: keywords.map(k => k.keyword),
        domain,
      });
      setLiveRankResults(r.data);
      // Merge live results back into keywords display
      const results = r.data?.results || [];
      setKeywords(prev => prev.map(kw => {
        const live = results.find(lr => lr.keyword === kw.keyword);
        if (live) return { ...kw, live_position: live.position, position_change: live.position_change, live_url: live.url, data_source: r.data?.data_source, last_checked: new Date().toISOString() };
        return kw;
      }));
      toast.success(`Live rankings checked — ${r.data?.data_source || 'done'}`);
    } catch (e) { toast.error(e.response?.data?.detail || 'Live rank check failed'); }
    finally { setLiveChecking(false); }
  };

  const handleCannibalization = async () => {
    setCannibLoading(true);
    try {
      const r = await detectCannibalization(selectedSite);
      setCannibResults(r.data?.conflicts || r.data || []);
    } catch (e) { toast.error(e.response?.data?.detail || "Cannibalization check failed"); }
    finally { setCannibLoading(false); }
  };

  const loadROI = async () => {
    setRoiLoading(true);
    try {
      const r = await getKeywordROI(selectedSite);
      setRoiData(r.data?.keywords || r.data || []);
    } catch (e) { toast.error(e.response?.data?.detail || "Failed to load ROI data"); }
    finally { setRoiLoading(false); }
  };

  const loadPredictions = async () => {
    setPredLoading(true);
    try {
      const r = await getRankPredictions(selectedSite);
      setPredictions(r.data?.predictions || r.data || []);
    } catch (e) { toast.error(e.response?.data?.detail || "Failed to load predictions"); }
    finally { setPredLoading(false); }
  };

  useEffect(() => {
    if (selectedSite && activeTab === "roi") loadROI();
    if (selectedSite && activeTab === "predictions") loadPredictions();
  }, [activeTab, selectedSite]); // eslint-disable-line

  return (
    <div className="page-container">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
            Keyword Tracking
          </motion.h1>
          <p className="page-description">Track rankings, monitor changes, and discover new keywords</p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Select site" /></SelectTrigger>
            <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={handleSuggest} disabled={suggesting || !selectedSite}>
            {suggesting ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Sparkles size={14} className="mr-1" />}
            AI Suggest
          </Button>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing || !selectedSite}>
            {refreshing ? <Loader2 size={14} className="mr-1 animate-spin" /> : <RefreshCw size={14} className="mr-1" />}
            Refresh Ranks
          </Button>
          <Button variant="outline" size="sm" onClick={handleLiveCheck} disabled={liveChecking || !selectedSite || keywords.length === 0} className="border-emerald-500/40 text-emerald-500 hover:bg-emerald-500/10">
            {liveChecking ? <Loader2 size={14} className="mr-1 animate-spin" /> : <TrendingUp size={14} className="mr-1" />}
            Check Live Rankings
          </Button>
          <Button variant="outline" size="sm" onClick={handleCategorize} disabled={categorizing || !selectedSite}>
            {categorizing ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Sparkles size={14} className="mr-1" />}
            Categorise All
          </Button>
          <Button className="btn-primary" size="sm" onClick={() => setAddOpen(true)} disabled={!selectedSite}>
            <Plus size={14} className="mr-1" /> Add Keyword
          </Button>
        </div>
      </div>

      {/* AI Suggestions */}
      {suggestions.length > 0 && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
          <Card className="content-card border-primary/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-heading flex items-center gap-2">
                <Sparkles size={15} className="text-primary" /> AI Keyword Suggestions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((s, i) => (
                  <button key={i} onClick={() => addSuggested(s)}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/5 text-xs hover:bg-primary/10 transition-colors">
                    <Plus size={10} />
                    <span>{s.keyword}</span>
                    <DiffBadge difficulty={s.difficulty} />
                    {s.search_volume && <span className="text-muted-foreground">{s.search_volume.toLocaleString()}/mo</span>}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Intent Filter */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="tracking"><Hash size={14} className="mr-1" /> Tracking</TabsTrigger>
          <TabsTrigger value="cannibalization"><AlertTriangle size={14} className="mr-1" /> Cannibalization</TabsTrigger>
          <TabsTrigger value="roi"><DollarSign size={14} className="mr-1" /> Keyword ROI</TabsTrigger>
          <TabsTrigger value="predictions"><Target size={14} className="mr-1" /> Rank Predictions</TabsTrigger>
        </TabsList>

        <TabsContent value="tracking" className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Filter by intent:</span>
        {["all", "informational", "navigational", "transactional", "commercial"].map(i => (
          <button key={i} onClick={() => setIntentFilter(i)}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors capitalize ${
              intentFilter === i
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}>
            {i === "all" ? "All" : i}
          </button>
        ))}
      </div>

      {/* Keywords Table */}
      <Card className="content-card">
        <CardHeader>
          <CardTitle className="font-heading flex items-center gap-2">
            <Hash size={18} className="text-primary" />
            Tracked Keywords
            <Badge variant="secondary" className="ml-auto">{keywords.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-12"><Loader2 size={28} className="animate-spin text-primary" /></div>
          ) : keywords.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Hash size={40} className="mx-auto mb-3 opacity-30" />
              <p>No keywords tracked yet. Add a keyword or use AI Suggest.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/40 text-muted-foreground text-xs">
                    <th className="text-left py-2 pr-4">Keyword</th>
                    <th className="text-center py-2 px-2">Intent</th>
                    <th className="text-center py-2 px-2">Current</th>
                    <th className="text-center py-2 px-2">Previous</th>
                    <th className="text-center py-2 px-2">Change</th>
                    <th className="text-center py-2 px-2">Volume</th>
                    <th className="text-center py-2 px-2">Difficulty</th>
                    <th className="text-center py-2 px-2">Source</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {keywords.filter(kw => intentFilter === "all" || kw.intent === intentFilter).map(kw => (
                    <tr key={kw.id} className="border-b border-border/20 hover:bg-muted/20 transition-colors">
                      <td className="py-2.5 pr-4 font-medium">{kw.keyword}</td>
                      <td className="text-center px-2"><IntentBadge intent={kw.intent} /></td>
                      <td className="text-center px-2">
                        {kw.live_position != null
                          ? <span className="font-bold text-emerald-500" title="Live DataForSEO">#{kw.live_position}</span>
                          : kw.current_rank != null
                          ? <span className="font-bold text-primary">#{kw.current_rank}</span>
                          : <span className="text-muted-foreground text-xs">–</span>}
                      </td>
                      <td className="text-center px-2 text-muted-foreground">
                        {kw.previous_rank != null ? `#${kw.previous_rank}` : "–"}
                      </td>
                      <td className="text-center px-2">
                        <RankChange current={kw.current_rank} previous={kw.previous_rank} />
                      </td>
                      <td className="text-center px-2 text-xs text-muted-foreground">
                        {kw.search_volume ? kw.search_volume.toLocaleString() : "–"}
                      </td>
                      <td className="text-center px-2"><DiffBadge difficulty={kw.difficulty} /></td>
                      <td className="text-center px-2">
                        {kw.data_source ? (
                          <span title={kw.last_checked ? `Checked: ${new Date(kw.last_checked).toLocaleString()}` : ''}>
                            <Badge className={`text-[10px] ${kw.data_source === 'dataforseo' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-blue-500/10 text-blue-500'}`}>
                              {kw.data_source === 'dataforseo' ? 'Live' : kw.data_source}
                            </Badge>
                          </span>
                        ) : <span className="text-xs text-muted-foreground">—</span>}
                      </td>
                      <td className="py-2 pl-2">
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-red-500"
                          onClick={() => handleDelete(kw)}>
                          <Trash2 size={13} />
                        </Button>
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

        {/* Cannibalization Tab */}
        <TabsContent value="cannibalization" className="space-y-4">
          <Card className="content-card">
            <CardHeader>
              <CardTitle className="font-heading flex items-center justify-between">
                <span className="flex items-center gap-2"><AlertTriangle size={18} className="text-amber-500" /> Keyword Cannibalization</span>
                <Button onClick={handleCannibalization} disabled={cannibLoading || !selectedSite} size="sm">
                  {cannibLoading ? <Loader2 size={14} className="mr-2 animate-spin" /> : <RefreshCw size={14} className="mr-2" />}
                  Run Cannibalization Check
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {cannibLoading ? (
                <div className="flex justify-center py-12"><Loader2 size={28} className="animate-spin text-primary" /></div>
              ) : !cannibResults ? (
                <div className="text-center py-12 text-muted-foreground">
                  <AlertTriangle size={40} className="mx-auto mb-3 opacity-30" />
                  <p>Click "Run Cannibalization Check" to detect keyword conflicts across your pages.</p>
                </div>
              ) : cannibResults.length === 0 ? (
                <div className="text-center py-12">
                  <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-500/10 text-emerald-500">
                    <Hash size={16} /> No cannibalization issues found
                  </div>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Primary Keyword</TableHead>
                      <TableHead>Conflicting Pages</TableHead>
                      <TableHead className="w-[160px]">Recommendation</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cannibResults.map((item, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-medium">{item.keyword}</TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            {(item.conflicting_pages || item.pages || []).map((url, j) => (
                              <span key={j} className="block text-xs text-amber-500 truncate max-w-[300px]">{url}</span>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge className="text-xs bg-amber-500/10 text-amber-500 border-amber-500/20">
                            {item.recommendation || "Review"}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Keyword ROI Tab */}
        <TabsContent value="roi" className="space-y-4">
          <Card className="content-card">
            <CardHeader>
              <CardTitle className="font-heading flex items-center gap-2">
                <DollarSign size={18} className="text-primary" /> Keyword ROI Attribution
              </CardTitle>
            </CardHeader>
            <CardContent>
              {roiLoading ? (
                <div className="flex justify-center py-12"><Loader2 size={28} className="animate-spin text-primary" /></div>
              ) : !roiData ? (
                <div className="text-center py-12 text-muted-foreground">
                  <DollarSign size={40} className="mx-auto mb-3 opacity-30" />
                  <p>Loading ROI data...</p>
                </div>
              ) : roiData.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <DollarSign size={40} className="mx-auto mb-3 opacity-30" />
                  <p>No keyword ROI data available yet.</p>
                </div>
              ) : roiData.every(k => !k.revenue || k.revenue === 0) ? (
                <div className="text-center py-8">
                  <Card className="inline-block border-blue-500/30 bg-blue-500/5">
                    <CardContent className="p-4 text-sm text-blue-400">
                      Connect Revenue Dashboard to see attribution data
                    </CardContent>
                  </Card>
                </div>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Keyword</TableHead>
                        <TableHead className="w-[80px]">Position</TableHead>
                        <TableHead>Page URL</TableHead>
                        <TableHead className="text-right w-[120px]">Revenue</TableHead>
                        <TableHead className="text-right w-[100px]">Conversions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...roiData].sort((a, b) => (b.revenue || 0) - (a.revenue || 0)).map((kw, i) => (
                        <TableRow key={i}>
                          <TableCell className="font-medium">{kw.keyword}</TableCell>
                          <TableCell className="font-bold text-primary">#{kw.current_position || kw.position || "—"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground truncate max-w-[200px]">{kw.page_url || "—"}</TableCell>
                          <TableCell className="text-right font-mono text-emerald-500">${(kw.revenue || 0).toLocaleString()}</TableCell>
                          <TableCell className="text-right font-mono">{kw.conversions || 0}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <div className="mt-3 text-right text-sm font-medium text-emerald-500">
                    Total Revenue: ${roiData.reduce((sum, k) => sum + (k.revenue || 0), 0).toLocaleString()}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Rank Predictions Tab */}
        <TabsContent value="predictions" className="space-y-4">
          <Card className="content-card">
            <CardHeader>
              <CardTitle className="font-heading flex items-center gap-2">
                <Target size={18} className="text-primary" /> Rank Predictions (30-Day)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {predLoading ? (
                <div className="flex justify-center py-12"><Loader2 size={28} className="animate-spin text-primary" /></div>
              ) : !predictions ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Target size={40} className="mx-auto mb-3 opacity-30" />
                  <p>Loading rank predictions...</p>
                </div>
              ) : predictions.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Target size={40} className="mx-auto mb-3 opacity-30" />
                  <p>No prediction data available. Track keywords and refresh rankings to generate predictions.</p>
                </div>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground mb-3">
                    Predictions based on last 30 days of ranking history using linear regression
                  </p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Keyword</TableHead>
                        <TableHead className="w-[100px]">Current</TableHead>
                        <TableHead className="w-[120px]">Predicted (30d)</TableHead>
                        <TableHead className="w-[80px]">Trend</TableHead>
                        <TableHead className="text-right w-[100px]">Confidence</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {predictions.map((p, i) => {
                        const current = p.current_position || p.current_rank;
                        const predicted = p.predicted_position || p.predicted_rank;
                        const improving = predicted != null && current != null && predicted < current;
                        const declining = predicted != null && current != null && predicted > current;
                        const trendColor = improving ? "text-emerald-500" : declining ? "text-red-500" : "text-muted-foreground";
                        const rowBg = improving ? "bg-emerald-500/5" : declining ? "bg-red-500/5" : "";
                        return (
                          <TableRow key={i} className={rowBg}>
                            <TableCell className="font-medium">{p.keyword}</TableCell>
                            <TableCell className="font-bold text-primary">#{current || "—"}</TableCell>
                            <TableCell className={`font-bold ${trendColor}`}>#{predicted || "—"}</TableCell>
                            <TableCell>
                              <span className={`flex items-center gap-1 ${trendColor}`}>
                                {improving ? <><ArrowUp size={14} /> ↑</> : declining ? <><ArrowDown size={14} /> ↓</> : <><ArrowRight size={14} /> →</>}
                              </span>
                            </TableCell>
                            <TableCell className="text-right">
                              <Badge variant="outline" className="text-xs">{p.confidence ? `${Math.round(p.confidence)}%` : "—"}</Badge>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Add Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle className="font-heading">Add Keyword</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>Keyword</Label>
              <Input placeholder="e.g. best coffee shops" value={newKw.keyword}
                onChange={e => setNewKw(p => ({ ...p, keyword: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Difficulty</Label>
              <Select value={newKw.difficulty} onValueChange={v => setNewKw(p => ({ ...p, difficulty: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Est. Monthly Search Volume (optional)</Label>
              <Input type="number" placeholder="1000" value={newKw.search_volume}
                onChange={e => setNewKw(p => ({ ...p, search_volume: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button className="btn-primary" onClick={handleAdd} disabled={adding || !newKw.keyword.trim()}>
              {adding ? <Loader2 size={14} className="mr-1 animate-spin" /> : null} Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
