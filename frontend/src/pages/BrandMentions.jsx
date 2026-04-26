import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Bell, Loader2, RefreshCw, ThumbsUp, ThumbsDown, Minus, Mail, BarChart3 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { toast } from "sonner";
import { getSites, scanBrandMentions, listBrandMentions, generateMentionOutreach, getBrandMentionSummary, subscribeToTask } from "../lib/api";

const sentimentIcons = { positive: ThumbsUp, negative: ThumbsDown, neutral: Minus };
const sentimentColors = {
  positive: "text-emerald-400 bg-emerald-500/10",
  negative: "text-red-400 bg-red-500/10",
  neutral: "text-muted-foreground bg-muted",
};

export default function BrandMentions() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [mentions, setMentions] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState("");
  const [emailDialog, setEmailDialog] = useState(null);
  const [generatingEmail, setGeneratingEmail] = useState("");

  const [form, setForm] = useState({ brand_name: "", your_domain: "", keywords: "" });

  useEffect(() => {
    getSites().then(r => { setSites(r.data); if (r.data.length > 0) setSelectedSite(r.data[0].id); }).catch(() => {});
  }, []);
  useEffect(() => { if (selectedSite) { loadMentions(); loadSummary(); } }, [selectedSite]);

  const loadMentions = async () => {
    setLoading(true);
    try { const r = await listBrandMentions(selectedSite); setMentions(r.data); }
    catch { setMentions([]); } finally { setLoading(false); }
  };
  const loadSummary = async () => {
    try { const r = await getBrandMentionSummary(selectedSite); setSummary(r.data); } catch {}
  };

  const handleScan = async () => {
    if (!form.brand_name.trim()) return toast.error("Enter brand name");
    setScanning(true); setProgress("Scanning the web for mentions…");
    try {
      const r = await scanBrandMentions(selectedSite, { brand_name: form.brand_name, your_domain: form.your_domain, keywords: form.keywords.split(",").map(k => k.trim()).filter(Boolean) });
      subscribeToTask(r.data.task_id, evt => {
        if (evt.type === "progress") setProgress(evt.data?.message || "…");
        if (evt.type === "complete") { setScanning(false); setProgress(""); loadMentions(); loadSummary(); toast.success(`Found ${evt.data?.count || 0} mentions`); }
        if (evt.type === "error") { setScanning(false); setProgress(""); toast.error(evt.data?.message || "Scan failed"); }
      });
    } catch (e) { setScanning(false); setProgress(""); toast.error("Scan failed"); }
  };

  const handleGenerateOutreach = async (mention) => {
    if (mention.has_link) return toast.info("This mention already has a link — no outreach needed.");
    setGeneratingEmail(mention.id);
    try {
      const r = await generateMentionOutreach(selectedSite, mention.id);
      setEmailDialog({ mention, email: r.data });
      toast.success("Outreach email generated");
    } catch { toast.error("Failed"); }
    finally { setGeneratingEmail(""); }
  };

  const filtered = (tab) => tab === "all" ? mentions : tab === "unlinked" ? mentions.filter(m => m.is_unlinked_mention) : mentions.filter(m => m.sentiment === tab);

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Bell size={24} />Brand Mentions</h1>
          <p className="page-description">Monitor web mentions, classify sentiment, and convert unlinked mentions to backlinks</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {progress && <Card className="border-blue-500/30 bg-blue-500/5"><CardContent className="py-3 flex items-center gap-3"><Loader2 size={14} className="animate-spin text-blue-400" /><p className="text-sm text-blue-400">{progress}</p></CardContent></Card>}

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Total Mentions", value: summary.total, color: "text-primary" },
            { label: "Positive", value: summary.positive, color: "text-emerald-400" },
            { label: "Negative", value: summary.negative, color: "text-red-400" },
            { label: "Unlinked", value: summary.unlinked, color: "text-yellow-400" },
          ].map(({ label, value, color }) => (
            <Card key={label}><CardContent className="pt-4"><p className={`text-2xl font-bold ${color}`}>{value}</p><p className="text-xs text-muted-foreground">{label}</p></CardContent></Card>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Scan for Mentions</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Input placeholder="Brand name *" value={form.brand_name} onChange={e => setForm(p => ({ ...p, brand_name: e.target.value }))} />
            <Input placeholder="Your domain" value={form.your_domain} onChange={e => setForm(p => ({ ...p, your_domain: e.target.value }))} />
            <Input placeholder="Additional keywords (comma-sep)" value={form.keywords} onChange={e => setForm(p => ({ ...p, keywords: e.target.value }))} />
            <Button className="w-full" onClick={handleScan} disabled={scanning || !selectedSite}>
              {scanning ? <><Loader2 size={14} className="mr-2 animate-spin" />Scanning…</> : <><BarChart3 size={14} className="mr-2" />Scan Mentions</>}
            </Button>
          </CardContent>
        </Card>

        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-base">Mentions ({mentions.length})</CardTitle>
              <Button variant="ghost" size="sm" onClick={loadMentions} disabled={loading}><RefreshCw size={12} className={loading ? "animate-spin" : ""} /></Button>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="all">
                <TabsList className="mb-3">
                  {["all","positive","negative","neutral","unlinked"].map(t => (
                    <TabsTrigger key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</TabsTrigger>
                  ))}
                </TabsList>
                {["all","positive","negative","neutral","unlinked"].map(tab => (
                  <TabsContent key={tab} value={tab}>
                    <div className="space-y-2 max-h-[480px] overflow-y-auto">
                      {filtered(tab).map(m => {
                        const Icon = sentimentIcons[m.sentiment] || Minus;
                        return (
                          <div key={m.id} className="p-3 rounded-lg border hover:bg-muted/20">
                            <div className="flex gap-3">
                              <div className={`p-1.5 rounded-full shrink-0 h-7 w-7 flex items-center justify-center ${sentimentColors[m.sentiment]}`}><Icon size={13} /></div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-0.5">
                                  <a href={m.source_url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-primary hover:underline truncate">{m.headline || m.source_url}</a>
                                </div>
                                <p className="text-xs text-muted-foreground line-clamp-2">{m.snippet}</p>
                                <div className="flex items-center gap-2 mt-1.5">
                                  <span className="text-xs text-muted-foreground">DA ~{m.estimated_da}</span>
                                  {m.is_unlinked_mention && <Badge className="bg-yellow-500/10 text-yellow-400 text-xs">Unlinked</Badge>}
                                  {m.has_link && <Badge className="bg-emerald-500/10 text-emerald-400 text-xs">Has Link</Badge>}
                                </div>
                              </div>
                              {m.is_unlinked_mention && (
                                <Button variant="outline" size="sm" className="shrink-0 text-xs h-7" onClick={() => handleGenerateOutreach(m)} disabled={generatingEmail === m.id}>
                                  {generatingEmail === m.id ? <Loader2 size={11} className="animate-spin" /> : <><Mail size={11} className="mr-1" />Outreach</>}
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {filtered(tab).length === 0 && <div className="text-center py-8"><Bell size={32} className="mx-auto mb-2 text-muted-foreground opacity-40" /><p className="text-sm text-muted-foreground">No {tab} mentions found</p></div>}
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
          <DialogHeader><DialogTitle>Outreach Email — Unlinked Mention</DialogTitle></DialogHeader>
          {emailDialog?.email && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">Source: <a href={emailDialog.mention?.source_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{emailDialog.mention?.source_url}</a></p>
              <div><label className="text-xs text-muted-foreground">Subject</label><p className="font-medium">{emailDialog.email.subject}</p></div>
              <div className="relative">
                <label className="text-xs text-muted-foreground">Body</label>
                <textarea readOnly value={emailDialog.email.body} rows={10} className="w-full mt-1 p-3 rounded-lg bg-muted/30 text-sm resize-none border border-border" />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
