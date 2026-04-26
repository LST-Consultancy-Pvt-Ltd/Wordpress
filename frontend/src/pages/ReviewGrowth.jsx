import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Star, Bot, MessageSquare, Send, Loader2, Copy, Check, RefreshCw, Webhook, Heart } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Badge } from "../components/ui/badge";
import { Progress } from "../components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";
import { getSites, generateReviewPlan, listReviewPlans, setReviewWebhook, testReviewWebhook } from "../lib/api";

const starColors = {
  5: "text-yellow-400",
  4: "text-yellow-400",
  3: "text-orange-400",
  2: "text-red-400",
  1: "text-red-500",
};

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success("Copied");
  };
  return (
    <Button variant="ghost" size="sm" onClick={handleCopy} className="h-6 w-6 p-0 shrink-0">
      {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
    </Button>
  );
}

function TemplateCard({ label, text }) {
  return (
    <div className="p-3 rounded-lg bg-muted/20 hover:bg-muted/30 transition-colors">
      {label && <p className="text-xs font-medium text-muted-foreground mb-1">{label}</p>}
      <div className="flex gap-2">
        <p className="text-sm flex-1 whitespace-pre-line">{text}</p>
        <CopyButton text={text} />
      </div>
    </div>
  );
}

export default function ReviewGrowth() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [plans, setPlans] = useState([]);
  const [activePlan, setActivePlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState(false);

  const [form, setForm] = useState({
    business_name: "",
    service: "",
    city: "",
    our_review_count: "",
    competitor_review_counts: "",
  });

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSite) loadPlans();
  }, [selectedSite]);

  const loadPlans = async () => {
    setLoading(true);
    try {
      const r = await listReviewPlans(selectedSite);
      setPlans(r.data);
      if (r.data.length > 0 && !activePlan) {
        const first = r.data[0];
        setActivePlan(first);
        setWebhookUrl(first.webhook_url || "");
      }
    } catch { setPlans([]); }
    finally { setLoading(false); }
  };

  const handleGenerate = async () => {
    if (!selectedSite) return toast.error("Select a site");
    if (!form.business_name.trim() || !form.service.trim() || !form.city.trim()) return toast.error("Fill required fields");
    const competitor_review_counts = form.competitor_review_counts.split(",").map(n => parseInt(n.trim())).filter(n => !isNaN(n));
    setGenerating(true);
    try {
      const r = await generateReviewPlan(selectedSite, {
        ...form,
        our_review_count: parseInt(form.our_review_count) || 0,
        competitor_review_counts,
      });
      setPlans(prev => [r.data, ...prev]);
      setActivePlan(r.data);
      setWebhookUrl(r.data.webhook_url || "");
      toast.success("Review plan generated");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Generation failed");
    } finally {
      setGenerating(false);
    }
  };

  const handleSaveWebhook = async () => {
    if (!activePlan) return;
    setSavingWebhook(true);
    try {
      await setReviewWebhook(selectedSite, activePlan.id, { webhook_url: webhookUrl });
      toast.success("Webhook saved");
    } catch { toast.error("Failed to save webhook"); }
    finally { setSavingWebhook(false); }
  };

  const handleTestWebhook = async () => {
    if (!activePlan) return;
    setTestingWebhook(true);
    try {
      const r = await testReviewWebhook(selectedSite, activePlan.id);
      toast.success(r.data.message || "Test sent");
    } catch { toast.error("Test failed"); }
    finally { setTestingWebhook(false); }
  };

  const progressPct = activePlan
    ? Math.min(100, Math.round((activePlan.our_review_count / Math.max(activePlan.target_90_day, 1)) * 100))
    : 0;

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Heart size={24} />Review Growth</h1>
          <p className="page-description">AI-generated outreach templates and 90-day review acquisition plan</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Input Panel */}
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><Bot size={16} />Generate Plan</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {[
                { key: "business_name", label: "Business Name *", placeholder: "Acme Plumbing" },
                { key: "service", label: "Primary Service *", placeholder: "Water heater replacement" },
                { key: "city", label: "City *", placeholder: "Austin" },
                { key: "our_review_count", label: "Our Current Reviews", placeholder: "42", type: "number" },
                { key: "competitor_review_counts", label: "Competitor Review Counts (comma-sep)", placeholder: "150, 89, 210" },
              ].map(({ key, label, placeholder, type }) => (
                <div key={key}>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
                  <Input type={type || "text"} placeholder={placeholder} value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} />
                </div>
              ))}
              <Button className="w-full" onClick={handleGenerate} disabled={generating}>
                {generating ? <><Loader2 size={14} className="mr-2 animate-spin" />Generating...</> : <><Star size={14} className="mr-2" />Generate Plan</>}
              </Button>
            </CardContent>
          </Card>

          {/* History */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm">Plans</CardTitle>
              <Button variant="ghost" size="sm" onClick={loadPlans} disabled={loading}><RefreshCw size={12} className={loading ? "animate-spin" : ""} /></Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {plans.map(p => (
                <button key={p.id} onClick={() => { setActivePlan(p); setWebhookUrl(p.webhook_url || ""); }}
                  className={`w-full text-left p-2 rounded-lg border text-sm hover:bg-muted/30 transition-colors ${activePlan?.id === p.id ? "border-primary bg-primary/5" : "border-transparent"}`}>
                  <p className="font-medium truncate">{p.business_name}</p>
                  <p className="text-xs text-muted-foreground">{p.service} · {p.city}</p>
                </button>
              ))}
              {plans.length === 0 && !loading && <p className="text-xs text-muted-foreground text-center py-3">No plans yet</p>}
            </CardContent>
          </Card>
        </div>

        {/* Results Panel */}
        <div className="lg:col-span-2 space-y-4">
          {activePlan ? (
            <>
              {/* Progress Bar */}
              <Card>
                <CardContent className="pt-5">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <p className="font-semibold">{activePlan.our_review_count} Reviews</p>
                      <p className="text-xs text-muted-foreground">Target: {activePlan.target_90_day} in 90 days</p>
                    </div>
                    <Badge className="text-xs bg-blue-500/10 text-blue-400">+{activePlan.weekly_target}/week</Badge>
                  </div>
                  <Progress value={progressPct} className="h-2" />
                  <p className="text-xs text-muted-foreground mt-1">{progressPct}% to goal</p>
                </CardContent>
              </Card>

              {/* Templates */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base">Outreach Templates</CardTitle></CardHeader>
                <CardContent>
                  <Tabs defaultValue="whatsapp">
                    <TabsList className="mb-3">
                      <TabsTrigger value="whatsapp"><MessageSquare size={12} className="mr-1" />WhatsApp</TabsTrigger>
                      <TabsTrigger value="sms">SMS</TabsTrigger>
                      <TabsTrigger value="email">Email</TabsTrigger>
                      <TabsTrigger value="responses"><Star size={12} className="mr-1" />Responses</TabsTrigger>
                    </TabsList>

                    <TabsContent value="whatsapp">
                      {activePlan.templates?.whatsapp ? (
                        <TemplateCard text={activePlan.templates.whatsapp} />
                      ) : <p className="text-sm text-muted-foreground">No WhatsApp template</p>}
                    </TabsContent>

                    <TabsContent value="sms">
                      {activePlan.templates?.sms ? (
                        <TemplateCard text={activePlan.templates.sms} />
                      ) : <p className="text-sm text-muted-foreground">No SMS template</p>}
                    </TabsContent>

                    <TabsContent value="email">
                      <div className="space-y-2">
                        {activePlan.templates?.email_subject && (
                          <TemplateCard label="Subject" text={activePlan.templates.email_subject} />
                        )}
                        {activePlan.templates?.email_body && (
                          <TemplateCard label="Body" text={activePlan.templates.email_body} />
                        )}
                        {!activePlan.templates?.email_subject && !activePlan.templates?.email_body && (
                          <p className="text-sm text-muted-foreground">No email template</p>
                        )}
                      </div>
                    </TabsContent>

                    <TabsContent value="responses">
                      <div className="space-y-2">
                        {[5, 4, 3, 2, 1].map(stars => {
                          const responses = activePlan.review_responses?.[`${stars}_star`] || [];
                          if (!responses.length) return null;
                          return (
                            <div key={stars}>
                              <div className="flex items-center gap-1 mb-1">
                                {[...Array(stars)].map((_, i) => <Star key={i} size={11} className={`fill-current ${starColors[stars]}`} />)}
                                <span className="text-xs text-muted-foreground ml-1">{stars}-Star Responses</span>
                              </div>
                              {responses.map((r, i) => <TemplateCard key={i} text={r} />)}
                            </div>
                          );
                        })}
                      </div>
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>

              {/* Webhook */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Webhook size={16} />Automation Webhook</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-muted-foreground">Connect a CRM or form webhook to auto-trigger review requests after job completion.</p>
                  <div className="flex gap-2">
                    <Input placeholder="https://hooks.zapier.com/..." value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} className="flex-1" />
                    <Button variant="outline" onClick={handleSaveWebhook} disabled={savingWebhook}>
                      {savingWebhook ? <Loader2 size={14} className="animate-spin" /> : <><Send size={14} className="mr-1" />Save</>}
                    </Button>
                    <Button variant="secondary" onClick={handleTestWebhook} disabled={testingWebhook || !activePlan.webhook_url}>
                      {testingWebhook ? <Loader2 size={14} className="animate-spin" /> : "Test"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </>
          ) : (
            <Card className="h-64 flex items-center justify-center">
              <CardContent className="text-center">
                <Heart size={40} className="mx-auto mb-4 text-muted-foreground opacity-50" />
                <p className="text-muted-foreground">Generate a plan to see outreach templates</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </motion.div>
  );
}
