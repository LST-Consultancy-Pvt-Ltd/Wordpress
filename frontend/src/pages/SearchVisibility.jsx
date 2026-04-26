import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Eye, TrendingUp, Play, Loader2, RefreshCw, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { toast } from "sonner";
import { getSites, getSearchVisibility, analyzeSearchVisibility, subscribeToTask } from "../lib/api";

const ScoreGauge = ({ score, label, size = 100 }) => {
  const r = 40;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  const color = score >= 70 ? "#10b981" : score >= 40 ? "#f59e0b" : "#ef4444";
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size} viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#1e293b" strokeWidth="10" />
        <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="10"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          transform="rotate(-90 50 50)" style={{ transition: "stroke-dasharray 1s ease" }} />
        <text x="50" y="54" textAnchor="middle" fill="white" fontSize="18" fontWeight="bold">{score}</text>
      </svg>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
};

export default function SearchVisibility() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSite) loadData();
  }, [selectedSite]);

  const loadData = async () => {
    setLoading(true);
    try {
      const r = await getSearchVisibility(selectedSite);
      setData(r.data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  const handleAnalyze = async () => {
    if (!selectedSite) return;
    setAnalyzing(true);
    toast.info("Running search visibility analysis…");
    try {
      const r = await analyzeSearchVisibility(selectedSite);
      const taskId = r.data.task_id;
      const unsub = subscribeToTask(taskId, (ev) => {
        if (ev.type === "status" && ev.data?.step === ev.data?.total) {
          unsub();
          setAnalyzing(false);
          loadData();
          toast.success("Analysis complete!");
        }
        if (ev.type === "error") {
          unsub();
          setAnalyzing(false);
          toast.error(ev.data?.message || "Analysis failed");
        }
      });
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to start analysis");
      setAnalyzing(false);
    }
  };

  return (
    <div className="page-container">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
            Search Visibility Engine
          </motion.h1>
          <p className="page-description">AI-powered search visibility scoring and action planning</p>
        </div>
        <div className="flex gap-2 items-center">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
            <SelectContent>
              {sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button className="btn-primary" onClick={handleAnalyze} disabled={analyzing || !selectedSite}>
            {analyzing ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Play size={15} className="mr-2" />}
            Run Analysis
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24"><Loader2 size={32} className="animate-spin text-primary" /></div>
      ) : !data ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Eye size={48} className="text-muted-foreground mb-4" />
          <p className="text-muted-foreground mb-4">No visibility data yet. Run your first analysis.</p>
          <Button className="btn-primary" onClick={handleAnalyze} disabled={analyzing || !selectedSite}>
            {analyzing ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Play size={15} className="mr-2" />}
            Run Analysis
          </Button>
        </div>
      ) : (
        <div className="grid gap-6">
          {/* Score Gauges */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <Card className="content-card">
              <CardHeader>
                <CardTitle className="font-heading flex items-center gap-2">
                  <Eye size={18} className="text-primary" /> Overall Search Visibility Score
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap justify-center gap-8 py-4">
                  <ScoreGauge score={Math.round(data.overall_score)} label="Overall" size={120} />
                  <ScoreGauge score={Math.round(data.branded_score)} label="Branded" />
                  <ScoreGauge score={Math.round(data.informational_score)} label="Informational" />
                  <ScoreGauge score={Math.round(data.transactional_score)} label="Transactional" />
                </div>
                <p className="text-center text-xs text-muted-foreground mt-2">
                  Last analyzed: {new Date(data.analyzed_at).toLocaleString()}
                </p>
              </CardContent>
            </Card>
          </motion.div>

          {/* Trend Chart */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <Card className="content-card">
              <CardHeader>
                <CardTitle className="font-heading flex items-center gap-2">
                  <TrendingUp size={18} className="text-primary" /> 30-Day Score Trend
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={data.trend_data || []}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="date" tick={{ fill: "#64748b", fontSize: 10 }}
                      tickFormatter={v => v.slice(5)} />
                    <YAxis domain={[0, 100]} tick={{ fill: "#64748b", fontSize: 10 }} />
                    <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8 }}
                      labelStyle={{ color: "#94a3b8" }} itemStyle={{ color: "#6366f1" }} />
                    <Line type="monotone" dataKey="score" stroke="#6366f1" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </motion.div>

          {/* AI Action Plan */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
            <Card className="content-card">
              <CardHeader>
                <CardTitle className="font-heading flex items-center gap-2">
                  <Zap size={18} className="text-primary" /> Top 3 Actions This Week
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {(data.actions || []).map((action, i) => (
                    <div key={i} className="flex gap-3 p-3 rounded-lg bg-primary/5 border border-primary/10">
                      <span className="w-6 h-6 rounded-full bg-primary text-white text-xs flex items-center justify-center flex-shrink-0 font-bold">{i + 1}</span>
                      <p className="text-sm text-foreground">{action}</p>
                    </div>
                  ))}
                  {(!data.actions || data.actions.length === 0) && (
                    <p className="text-sm text-muted-foreground">Re-run analysis to generate AI recommendations.</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      )}
    </div>
  );
}
