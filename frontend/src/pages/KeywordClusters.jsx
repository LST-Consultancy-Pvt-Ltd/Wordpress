import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Hash, Plus, Trash2, Loader2, RefreshCw, Star, TrendingUp, Target, Bot } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";
import { getSites, generateKeywordClusters, listKeywordClusters, deleteKeywordCluster } from "../lib/api";

const intentColors = {
  transactional: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  local: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  comparison: "bg-purple-500/10 text-purple-500 border-purple-500/20",
};

const volumeColors = {
  high: "bg-red-500/10 text-red-400",
  medium: "bg-yellow-500/10 text-yellow-400",
  low: "bg-muted text-muted-foreground",
};

export default function KeywordClusters() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [clusters, setClusters] = useState([]);
  const [activeCluster, setActiveCluster] = useState(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);

  // Form state
  const [seedService, setSeedService] = useState("");
  const [citiesInput, setCitiesInput] = useState("");
  const [competitorsInput, setCompetitorsInput] = useState("");
  const [activeTab, setActiveTab] = useState("all");

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSite) loadClusters();
  }, [selectedSite]);

  const loadClusters = async () => {
    setLoading(true);
    try {
      const r = await listKeywordClusters(selectedSite);
      setClusters(r.data);
      if (r.data.length > 0 && !activeCluster) setActiveCluster(r.data[0]);
    } catch { setClusters([]); }
    finally { setLoading(false); }
  };

  const handleGenerate = async () => {
    if (!selectedSite) return toast.error("Select a site");
    if (!seedService.trim()) return toast.error("Enter a seed service");
    const cities = citiesInput.split(",").map(c => c.trim()).filter(Boolean);
    if (cities.length === 0) return toast.error("Enter at least one city");
    const competitors = competitorsInput.split(",").map(c => c.trim()).filter(Boolean);
    setGenerating(true);
    try {
      const r = await generateKeywordClusters(selectedSite, { seed_service: seedService, cities, competitors });
      setClusters(prev => [r.data, ...prev]);
      setActiveCluster(r.data);
      toast.success(`Generated ${r.data.keywords?.length || 0} keywords`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Generation failed");
    } finally {
      setGenerating(false);
    }
  };

  const handleDelete = async (clusterId) => {
    try {
      await deleteKeywordCluster(selectedSite, clusterId);
      setClusters(prev => prev.filter(c => c.id !== clusterId));
      if (activeCluster?.id === clusterId) setActiveCluster(clusters.find(c => c.id !== clusterId) || null);
      toast.success("Deleted");
    } catch { toast.error("Delete failed"); }
  };

  const displayKeywords = activeCluster ? (
    activeTab === "all" ? activeCluster.keywords :
    activeTab === "money" ? activeCluster.clusters?.money_keywords :
    activeCluster.clusters?.[activeTab] || []
  ) : [];

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Hash size={24} />Keyword Clusters</h1>
          <p className="page-description">Generate intent-clustered keywords from service + city combinations</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Generator Panel */}
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><Bot size={16} />Generate New Cluster</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Seed Service *</label>
                <Input placeholder="e.g. Plumbing, HVAC, Roofing" value={seedService} onChange={e => setSeedService(e.target.value)} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Cities (comma-separated) *</label>
                <Input placeholder="Austin, Dallas, Houston" value={citiesInput} onChange={e => setCitiesInput(e.target.value)} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Competitors (for comparison keywords)</label>
                <Input placeholder="CompetitorA, CompetitorB" value={competitorsInput} onChange={e => setCompetitorsInput(e.target.value)} />
              </div>
              <Button className="w-full" onClick={handleGenerate} disabled={generating}>
                {generating ? <><Loader2 size={14} className="mr-2 animate-spin" />Generating...</> : <><Plus size={14} className="mr-2" />Generate Keywords</>}
              </Button>
            </CardContent>
          </Card>

          {/* Cluster History */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm">History</CardTitle>
              <Button variant="ghost" size="sm" onClick={loadClusters} disabled={loading}><RefreshCw size={12} className={loading ? "animate-spin" : ""} /></Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {clusters.map(c => (
                <button
                  key={c.id}
                  onClick={() => setActiveCluster(c)}
                  className={`w-full text-left p-2 rounded-lg border text-sm hover:bg-muted/30 transition-colors ${activeCluster?.id === c.id ? "border-primary bg-primary/5" : "border-transparent"}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium truncate">{c.seed_service}</span>
                    <Button variant="ghost" size="sm" className="h-5 w-5 p-0 text-destructive"
                      onClick={e => { e.stopPropagation(); handleDelete(c.id); }}>
                      <Trash2 size={10} />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{c.keywords?.length || 0} keywords · {c.cities?.length || 0} cities</p>
                </button>
              ))}
              {clusters.length === 0 && !loading && <p className="text-xs text-muted-foreground text-center py-3">No clusters yet</p>}
            </CardContent>
          </Card>
        </div>

        {/* Keywords Display */}
        <div className="lg:col-span-2">
          {activeCluster ? (
            <Card className="h-full">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{activeCluster.seed_service} — {activeCluster.keywords?.length || 0} keywords</CardTitle>
                  <div className="flex gap-2">
                    <Badge className="bg-red-500/10 text-red-400 text-xs">
                      <Star size={10} className="mr-1" />{activeCluster.clusters?.money_keywords?.length || 0} money
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Tabs value={activeTab} onValueChange={setActiveTab}>
                  <TabsList className="mb-4">
                    <TabsTrigger value="all">All ({activeCluster.keywords?.length || 0})</TabsTrigger>
                    <TabsTrigger value="local">Local ({activeCluster.clusters?.local?.length || 0})</TabsTrigger>
                    <TabsTrigger value="transactional">Transactional ({activeCluster.clusters?.transactional?.length || 0})</TabsTrigger>
                    <TabsTrigger value="comparison">Comparison ({activeCluster.clusters?.comparison?.length || 0})</TabsTrigger>
                    <TabsTrigger value="money">💰 Money ({activeCluster.clusters?.money_keywords?.length || 0})</TabsTrigger>
                  </TabsList>

                  <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1">
                    {(displayKeywords || []).map((kw, i) => (
                      <div key={i} className="flex items-center gap-3 p-2 rounded-lg bg-muted/20 hover:bg-muted/40">
                        <div className="flex-1">
                          <p className="text-sm font-medium">{kw.keyword}</p>
                          {kw.city && <p className="text-xs text-muted-foreground">{kw.city}</p>}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {kw.intent && (
                            <Badge className={`text-xs ${intentColors[kw.intent] || ""}`}>{kw.intent}</Badge>
                          )}
                          {kw.search_volume_tier && (
                            <Badge className={`text-xs ${volumeColors[kw.search_volume_tier] || ""}`}>{kw.search_volume_tier}</Badge>
                          )}
                          {kw.is_money_keyword && (
                            <span title="Money keyword"><TrendingUp size={12} className="text-emerald-500" /></span>
                          )}
                        </div>
                      </div>
                    ))}
                    {(!displayKeywords || displayKeywords.length === 0) && (
                      <p className="text-center text-muted-foreground text-sm py-8">No keywords in this cluster</p>
                    )}
                  </div>
                </Tabs>
              </CardContent>
            </Card>
          ) : (
            <Card className="h-full flex items-center justify-center">
              <CardContent className="text-center py-16">
                <Target size={40} className="mx-auto mb-4 text-muted-foreground opacity-50" />
                <p className="text-muted-foreground">Generate a keyword cluster to see results</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </motion.div>
  );
}
