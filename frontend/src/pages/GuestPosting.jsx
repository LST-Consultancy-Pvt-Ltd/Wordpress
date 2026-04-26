import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { PenLine, Plus, Loader2, RefreshCw, Mail, FileText, ExternalLink, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Textarea } from "../components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { toast } from "sonner";
import { getSites, findGuestPostSites, listGuestPostProspects, generateGuestPitch, generateGuestArticle, updateGuestProspect, checkGuestLiveLinks } from "../lib/api";

const statusColors = {
  prospect: "bg-muted text-muted-foreground",
  pitched: "bg-blue-500/10 text-blue-400",
  accepted: "bg-yellow-500/10 text-yellow-400",
  published: "bg-emerald-500/10 text-emerald-500",
  rejected: "bg-red-500/10 text-red-400",
};

export default function GuestPosting() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [prospects, setProspects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [finding, setFinding] = useState(false);
  const [checkingLinks, setCheckingLinks] = useState(false);
  const [form, setForm] = useState({ niche: "", target_domain: "" });
  const [activeProspect, setActiveProspect] = useState(null);
  const [dialog, setDialog] = useState(null); // "pitch" | "article"
  const [dialogContent, setDialogContent] = useState(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    getSites().then(r => { setSites(r.data); if (r.data.length > 0) setSelectedSite(r.data[0].id); }).catch(() => {});
  }, []);
  useEffect(() => { if (selectedSite) loadProspects(); }, [selectedSite]);

  const loadProspects = async () => {
    setLoading(true);
    try { const r = await listGuestPostProspects(selectedSite); setProspects(r.data); }
    catch { setProspects([]); } finally { setLoading(false); }
  };

  const handleFind = async () => {
    if (!form.niche.trim()) return toast.error("Enter a niche");
    setFinding(true);
    try {
      const r = await findGuestPostSites(selectedSite, form);
      setProspects(prev => [...r.data.prospects, ...prev]);
      toast.success(`Found ${r.data.count} guest post sites`);
    } catch (e) { toast.error(e.response?.data?.detail || "Failed"); }
    finally { setFinding(false); }
  };

  const handleGenerate = async (type) => {
    if (!activeProspect) return;
    setGenerating(true);
    try {
      const fn = type === "pitch" ? generateGuestPitch : generateGuestArticle;
      const r = await fn(selectedSite, activeProspect.id);
      setDialogContent(r.data);
      setDialog(type);
      setProspects(prev => prev.map(p => p.id === activeProspect.id ? { ...p, [`${type}_drafted`]: true } : p));
      toast.success(`${type === "pitch" ? "Pitch email" : "Article"} generated`);
    } catch { toast.error("Generation failed"); }
    finally { setGenerating(false); }
  };

  const handleStatusChange = async (prospectId, status) => {
    try {
      await updateGuestProspect(selectedSite, prospectId, { status });
      setProspects(prev => prev.map(p => p.id === prospectId ? { ...p, status } : p));
      if (activeProspect?.id === prospectId) setActiveProspect(p => ({ ...p, status }));
      toast.success("Status updated");
    } catch { toast.error("Failed"); }
  };

  const handleCheckLinks = async () => {
    setCheckingLinks(true);
    try {
      const r = await checkGuestLiveLinks(selectedSite);
      toast.success(`Checked ${r.data.length} links`);
      loadProspects();
    } catch { toast.error("Failed"); }
    finally { setCheckingLinks(false); }
  };

  const published = prospects.filter(p => p.status === "published");

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><PenLine size={24} />Guest Posting</h1>
          <p className="page-description">Find sites, generate pitches, draft articles, and track submissions</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleCheckLinks} disabled={checkingLinks}>
            {checkingLinks ? <Loader2 size={14} className="animate-spin mr-1" /> : <ExternalLink size={14} className="mr-1" />}Check Live Links
          </Button>
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
            <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-4 mb-2">
        {["prospect","pitched","accepted","published","rejected"].map(s => (
          <Card key={s}><CardContent className="pt-4 text-center">
            <p className="text-xl font-bold">{prospects.filter(p => p.status === s).length}</p>
            <p className="text-xs text-muted-foreground capitalize">{s}</p>
          </CardContent></Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Find Guest Post Sites</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Input placeholder="Niche *" value={form.niche} onChange={e => setForm(p => ({ ...p, niche: e.target.value }))} />
              <Input placeholder="Your domain (optional)" value={form.target_domain} onChange={e => setForm(p => ({ ...p, target_domain: e.target.value }))} />
              <Button className="w-full" onClick={handleFind} disabled={finding || !selectedSite}>
                {finding ? <><Loader2 size={14} className="mr-2 animate-spin" />Finding…</> : <><Plus size={14} className="mr-2" />Find Sites</>}
              </Button>
            </CardContent>
          </Card>

          {activeProspect && (
            <Card className="border-primary/30">
              <CardHeader className="pb-2"><CardTitle className="text-sm">{activeProspect.site_name}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">{activeProspect.notes}</p>
                <div className="flex gap-1.5 flex-wrap">
                  <Badge className="text-xs">DA ~{activeProspect.domain_authority}</Badge>
                  {activeProspect.pitch_drafted && <Badge className="bg-emerald-500/10 text-emerald-400 text-xs"><Check size={9} className="mr-1" />Pitch</Badge>}
                  {activeProspect.article_drafted && <Badge className="bg-emerald-500/10 text-emerald-400 text-xs"><Check size={9} className="mr-1" />Article</Badge>}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="flex-1 text-xs" onClick={() => handleGenerate("pitch")} disabled={generating}>
                    <Mail size={11} className="mr-1" />Generate Pitch
                  </Button>
                  <Button size="sm" variant="outline" className="flex-1 text-xs" onClick={() => handleGenerate("article")} disabled={generating}>
                    <FileText size={11} className="mr-1" />Draft Article
                  </Button>
                </div>
                <Select value={activeProspect.status} onValueChange={val => handleStatusChange(activeProspect.id, val)}>
                  <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>{["prospect","pitched","accepted","published","rejected"].map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                </Select>
                {activeProspect.status === "published" && (
                  <Input placeholder="Published URL" onBlur={e => updateGuestProspect(selectedSite, activeProspect.id, { published_url: e.target.value })} className="text-xs h-7" />
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-base">Prospects ({prospects.length})</CardTitle>
              <Button variant="ghost" size="sm" onClick={loadProspects} disabled={loading}><RefreshCw size={12} className={loading ? "animate-spin" : ""} /></Button>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-[520px] overflow-y-auto">
                {prospects.map(p => (
                  <button key={p.id} onClick={() => setActiveProspect(p)}
                    className={`w-full text-left p-3 rounded-lg border hover:bg-muted/20 transition-colors ${activeProspect?.id === p.id ? "border-primary bg-primary/5" : ""}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{p.site_name}</p>
                        <p className="text-xs text-muted-foreground truncate">{p.url}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <Badge className="text-xs">DA ~{p.domain_authority}</Badge>
                        <Badge className={`text-xs ${statusColors[p.status]}`}>{p.status}</Badge>
                      </div>
                    </div>
                  </button>
                ))}
                {prospects.length === 0 && !loading && <div className="text-center py-8"><PenLine size={32} className="mx-auto mb-2 text-muted-foreground opacity-40" /><p className="text-sm text-muted-foreground">No prospects yet. Find sites to get started.</p></div>}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={!!dialog} onOpenChange={() => { setDialog(null); setDialogContent(null); }}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{dialog === "pitch" ? "Pitch Email" : "Draft Article"} — {activeProspect?.site_name}</DialogTitle></DialogHeader>
          {dialog === "pitch" && dialogContent && (
            <div className="space-y-3">
              <div><label className="text-xs text-muted-foreground">Subject</label><p className="font-medium">{dialogContent.subject}</p></div>
              <div><label className="text-xs text-muted-foreground">Body</label><Textarea rows={12} readOnly value={dialogContent.body} /></div>
              {dialogContent.title_ideas?.length > 0 && (
                <div><label className="text-xs text-muted-foreground">Article Ideas</label>
                  <ul className="list-disc pl-4 space-y-1">{dialogContent.title_ideas.map((t, i) => <li key={i} className="text-sm">{t}</li>)}</ul>
                </div>
              )}
            </div>
          )}
          {dialog === "article" && dialogContent && (
            <div className="space-y-3">
              <div><label className="text-xs text-muted-foreground">Title</label><p className="font-semibold text-base">{dialogContent.title}</p></div>
              <div><label className="text-xs text-muted-foreground">Author Bio</label><p className="text-sm text-muted-foreground italic">{dialogContent.author_bio}</p></div>
              <Textarea rows={20} readOnly value={dialogContent.content} className="font-mono text-xs" />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
