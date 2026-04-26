import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { MessageSquare, Loader2, RefreshCw, Hash, Users, TrendingUp, Copy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { toast } from "sonner";
import { getSites, findCommunities, generateCommunityAnswer, listCommunityOpportunities, updateCommunityOpp, getCommunityPerformance } from "../lib/api";

const statusColors = { queued: "bg-muted text-muted-foreground", posted: "bg-emerald-500/10 text-emerald-400", skipped: "bg-red-500/10 text-red-400" };

export default function CommunityEngagement() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [opportunities, setOpportunities] = useState([]);
  const [performance, setPerformance] = useState(null);
  const [loading, setLoading] = useState(false);
  const [finding, setFinding] = useState(false);
  const [answerDialog, setAnswerDialog] = useState(null);
  const [generatingAnswer, setGeneratingAnswer] = useState(false);
  const [communities, setCommunities] = useState([]);
  const [form, setForm] = useState({ niche: "", keywords: "" });
  const [answerForm, setAnswerForm] = useState({ thread_title: "", thread_body: "", platform: "reddit", your_domain: "" });

  useEffect(() => {
    getSites().then(r => { setSites(r.data); if (r.data.length > 0) setSelectedSite(r.data[0].id); }).catch(() => {});
  }, []);
  useEffect(() => { if (selectedSite) { loadOpps(); loadPerf(); } }, [selectedSite]);

  const loadOpps = async () => {
    setLoading(true);
    try { const r = await listCommunityOpportunities(selectedSite); setOpportunities(r.data); } catch { setOpportunities([]); }
    finally { setLoading(false); }
  };
  const loadPerf = async () => {
    try { const r = await getCommunityPerformance(selectedSite); setPerformance(r.data); } catch {}
  };

  const handleFind = async () => {
    if (!form.niche.trim()) return toast.error("Enter a niche");
    setFinding(true);
    try {
      const r = await findCommunities(selectedSite, { niche: form.niche, keywords: form.keywords.split(",").map(k => k.trim()).filter(Boolean) });
      setCommunities(r.data.communities || []);
      toast.success(`Found ${r.data.communities?.length || 0} communities`);
    } catch { toast.error("Search failed"); }
    finally { setFinding(false); }
  };

  const handleGenAnswer = async () => {
    if (!answerForm.thread_title.trim()) return toast.error("Enter thread title");
    setGeneratingAnswer(true);
    try {
      const r = await generateCommunityAnswer(selectedSite, "new", answerForm);
      setAnswerDialog(r.data);
      toast.success("Answer generated");
      loadOpps();
    } catch { toast.error("Failed"); }
    finally { setGeneratingAnswer(false); }
  };

  const handleStatusUpdate = async (id, status) => {
    try {
      await updateCommunityOpp(selectedSite, id, { status });
      setOpportunities(prev => prev.map(o => o.id === id ? { ...o, status } : o));
      toast.success("Updated");
    } catch { toast.error("Failed"); }
  };

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><MessageSquare size={24} />Community Engagement</h1>
          <p className="page-description">Find communities, generate helpful answers, and track engagement</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {performance && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Communities", value: performance.communities_found || 0, color: "text-primary" },
            { label: "Answers Drafted", value: performance.answers_drafted || 0, color: "text-blue-400" },
            { label: "Posted", value: performance.posted || 0, color: "text-emerald-400" },
            { label: "Engagement Rate", value: `${performance.engagement_rate || 0}%`, color: "text-yellow-400" },
          ].map(({ label, value, color }) => (
            <Card key={label}><CardContent className="pt-4"><p className={`text-2xl font-bold ${color}`}>{value}</p><p className="text-xs text-muted-foreground">{label}</p></CardContent></Card>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Find Communities</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Input placeholder="Niche *" value={form.niche} onChange={e => setForm(p => ({ ...p, niche: e.target.value }))} />
              <Input placeholder="Keywords (comma-sep)" value={form.keywords} onChange={e => setForm(p => ({ ...p, keywords: e.target.value }))} />
              <Button className="w-full" onClick={handleFind} disabled={finding || !selectedSite}>
                {finding ? <><Loader2 size={14} className="mr-2 animate-spin" />Searching…</> : <><Hash size={14} className="mr-2" />Find Communities</>}
              </Button>
            </CardContent>
          </Card>

          {communities.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Discovered ({communities.length})</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {communities.map((c, i) => (
                    <div key={i} className="p-2.5 rounded-lg border">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">{c.platform}</Badge>
                        <span className="text-sm font-medium truncate">{c.name}</span>
                      </div>
                      <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                        <span><Users size={10} className="inline mr-0.5" />{c.member_count?.toLocaleString()}</span>
                        <span>Activity: {c.activity_level}</span>
                        <span>Relevance: {c.topic_relevance}/10</span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle className="text-base">Generate Answer</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Input placeholder="Thread title *" value={answerForm.thread_title} onChange={e => setAnswerForm(p => ({ ...p, thread_title: e.target.value }))} />
              <Textarea placeholder="Thread body / context" value={answerForm.thread_body} onChange={e => setAnswerForm(p => ({ ...p, thread_body: e.target.value }))} rows={3} />
              <Select value={answerForm.platform} onValueChange={v => setAnswerForm(p => ({ ...p, platform: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["reddit","quora","stackoverflow","forum","other"].map(p => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input placeholder="Your domain" value={answerForm.your_domain} onChange={e => setAnswerForm(p => ({ ...p, your_domain: e.target.value }))} />
              <Button className="w-full" onClick={handleGenAnswer} disabled={generatingAnswer || !selectedSite}>
                {generatingAnswer ? <><Loader2 size={14} className="mr-2 animate-spin" />Generating…</> : "Generate Answer"}
              </Button>
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-base">Opportunities ({opportunities.length})</CardTitle>
              <Button variant="ghost" size="sm" onClick={loadOpps} disabled={loading}><RefreshCw size={12} className={loading ? "animate-spin" : ""} /></Button>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-[560px] overflow-y-auto">
                {opportunities.map(opp => (
                  <div key={opp.id} className="p-3 rounded-lg border hover:bg-muted/20 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{opp.thread_title}</p>
                        <p className="text-xs text-muted-foreground">{opp.platform} · {new Date(opp.created_at).toLocaleDateString()}</p>
                      </div>
                      <Badge className={`text-xs shrink-0 ${statusColors[opp.status] || statusColors.queued}`}>{opp.status}</Badge>
                    </div>
                    <div className="bg-muted/30 rounded p-2 text-xs max-h-24 overflow-y-auto whitespace-pre-wrap">{opp.answer}</div>
                    <div className="flex items-center gap-2">
                      <Select value={opp.status} onValueChange={v => handleStatusUpdate(opp.id, v)}>
                        <SelectTrigger className="h-7 text-xs w-24"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {["queued","posted","skipped"].map(s => <SelectItem key={s} value={s} className="text-xs capitalize">{s}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { navigator.clipboard.writeText(opp.answer); toast.success("Copied"); }}><Copy size={11} className="mr-1" />Copy</Button>
                    </div>
                  </div>
                ))}
                {opportunities.length === 0 && <div className="text-center py-8"><MessageSquare size={32} className="mx-auto mb-2 text-muted-foreground opacity-40" /><p className="text-sm text-muted-foreground">No answers generated yet</p></div>}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={!!answerDialog} onOpenChange={() => setAnswerDialog(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Generated Answer</DialogTitle></DialogHeader>
          {answerDialog && (
            <div className="space-y-3">
              <div className="relative">
                <textarea readOnly value={answerDialog.answer} rows={10} className="w-full p-3 rounded-lg bg-muted/30 text-sm resize-none border border-border" />
                <Button variant="ghost" size="icon" className="absolute top-1 right-1 h-6 w-6" onClick={() => { navigator.clipboard.writeText(answerDialog.answer); toast.success("Copied"); }}><Copy size={12} /></Button>
              </div>
              {answerDialog.natural_link_placement && <p className="text-xs text-muted-foreground">Link placement: {answerDialog.natural_link_placement}</p>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
