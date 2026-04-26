import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  BarChart3, Loader2, Search, Download, GitCompare,
  Target, BookOpen, Lightbulb, AlertTriangle, CheckCircle2
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { Progress } from "../components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "../components/ui/table";
import { ScrollArea } from "../components/ui/scroll-area";
import { getSites, analyzeKeywordDensity, getKeywordMetrics, getSERPAnalysis } from "../lib/api";
import { toast } from "sonner";

const densityColor = (d) => {
  if (d >= 3) return "text-red-500";
  if (d >= 1) return "text-emerald-500";
  return "text-yellow-500";
};

const readabilityColor = (score) => {
  if (score >= 70) return "text-emerald-500";
  if (score >= 50) return "text-yellow-500";
  return "text-red-500";
};

export default function KeywordAnalysis() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [url, setUrl] = useState("");
  const [compareUrl, setCompareUrl] = useState("");
  const [comparing, setComparing] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [compareResult, setCompareResult] = useState(null);
  // DataForSEO real data
  const [realMetrics, setRealMetrics] = useState(null);
  const [serpLandscape, setSerpLandscape] = useState(null);

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  const handleAnalyze = async () => {
    if (!url.trim()) { toast.error("Enter a URL to analyze"); return; }
    setAnalyzing(true);
    setResult(null);
    try {
      const r = await analyzeKeywordDensity(selectedSite, { url: url.trim() });
      setResult(r.data);
      toast.success("Analysis complete");
      // Fetch real metrics for primary keyword
      if (r.data?.primary_keyword) {
        getKeywordMetrics(selectedSite, { keywords: [r.data.primary_keyword] })
          .then(mr => setRealMetrics(mr.data))
          .catch(() => {});
        getSERPAnalysis(selectedSite, { keyword: r.data.primary_keyword })
          .then(sr => setSerpLandscape(sr.data))
          .catch(() => {});
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || "Analysis failed");
    } finally { setAnalyzing(false); }
  };

  const handleCompare = async () => {
    if (!compareUrl.trim()) { toast.error("Enter a comparison URL"); return; }
    setComparing(true);
    setCompareResult(null);
    try {
      const r = await analyzeKeywordDensity(selectedSite, { url: compareUrl.trim() });
      setCompareResult(r.data);
      toast.success("Comparison analysis complete");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Comparison failed");
    } finally { setComparing(false); }
  };

  const exportCSV = () => {
    if (!result?.density_table) return;
    const headers = ["Keyword", "Count", "Density %"];
    const rows = result.density_table.map(r => [r.keyword, r.count, r.density]);
    const csv = [headers, ...rows].map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "keyword-analysis.csv";
    a.click();
    URL.revokeObjectURL(url);
    toast.success("CSV exported");
  };

  const ResultPanel = ({ data, label }) => (
    <div className="space-y-4">
      {/* Primary keyword */}
      {data.primary_keyword && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm text-muted-foreground">Primary Keyword</span>
                <p className="text-xl font-bold mt-1">{data.primary_keyword}</p>
              </div>
              <div className="text-right">
                <span className="text-sm text-muted-foreground">Density</span>
                <p className={`text-xl font-bold mt-1 ${densityColor(data.primary_density)}`}>{data.primary_density}%</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {data.word_count && (
          <Card>
            <CardContent className="pt-4 pb-4">
              <span className="text-xs text-muted-foreground">Word Count</span>
              <p className="text-lg font-bold">{data.word_count.toLocaleString()}</p>
            </CardContent>
          </Card>
        )}
        {data.readability_score != null && (
          <Card>
            <CardContent className="pt-4 pb-4">
              <span className="text-xs text-muted-foreground">Readability</span>
              <p className={`text-lg font-bold ${readabilityColor(data.readability_score)}`}>{data.readability_score}/100</p>
            </CardContent>
          </Card>
        )}
        {data.unique_keywords != null && (
          <Card>
            <CardContent className="pt-4 pb-4">
              <span className="text-xs text-muted-foreground">Unique Keywords</span>
              <p className="text-lg font-bold">{data.unique_keywords}</p>
            </CardContent>
          </Card>
        )}
        {data.heading_count != null && (
          <Card>
            <CardContent className="pt-4 pb-4">
              <span className="text-xs text-muted-foreground">Headings</span>
              <p className="text-lg font-bold">{data.heading_count}</p>
            </CardContent>
          </Card>
        )}
      </div>

      <Tabs defaultValue="density">
        <TabsList>
          <TabsTrigger value="density"><Target size={14} className="mr-1" /> Density</TabsTrigger>
          <TabsTrigger value="lsi"><Lightbulb size={14} className="mr-1" /> LSI Keywords</TabsTrigger>
          <TabsTrigger value="missing"><AlertTriangle size={14} className="mr-1" /> Missing</TabsTrigger>
          <TabsTrigger value="recommendations"><CheckCircle2 size={14} className="mr-1" /> Tips</TabsTrigger>
        </TabsList>

        <TabsContent value="density" className="mt-4">
          {data.density_table && data.density_table.length > 0 ? (
            <ScrollArea className="h-[350px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Keyword</TableHead>
                    <TableHead className="w-[80px]">Count</TableHead>
                    <TableHead className="w-[100px]">Density</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.density_table.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium">{r.keyword}</TableCell>
                      <TableCell><span className="font-mono text-xs">{r.count}</span></TableCell>
                      <TableCell>
                        <span className={`font-mono text-xs font-bold ${densityColor(r.density)}`}>{r.density}%</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          ) : (
            <p className="text-center text-muted-foreground py-8">No density data</p>
          )}
        </TabsContent>

        <TabsContent value="lsi" className="mt-4">
          {data.lsi_keywords && data.lsi_keywords.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {data.lsi_keywords.map((kw, i) => (
                <Badge key={i} variant="outline" className="text-xs">{kw}</Badge>
              ))}
            </div>
          ) : (
            <p className="text-center text-muted-foreground py-8">No LSI keywords found</p>
          )}
        </TabsContent>

        <TabsContent value="missing" className="mt-4">
          {data.missing_keywords && data.missing_keywords.length > 0 ? (
            <div className="space-y-2">
              {data.missing_keywords.map((kw, i) => (
                <div key={i} className="flex items-center gap-2 p-2 rounded bg-muted/30">
                  <AlertTriangle size={14} className="text-yellow-500 shrink-0" />
                  <span className="text-sm">{kw}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-center text-muted-foreground py-8">No missing keywords detected</p>
          )}
        </TabsContent>

        <TabsContent value="recommendations" className="mt-4">
          {data.recommendations && data.recommendations.length > 0 ? (
            <div className="space-y-2">
              {data.recommendations.map((rec, i) => (
                <div key={i} className="flex items-start gap-2 p-3 rounded bg-muted/30">
                  <CheckCircle2 size={14} className="text-primary mt-0.5 shrink-0" />
                  <span className="text-sm text-muted-foreground">{rec}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-center text-muted-foreground py-8">No recommendations</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-heading font-bold flex items-center gap-3">
            <BarChart3 className="text-primary" /> Keyword Analysis
          </h1>
          <p className="text-muted-foreground mt-1">Analyze keyword density, TF-IDF, and content optimization</p>
        </div>
        <div className="flex items-center gap-2">
          {result && (
            <Button variant="outline" size="sm" onClick={exportCSV}>
              <Download size={14} className="mr-1" /> Export CSV
            </Button>
          )}
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-[220px]"><SelectValue placeholder="Select site" /></SelectTrigger>
            <SelectContent>
              {sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name || s.url}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Analysis Input */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-3">
            <Input
              placeholder="Enter page URL to analyze (e.g., https://example.com/blog/post)..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
              className="flex-1"
            />
            <Button onClick={handleAnalyze} disabled={analyzing || !url.trim()}>
              {analyzing ? <><Loader2 size={14} className="animate-spin mr-2" /> Analyzing...</> : <><Search size={14} className="mr-2" /> Analyze</>}
            </Button>
          </div>
        </CardContent>
      </Card>

      {result && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
          <ResultPanel data={result} label="Primary" />

          {/* Real Data Card (DataForSEO) */}
          {realMetrics?.metrics && Object.keys(realMetrics.metrics).length > 0 && (() => {
            const kw = Object.keys(realMetrics.metrics)[0];
            const m = realMetrics.metrics[kw];
            return (
              <Card className="border-emerald-500/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Target size={15} className="text-emerald-500" /> Real Keyword Data
                    <Badge className="bg-emerald-500/10 text-emerald-500 text-[10px] ml-auto">{realMetrics.data_source || "DataForSEO"}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div><span className="text-xs text-muted-foreground">Search Volume</span><p className="text-lg font-bold">{m.search_volume?.toLocaleString() || "—"}</p></div>
                    <div><span className="text-xs text-muted-foreground">CPC</span><p className="text-lg font-bold">${m.cpc?.toFixed(2) || "—"}</p></div>
                    <div><span className="text-xs text-muted-foreground">Competition</span><p className="text-lg font-bold">{m.competition_level || m.competition || "—"}</p></div>
                    <div><span className="text-xs text-muted-foreground">Difficulty</span><p className="text-lg font-bold">{m.keyword_difficulty != null ? `${m.keyword_difficulty}/100` : "—"}</p></div>
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* SERP Landscape */}
          {serpLandscape?.organic?.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Search size={15} className="text-primary" /> SERP Landscape — Top 3 Competitors
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {serpLandscape.organic.slice(0, 3).map((s, i) => (
                    <div key={i} className="flex items-center gap-3 p-2 rounded bg-muted/30">
                      <span className="text-xs font-mono text-muted-foreground w-5 text-right">#{s.position || i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{s.title}</p>
                        <p className="text-xs text-primary truncate">{s.url}</p>
                      </div>
                      {s.domain_rank && <Badge variant="outline" className="text-xs shrink-0">DR {s.domain_rank}</Badge>}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Compare Mode */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><GitCompare size={16} /> Compare with Another URL</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-3">
                <Input
                  placeholder="Enter competitor URL to compare..."
                  value={compareUrl}
                  onChange={(e) => setCompareUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCompare()}
                  className="flex-1"
                />
                <Button variant="outline" onClick={handleCompare} disabled={comparing || !compareUrl.trim()}>
                  {comparing ? <><Loader2 size={14} className="animate-spin mr-2" /> Comparing...</> : <><GitCompare size={14} className="mr-2" /> Compare</>}
                </Button>
              </div>
            </CardContent>
          </Card>

          {compareResult && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
              <Card>
                <CardHeader>
                  <CardTitle>Comparison Results</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResultPanel data={compareResult} label="Comparison" />
                </CardContent>
              </Card>
            </motion.div>
          )}
        </motion.div>
      )}
    </motion.div>
  );
}
