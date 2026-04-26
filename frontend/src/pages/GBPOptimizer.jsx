import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { MapPin, Bot, CheckSquare, Plus, Loader2, Star, ExternalLink, RefreshCw, Copy, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Badge } from "../components/ui/badge";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";
import { getSites, analyzeGBP, listGBPAnalyses, toggleGBPChecklistItem } from "../lib/api";

export default function GBPOptimizer() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [analyses, setAnalyses] = useState([]);
  const [activeAnalysis, setActiveAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [copied, setCopied] = useState(false);

  // Form state
  const [form, setForm] = useState({
    business_name: "",
    our_gbp_url: "",
    competitor_gbp_urls: "",
    business_description: "",
    current_categories: "",
  });

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSite) loadAnalyses();
  }, [selectedSite]);

  const loadAnalyses = async () => {
    setLoading(true);
    try {
      const r = await listGBPAnalyses(selectedSite);
      setAnalyses(r.data);
      if (r.data.length > 0 && !activeAnalysis) setActiveAnalysis(r.data[0]);
    } catch { setAnalyses([]); }
    finally { setLoading(false); }
  };

  const handleAnalyze = async () => {
    if (!selectedSite) return toast.error("Select a site");
    if (!form.business_name.trim()) return toast.error("Enter business name");
    const competitors = form.competitor_gbp_urls.split("\n").map(u => u.trim()).filter(Boolean);
    const categories = form.current_categories.split(",").map(c => c.trim()).filter(Boolean);
    setAnalyzing(true);
    try {
      const r = await analyzeGBP(selectedSite, { ...form, competitor_gbp_urls: competitors, current_categories: categories });
      setAnalyses(prev => [r.data, ...prev]);
      setActiveAnalysis(r.data);
      toast.success("GBP analysis complete");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleToggleChecklist = async (itemIndex) => {
    if (!activeAnalysis) return;
    try {
      const r = await toggleGBPChecklistItem(selectedSite, activeAnalysis.id, itemIndex);
      const updated = { ...activeAnalysis, checklist: r.data.checklist };
      setActiveAnalysis(updated);
      setAnalyses(prev => prev.map(a => a.id === updated.id ? updated : a));
    } catch { toast.error("Failed to update checklist"); }
  };

  const copyDescription = () => {
    if (!activeAnalysis?.optimized_description) return;
    navigator.clipboard.writeText(activeAnalysis.optimized_description);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success("Copied to clipboard");
  };

  const completedItems = activeAnalysis?.checklist?.filter(item => item.done).length || 0;
  const totalItems = activeAnalysis?.checklist?.length || 0;

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><MapPin size={24} />GBP Optimizer</h1>
          <p className="page-description">Analyze and optimize your Google Business Profile against competitors</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Input Panel */}
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><Bot size={16} />Analyze GBP</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {[
                { key: "business_name", label: "Business Name *", placeholder: "Acme Plumbing Austin" },
                { key: "our_gbp_url", label: "Our GBP URL", placeholder: "https://g.page/..." },
                { key: "current_categories", label: "Current Categories (comma-sep)", placeholder: "Plumber, Water heater installer" },
              ].map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
                  <Input placeholder={placeholder} value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} />
                </div>
              ))}
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Business Description</label>
                <Textarea rows={2} placeholder="We provide emergency plumbing..." value={form.business_description} onChange={e => setForm(p => ({ ...p, business_description: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Competitor GBP URLs (one per line)</label>
                <Textarea rows={3} placeholder="https://g.page/competitor1" value={form.competitor_gbp_urls} onChange={e => setForm(p => ({ ...p, competitor_gbp_urls: e.target.value }))} />
              </div>
              <Button className="w-full" onClick={handleAnalyze} disabled={analyzing}>
                {analyzing ? <><Loader2 size={14} className="mr-2 animate-spin" />Analyzing...</> : <><Plus size={14} className="mr-2" />Analyze GBP</>}
              </Button>
            </CardContent>
          </Card>

          {/* History */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm">Past Analyses</CardTitle>
              <Button variant="ghost" size="sm" onClick={loadAnalyses} disabled={loading}><RefreshCw size={12} className={loading ? "animate-spin" : ""} /></Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {analyses.map(a => (
                <button key={a.id} onClick={() => setActiveAnalysis(a)}
                  className={`w-full text-left p-2 rounded-lg border text-sm hover:bg-muted/30 transition-colors ${activeAnalysis?.id === a.id ? "border-primary bg-primary/5" : "border-transparent"}`}>
                  <p className="font-medium truncate">{a.business_name}</p>
                  <p className="text-xs text-muted-foreground">{new Date(a.created_at).toLocaleDateString()}</p>
                </button>
              ))}
              {analyses.length === 0 && !loading && <p className="text-xs text-muted-foreground text-center py-3">No analyses yet</p>}
            </CardContent>
          </Card>
        </div>

        {/* Results Panel */}
        <div className="lg:col-span-2 space-y-4">
          {activeAnalysis ? (
            <>
              {/* Category Recommendations */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Category Recommendations</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {activeAnalysis.primary_category && (
                    <div className="p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5">
                      <p className="text-xs font-medium text-emerald-500 mb-1">Recommended Primary Category</p>
                      <p className="font-semibold">{activeAnalysis.primary_category}</p>
                    </div>
                  )}
                  {activeAnalysis.missing_categories?.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-2">Missing Secondary Categories</p>
                      <div className="flex flex-wrap gap-1">
                        {activeAnalysis.missing_categories.map((cat, i) => (
                          <Badge key={i} variant="outline" className="text-xs">{cat}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Optimized Description */}
              {activeAnalysis.optimized_description && (
                <Card>
                  <CardHeader className="pb-2 flex flex-row items-center justify-between">
                    <CardTitle className="text-base">Optimized Description</CardTitle>
                    <Button variant="outline" size="sm" onClick={copyDescription}>
                      {copied ? <><Check size={12} className="mr-1 text-emerald-500" />Copied</> : <><Copy size={12} className="mr-1" />Copy</>}
                    </Button>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm leading-relaxed text-muted-foreground">{activeAnalysis.optimized_description}</p>
                  </CardContent>
                </Card>
              )}

              {/* Checklist */}
              {activeAnalysis.checklist?.length > 0 && (
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base flex items-center gap-2"><CheckSquare size={16} />Optimization Checklist</CardTitle>
                      <Badge className="text-xs">{completedItems}/{totalItems} done</Badge>
                    </div>
                    <div className="w-full bg-muted rounded-full h-1.5 mt-2">
                      <div className="bg-primary h-1.5 rounded-full transition-all" style={{ width: `${totalItems ? (completedItems / totalItems) * 100 : 0}%` }} />
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {activeAnalysis.checklist.map((item, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <Checkbox id={`check-${i}`} checked={!!item.done} onCheckedChange={() => handleToggleChecklist(i)} className="mt-0.5" />
                        <label htmlFor={`check-${i}`} className={`text-sm cursor-pointer ${item.done ? "line-through text-muted-foreground" : ""}`}>
                          {item.task}
                        </label>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* GBP Post Ideas */}
              {activeAnalysis.post_ideas?.length > 0 && (
                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-base">GBP Post Ideas</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    {activeAnalysis.post_ideas.map((idea, i) => (
                      <div key={i} className="flex gap-3 p-2 rounded-lg bg-muted/20">
                        <Star size={14} className="text-yellow-500 shrink-0 mt-0.5" />
                        <p className="text-sm">{idea}</p>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </>
          ) : (
            <Card className="h-64 flex items-center justify-center">
              <CardContent className="text-center">
                <MapPin size={40} className="mx-auto mb-4 text-muted-foreground opacity-50" />
                <p className="text-muted-foreground">Analyze a GBP to see recommendations</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </motion.div>
  );
}
