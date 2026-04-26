import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Zap, TrendingUp, BarChart3, Target, RefreshCw, Loader2, Star } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Progress } from "../components/ui/progress";
import { toast } from "sonner";
import { getSites, getOffPageScore, getOffPagePriorityActions, generateOffPageStrategy, getOffPageDigest } from "../lib/api";

const priorityColors = { high: "bg-red-500/10 text-red-400", medium: "bg-yellow-500/10 text-yellow-400", low: "bg-blue-500/10 text-blue-400" };
const scoreColor = (s) => s >= 67 ? "text-emerald-400" : s >= 34 ? "text-yellow-400" : "text-red-400";

export default function OffPageAutopilot() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [score, setScore] = useState(null);
  const [actions, setActions] = useState([]);
  const [digest, setDigest] = useState(null);
  const [loading, setLoading] = useState(false);
  const [strategyDialog, setStrategyDialog] = useState(null);
  const [generatingStrategy, setGeneratingStrategy] = useState(false);

  useEffect(() => {
    getSites().then(r => { setSites(r.data); if (r.data.length > 0) setSelectedSite(r.data[0].id); }).catch(() => {});
  }, []);
  useEffect(() => { if (selectedSite) loadAll(); }, [selectedSite]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [scoreR, actionsR, digestR] = await Promise.all([
        getOffPageScore(selectedSite).catch(() => ({ data: null })),
        getOffPagePriorityActions(selectedSite).catch(() => ({ data: { actions: [] } })),
        getOffPageDigest(selectedSite).catch(() => ({ data: null })),
      ]);
      setScore(scoreR.data);
      setActions(Array.isArray(actionsR.data) ? actionsR.data : (actionsR.data?.actions ?? []));
      setDigest(digestR.data);
    } finally { setLoading(false); }
  };

  const handleStrategy = async () => {
    setGeneratingStrategy(true);
    try {
      const r = await generateOffPageStrategy(selectedSite);
      setStrategyDialog(r.data);
      toast.success("Strategy generated");
    } catch { toast.error("Failed"); }
    finally { setGeneratingStrategy(false); }
  };

  const breakdown = score?.breakdown || {};
  const metricCards = [
    { key: "backlinks_acquired", label: "Backlinks", icon: "🔗" },
    { key: "brand_mentions", label: "Mentions", icon: "📢" },
    { key: "citations_consistent", label: "Citations", icon: "📍" },
    { key: "guest_posts_published", label: "Guest Posts", icon: "✍️" },
    { key: "community_posts", label: "Community", icon: "💬" },
    { key: "podcast_appearances", label: "Podcasts", icon: "🎙️" },
    { key: "pr_campaigns", label: "PR Campaigns", icon: "📰" },
    { key: "active_influencers", label: "Influencers", icon: "👥" },
  ];

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Zap size={24} />Off-Page Autopilot</h1>
          <p className="page-description">Unified dashboard for all off-page SEO activities</p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
            <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={loadAll} disabled={loading}><RefreshCw size={14} className={loading ? "animate-spin" : ""} /></Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Score */}
        <Card className="lg:row-span-2">
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Target size={16} />Off-Page Score</CardTitle></CardHeader>
          <CardContent className="flex flex-col items-center">
            {score ? (
              <>
                <div className="relative w-36 h-36 flex items-center justify-center">
                  <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 120 120">
                    <circle cx="60" cy="60" r="50" fill="none" stroke="currentColor" strokeWidth="8" className="text-muted/30" />
                    <circle cx="60" cy="60" r="50" fill="none" stroke="currentColor" strokeWidth="8" strokeDasharray={`${(score.overall_score / 100) * 314} 314`} strokeLinecap="round" className={scoreColor(score.overall_score)} />
                  </svg>
                  <span className={`text-4xl font-bold ${scoreColor(score.overall_score)}`}>{score.overall_score}</span>
                </div>
                <p className="text-sm text-muted-foreground mt-2">out of 100</p>
                <Button className="w-full mt-4" onClick={handleStrategy} disabled={generatingStrategy}>
                  {generatingStrategy ? <><Loader2 size={14} className="mr-2 animate-spin" />Generating…</> : <><Star size={14} className="mr-2" />Generate 90-Day Strategy</>}
                </Button>
              </>
            ) : (
              <div className="py-8 text-center"><p className="text-sm text-muted-foreground">No score data yet</p></div>
            )}
          </CardContent>
        </Card>

        {/* Metrics breakdown */}
        <div className="lg:col-span-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {metricCards.map(({ key, label, icon }) => (
              <Card key={key}>
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg">{icon}</span>
                    <span className="text-xs text-muted-foreground">{label}</span>
                  </div>
                  <p className="text-xl font-bold">{breakdown[key] ?? "—"}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        {/* Priority Actions */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><TrendingUp size={16} />Priority Actions</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-2">
                {actions.map((a, i) => (
                  <div key={i} className="p-3 rounded-lg border hover:bg-muted/20">
                    <div className="flex items-start gap-3">
                      <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary shrink-0">{i + 1}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <p className="text-sm font-medium">{a.action}</p>
                          <Badge className={`text-xs ${priorityColors[a.priority] || priorityColors.medium}`}>{a.priority}</Badge>
                          {a.module && <Badge variant="outline" className="text-xs">{a.module}</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground">{a.why}</p>
                        {a.estimated_impact && <p className="text-xs mt-1"><span className="text-emerald-400">Impact:</span> {a.estimated_impact}</p>}
                      </div>
                    </div>
                  </div>
                ))}
                {actions.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">No priority actions yet</p>}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Digest */}
      {digest && (
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><BarChart3 size={16} />Monthly Digest</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {digest.this_month && Object.entries(digest.this_month).map(([key, val]) => (
                <div key={key} className="text-center">
                  <p className="text-xl font-bold text-primary">{val}</p>
                  <p className="text-xs text-muted-foreground capitalize">{key.replace(/_/g, " ")}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!strategyDialog} onOpenChange={() => setStrategyDialog(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>90-Day Off-Page SEO Strategy</DialogTitle></DialogHeader>
          {strategyDialog && (
            <div className="space-y-4">
              {["month_1", "month_2", "month_3"].map(m => (
                strategyDialog[m] && (
                  <div key={m}>
                    <h3 className="font-semibold text-sm mb-2 capitalize">{m.replace("_", " ")}</h3>
                    <div className="bg-muted/30 rounded-lg p-3 text-sm whitespace-pre-wrap">{typeof strategyDialog[m] === "string" ? strategyDialog[m] : JSON.stringify(strategyDialog[m], null, 2)}</div>
                  </div>
                )
              ))}
              {strategyDialog.expected_outcomes && (
                <div>
                  <h3 className="font-semibold text-sm mb-2">Expected Outcomes</h3>
                  <div className="bg-muted/30 rounded-lg p-3 text-sm whitespace-pre-wrap">{typeof strategyDialog.expected_outcomes === "string" ? strategyDialog.expected_outcomes : JSON.stringify(strategyDialog.expected_outcomes, null, 2)}</div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
