import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { MapPin, Plus, Trash2, Sparkles, Loader2, Map } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";
import { getSites, getLocalTracking, addLocalKeyword, deleteLocalKeyword, getLocalRecommendations } from "../lib/api";

const PriorityBadge = ({ priority }) => {
  const map = {
    high: "bg-red-500/10 text-red-500",
    medium: "bg-yellow-500/10 text-yellow-500",
    low: "bg-blue-500/10 text-blue-500",
  };
  return <Badge className={`text-xs ${map[priority] || map.medium} capitalize`}>{priority}</Badge>;
};

// Simple visual heatmap-style grid showing ranks 1-20
const VisibilityGrid = ({ keywords }) => {
  if (!keywords.length) return null;
  const locations = [...new Set(keywords.map(k => k.location))];
  const kws = [...new Set(keywords.map(k => k.keyword))];
  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full">
        <thead>
          <tr>
            <th className="text-left py-1.5 pr-3 text-muted-foreground">Location / Keyword</th>
            {kws.map(k => (
              <th key={k} className="py-1.5 px-2 text-muted-foreground text-center max-w-[100px] truncate">{k}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {locations.map(loc => (
            <tr key={loc} className="border-t border-border/20">
              <td className="py-1.5 pr-3 font-medium">{loc}</td>
              {kws.map(kw => {
                const entry = keywords.find(k => k.keyword === kw && k.location === loc);
                const rank = entry?.local_pack_rank;
                const color = rank == null ? "bg-muted/20 text-muted-foreground"
                  : rank <= 3 ? "bg-emerald-500/20 text-emerald-500"
                    : rank <= 7 ? "bg-yellow-500/20 text-yellow-500"
                      : "bg-red-500/20 text-red-400";
                return (
                  <td key={kw} className="py-1.5 px-2 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${color}`}>
                      {rank != null ? `#${rank}` : "–"}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default function LocalTracking() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [keywords, setKeywords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [recommendations, setRecommendations] = useState([]);
  const [loadingRecs, setLoadingRecs] = useState(false);
  const [newKw, setNewKw] = useState({ keyword: "", location: "" });
  const [adding, setAdding] = useState(false);

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
      const r = await getLocalTracking(selectedSite);
      setKeywords(r.data || []);
    } catch { setKeywords([]); }
    finally { setLoading(false); }
  };

  const handleAdd = async () => {
    if (!newKw.keyword.trim() || !newKw.location.trim()) {
      toast.error("Keyword and location are required"); return;
    }
    setAdding(true);
    try {
      const r = await addLocalKeyword(selectedSite, newKw);
      setKeywords(prev => [...prev, r.data]);
      setNewKw({ keyword: "", location: "" });
      toast.success("Local keyword added");
    } catch (e) { toast.error(e.response?.data?.detail || "Failed"); }
    finally { setAdding(false); }
  };

  const handleDelete = async (kw) => {
    try {
      await deleteLocalKeyword(selectedSite, kw.id);
      setKeywords(prev => prev.filter(k => k.id !== kw.id));
      toast.success("Removed");
    } catch { toast.error("Failed to remove"); }
  };

  const handleGetRecs = async () => {
    setLoadingRecs(true);
    try {
      const r = await getLocalRecommendations(selectedSite);
      setRecommendations(r.data.recommendations || []);
      toast.success("Recommendations generated!");
    } catch (e) { toast.error(e.response?.data?.detail || "Failed"); }
    finally { setLoadingRecs(false); }
  };

  return (
    <div className="page-container">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
            Local Results Tracking
          </motion.h1>
          <p className="page-description">Track local pack and organic rankings by keyword + location</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {/* Add Form */}
      <Card className="content-card mb-6">
        <CardHeader><CardTitle className="font-heading text-sm flex items-center gap-2">
          <Plus size={15} className="text-primary" /> Track New Keyword + Location
        </CardTitle></CardHeader>
        <CardContent>
          <div className="flex gap-3 flex-wrap items-end">
            <div className="space-y-1 flex-1 min-w-[140px]">
              <Label>Keyword</Label>
              <Input placeholder="e.g. coffee shop" value={newKw.keyword}
                onChange={e => setNewKw(p => ({ ...p, keyword: e.target.value }))} />
            </div>
            <div className="space-y-1 flex-1 min-w-[140px]">
              <Label>Location / City</Label>
              <Input placeholder="e.g. New York, NY" value={newKw.location}
                onChange={e => setNewKw(p => ({ ...p, location: e.target.value }))} />
            </div>
            <Button className="btn-primary" onClick={handleAdd} disabled={adding || !selectedSite}>
              {adding ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Plus size={14} className="mr-1" />}
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Visibility Heatmap Grid */}
      {keywords.length > 0 && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
          <Card className="content-card">
            <CardHeader>
              <CardTitle className="font-heading flex items-center gap-2">
                <Map size={16} className="text-primary" /> Local Visibility Map
              </CardTitle>
            </CardHeader>
            <CardContent>
              <VisibilityGrid keywords={keywords} />
              <div className="flex gap-3 mt-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-500/20 inline-block"></span> Rank 1–3</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-yellow-500/20 inline-block"></span> Rank 4–7</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-500/20 inline-block"></span> Rank 8+</span>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Keyword Table */}
      <Card className="content-card mb-6">
        <CardHeader>
          <CardTitle className="font-heading flex items-center gap-2">
            <MapPin size={16} className="text-primary" /> Tracked Keywords
            <Badge variant="secondary" className="ml-auto">{keywords.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-12"><Loader2 size={28} className="animate-spin text-primary" /></div>
          ) : keywords.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No local keywords tracked yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/40 text-muted-foreground text-xs">
                    <th className="text-left py-2 pr-4">Keyword</th>
                    <th className="text-left py-2 px-2">Location</th>
                    <th className="text-center py-2 px-2">Local Pack</th>
                    <th className="text-center py-2 px-2">Organic</th>
                    <th className="text-right py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {keywords.map(kw => (
                    <tr key={kw.id} className="border-b border-border/20 hover:bg-muted/20">
                      <td className="py-2.5 pr-4 font-medium">{kw.keyword}</td>
                      <td className="py-2.5 px-2 text-muted-foreground">{kw.location}</td>
                      <td className="py-2.5 px-2 text-center">
                        {kw.local_pack_rank
                          ? <span className={`font-bold ${kw.local_pack_rank <= 3 ? "text-emerald-500" : kw.local_pack_rank <= 7 ? "text-yellow-500" : "text-red-500"}`}>
                            #{kw.local_pack_rank}
                          </span>
                          : "–"}
                      </td>
                      <td className="py-2.5 px-2 text-center text-muted-foreground">
                        {kw.organic_rank ? `#${kw.organic_rank}` : "–"}
                      </td>
                      <td className="py-2.5 text-right">
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

      {/* AI Recommendations */}
      <div className="flex justify-between items-center mb-3">
        <h2 className="font-heading font-semibold text-base">Local SEO Recommendations</h2>
        <Button variant="outline" size="sm" onClick={handleGetRecs} disabled={loadingRecs || !selectedSite}>
          {loadingRecs ? <Loader2 size={13} className="mr-1 animate-spin" /> : <Sparkles size={13} className="mr-1" />}
          Generate with AI
        </Button>
      </div>
      {recommendations.length > 0 && (
        <div className="grid gap-3">
          {recommendations.map((rec, i) => (
            <motion.div key={i} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.06 }}>
              <Card className="content-card">
                <CardContent className="pt-3 pb-3 flex items-start gap-3">
                  <span className="text-xs font-bold text-primary bg-primary/10 rounded px-1.5 py-0.5 mt-0.5">{rec.category}</span>
                  <p className="text-sm flex-1">{rec.tip}</p>
                  <PriorityBadge priority={rec.priority} />
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
