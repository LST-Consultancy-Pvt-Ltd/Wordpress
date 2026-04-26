import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Mic, Loader2, RefreshCw, Radio, FileText, Mail } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { toast } from "sonner";
import { getSites, findPodcasts, listPodcasts, generatePodcastPitch, generateTalkingPoints, updatePodcastStatus } from "../lib/api";

const statusColors = {
  new: "bg-muted text-muted-foreground",
  pitched: "bg-blue-500/10 text-blue-400",
  booked: "bg-yellow-500/10 text-yellow-400",
  recorded: "bg-emerald-500/10 text-emerald-400",
  published: "bg-primary/10 text-primary",
};

export default function PodcastOutreach() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [podcasts, setPodcasts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [finding, setFinding] = useState(false);
  const [contentDialog, setContentDialog] = useState(null);
  const [generatingId, setGeneratingId] = useState("");
  const [form, setForm] = useState({ niche: "", expert_name: "", expertise_topics: "" });

  useEffect(() => {
    getSites().then(r => { setSites(r.data); if (r.data.length > 0) setSelectedSite(r.data[0].id); }).catch(() => {});
  }, []);
  useEffect(() => { if (selectedSite) loadPodcasts(); }, [selectedSite]);

  const loadPodcasts = async () => {
    setLoading(true);
    try { const r = await listPodcasts(selectedSite); setPodcasts(r.data); } catch { setPodcasts([]); }
    finally { setLoading(false); }
  };

  const handleFind = async () => {
    if (!form.niche.trim()) return toast.error("Enter a niche");
    setFinding(true);
    try {
      await findPodcasts(selectedSite, { niche: form.niche, expert_name: form.expert_name, expertise_topics: form.expertise_topics.split(",").map(k => k.trim()).filter(Boolean) });
      toast.success("Podcasts found");
      loadPodcasts();
    } catch { toast.error("Search failed"); }
    finally { setFinding(false); }
  };

  const handlePitch = async (id) => {
    setGeneratingId(id);
    try {
      const r = await generatePodcastPitch(selectedSite, id);
      setContentDialog({ type: "Podcast Pitch", ...r.data });
      toast.success("Pitch generated");
    } catch { toast.error("Failed"); }
    finally { setGeneratingId(""); }
  };

  const handleTalkingPoints = async (id) => {
    setGeneratingId(id);
    try {
      const r = await generateTalkingPoints(selectedSite, id);
      setContentDialog({ type: "Talking Points", ...r.data });
      toast.success("Talking points generated");
    } catch { toast.error("Failed"); }
    finally { setGeneratingId(""); }
  };

  const handleStatusUpdate = async (id, status) => {
    try {
      await updatePodcastStatus(selectedSite, id, { status });
      setPodcasts(prev => prev.map(p => p.id === id ? { ...p, status } : p));
      toast.success("Status updated");
    } catch { toast.error("Failed"); }
  };

  const statusCounts = podcasts.reduce((acc, p) => { acc[p.status] = (acc[p.status] || 0) + 1; return acc; }, {});

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Mic size={24} />Podcast Outreach</h1>
          <p className="page-description">Find podcasts, generate pitches, and prepare talking points</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {podcasts.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {["new","pitched","booked","recorded","published"].map(s => (
            <Card key={s}><CardContent className="pt-3 pb-3 text-center"><p className="text-xl font-bold">{statusCounts[s] || 0}</p><p className="text-xs text-muted-foreground capitalize">{s}</p></CardContent></Card>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Find Podcasts</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Input placeholder="Niche *" value={form.niche} onChange={e => setForm(p => ({ ...p, niche: e.target.value }))} />
            <Input placeholder="Expert name" value={form.expert_name} onChange={e => setForm(p => ({ ...p, expert_name: e.target.value }))} />
            <Input placeholder="Expertise topics (comma-sep)" value={form.expertise_topics} onChange={e => setForm(p => ({ ...p, expertise_topics: e.target.value }))} />
            <Button className="w-full" onClick={handleFind} disabled={finding || !selectedSite}>
              {finding ? <><Loader2 size={14} className="mr-2 animate-spin" />Searching…</> : <><Radio size={14} className="mr-2" />Find Podcasts</>}
            </Button>
          </CardContent>
        </Card>

        <div className="lg:col-span-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-base">Podcasts ({podcasts.length})</CardTitle>
              <Button variant="ghost" size="sm" onClick={loadPodcasts} disabled={loading}><RefreshCw size={12} className={loading ? "animate-spin" : ""} /></Button>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[540px] overflow-y-auto">
                {podcasts.map(pod => (
                  <div key={pod.id} className="p-3 rounded-lg border hover:bg-muted/20 space-y-2">
                    <div className="flex items-start justify-between">
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{pod.podcast_name}</p>
                        <p className="text-xs text-muted-foreground">Host: {pod.host_name}</p>
                      </div>
                      <Badge className={`text-xs shrink-0 ${statusColors[pod.status] || statusColors.new}`}>{pod.status}</Badge>
                    </div>
                    <div className="flex gap-3 text-xs text-muted-foreground">
                      <span><Radio size={10} className="inline mr-0.5" />{pod.estimated_monthly_listeners?.toLocaleString() || "—"} listeners</span>
                      <span>Relevance: {pod.relevance_score || "—"}/10</span>
                      {pod.episodes_count && <span>{pod.episodes_count} episodes</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Select value={pod.status} onValueChange={v => handleStatusUpdate(pod.id, v)}>
                        <SelectTrigger className="h-7 text-xs w-24"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {["new","pitched","booked","recorded","published"].map(s => <SelectItem key={s} value={s} className="text-xs capitalize">{s}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => handlePitch(pod.id)} disabled={generatingId === pod.id}>
                        {generatingId === pod.id ? <Loader2 size={11} className="animate-spin" /> : <><Mail size={11} className="mr-1" />Pitch</>}
                      </Button>
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => handleTalkingPoints(pod.id)} disabled={generatingId === pod.id}>
                        {generatingId === pod.id ? <Loader2 size={11} className="animate-spin" /> : <><FileText size={11} className="mr-1" />Talking Pts</>}
                      </Button>
                    </div>
                  </div>
                ))}
                {podcasts.length === 0 && <div className="col-span-2 text-center py-8"><Mic size={32} className="mx-auto mb-2 text-muted-foreground opacity-40" /><p className="text-sm text-muted-foreground">No podcasts found yet</p></div>}
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
              {contentDialog.body && <div><label className="text-xs text-muted-foreground">Body</label><textarea readOnly value={contentDialog.body} rows={8} className="w-full mt-1 p-3 rounded-lg bg-muted/30 text-sm resize-none border border-border" /></div>}
              {contentDialog.speaker_bio && <div><label className="text-xs text-muted-foreground">Speaker Bio</label><p className="text-sm bg-muted/30 p-2 rounded">{contentDialog.speaker_bio}</p></div>}
              {contentDialog.proposed_topics?.length > 0 && (
                <div><label className="text-xs text-muted-foreground">Proposed Topics</label>
                  <div className="flex flex-wrap gap-1.5 mt-1">{contentDialog.proposed_topics.map((t, i) => <Badge key={i} variant="secondary" className="text-xs">{t}</Badge>)}</div>
                </div>
              )}
              {contentDialog.episode_title_suggestions?.length > 0 && (
                <div><label className="text-xs text-muted-foreground">Episode Title Ideas</label>
                  <ul className="mt-1 space-y-1">{contentDialog.episode_title_suggestions.map((t, i) => <li key={i} className="text-sm">{t}</li>)}</ul>
                </div>
              )}
              {contentDialog.talking_points?.length > 0 && (
                <div><label className="text-xs text-muted-foreground">Talking Points</label>
                  <ul className="mt-1 space-y-1 list-disc pl-4">{contentDialog.talking_points.map((t, i) => <li key={i} className="text-sm">{t}</li>)}</ul>
                </div>
              )}
              {contentDialog.hook_opening && <div><label className="text-xs text-muted-foreground">Hook Opening</label><p className="text-sm bg-muted/30 p-2 rounded">{contentDialog.hook_opening}</p></div>}
              {contentDialog.call_to_action && <div><label className="text-xs text-muted-foreground">Call to Action</label><p className="text-sm bg-muted/30 p-2 rounded">{contentDialog.call_to_action}</p></div>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
