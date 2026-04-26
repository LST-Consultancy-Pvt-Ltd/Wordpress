import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Search, Loader2, TrendingUp, Hash, DollarSign,
  Save, Sparkles, BarChart3, HelpCircle, Globe
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "../components/ui/table";
import { ScrollArea } from "../components/ui/scroll-area";
import { getSites, researchKeyword, addTrackedKeyword, getKeywordTrends, getKeywordMetrics, getKeywordIdeas, getSERPAnalysis } from "../lib/api";
import { toast } from "sonner";

const DiffBadge = ({ difficulty }) => {
  const map = { low: "bg-emerald-500/10 text-emerald-500", medium: "bg-yellow-500/10 text-yellow-500", high: "bg-red-500/10 text-red-500" };
  return <Badge className={`text-xs ${map[difficulty] || map.medium}`}>{difficulty}</Badge>;
};

const IntentBadge = ({ intent }) => {
  const map = {
    informational: "bg-blue-500/10 text-blue-500",
    navigational: "bg-slate-500/10 text-slate-400",
    transactional: "bg-emerald-500/10 text-emerald-500",
    commercial: "bg-amber-500/10 text-amber-500",
  };
  if (!intent) return <span className="text-xs text-muted-foreground">—</span>;
  return <Badge className={`text-[10px] px-1.5 capitalize ${map[intent] || "bg-muted text-muted-foreground"}`}>{intent}</Badge>;
};

export default function KeywordResearch() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [keyword, setKeyword] = useState("");
  const [researching, setResearching] = useState(false);
  const [result, setResult] = useState(null);
  const [savingKeyword, setSavingKeyword] = useState(null);

  // Trends tab state
  const [trendsKeywords, setTrendsKeywords] = useState("");
  const [trendsTimeframe, setTrendsTimeframe] = useState("today 12-m");
  const [trendsLoading, setTrendsLoading] = useState(false);
  const [trendsResults, setTrendsResults] = useState(null);

  // Live metrics (DataForSEO)
  const [liveMetrics, setLiveMetrics] = useState(null);
  const [liveMetricsLoading, setLiveMetricsLoading] = useState(false);
  // Keyword ideas (DataForSEO)
  const [keywordIdeas, setKeywordIdeas] = useState(null);
  const [ideasLoading, setIdeasLoading] = useState(false);
  // SERP preview (DataForSEO)
  const [serpData, setSerpData] = useState(null);
  const [serpLoading, setSerpLoading] = useState(false);

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  const handleResearch = async () => {
    if (!keyword.trim()) { toast.error("Enter a keyword"); return; }
    setResearching(true);
    setResult(null);
    setLiveMetrics(null);
    setKeywordIdeas(null);
    setSerpData(null);
    try {
      const r = await researchKeyword(selectedSite, { keyword: keyword.trim() });
      setResult(r.data);
      toast.success("Keyword research complete");

      // Fire off live data fetches in parallel (non-blocking)
      setLiveMetricsLoading(true);
      setIdeasLoading(true);
      setSerpLoading(true);

      getKeywordMetrics(selectedSite, { keywords: [keyword.trim()] })
        .then(res => setLiveMetrics(res.data))
        .catch(() => {})
        .finally(() => setLiveMetricsLoading(false));

      getKeywordIdeas(selectedSite, { seed_keyword: keyword.trim(), limit: 30 })
        .then(res => setKeywordIdeas(res.data))
        .catch(() => {})
        .finally(() => setIdeasLoading(false));

      getSERPAnalysis(selectedSite, { keyword: keyword.trim() })
        .then(res => setSerpData(res.data))
        .catch(() => {})
        .finally(() => setSerpLoading(false));
    } catch (e) {
      toast.error(e.response?.data?.detail || "Research failed");
    } finally { setResearching(false); }
  };

  const handleSaveKeyword = async (kw) => {
    setSavingKeyword(kw.keyword);
    try {
      await addTrackedKeyword(selectedSite, {
        keyword: kw.keyword,
        difficulty: kw.difficulty || "medium",
        search_volume: kw.volume || null,
      });
      toast.success(`"${kw.keyword}" saved to Keyword Tracking`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to save");
    } finally { setSavingKeyword(null); }
  };

  const handleAnalyzeTrends = async () => {
    const kws = trendsKeywords.split(",").map(k => k.trim()).filter(Boolean).slice(0, 5);
    if (kws.length === 0) { toast.error("Enter at least one keyword"); return; }
    setTrendsLoading(true);
    setTrendsResults(null);
    try {
      const r = await getKeywordTrends(selectedSite, { keywords: kws, timeframe: trendsTimeframe });
      setTrendsResults(r.data?.trends || r.data || []);
      toast.success("Trends analysis complete");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Trends analysis failed");
    } finally { setTrendsLoading(false); }
  };

  const KeywordTable = ({ keywords, showSave = true }) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Keyword</TableHead>
          <TableHead className="w-[90px]">Volume</TableHead>
          <TableHead className="w-[90px]">Difficulty</TableHead>
          <TableHead className="w-[80px]">CPC</TableHead>
          <TableHead className="w-[90px]">Competition</TableHead>
          <TableHead className="w-[90px]">Intent</TableHead>
          {showSave && <TableHead className="w-[60px]" />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {keywords.map((kw, i) => (
          <TableRow key={i}>
            <TableCell className="font-medium">{kw.keyword}</TableCell>
            <TableCell><span className="font-mono text-xs">{kw.volume?.toLocaleString() ?? "—"}</span></TableCell>
            <TableCell><DiffBadge difficulty={kw.difficulty} /></TableCell>
            <TableCell><span className="font-mono text-xs">{kw.cpc ? `$${kw.cpc}` : "—"}</span></TableCell>
            <TableCell><span className="text-xs capitalize">{kw.competition || "—"}</span></TableCell>
            <TableCell><IntentBadge intent={kw.intent} /></TableCell>
            {showSave && (
              <TableCell>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  disabled={savingKeyword === kw.keyword}
                  onClick={() => handleSaveKeyword(kw)}
                  title="Save to Keyword Tracking"
                >
                  {savingKeyword === kw.keyword ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                </Button>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-heading font-bold flex items-center gap-3">
            <Search className="text-primary" /> Keyword Research
          </h1>
          <p className="text-muted-foreground mt-1">Discover high-value keywords with AI-powered research</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[220px]"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>
            {sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name || s.url}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* Search bar */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-3">
            <Input
              placeholder="Enter a seed keyword (e.g., 'best running shoes')..."
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleResearch()}
              className="flex-1"
            />
            <Button onClick={handleResearch} disabled={researching || !keyword.trim()}>
              {researching ? <><Loader2 size={14} className="animate-spin mr-2" /> Researching...</> : <><Sparkles size={14} className="mr-2" /> Research</>}
            </Button>
          </div>
        </CardContent>
      </Card>

      {result && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
          {/* Data source badge */}
          <div className="flex items-center gap-2">
            {result.data_source === "dataforseo" ? (
              <Badge className="bg-emerald-500/10 text-emerald-500">Live Data — DataForSEO</Badge>
            ) : result.data_source === "dataforseo_cached" ? (
              <Badge className="bg-blue-500/10 text-blue-500">Cached Data — DataForSEO</Badge>
            ) : (
              <Badge className="bg-yellow-500/10 text-yellow-500">AI Estimated</Badge>
            )}
          </div>

          {/* Overview cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><Hash size={14} /> Volume</div>
                <p className="text-2xl font-bold mt-1">{result.primary?.volume?.toLocaleString() ?? "—"}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><BarChart3 size={14} /> Difficulty</div>
                <p className="text-2xl font-bold mt-1 capitalize">{result.primary?.keyword_difficulty != null ? `${result.primary.keyword_difficulty}/100` : (result.primary?.difficulty || "—")}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><DollarSign size={14} /> CPC</div>
                <p className="text-2xl font-bold mt-1">{result.primary?.cpc ? `$${Number(result.primary.cpc).toFixed(2)}` : "—"}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><TrendingUp size={14} /> Intent</div>
                <p className="text-2xl font-bold mt-1 capitalize">{result.primary?.intent || "—"}</p>
              </CardContent>
            </Card>
          </div>

          {/* Live Metrics Card (DataForSEO) */}
          {(liveMetricsLoading || liveMetrics) && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <BarChart3 size={16} /> Live Keyword Metrics
                  {liveMetrics?.data_source === "dataforseo" && <Badge className="bg-emerald-500/10 text-emerald-500 text-[10px]">DataForSEO Live</Badge>}
                  {liveMetrics?.data_source === "dataforseo_cached" && <Badge className="bg-blue-500/10 text-blue-500 text-[10px]">Cached</Badge>}
                  {liveMetrics?.is_estimated && <Badge className="bg-yellow-500/10 text-yellow-500 text-[10px]">AI Estimate</Badge>}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {liveMetricsLoading ? (
                  <div className="flex items-center justify-center py-6"><Loader2 className="animate-spin mr-2" size={16} /> Fetching live data...</div>
                ) : liveMetrics?.items?.[0] ? (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="p-3 rounded-lg bg-muted/30">
                        <p className="text-xs text-muted-foreground">Search Volume</p>
                        <p className="text-xl font-bold font-mono">{liveMetrics.items[0].search_volume?.toLocaleString() ?? "—"}</p>
                      </div>
                      <div className="p-3 rounded-lg bg-muted/30">
                        <p className="text-xs text-muted-foreground">CPC</p>
                        <p className="text-xl font-bold font-mono">${Number(liveMetrics.items[0].cpc || 0).toFixed(2)}</p>
                      </div>
                      <div className="p-3 rounded-lg bg-muted/30">
                        <p className="text-xs text-muted-foreground">Competition</p>
                        <Badge className={`mt-1 ${liveMetrics.items[0].competition_level === "HIGH" ? "bg-red-500/10 text-red-500" : liveMetrics.items[0].competition_level === "MEDIUM" ? "bg-yellow-500/10 text-yellow-500" : "bg-emerald-500/10 text-emerald-500"}`}>
                          {liveMetrics.items[0].competition_level || "—"}
                        </Badge>
                      </div>
                      <div className="p-3 rounded-lg bg-muted/30">
                        <p className="text-xs text-muted-foreground">Keyword Difficulty</p>
                        <p className="text-xl font-bold font-mono">{liveMetrics.items[0].keyword_difficulty ?? "—"}/100</p>
                      </div>
                    </div>
                    {liveMetrics.items[0].monthly_searches?.length > 0 && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-2">Monthly Trend (last 12 months)</p>
                        <div className="flex items-end gap-1 h-16">
                          {liveMetrics.items[0].monthly_searches.slice(-12).map((m, i) => {
                            const maxVol = Math.max(...liveMetrics.items[0].monthly_searches.slice(-12).map(x => x.search_volume || 0));
                            const pct = maxVol > 0 ? ((m.search_volume || 0) / maxVol) * 100 : 0;
                            return <div key={i} className="flex-1 bg-primary/20 hover:bg-primary/40 rounded-t transition-colors" style={{ height: `${Math.max(pct, 4)}%` }} title={`${m.year}-${String(m.month).padStart(2, "0")}: ${(m.search_volume || 0).toLocaleString()}`} />;
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          )}

          {/* Tabs */}
          <Tabs defaultValue="related">
            <TabsList>
              <TabsTrigger value="related"><Search size={14} className="mr-1" /> Related Keywords</TabsTrigger>
              <TabsTrigger value="ideas"><Sparkles size={14} className="mr-1" /> Keyword Ideas</TabsTrigger>
              <TabsTrigger value="questions"><HelpCircle size={14} className="mr-1" /> Questions</TabsTrigger>
              <TabsTrigger value="serp"><Globe size={14} className="mr-1" /> SERP Preview</TabsTrigger>
              <TabsTrigger value="trends"><TrendingUp size={14} className="mr-1" /> Trends</TabsTrigger>
            </TabsList>

            <TabsContent value="related" className="mt-4">
              <Card>
                <CardContent className="pt-6">
                  {result.related && result.related.length > 0 ? (
                    <ScrollArea className="h-[400px]">
                      <KeywordTable keywords={result.related} />
                    </ScrollArea>
                  ) : (
                    <p className="text-center text-muted-foreground py-8">No related keywords found</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Keyword Ideas from DataForSEO */}
            <TabsContent value="ideas" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    Keyword Ideas
                    {keywordIdeas?.data_source === "dataforseo" && <Badge className="bg-emerald-500/10 text-emerald-500 text-[10px]">Live Data</Badge>}
                    {keywordIdeas?.is_estimated && <Badge className="bg-yellow-500/10 text-yellow-500 text-[10px]">AI Estimate</Badge>}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {ideasLoading ? (
                    <div className="flex items-center justify-center py-8"><Loader2 className="animate-spin mr-2" size={16} /> Fetching keyword ideas...</div>
                  ) : keywordIdeas?.items?.length > 0 ? (
                    <ScrollArea className="h-[400px]">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Keyword</TableHead>
                            <TableHead className="w-[90px]">Volume</TableHead>
                            <TableHead className="w-[80px]">CPC</TableHead>
                            <TableHead className="w-[90px]">Competition</TableHead>
                            <TableHead className="w-[90px]">Intent</TableHead>
                            <TableHead className="w-[60px]" />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {keywordIdeas.items.map((kw, i) => (
                            <TableRow key={i}>
                              <TableCell className="font-medium">{kw.keyword}</TableCell>
                              <TableCell><span className="font-mono text-xs">{kw.search_volume?.toLocaleString() ?? "—"}</span></TableCell>
                              <TableCell><span className="font-mono text-xs">{kw.cpc ? `$${Number(kw.cpc).toFixed(2)}` : "—"}</span></TableCell>
                              <TableCell>
                                <Badge className={`text-[10px] ${kw.competition_level === "HIGH" ? "bg-red-500/10 text-red-500" : kw.competition_level === "MEDIUM" ? "bg-yellow-500/10 text-yellow-500" : "bg-emerald-500/10 text-emerald-500"}`}>
                                  {kw.competition_level || "—"}
                                </Badge>
                              </TableCell>
                              <TableCell><IntentBadge intent={kw.intent} /></TableCell>
                              <TableCell>
                                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={savingKeyword === kw.keyword}
                                  onClick={() => handleSaveKeyword({ keyword: kw.keyword, difficulty: (kw.competition_level || "medium").toLowerCase(), volume: kw.search_volume })}
                                  title="Add to Tracker">
                                  {savingKeyword === kw.keyword ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </ScrollArea>
                  ) : (
                    <p className="text-center text-muted-foreground py-8">No keyword ideas available</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="questions" className="mt-4">
              <Card>
                <CardContent className="pt-6">
                  {result.questions && result.questions.length > 0 ? (
                    <ScrollArea className="h-[400px]">
                      <div className="space-y-2">
                        {result.questions.map((q, i) => (
                          <div key={i} className="flex items-start gap-3 p-3 rounded-lg bg-muted/30">
                            <HelpCircle size={14} className="text-primary mt-0.5 shrink-0" />
                            <div className="flex-1">
                              <p className="text-sm font-medium">{q.question}</p>
                              {q.volume && <span className="text-xs text-muted-foreground">Volume: {q.volume.toLocaleString()}</span>}
                            </div>
                            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => { setKeyword(q.question); handleResearch(); }}>
                              <Search size={12} />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  ) : (
                    <p className="text-center text-muted-foreground py-8">No questions found</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="serp" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    SERP Preview
                    {serpData?.data_source === "dataforseo" && <Badge className="bg-emerald-500/10 text-emerald-500 text-[10px]">Live SERP Data</Badge>}
                    {serpData?.data_source === "dataforseo_cached" && <Badge className="bg-blue-500/10 text-blue-500 text-[10px]">Cached</Badge>}
                    {(serpData?.is_estimated || !serpData) && <Badge className="bg-yellow-500/10 text-yellow-500 text-[10px]">AI Estimated</Badge>}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {serpLoading ? (
                    <div className="flex items-center justify-center py-8"><Loader2 className="animate-spin mr-2" size={16} /> Fetching SERP data...</div>
                  ) : (() => {
                    const serpItems = serpData?.organic || result.serp || [];
                    const paa = serpData?.people_also_ask || [];
                    const relSearches = serpData?.related_searches || [];
                    return serpItems.length > 0 ? (
                      <ScrollArea className="h-[500px]">
                        <div className="space-y-3">
                          {serpItems.map((s, i) => (
                            <div key={i} className="flex items-start gap-3 p-3 rounded-lg bg-muted/30">
                              <span className="text-xs font-mono text-muted-foreground w-5 text-right shrink-0">#{s.position || i + 1}</span>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">{s.title}</p>
                                <p className="text-xs text-primary truncate">{s.url}</p>
                                {(s.description || s.snippet) && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{s.description || s.snippet}</p>}
                              </div>
                              {(s.domain_rank || s.domain_authority) ? (
                                <Badge variant="outline" className="text-xs shrink-0">DR {s.domain_rank || s.domain_authority}</Badge>
                              ) : null}
                            </div>
                          ))}
                        </div>
                        {paa.length > 0 && (
                          <div className="mt-6">
                            <h4 className="text-sm font-medium mb-2">People Also Ask</h4>
                            <div className="space-y-1">
                              {paa.map((q, i) => (
                                <div key={i} className="flex items-start gap-2 p-2 rounded bg-muted/20 text-sm">
                                  <HelpCircle size={12} className="text-primary mt-0.5 shrink-0" />
                                  <span>{q.question}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {relSearches.length > 0 && (
                          <div className="mt-4">
                            <h4 className="text-sm font-medium mb-2">Related Searches</h4>
                            <div className="flex flex-wrap gap-2">
                              {relSearches.map((rs, i) => (
                                <Badge key={i} variant="outline" className="text-xs cursor-pointer hover:bg-muted" onClick={() => { setKeyword(rs.query); }}>
                                  {rs.query}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </ScrollArea>
                    ) : (
                      <p className="text-center text-muted-foreground py-8">No SERP data available</p>
                    );
                  })()}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Trends Tab */}
            <TabsContent value="trends" className="mt-4">
              <Card>
                <CardHeader><CardTitle>Google Keyword Trends</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-3 flex-wrap">
                    <Input
                      placeholder="Enter keywords (comma separated, max 5)..."
                      value={trendsKeywords}
                      onChange={(e) => setTrendsKeywords(e.target.value)}
                      className="flex-1 min-w-[200px]"
                    />
                    <Select value={trendsTimeframe} onValueChange={setTrendsTimeframe}>
                      <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="today 12-m">Last 12 months</SelectItem>
                        <SelectItem value="today 3-m">Last 3 months</SelectItem>
                        <SelectItem value="all">Last 5 years</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button onClick={handleAnalyzeTrends} disabled={trendsLoading || !trendsKeywords.trim()}>
                      {trendsLoading ? <><Loader2 size={14} className="animate-spin mr-2" /> Analyzing...</> : <><TrendingUp size={14} className="mr-2" /> Analyze Trends</>}
                    </Button>
                  </div>

                  {trendsResults && (
                    <div className="grid gap-4 mt-4">
                      {(Array.isArray(trendsResults) ? trendsResults : [trendsResults]).map((t, i) => (
                        <Card key={i} className="border-border/40">
                          <CardContent className="pt-4 space-y-3">
                            <div className="flex items-center justify-between">
                              <h3 className="font-medium text-sm">{t.keyword}</h3>
                              <div className="flex items-center gap-2">
                                {t.trend === "rising" || t.trend === "Rising" ? (
                                  <Badge className="bg-emerald-500/10 text-emerald-500">Rising 📈</Badge>
                                ) : t.trend === "declining" || t.trend === "Declining" ? (
                                  <Badge className="bg-red-500/10 text-red-500">Declining 📉</Badge>
                                ) : (
                                  <Badge className="bg-muted text-muted-foreground">Stable ➡</Badge>
                                )}
                                {t.source === "pytrends" ? (
                                  <Badge className="bg-emerald-500/10 text-emerald-500 text-[10px]">Live Google Data</Badge>
                                ) : t.source === "ai_estimate" ? (
                                  <Badge className="bg-yellow-500/10 text-yellow-500 text-[10px]">AI Estimated</Badge>
                                ) : null}
                              </div>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                              <div><span className="text-muted-foreground">Peak Month:</span> <span className="font-medium">{t.peak_month || "—"}</span></div>
                              <div><span className="text-muted-foreground">Seasonality:</span> <span className="font-medium">{t.seasonality || "—"}</span></div>
                              <div><span className="text-muted-foreground">Est. Volume:</span> <span className="font-medium font-mono">{t.estimated_volume?.toLocaleString() || t.volume?.toLocaleString() || "—"}</span></div>
                              <div><span className="text-muted-foreground">Avg Interest:</span> <span className="font-medium">{t.average_interest || "—"}</span></div>
                            </div>
                            {(t.related_queries || t.related)?.length > 0 && (
                              <div>
                                <p className="text-xs text-muted-foreground mb-1">Related Queries:</p>
                                <div className="flex flex-wrap gap-1">
                                  {(t.related_queries || t.related).map((q, j) => (
                                    <Badge key={j} variant="outline" className="text-[10px]">{typeof q === "string" ? q : q.query || q.keyword}</Badge>
                                  ))}
                                </div>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}

                  {!trendsResults && !trendsLoading && (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      Enter keywords and click "Analyze Trends" to see Google Trends data
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </motion.div>
      )}
    </motion.div>
  );
}
