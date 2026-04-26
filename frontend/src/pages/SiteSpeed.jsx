import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Zap, Globe, Loader2, Play, Clock, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";
import { getSites, analyzePageSpeed, getPageSpeedResults } from "../lib/api";

const MetricCard = ({ label, value, unit, description }) => {
  const num = parseFloat(value) || 0;
  const good = (label === "Performance" && num >= 90) || (label === "CLS" && num < 0.1) ||
    (["FCP", "LCP"].includes(label) && num < 2000) || (label === "TBT" && num < 200);
  const poor = (label === "Performance" && num < 50) || (label === "CLS" && num > 0.25) ||
    (["FCP", "LCP"].includes(label) && num > 4000) || (label === "TBT" && num > 600);
  const color = poor ? "text-red-500 border-red-500/20 bg-red-500/5"
    : good ? "text-emerald-500 border-emerald-500/20 bg-emerald-500/5"
      : "text-yellow-500 border-yellow-500/20 bg-yellow-500/5";
  return (
    <div className={`rounded-xl border p-4 ${color}`}>
      <div className="text-2xl font-bold">{value}{unit}</div>
      <div className="text-sm font-medium mt-1">{label}</div>
      {description && <div className="text-xs opacity-70 mt-0.5">{description}</div>}
    </div>
  );
};

const PriorityBadge = ({ priority }) => {
  const map = {
    high: "bg-red-500/10 text-red-500 border-red-500/20",
    medium: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
    low: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  };
  return <Badge className={`text-xs ${map[priority] || map.medium} capitalize`}>{priority}</Badge>;
};

export default function SiteSpeed() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [url, setUrl] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [results, setResults] = useState([]);
  const [latest, setLatest] = useState(null);

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data);
      if (r.data.length > 0) {
        setSelectedSite(r.data[0].id);
        setUrl(r.data[0].url || "");
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSite) loadResults();
  }, [selectedSite]);

  useEffect(() => {
    const site = sites.find(s => s.id === selectedSite);
    if (site) setUrl(site.url || "");
  }, [selectedSite, sites]);

  const loadResults = async () => {
    try {
      const r = await getPageSpeedResults(selectedSite);
      setResults(r.data || []);
      setLatest(r.data?.[0] || null);
    } catch { setResults([]); setLatest(null); }
  };

  const handleAnalyze = async () => {
    if (!url.trim()) { toast.error("Enter a URL to analyze"); return; }
    setAnalyzing(true);
    toast.info("Running PageSpeed analysis…");
    try {
      const r = await analyzePageSpeed(selectedSite, { url: url.trim() });
      setLatest(r.data);
      setResults(prev => [r.data, ...prev]);
      if (r.data.psi_warning) toast.warning(r.data.psi_warning, { duration: 7000 });
      else toast.success("Analysis complete!");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Analysis failed");
    } finally { setAnalyzing(false); }
  };

  return (
    <div className="page-container">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
            Site Speed Optimizer
          </motion.h1>
          <p className="page-description">Google PageSpeed Insights + AI-powered fix recommendations</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {/* URL input + run */}
      <Card className="content-card mb-6">
        <CardContent className="pt-4">
          <div className="flex gap-3 items-end">
            <div className="flex-1 space-y-1">
              <Label>Page URL to Audit</Label>
              <Input placeholder="https://example.com" value={url} onChange={e => setUrl(e.target.value)} />
            </div>
            <Button className="btn-primary" onClick={handleAnalyze} disabled={analyzing}>
              {analyzing ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Play size={15} className="mr-2" />}
              Analyze
            </Button>
          </div>
        </CardContent>
      </Card>

      {latest ? (
        <div className="grid gap-6">
          {/* Core Web Vitals */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <Card className="content-card">
              <CardHeader>
                <CardTitle className="font-heading flex items-center gap-2">
                  <Zap size={18} className="text-primary" /> Core Web Vitals
                  <span className="text-xs text-muted-foreground ml-2">
                    {latest.url && `— ${new URL(latest.url).hostname}`}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  <MetricCard label="Performance" value={latest.performance_score?.toFixed(0)} unit="/100" />
                  <MetricCard label="FCP" value={(latest.fcp / 1000).toFixed(2)} unit="s" description="First Contentful Paint" />
                  <MetricCard label="LCP" value={(latest.lcp / 1000).toFixed(2)} unit="s" description="Largest Contentful Paint" />
                  <MetricCard label="TBT" value={latest.tbt?.toFixed(0)} unit="ms" description="Total Blocking Time" />
                  <MetricCard label="CLS" value={latest.cls?.toFixed(3)} unit="" description="Cumulative Layout Shift" />
                </div>
                <p className="text-xs text-muted-foreground mt-3">
                  Audited: {new Date(latest.fetched_at).toLocaleString()}
                </p>
              </CardContent>
            </Card>
          </motion.div>

          {/* Opportunities */}
          {(latest.opportunities?.length > 0) && (
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
              <Card className="content-card">
                <CardHeader>
                  <CardTitle className="font-heading flex items-center gap-2">
                    <Clock size={18} className="text-primary" /> Opportunities
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {latest.opportunities.map((op, i) => (
                    <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/30">
                      <div>
                        <p className="text-sm font-medium">{op.title}</p>
                        {op.description && <p className="text-xs text-muted-foreground mt-0.5">{op.description}</p>}
                      </div>
                      {op.savings_ms > 0 && (
                        <Badge className="bg-emerald-500/10 text-emerald-500 whitespace-nowrap ml-4">
                          -{(op.savings_ms / 1000).toFixed(1)}s
                        </Badge>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* AI Recommendations */}
          {(latest.ai_recommendations?.length > 0) && (
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
              <Card className="content-card">
                <CardHeader>
                  <CardTitle className="font-heading flex items-center gap-2">
                    <AlertTriangle size={18} className="text-primary" /> AI Fix Recommendations
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {latest.ai_recommendations.map((rec, i) => (
                    <div key={i} className="p-4 rounded-lg border border-border/40 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium flex-1">{rec.recommendation}</p>
                        <PriorityBadge priority={rec.priority} />
                      </div>
                      {rec.implementation_steps?.length > 0 && (
                        <ul className="text-xs text-muted-foreground space-y-0.5 pl-4 list-disc">
                          {rec.implementation_steps.map((s, j) => <li key={j}>{s}</li>)}
                        </ul>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* Audit History */}
          {results.length > 1 && (
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
              <Card className="content-card">
                <CardHeader>
                  <CardTitle className="font-heading text-sm">Audit History</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {results.slice(0, 5).map((r, i) => (
                      <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-border/20 last:border-0">
                        <span className="text-muted-foreground text-xs">{new Date(r.fetched_at).toLocaleDateString()}</span>
                        <span className="text-xs">{r.url}&nbsp;</span>
                        <Badge className={r.performance_score >= 90 ? "bg-emerald-500/10 text-emerald-500"
                          : r.performance_score >= 50 ? "bg-yellow-500/10 text-yellow-500"
                            : "bg-red-500/10 text-red-500"}>
                          {r.performance_score?.toFixed(0)}/100
                        </Badge>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground">
          <Zap size={48} className="mb-4 opacity-30" />
          <p>No speed audit yet. Enter a URL and click Analyze.</p>
        </div>
      )}
    </div>
  );
}
