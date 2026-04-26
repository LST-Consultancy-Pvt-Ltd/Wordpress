import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Users, Loader2, RefreshCw, Mail, FileText, Globe, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { toast } from "sonner";
import { getSites, findInfluencers, listInfluencers, generateInfluencerPitch, generateCollabBrief, updateInfluencerStatus } from "../lib/api";

const statusColors = {
  new: "bg-muted text-muted-foreground",
  contacted: "bg-blue-500/10 text-blue-400",
  negotiating: "bg-yellow-500/10 text-yellow-400",
  active: "bg-emerald-500/10 text-emerald-400",
  completed: "bg-primary/10 text-primary",
};

export default function InfluencerOutreach() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [influencers, setInfluencers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [finding, setFinding] = useState(false);
  const [contentDialog, setContentDialog] = useState(null);
  const [generatingId, setGeneratingId] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [form, setForm] = useState({ niche: "", collaboration_type: "sponsored_post" });

  useEffect(() => {
    getSites().then(r => { setSites(r.data); if (r.data.length > 0) setSelectedSite(r.data[0].id); }).catch(() => {});
  }, []);
  useEffect(() => { if (selectedSite) loadInfluencers(); }, [selectedSite]);

  const loadInfluencers = async () => {
    setLoading(true);
    try { const r = await listInfluencers(selectedSite); setInfluencers(r.data); } catch { setInfluencers([]); }
    finally { setLoading(false); }
  };

  const handleFind = async () => {
    if (!form.niche.trim()) return toast.error("Enter a niche");
    setFinding(true);
    try {
      await findInfluencers(selectedSite, form);
      toast.success("Influencers found");
      loadInfluencers();
    } catch { toast.error("Search failed"); }
    finally { setFinding(false); }
  };

  const handlePitch = async (id) => {
    setGeneratingId(id);
    try {
      const r = await generateInfluencerPitch(selectedSite, id);
      setContentDialog({ type: "Pitch Email", ...r.data });
      toast.success("Pitch generated");
    } catch { toast.error("Failed"); }
    finally { setGeneratingId(""); }
  };

  const handleBrief = async (id) => {
    setGeneratingId(id);
    try {
      const r = await generateCollabBrief(selectedSite, id);
      setContentDialog({ type: "Collaboration Brief", ...r.data });
      toast.success("Brief generated");
    } catch { toast.error("Failed"); }
    finally { setGeneratingId(""); }
  };

  const handleStatusUpdate = async (id, status) => {
    try {
      await updateInfluencerStatus(selectedSite, id, { status });
      setInfluencers(prev => prev.map(inf => inf.id === id ? { ...inf, status } : inf));
      toast.success("Status updated");
    } catch { toast.error("Failed"); }
  };

  const filtered = filterStatus === "all" ? influencers : influencers.filter(i => i.status === filterStatus);
  const statusCounts = influencers.reduce((acc, i) => { acc[i.status] = (acc[i.status] || 0) + 1; return acc; }, {});

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Users size={24} />Influencer Outreach</h1>
          <p className="page-description">Find influencers, generate pitches, and manage collaborations</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {influencers.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {["new","contacted","negotiating","active","completed"].map(s => (
            <Card key={s} className={`cursor-pointer transition-all ${filterStatus === s ? "border-primary" : ""}`} onClick={() => setFilterStatus(filterStatus === s ? "all" : s)}>
              <CardContent className="pt-3 pb-3 text-center">
                <p className="text-xl font-bold">{statusCounts[s] || 0}</p>
                <p className="text-xs text-muted-foreground capitalize">{s}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Find Influencers</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Input placeholder="Niche *" value={form.niche} onChange={e => setForm(p => ({ ...p, niche: e.target.value }))} />
            <Select value={form.collaboration_type} onValueChange={v => setForm(p => ({ ...p, collaboration_type: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["sponsored_post","product_review","co_content","guest_post"].map(t => (
                  <SelectItem key={t} value={t}>{t.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button className="w-full" onClick={handleFind} disabled={finding || !selectedSite}>
              {finding ? <><Loader2 size={14} className="mr-2 animate-spin" />Searching…</> : <><Users size={14} className="mr-2" />Find Influencers</>}
            </Button>
          </CardContent>
        </Card>

        <div className="lg:col-span-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-base">Influencers ({filtered.length})</CardTitle>
              <Button variant="ghost" size="sm" onClick={loadInfluencers} disabled={loading}><RefreshCw size={12} className={loading ? "animate-spin" : ""} /></Button>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[540px] overflow-y-auto">
                {filtered.map(inf => (
                  <div key={inf.id} className="p-3 rounded-lg border hover:bg-muted/20 space-y-2">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-medium text-sm">{inf.name}</p>
                        <p className="text-xs text-muted-foreground">{inf.platform} · {inf.niche}</p>
                      </div>
                      <Badge className={`text-xs ${statusColors[inf.status] || statusColors.new}`}>{inf.status}</Badge>
                    </div>
                    <div className="flex gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1"><Globe size={10} />{inf.estimated_monthly_reach?.toLocaleString() || "—"} reach</span>
                      <span className="flex items-center gap-1"><TrendingUp size={10} />{inf.relevance_score || "—"}/10</span>
                      {inf.engagement_rate && <span>{inf.engagement_rate}% eng.</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Select value={inf.status} onValueChange={v => handleStatusUpdate(inf.id, v)}>
                        <SelectTrigger className="h-7 text-xs w-28"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {["new","contacted","negotiating","active","completed"].map(s => <SelectItem key={s} value={s} className="text-xs capitalize">{s}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => handlePitch(inf.id)} disabled={generatingId === inf.id}>
                        {generatingId === inf.id ? <Loader2 size={11} className="animate-spin" /> : <><Mail size={11} className="mr-1" />Pitch</>}
                      </Button>
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => handleBrief(inf.id)} disabled={generatingId === inf.id}>
                        {generatingId === inf.id ? <Loader2 size={11} className="animate-spin" /> : <><FileText size={11} className="mr-1" />Brief</>}
                      </Button>
                    </div>
                  </div>
                ))}
                {filtered.length === 0 && <div className="col-span-2 text-center py-8"><Users size={32} className="mx-auto mb-2 text-muted-foreground opacity-40" /><p className="text-sm text-muted-foreground">No influencers found</p></div>}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={!!contentDialog} onOpenChange={() => setContentDialog(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{contentDialog?.type}</DialogTitle></DialogHeader>
          {contentDialog && (
            <div className="space-y-3">
              {contentDialog.subject && <div><label className="text-xs text-muted-foreground">Subject</label><p className="font-medium">{contentDialog.subject}</p></div>}
              {contentDialog.body && <div><label className="text-xs text-muted-foreground">Body</label><textarea readOnly value={contentDialog.body} rows={10} className="w-full mt-1 p-3 rounded-lg bg-muted/30 text-sm resize-none border border-border" /></div>}
              {contentDialog.brief && <div><label className="text-xs text-muted-foreground">Brief</label><textarea readOnly value={contentDialog.brief} rows={10} className="w-full mt-1 p-3 rounded-lg bg-muted/30 text-sm resize-none border border-border" /></div>}
              {contentDialog.deliverables?.length > 0 && (
                <div><label className="text-xs text-muted-foreground">Deliverables</label>
                  <div className="flex flex-wrap gap-1.5 mt-1">{contentDialog.deliverables.map((d, i) => <Badge key={i} variant="secondary" className="text-xs">{d}</Badge>)}</div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
