import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Newspaper, Loader2, RefreshCw, Mail, Globe, Plus, Copy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Badge } from "../components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { toast } from "sonner";
import { getSites, generatePressRelease, generatePRPitch, generateHaroResponse, listPRCampaigns, addPRCoverage } from "../lib/api";

export default function DigitalPR() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [campaigns, setCampaigns] = useState([]);
  const [activeCampaign, setActiveCampaign] = useState(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [pitchDialog, setPitchDialog] = useState(null);
  const [generatingPitch, setGeneratingPitch] = useState(false);

  // Press release form
  const [prForm, setPrForm] = useState({ topic: "", business_name: "", city: "", key_facts: "" });
  // HARO form
  const [haroForm, setHaroForm] = useState({ query_text: "", expert_name: "", expertise: "", your_domain: "" });
  const [haroResult, setHaroResult] = useState(null);
  const [generatingHaro, setGeneratingHaro] = useState(false);
  // Coverage form
  const [coverageForm, setCoverageForm] = useState({ outlet: "", url: "" });
  const [addingCoverage, setAddingCoverage] = useState(false);

  useEffect(() => {
    getSites().then(r => { setSites(r.data); if (r.data.length > 0) setSelectedSite(r.data[0].id); }).catch(() => {});
  }, []);
  useEffect(() => { if (selectedSite) loadCampaigns(); }, [selectedSite]);

  const loadCampaigns = async () => {
    setLoading(true);
    try { const r = await listPRCampaigns(selectedSite); setCampaigns(r.data); } catch { setCampaigns([]); }
    finally { setLoading(false); }
  };

  const handleGeneratePR = async () => {
    if (!prForm.topic.trim()) return toast.error("Enter a topic");
    setGenerating(true);
    try {
      const r = await generatePressRelease(selectedSite, prForm);
      toast.success("Press release generated");
      loadCampaigns();
      setActiveCampaign(r.data);
      setPrForm({ topic: "", business_name: "", city: "", key_facts: "" });
    } catch { toast.error("Generation failed"); }
    finally { setGenerating(false); }
  };

  const handleGeneratePitch = async (campaignId) => {
    setGeneratingPitch(true);
    try {
      const r = await generatePRPitch(selectedSite, campaignId);
      setPitchDialog(r.data);
      toast.success("Pitch email generated");
    } catch { toast.error("Failed"); }
    finally { setGeneratingPitch(false); }
  };

  const handleHaro = async () => {
    if (!haroForm.query_text.trim()) return toast.error("Enter the HARO query");
    setGeneratingHaro(true);
    try {
      const r = await generateHaroResponse(selectedSite, haroForm);
      setHaroResult(r.data);
      toast.success("HARO response generated");
    } catch { toast.error("Failed"); }
    finally { setGeneratingHaro(false); }
  };

  const handleAddCoverage = async () => {
    if (!activeCampaign || !coverageForm.outlet.trim()) return toast.error("Enter outlet name");
    setAddingCoverage(true);
    try {
      await addPRCoverage(selectedSite, activeCampaign.id, coverageForm);
      toast.success("Coverage added");
      setCoverageForm({ outlet: "", url: "" });
      loadCampaigns();
    } catch { toast.error("Failed"); }
    finally { setAddingCoverage(false); }
  };

  const copyText = (text) => { navigator.clipboard.writeText(text); toast.success("Copied"); };

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Newspaper size={24} />Digital PR</h1>
          <p className="page-description">Generate press releases, respond to HARO queries, and track media coverage</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <Tabs defaultValue="press-releases">
        <TabsList><TabsTrigger value="press-releases">Press Releases</TabsTrigger><TabsTrigger value="haro">HARO Responses</TabsTrigger></TabsList>

        <TabsContent value="press-releases" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card>
              <CardHeader><CardTitle className="text-base">New Press Release</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <Input placeholder="Topic / headline *" value={prForm.topic} onChange={e => setPrForm(p => ({ ...p, topic: e.target.value }))} />
                <Input placeholder="Business name" value={prForm.business_name} onChange={e => setPrForm(p => ({ ...p, business_name: e.target.value }))} />
                <Input placeholder="City" value={prForm.city} onChange={e => setPrForm(p => ({ ...p, city: e.target.value }))} />
                <Textarea placeholder="Key facts (one per line)" value={prForm.key_facts} onChange={e => setPrForm(p => ({ ...p, key_facts: e.target.value }))} rows={4} />
                <Button className="w-full" onClick={handleGeneratePR} disabled={generating || !selectedSite}>
                  {generating ? <><Loader2 size={14} className="mr-2 animate-spin" />Generating…</> : <><Newspaper size={14} className="mr-2" />Generate Press Release</>}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-base">Campaigns ({campaigns.length})</CardTitle>
                <Button variant="ghost" size="sm" onClick={loadCampaigns} disabled={loading}><RefreshCw size={12} className={loading ? "animate-spin" : ""} /></Button>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 max-h-[400px] overflow-y-auto">
                  {campaigns.map(c => (
                    <div key={c.id} className={`p-3 rounded-lg border cursor-pointer hover:bg-muted/20 ${activeCampaign?.id === c.id ? "border-primary bg-primary/5" : ""}`} onClick={() => setActiveCampaign(c)}>
                      <p className="text-sm font-medium truncate">{c.headline || c.topic}</p>
                      <div className="flex gap-2 mt-1">
                        {c.coverage && <Badge variant="outline" className="text-xs">{c.coverage.length} coverage</Badge>}
                      </div>
                    </div>
                  ))}
                  {campaigns.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">No campaigns yet</p>}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Campaign Detail</CardTitle></CardHeader>
              <CardContent>
                {activeCampaign ? (
                  <div className="space-y-3">
                    <p className="font-medium">{activeCampaign.headline}</p>
                    <div className="relative">
                      <Textarea readOnly value={activeCampaign.press_release} rows={8} className="bg-muted/30 text-xs resize-none" />
                      <Button variant="ghost" size="icon" className="absolute top-1 right-1 h-6 w-6" onClick={() => copyText(activeCampaign.press_release)}><Copy size={12} /></Button>
                    </div>
                    <Button variant="outline" size="sm" className="w-full" onClick={() => handleGeneratePitch(activeCampaign.id)} disabled={generatingPitch}>
                      {generatingPitch ? <Loader2 size={12} className="animate-spin mr-1" /> : <Mail size={12} className="mr-1" />}Generate Journalist Pitch
                    </Button>
                    <div className="border-t pt-3 mt-3">
                      <p className="text-xs text-muted-foreground mb-2">Add Coverage</p>
                      <div className="flex gap-2">
                        <Input placeholder="Outlet name" value={coverageForm.outlet} onChange={e => setCoverageForm(p => ({ ...p, outlet: e.target.value }))} className="text-xs" />
                        <Input placeholder="URL" value={coverageForm.url} onChange={e => setCoverageForm(p => ({ ...p, url: e.target.value }))} className="text-xs" />
                        <Button size="sm" onClick={handleAddCoverage} disabled={addingCoverage}><Plus size={12} /></Button>
                      </div>
                      {activeCampaign.coverage?.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {activeCampaign.coverage.map((c, i) => (
                            <Badge key={i} variant="secondary" className="text-xs">
                              <Globe size={10} className="mr-1" />{c.outlet}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-6">Select a campaign</p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="haro" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader><CardTitle className="text-base">HARO Query Response</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <Textarea placeholder="Paste the HARO query here *" value={haroForm.query_text} onChange={e => setHaroForm(p => ({ ...p, query_text: e.target.value }))} rows={4} />
                <Input placeholder="Expert name" value={haroForm.expert_name} onChange={e => setHaroForm(p => ({ ...p, expert_name: e.target.value }))} />
                <Input placeholder="Area of expertise" value={haroForm.expertise} onChange={e => setHaroForm(p => ({ ...p, expertise: e.target.value }))} />
                <Input placeholder="Your domain" value={haroForm.your_domain} onChange={e => setHaroForm(p => ({ ...p, your_domain: e.target.value }))} />
                <Button className="w-full" onClick={handleHaro} disabled={generatingHaro || !selectedSite}>
                  {generatingHaro ? <><Loader2 size={14} className="mr-2 animate-spin" />Generating…</> : "Generate HARO Response"}
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Generated Response</CardTitle></CardHeader>
              <CardContent>
                {haroResult ? (
                  <div className="space-y-3">
                    <div><label className="text-xs text-muted-foreground">Subject</label><p className="font-medium text-sm">{haroResult.subject}</p></div>
                    <div className="relative">
                      <label className="text-xs text-muted-foreground">Response</label>
                      <Textarea readOnly value={haroResult.response} rows={8} className="mt-1 bg-muted/30 text-xs resize-none" />
                      <Button variant="ghost" size="icon" className="absolute top-5 right-1 h-6 w-6" onClick={() => copyText(haroResult.response)}><Copy size={12} /></Button>
                    </div>
                    {haroResult.suggested_bio && (
                      <div><label className="text-xs text-muted-foreground">Suggested Bio</label><p className="text-sm bg-muted/30 p-2 rounded">{haroResult.suggested_bio}</p></div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-6">Generate a HARO response to see it here</p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={!!pitchDialog} onOpenChange={() => setPitchDialog(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Journalist Pitch Email</DialogTitle></DialogHeader>
          {pitchDialog && (
            <div className="space-y-3">
              <div><label className="text-xs text-muted-foreground">Subject</label><p className="font-medium">{pitchDialog.subject}</p></div>
              <div className="relative">
                <label className="text-xs text-muted-foreground">Body</label>
                <Textarea readOnly value={pitchDialog.body} rows={10} className="mt-1 bg-muted/30 text-sm resize-none" />
                <Button variant="ghost" size="icon" className="absolute top-5 right-1 h-6 w-6" onClick={() => copyText(pitchDialog.body)}><Copy size={12} /></Button>
              </div>
              {pitchDialog.suggested_outlets?.length > 0 && (
                <div>
                  <label className="text-xs text-muted-foreground">Suggested Outlets</label>
                  <div className="flex flex-wrap gap-1.5 mt-1">{pitchDialog.suggested_outlets.map((o, i) => <Badge key={i} variant="secondary" className="text-xs">{o}</Badge>)}</div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
