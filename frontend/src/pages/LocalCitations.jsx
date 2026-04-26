import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { MapPin, Check, X, AlertTriangle, Loader2, RefreshCw, Building, Copy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { toast } from "sonner";
import { getSites, auditLocalCitations, listLocalCitations, generateCitationDescription, getCitationGaps, updateCanonicalNAP } from "../lib/api";

export default function LocalCitations() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [citations, setCitations] = useState([]);
  const [gaps, setGaps] = useState([]);
  const [loading, setLoading] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [descDialog, setDescDialog] = useState(null);
  const [generatingDesc, setGeneratingDesc] = useState("");
  const [savingNAP, setSavingNAP] = useState(false);

  const [auditForm, setAuditForm] = useState({ business_name: "", address: "", phone: "", website: "", niche: "", city: "" });
  const [napForm, setNapForm] = useState({ business_name: "", address: "", phone: "", website: "" });

  useEffect(() => {
    getSites().then(r => { setSites(r.data); if (r.data.length > 0) setSelectedSite(r.data[0].id); }).catch(() => {});
  }, []);
  useEffect(() => { if (selectedSite) { loadCitations(); loadGaps(); } }, [selectedSite]);

  const loadCitations = async () => {
    setLoading(true);
    try { const r = await listLocalCitations(selectedSite); setCitations(r.data); } catch { setCitations([]); }
    finally { setLoading(false); }
  };
  const loadGaps = async () => {
    try { const r = await getCitationGaps(selectedSite); setGaps(r.data); } catch { setGaps([]); }
  };

  const handleAudit = async () => {
    if (!auditForm.business_name.trim()) return toast.error("Enter business name");
    setAuditing(true);
    try {
      await auditLocalCitations(selectedSite, auditForm);
      toast.success("Citation audit complete");
      loadCitations();
      loadGaps();
    } catch { toast.error("Audit failed"); }
    finally { setAuditing(false); }
  };

  const handleGenDesc = async (directory) => {
    setGeneratingDesc(directory);
    try {
      const r = await generateCitationDescription(selectedSite, directory);
      setDescDialog({ directory, description: r.data.description });
      toast.success("Description generated");
    } catch { toast.error("Failed"); }
    finally { setGeneratingDesc(""); }
  };

  const handleUpdateNAP = async () => {
    if (!napForm.business_name.trim()) return toast.error("Enter business name");
    setSavingNAP(true);
    try {
      await updateCanonicalNAP(selectedSite, napForm);
      toast.success("Canonical NAP updated");
    } catch { toast.error("Failed"); }
    finally { setSavingNAP(false); }
  };

  const listed = citations.filter(c => c.has_listing);
  const consistent = citations.filter(c => c.nap_consistent);

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><MapPin size={24} />Local Citations</h1>
          <p className="page-description">Audit citations, fix NAP inconsistencies, and fill directory gaps</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {citations.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Total Directories", value: citations.length, color: "text-primary" },
            { label: "Listed", value: listed.length, color: "text-emerald-400" },
            { label: "NAP Consistent", value: consistent.length, color: "text-blue-400" },
            { label: "Gaps", value: gaps.length, color: "text-yellow-400" },
          ].map(({ label, value, color }) => (
            <Card key={label}><CardContent className="pt-4"><p className={`text-2xl font-bold ${color}`}>{value}</p><p className="text-xs text-muted-foreground">{label}</p></CardContent></Card>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-base">NAP Audit</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Input placeholder="Business name *" value={auditForm.business_name} onChange={e => setAuditForm(p => ({ ...p, business_name: e.target.value }))} />
            <Input placeholder="Address" value={auditForm.address} onChange={e => setAuditForm(p => ({ ...p, address: e.target.value }))} />
            <Input placeholder="Phone" value={auditForm.phone} onChange={e => setAuditForm(p => ({ ...p, phone: e.target.value }))} />
            <Input placeholder="Website" value={auditForm.website} onChange={e => setAuditForm(p => ({ ...p, website: e.target.value }))} />
            <Input placeholder="Niche" value={auditForm.niche} onChange={e => setAuditForm(p => ({ ...p, niche: e.target.value }))} />
            <Input placeholder="City" value={auditForm.city} onChange={e => setAuditForm(p => ({ ...p, city: e.target.value }))} />
            <Button className="w-full" onClick={handleAudit} disabled={auditing || !selectedSite}>
              {auditing ? <><Loader2 size={14} className="mr-2 animate-spin" />Auditing…</> : <><MapPin size={14} className="mr-2" />Run Audit</>}
            </Button>
          </CardContent>
        </Card>

        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-base">Citations</CardTitle>
              <Button variant="ghost" size="sm" onClick={loadCitations} disabled={loading}><RefreshCw size={12} className={loading ? "animate-spin" : ""} /></Button>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="all">
                <TabsList className="mb-3">
                  <TabsTrigger value="all">All ({citations.length})</TabsTrigger>
                  <TabsTrigger value="gaps">Gaps ({gaps.length})</TabsTrigger>
                </TabsList>
                <TabsContent value="all">
                  <div className="space-y-1.5 max-h-[480px] overflow-y-auto">
                    {citations.map(c => (
                      <div key={c.id} className="flex items-center gap-3 p-2.5 rounded-lg border hover:bg-muted/20">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <Building size={14} className="text-muted-foreground shrink-0" />
                            <span className="text-sm font-medium truncate">{c.directory}</span>
                          </div>
                          {c.inconsistency_note && <p className="text-xs text-yellow-400 mt-0.5 flex items-center gap-1"><AlertTriangle size={10} />{c.inconsistency_note}</p>}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {c.has_listing ? <Badge className="bg-emerald-500/10 text-emerald-400 text-xs"><Check size={10} className="mr-0.5" />Listed</Badge> : <Badge className="bg-red-500/10 text-red-400 text-xs"><X size={10} className="mr-0.5" />Missing</Badge>}
                          {c.has_listing && (c.nap_consistent ? <Badge className="bg-blue-500/10 text-blue-400 text-xs"><Check size={10} className="mr-0.5" />NAP OK</Badge> : <Badge className="bg-yellow-500/10 text-yellow-400 text-xs"><AlertTriangle size={10} className="mr-0.5" />NAP Issue</Badge>)}
                          <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => handleGenDesc(c.directory)} disabled={generatingDesc === c.directory}>
                            {generatingDesc === c.directory ? <Loader2 size={11} className="animate-spin" /> : "Description"}
                          </Button>
                        </div>
                      </div>
                    ))}
                    {citations.length === 0 && <p className="text-sm text-muted-foreground text-center py-8">Run an audit to see citations</p>}
                  </div>
                </TabsContent>
                <TabsContent value="gaps">
                  <div className="space-y-1.5 max-h-[480px] overflow-y-auto">
                    {gaps.map((g, i) => (
                      <div key={i} className="flex items-center justify-between p-2.5 rounded-lg border hover:bg-muted/20">
                        <div className="flex items-center gap-2">
                          <Building size={14} className="text-muted-foreground" />
                          <span className="text-sm font-medium">{g.directory}</span>
                          {g.priority && <Badge variant="outline" className="text-xs">{g.priority}</Badge>}
                        </div>
                        <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => handleGenDesc(g.directory)} disabled={generatingDesc === g.directory}>
                          {generatingDesc === g.directory ? <Loader2 size={11} className="animate-spin" /> : "Generate Listing"}
                        </Button>
                      </div>
                    ))}
                    {gaps.length === 0 && <p className="text-sm text-muted-foreground text-center py-8">No gaps found</p>}
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Update Canonical NAP</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Input placeholder="Business name *" value={napForm.business_name} onChange={e => setNapForm(p => ({ ...p, business_name: e.target.value }))} />
            <Input placeholder="Address" value={napForm.address} onChange={e => setNapForm(p => ({ ...p, address: e.target.value }))} />
            <Input placeholder="Phone" value={napForm.phone} onChange={e => setNapForm(p => ({ ...p, phone: e.target.value }))} />
            <Input placeholder="Website" value={napForm.website} onChange={e => setNapForm(p => ({ ...p, website: e.target.value }))} />
          </div>
          <Button className="mt-3" onClick={handleUpdateNAP} disabled={savingNAP}>
            {savingNAP ? <><Loader2 size={14} className="mr-2 animate-spin" />Saving…</> : "Save Canonical NAP"}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={!!descDialog} onOpenChange={() => setDescDialog(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Listing Description — {descDialog?.directory}</DialogTitle></DialogHeader>
          {descDialog && (
            <div className="relative">
              <textarea readOnly value={descDialog.description} rows={8} className="w-full p-3 rounded-lg bg-muted/30 text-sm resize-none border border-border" />
              <Button variant="ghost" size="icon" className="absolute top-1 right-1 h-6 w-6" onClick={() => { navigator.clipboard.writeText(descDialog.description); toast.success("Copied"); }}><Copy size={12} /></Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
