import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Link2, Search, AlertTriangle, Check, Loader2, RefreshCw, ArrowRight, Mail, Copy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { toast } from "sonner";
import { getSites, scanInbound404s, getLinkReclamationReport, generateReclaimEmail, bulkCreateLinkRedirects, subscribeToTask } from "../lib/api";

export default function LinkReclamation() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [report, setReport] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState("");
  const [emailDialog, setEmailDialog] = useState(null);
  const [generatingEmail, setGeneratingEmail] = useState("");
  const [creatingRedirects, setCreatingRedirects] = useState(false);
  const [selectedLinks, setSelectedLinks] = useState(new Set());

  useEffect(() => {
    getSites().then(r => { setSites(r.data); if (r.data.length > 0) setSelectedSite(r.data[0].id); }).catch(() => {});
  }, []);
  useEffect(() => { if (selectedSite) loadReport(); }, [selectedSite]);

  const loadReport = async () => {
    setLoading(true);
    try { const r = await getLinkReclamationReport(selectedSite); setReport(Array.isArray(r.data) ? r.data : (r.data?.links ?? [])); } catch { setReport([]); }
    finally { setLoading(false); }
  };

  const handleScan = async () => {
    setScanning(true); setProgress("Scanning for inbound 404s…");
    try {
      const r = await scanInbound404s(selectedSite);
      subscribeToTask(r.data.task_id, evt => {
        if (evt.type === "progress") setProgress(evt.data?.message || "…");
        if (evt.type === "complete") { setScanning(false); setProgress(""); loadReport(); toast.success(`Found ${evt.data?.count || 0} broken links`); }
        if (evt.type === "error") { setScanning(false); setProgress(""); toast.error(evt.data?.message || "Scan failed"); }
      });
    } catch { setScanning(false); setProgress(""); toast.error("Scan failed"); }
  };

  const handleGenerateEmail = async (link) => {
    setGeneratingEmail(link.id);
    try {
      const r = await generateReclaimEmail(selectedSite, link.id);
      setEmailDialog({ link, email: r.data });
      toast.success("Email generated");
    } catch { toast.error("Failed"); }
    finally { setGeneratingEmail(""); }
  };

  const handleBulkRedirects = async () => {
    const links = report.filter(l => selectedLinks.has(l.id) && l.suggested_redirect && !l.redirect_created);
    if (links.length === 0) return toast.error("Select links with suggested redirects");
    setCreatingRedirects(true);
    try {
      await bulkCreateLinkRedirects(selectedSite, { redirects: links.map(l => ({ from_url: l.broken_url, to_url: l.suggested_redirect })) });
      toast.success(`${links.length} redirects created`);
      setSelectedLinks(new Set());
      loadReport();
    } catch { toast.error("Failed"); }
    finally { setCreatingRedirects(false); }
  };

  const toggleSelect = (id) => {
    setSelectedLinks(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    if (selectedLinks.size === report.length) setSelectedLinks(new Set());
    else setSelectedLinks(new Set(report.map(l => l.id)));
  };

  const totalValue = report.reduce((sum, l) => sum + (l.link_value || 0), 0);
  const reclaimed = report.filter(l => l.redirect_created).length;

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Link2 size={24} />Link Reclamation</h1>
          <p className="page-description">Find broken inbound links, reclaim link equity, and create redirects</p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
            <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button onClick={handleScan} disabled={scanning || !selectedSite}>
            {scanning ? <><Loader2 size={14} className="mr-2 animate-spin" />Scanning…</> : <><Search size={14} className="mr-2" />Scan 404s</>}
          </Button>
        </div>
      </div>

      {progress && <Card className="border-blue-500/30 bg-blue-500/5"><CardContent className="py-3 flex items-center gap-3"><Loader2 size={14} className="animate-spin text-blue-400" /><p className="text-sm text-blue-400">{progress}</p></CardContent></Card>}

      {report.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Card><CardContent className="pt-4"><p className="text-2xl font-bold text-red-400">{report.length}</p><p className="text-xs text-muted-foreground">Broken Inbound Links</p></CardContent></Card>
          <Card><CardContent className="pt-4"><p className="text-2xl font-bold text-yellow-400">{totalValue}</p><p className="text-xs text-muted-foreground">Total Link Value</p></CardContent></Card>
          <Card><CardContent className="pt-4"><p className="text-2xl font-bold text-emerald-400">{reclaimed}</p><p className="text-xs text-muted-foreground">Reclaimed</p></CardContent></Card>
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-base">Broken Links ({report.length})</CardTitle>
          <div className="flex gap-2">
            {selectedLinks.size > 0 && (
              <Button size="sm" onClick={handleBulkRedirects} disabled={creatingRedirects}>
                {creatingRedirects ? <Loader2 size={12} className="animate-spin mr-1" /> : <ArrowRight size={12} className="mr-1" />}
                Create {selectedLinks.size} Redirect{selectedLinks.size > 1 ? "s" : ""}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={loadReport} disabled={loading}><RefreshCw size={12} className={loading ? "animate-spin" : ""} /></Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-1 max-h-[520px] overflow-y-auto">
            {report.length > 0 && (
              <div className="flex items-center gap-3 p-2 text-xs text-muted-foreground border-b">
                <input type="checkbox" checked={selectedLinks.size === report.length} onChange={toggleAll} className="rounded" />
                <span className="w-1/4">Broken URL</span>
                <span className="w-1/5">Linking Domain</span>
                <span className="w-16 text-center">Value</span>
                <span className="flex-1">Suggested Redirect</span>
                <span className="w-24"></span>
              </div>
            )}
            {report.map(link => (
              <div key={link.id} className="flex items-center gap-3 p-2 rounded hover:bg-muted/20">
                <input type="checkbox" checked={selectedLinks.has(link.id)} onChange={() => toggleSelect(link.id)} className="rounded" />
                <div className="w-1/4 min-w-0">
                  <p className="text-xs truncate text-red-400">{link.broken_url}</p>
                  {link.anchor_text && <p className="text-xs text-muted-foreground truncate">"{link.anchor_text}"</p>}
                </div>
                <p className="w-1/5 text-xs truncate">{link.linking_domain}</p>
                <div className="w-16 text-center">
                  <Badge variant="outline" className="text-xs">{link.link_value || 0}</Badge>
                </div>
                <div className="flex-1 min-w-0 flex items-center gap-1">
                  {link.suggested_redirect ? (
                    <>
                      <ArrowRight size={10} className="text-muted-foreground shrink-0" />
                      <span className="text-xs truncate text-emerald-400">{link.suggested_redirect}</span>
                    </>
                  ) : <span className="text-xs text-muted-foreground">—</span>}
                  {link.redirect_created && <Check size={12} className="text-emerald-400 shrink-0" />}
                </div>
                <div className="w-24 flex gap-1 shrink-0">
                  <Button variant="outline" size="sm" className="h-6 text-xs px-2" onClick={() => handleGenerateEmail(link)} disabled={generatingEmail === link.id}>
                    {generatingEmail === link.id ? <Loader2 size={10} className="animate-spin" /> : <Mail size={10} />}
                  </Button>
                </div>
              </div>
            ))}
            {report.length === 0 && <div className="text-center py-8"><AlertTriangle size={32} className="mx-auto mb-2 text-muted-foreground opacity-40" /><p className="text-sm text-muted-foreground">Scan for inbound 404s to find broken links</p></div>}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!emailDialog} onOpenChange={() => setEmailDialog(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Link Reclamation Email</DialogTitle></DialogHeader>
          {emailDialog?.email && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">Broken: <span className="text-red-400">{emailDialog.link?.broken_url}</span> → Linking domain: {emailDialog.link?.linking_domain}</p>
              <div><label className="text-xs text-muted-foreground">Subject</label><p className="font-medium">{emailDialog.email.subject}</p></div>
              <div className="relative">
                <label className="text-xs text-muted-foreground">Body</label>
                <textarea readOnly value={emailDialog.email.body} rows={10} className="w-full mt-1 p-3 rounded-lg bg-muted/30 text-sm resize-none border border-border" />
                <Button variant="ghost" size="icon" className="absolute top-5 right-1 h-6 w-6" onClick={() => { navigator.clipboard.writeText(emailDialog.email.body); toast.success("Copied"); }}><Copy size={12} /></Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
