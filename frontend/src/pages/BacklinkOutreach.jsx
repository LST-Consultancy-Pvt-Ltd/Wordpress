import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Link2, Plus, Loader2, RefreshCw, Mail, Shield, TrendingUp, Copy, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Badge } from "../components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { toast } from "sonner";
import { getSites, findBacklinkOpportunities, listBacklinkOpportunities, generateOutreachEmail, updateBacklinkStatus, generateDisavow, getDisavow, subscribeToTask } from "../lib/api";

const statusColors = {
  new: "bg-muted text-muted-foreground",
  contacted: "bg-blue-500/10 text-blue-400",
  replied: "bg-yellow-500/10 text-yellow-400",
  acquired: "bg-emerald-500/10 text-emerald-500",
  rejected: "bg-red-500/10 text-red-400",
};
const typeColors = {
  "resource page": "bg-purple-500/10 text-purple-400",
  "broken link": "bg-orange-500/10 text-orange-400",
  "skyscraper": "bg-blue-500/10 text-blue-400",
  "guest post": "bg-emerald-500/10 text-emerald-400",
};

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0" onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); toast.success("Copied"); }}>
      {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
    </Button>
  );
}

export default function BacklinkOutreach() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [opportunities, setOpportunities] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState("");
  const [disavow, setDisavow] = useState(null);
  const [emailDialog, setEmailDialog] = useState(null);
  const [generatingEmail, setGeneratingEmail] = useState(false);

  const [form, setForm] = useState({ competitor_urls: "", your_domain: "", niche: "" });

  useEffect(() => {
    getSites().then(r => { setSites(r.data); if (r.data.length > 0) setSelectedSite(r.data[0].id); }).catch(() => {});
  }, []);
  useEffect(() => { if (selectedSite) { loadOpportunities(); loadDisavow(); } }, [selectedSite]);

  const loadOpportunities = async () => {
    setLoading(true);
    try { const r = await listBacklinkOpportunities(selectedSite); setOpportunities(r.data); }
    catch { setOpportunities([]); } finally { setLoading(false); }
  };
  const loadDisavow = async () => {
    try { const r = await getDisavow(selectedSite); setDisavow(r.data); } catch {}
  };

  const handleScan = async () => {
    const urls = form.competitor_urls.split("\n").map(u => u.trim()).filter(Boolean);
    if (!urls.length) return toast.error("Enter at least one competitor URL");
    if (!form.your_domain.trim()) return toast.error("Enter your domain");
    setScanning(true); setProgress("Starting analysis…");
    try {
      const r = await findBacklinkOpportunities(selectedSite, { competitor_urls: urls, your_domain: form.your_domain, niche: form.niche });
      subscribeToTask(r.data.task_id, evt => {
        if (evt.type === "progress") setProgress(evt.data?.message || "…");
        if (evt.type === "complete") { setScanning(false); setProgress(""); loadOpportunities(); toast.success(`Found ${evt.data?.count || 0} opportunities`); }
        if (evt.type === "error") { setScanning(false); setProgress(""); toast.error(evt.data?.message || "Scan failed"); }
      });
    } catch (e) { setScanning(false); setProgress(""); toast.error(e.response?.data?.detail || "Failed"); }
  };

  const handleGenerateEmail = async (opp) => {
    setGeneratingEmail(true);
    try {
      const r = await generateOutreachEmail(selectedSite, opp.id);
      setEmailDialog({ ...opp, email: r.data });
      toast.success("Email generated");
    } catch { toast.error("Failed to generate email"); }
    finally { setGeneratingEmail(false); }
  };

  const handleStatusChange = async (oppId, status) => {
    try {
      await updateBacklinkStatus(selectedSite, oppId, { status });
      setOpportunities(prev => prev.map(o => o.id === oppId ? { ...o, status } : o));
      toast.success("Status updated");
    } catch { toast.error("Failed"); }
  };

  const handleGenerateDisavow = async () => {
    try { const r = await generateDisavow(selectedSite); setDisavow(r.data); toast.success(`Disavow file generated (${r.data.domain_count} domains)`); }
    catch { toast.error("Failed"); }
  };

  const acquired = opportunities.filter(o => o.status === "acquired").length;

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Link2 size={24} />Backlink Outreach</h1>
          <p className="page-description">Competitor gap analysis, personalised outreach emails, and acquisition tracking</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {progress && <Card className="border-blue-500/30 bg-blue-500/5"><CardContent className="py-3 flex items-center gap-3"><Loader2 size={14} className="animate-spin text-blue-400" /><p className="text-sm text-blue-400">{progress}</p></CardContent></Card>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Find Opportunities</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Your Domain *</label><Input placeholder="example.com" value={form.your_domain} onChange={e => setForm(p => ({ ...p, your_domain: e.target.value }))} /></div>
              <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Niche</label><Input placeholder="Plumbing, SaaS, etc." value={form.niche} onChange={e => setForm(p => ({ ...p, niche: e.target.value }))} /></div>
              <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Competitor URLs (one per line) *</label><Textarea rows={4} placeholder={"https://competitor1.com\nhttps://competitor2.com"} value={form.competitor_urls} onChange={e => setForm(p => ({ ...p, competitor_urls: e.target.value }))} /></div>
              <Button className="w-full" onClick={handleScan} disabled={scanning || !selectedSite}>
                {scanning ? <><Loader2 size={14} className="mr-2 animate-spin" />Scanning…</> : <><TrendingUp size={14} className="mr-2" />Analyse Backlink Gap</>}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><Shield size={16} />Disavow File</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">Auto-generate a disavow file for all low-DA (&lt;20) domains.</p>
              <Button variant="outline" className="w-full" onClick={handleGenerateDisavow}>Generate Disavow</Button>
              {disavow?.content && (
                <div className="relative">
                  <Textarea rows={6} readOnly value={disavow.content} className="font-mono text-xs" />
                  <CopyBtn text={disavow.content} />
                  <p className="text-xs text-muted-foreground mt-1">{disavow.domain_count} domains</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-base">Opportunities ({opportunities.length})</CardTitle>
              <div className="flex items-center gap-2">
                <Badge className="bg-emerald-500/10 text-emerald-400 text-xs">{acquired} acquired</Badge>
                <Button variant="ghost" size="sm" onClick={loadOpportunities} disabled={loading}><RefreshCw size={12} className={loading ? "animate-spin" : ""} /></Button>
              </div>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="all">
                <TabsList className="mb-3">
                  {["all", "new", "contacted", "replied", "acquired"].map(t => (
                    <TabsTrigger key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</TabsTrigger>
                  ))}
                </TabsList>
                {["all", "new", "contacted", "replied", "acquired"].map(tab => (
                  <TabsContent key={tab} value={tab}>
                    <div className="space-y-2 max-h-[500px] overflow-y-auto">
                      {opportunities.filter(o => tab === "all" || o.status === tab).map(opp => (
                        <div key={opp.id} className="p-3 rounded-lg border hover:bg-muted/20">
                          <div className="flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm truncate">{opp.prospect_domain}</p>
                              <p className="text-xs text-muted-foreground mt-0.5">{opp.reason}</p>
                              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                <Badge className={`text-xs ${typeColors[opp.opportunity_type] || ""}`}>{opp.opportunity_type}</Badge>
                                <span className="text-xs text-muted-foreground">DA ~{opp.estimated_da}</span>
                                <span className="text-xs text-muted-foreground">Relevance: {opp.relevance_score}/10</span>
                              </div>
                            </div>
                            <div className="flex flex-col items-end gap-2 shrink-0">
                              <Badge className={`text-xs ${statusColors[opp.status]}`}>{opp.status}</Badge>
                              <div className="flex gap-1">
                                <Button variant="outline" size="sm" className="h-6 text-xs px-2" onClick={() => handleGenerateEmail(opp)} disabled={generatingEmail}>
                                  <Mail size={10} className="mr-1" />Email
                                </Button>
                                <Select value={opp.status} onValueChange={val => handleStatusChange(opp.id, val)}>
                                  <SelectTrigger className="h-6 text-xs px-2 w-28"><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    {["new","contacted","replied","acquired","rejected"].map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                      {opportunities.filter(o => tab === "all" || o.status === tab).length === 0 && (
                        <div className="text-center py-8"><Link2 size={32} className="mx-auto mb-2 text-muted-foreground opacity-40" /><p className="text-sm text-muted-foreground">No {tab === "all" ? "" : tab} opportunities yet</p></div>
                      )}
                    </div>
                  </TabsContent>
                ))}
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={!!emailDialog} onOpenChange={() => setEmailDialog(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Outreach Email — {emailDialog?.prospect_domain}</DialogTitle></DialogHeader>
          {emailDialog?.email && (
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Subject</label>
                <div className="flex gap-2 items-center p-2 rounded bg-muted/30">
                  <p className="text-sm flex-1">{emailDialog.email.subject}</p>
                  <CopyBtn text={emailDialog.email.subject} />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Body</label>
                <div className="relative">
                  <Textarea rows={10} readOnly value={emailDialog.email.body} />
                  <div className="absolute top-2 right-2"><CopyBtn text={emailDialog.email.body} /></div>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
