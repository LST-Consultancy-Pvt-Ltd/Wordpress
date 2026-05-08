import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Megaphone, Plus, Trash2, Pause, Play, RefreshCw,
  Loader2, CheckCircle2, XCircle, Zap, Eye, EyeOff,
  TrendingUp, DollarSign, MousePointer, BarChart3,
  Link2, Search, Bot, Settings2, ChevronDown, ChevronUp,
  ExternalLink, AlertTriangle, Check, X
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Separator } from "../components/ui/separator";
import { toast } from "sonner";
import api from "../lib/api";

// ─── API helpers ────────────────────────────────────────────────────
const adsApi = {
  // Meta
  metaConnect:          (d) => api.post("/ads/meta/connect", d),
  metaDisconnect:       ()  => api.delete("/ads/meta/disconnect"),
  metaCampaigns:        ()  => api.get("/ads/meta/campaigns"),
  metaGenerate:         (d) => api.post("/ads/meta/generate-campaign", d),
  metaCreate:           (d) => api.post("/ads/meta/create-campaign", d),
  metaPause:            (id) => api.put(`/ads/meta/campaign/${id}/pause`),
  metaResume:           (id) => api.put(`/ads/meta/campaign/${id}/resume`),
  metaDelete:           (id) => api.delete(`/ads/meta/campaign/${id}`),
  metaAutopilot:        (d) => api.post("/ads/meta/autopilot-settings", d),
  // Google
  googleOAuthUrl:       ()  => api.get("/ads/google/oauth-url"),
  googleConnect:        (d) => api.post("/ads/google/connect", d),
  googleCampaigns:      ()  => api.get("/ads/google/campaigns"),
  googleGenerate:       (d) => api.post("/ads/google/generate-campaign", d),
  googleCreate:         (d) => api.post("/ads/google/create-campaign", d),
  googlePause:          (id) => api.put(`/ads/google/campaign/${id}/pause`),
  googleResume:         (id) => api.put(`/ads/google/campaign/${id}/resume`),
  googleDelete:         (id) => api.delete(`/ads/google/campaign/${id}`),
  googleSearchTerms:    ()  => api.get("/ads/google/search-terms"),
  googleNegativeKw:     (d) => api.post("/ads/google/negative-keyword", d),
  googleBidSuggestions: (d) => api.post("/ads/google/bid-suggestions", d),
};

// ─── Helpers ─────────────────────────────────────────────────────────
const fmt = {
  money: (v) => v == null ? "—" : `$${Number(v).toLocaleString("en", { minimumFractionDigits: 2 })}`,
  num:   (v) => v == null ? "—" : Number(v).toLocaleString("en"),
  pct:   (v) => v == null ? "—" : `${(Number(v) * 100).toFixed(2)}%`,
};

const StatusBadge = ({ status }) => {
  const map = {
    ACTIVE:   "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    PAUSED:   "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    DELETED:  "bg-red-500/15 text-red-400 border-red-500/30",
    ENABLED:  "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    REMOVED:  "bg-red-500/15 text-red-400 border-red-500/30",
    connected:"bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    disconnected:"bg-muted/40 text-muted-foreground border-border/40",
  };
  return (
    <Badge variant="outline" className={`text-[11px] ${map[status] || "bg-muted/40 text-muted-foreground border-border/40"}`}>
      {status}
    </Badge>
  );
};

// ═══════════════════════════════════════════════════════════════════
// META ADS TAB
// ═══════════════════════════════════════════════════════════════════
function MetaAdsTab() {
  const [creds, setCreds]         = useState({ business_manager_id: "", access_token: "", ad_account_id: "" });
  const [connected, setConnected] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [campaigns, setCampaigns] = useState([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [connectLoading, setConnectLoading]   = useState(false);

  // AI Generator state
  const [gen, setGen]           = useState({ description: "", audience: "", goal: "OUTCOME_TRAFFIC", budget_daily: 10, duration_days: 7 });
  const [generating, setGenerating] = useState(false);
  const [preview, setPreview]   = useState(null);  // generated campaign JSON
  const [approved, setApproved] = useState([]);    // which ad indices are approved
  const [launching, setLaunching] = useState(false);

  // Autopilot
  const [autopilot, setAutopilot] = useState({ enabled: false, pageview_threshold: 500, max_daily_budget: 20 });
  const [savingAutopilot, setSavingAutopilot] = useState(false);

  const loadCampaigns = useCallback(async () => {
    if (!connected) return;
    setLoadingCampaigns(true);
    try {
      const r = await adsApi.metaCampaigns();
      setCampaigns(r.data?.campaigns || []);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to load Meta campaigns");
    } finally { setLoadingCampaigns(false); }
  }, [connected]);

  useEffect(() => { loadCampaigns(); }, [loadCampaigns]);

  const handleConnect = async () => {
    if (!creds.business_manager_id || !creds.access_token) {
      return toast.error("Fill in Business Manager ID and Access Token");
    }
    setConnectLoading(true);
    try {
      await adsApi.metaConnect(creds);
      setConnected(true);
      toast.success("Meta Ads connected");
      loadCampaigns();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Connection failed");
    } finally { setConnectLoading(false); }
  };

  const handleDisconnect = async () => {
    try {
      await adsApi.metaDisconnect();
      setConnected(false);
      setCampaigns([]);
      toast.success("Meta Ads disconnected");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to disconnect");
    }
  };

  const handleCampaignAction = async (action, id) => {
    try {
      if (action === "pause")  await adsApi.metaPause(id);
      if (action === "resume") await adsApi.metaResume(id);
      if (action === "delete") { await adsApi.metaDelete(id); }
      toast.success(`Campaign ${action}d`);
      loadCampaigns();
    } catch (e) { toast.error(e.response?.data?.detail || `Failed to ${action} campaign`); }
  };

  const handleGenerate = async () => {
    if (!gen.description) return toast.error("Enter a product/service description");
    setGenerating(true);
    setPreview(null);
    try {
      const r = await adsApi.metaGenerate(gen);
      setPreview(r.data);
      setApproved(r.data?.ads?.map((_, i) => i) || []);
    } catch (e) { toast.error(e.response?.data?.detail || "AI generation failed"); }
    finally { setGenerating(false); }
  };

  const handleLaunch = async () => {
    if (!preview) return;
    const approvedAds = preview.ads?.filter((_, i) => approved.includes(i));
    setLaunching(true);
    try {
      await adsApi.metaCreate({ ...preview, ads: approvedAds });
      toast.success("Campaign launched on Meta!");
      setPreview(null);
      loadCampaigns();
    } catch (e) { toast.error(e.response?.data?.detail || "Launch failed"); }
    finally { setLaunching(false); }
  };

  const handleSaveAutopilot = async () => {
    setSavingAutopilot(true);
    try {
      await adsApi.metaAutopilot({ platform: "meta", ...autopilot });
      toast.success("Autopilot settings saved");
    } catch (e) { toast.error(e.response?.data?.detail || "Failed to save"); }
    finally { setSavingAutopilot(false); }
  };

  return (
    <div className="space-y-6">
      {/* ── Connect ──────────────────────────────────────────────── */}
      <Card className="border-border/40 bg-card/60">
        <CardHeader className="pb-4">
          <CardTitle className="text-base flex items-center gap-2">
            <Megaphone size={18} className="text-primary" /> Connect Meta Ads Account
            <StatusBadge status={connected ? "connected" : "disconnected"} />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Business Manager ID</Label>
              <Input placeholder="123456789" value={creds.business_manager_id}
                onChange={e => setCreds(p => ({ ...p, business_manager_id: e.target.value }))}
                disabled={connected} className="bg-muted/30 border-border/50" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Ad Account ID</Label>
              <Input placeholder="act_123456789" value={creds.ad_account_id}
                onChange={e => setCreds(p => ({ ...p, ad_account_id: e.target.value }))}
                disabled={connected} className="bg-muted/30 border-border/50" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Long-Lived Access Token</Label>
              <div className="relative">
                <Input type={showToken ? "text" : "password"} placeholder="EAA..." value={creds.access_token}
                  onChange={e => setCreds(p => ({ ...p, access_token: e.target.value }))}
                  disabled={connected} className="bg-muted/30 border-border/50 pr-9" />
                <button onClick={() => setShowToken(p => !p)} className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground">
                  {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            {!connected
              ? <Button onClick={handleConnect} disabled={connectLoading} size="sm" className="gap-1.5">
                  {connectLoading ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} Connect
                </Button>
              : <Button onClick={handleDisconnect} variant="destructive" size="sm" className="gap-1.5">
                  <XCircle size={14} /> Disconnect
                </Button>
            }
          </div>
        </CardContent>
      </Card>

      {/* ── Campaigns Table ───────────────────────────────────────── */}
      <Card className="border-border/40 bg-card/60">
        <CardHeader className="pb-4 flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 size={18} className="text-primary" /> Campaign Overview
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={loadCampaigns} disabled={loadingCampaigns || !connected} className="gap-1.5">
            {loadingCampaigns ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {!connected ? (
            <p className="text-muted-foreground text-sm text-center py-8">Connect your Meta account first</p>
          ) : loadingCampaigns ? (
            <div className="flex items-center justify-center py-12"><Loader2 size={24} className="animate-spin text-primary" /></div>
          ) : campaigns.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-8">No campaigns found. Create one below.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/40 text-muted-foreground text-xs">
                    {["Campaign","Status","Objective","Daily Budget","Spend","Impressions","Clicks","CTR","ROAS","Actions"].map(h => (
                      <th key={h} className="text-left pb-3 pr-4 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map(c => (
                    <tr key={c.id} className="border-b border-border/20 hover:bg-muted/20 transition-colors">
                      <td className="py-3 pr-4 font-medium max-w-[160px] truncate">{c.name}</td>
                      <td className="py-3 pr-4"><StatusBadge status={c.status} /></td>
                      <td className="py-3 pr-4 text-muted-foreground text-xs">{c.objective}</td>
                      <td className="py-3 pr-4">{fmt.money(c.daily_budget)}</td>
                      <td className="py-3 pr-4">{fmt.money(c.spend)}</td>
                      <td className="py-3 pr-4">{fmt.num(c.impressions)}</td>
                      <td className="py-3 pr-4">{fmt.num(c.clicks)}</td>
                      <td className="py-3 pr-4">{fmt.pct(c.ctr)}</td>
                      <td className="py-3 pr-4">{c.roas != null ? Number(c.roas).toFixed(2) : "—"}</td>
                      <td className="py-3 pr-4">
                        <div className="flex gap-1">
                          {c.status === "ACTIVE"
                            ? <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleCampaignAction("pause", c.id)} title="Pause"><Pause size={13}/></Button>
                            : <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleCampaignAction("resume", c.id)} title="Resume"><Play size={13}/></Button>
                          }
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-red-400 hover:text-red-300" onClick={() => handleCampaignAction("delete", c.id)} title="Delete"><Trash2 size={13}/></Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── AI Campaign Generator ─────────────────────────────────── */}
      <Card className="border-border/40 bg-card/60">
        <CardHeader className="pb-4">
          <CardTitle className="text-base flex items-center gap-2">
            <Bot size={18} className="text-primary" /> AI Campaign Generator
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Product / Service Description</Label>
              <Textarea rows={3} placeholder="Describe what you're advertising..."
                value={gen.description} onChange={e => setGen(p => ({ ...p, description: e.target.value }))}
                className="bg-muted/30 border-border/50 resize-none" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Target Audience</Label>
              <Textarea rows={3} placeholder="e.g. Small business owners in India aged 25–45 interested in marketing tools"
                value={gen.audience} onChange={e => setGen(p => ({ ...p, audience: e.target.value }))}
                className="bg-muted/30 border-border/50 resize-none" />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Campaign Goal</Label>
              <Select value={gen.goal} onValueChange={v => setGen(p => ({ ...p, goal: v }))}>
                <SelectTrigger className="bg-muted/30 border-border/50"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="OUTCOME_TRAFFIC">Traffic</SelectItem>
                  <SelectItem value="OUTCOME_LEADS">Leads</SelectItem>
                  <SelectItem value="OUTCOME_SALES">Sales</SelectItem>
                  <SelectItem value="OUTCOME_AWARENESS">Awareness</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Daily Budget ($)</Label>
              <Input type="number" min={1} value={gen.budget_daily}
                onChange={e => setGen(p => ({ ...p, budget_daily: Number(e.target.value) }))}
                className="bg-muted/30 border-border/50" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Duration (days)</Label>
              <Input type="number" min={1} value={gen.duration_days}
                onChange={e => setGen(p => ({ ...p, duration_days: Number(e.target.value) }))}
                className="bg-muted/30 border-border/50" />
            </div>
          </div>
          <Button onClick={handleGenerate} disabled={generating} className="gap-1.5">
            {generating ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            {generating ? "Generating..." : "Generate with AI"}
          </Button>

          {/* Preview Cards */}
          <AnimatePresence>
            {preview && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-4 mt-2">
                {/* Campaign summary */}
                <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 text-sm space-y-1">
                  <p><span className="text-muted-foreground">Campaign:</span> <strong>{preview.campaign_name}</strong></p>
                  <p><span className="text-muted-foreground">Objective:</span> {preview.objective}</p>
                  <p><span className="text-muted-foreground">Bid Strategy:</span> {preview.bid_strategy}</p>
                  <p><span className="text-muted-foreground">Daily Budget:</span> ${(preview.daily_budget_cents / 100).toFixed(2)}</p>
                  {preview.targeting && (
                    <p><span className="text-muted-foreground">Audience:</span> Ages {preview.targeting.age_min}–{preview.targeting.age_max} · {preview.targeting.geo_locations?.countries?.join(", ")}</p>
                  )}
                </div>
                {/* Ad creative previews */}
                <p className="text-sm font-semibold text-foreground">Ad Creatives — approve the ones you want to launch:</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {preview.ads?.map((ad, i) => {
                    const isApproved = approved.includes(i);
                    return (
                      <div key={i} className={`rounded-lg border p-4 space-y-2 transition-all ${isApproved ? "border-primary/50 bg-primary/5" : "border-border/40 bg-card/40 opacity-60"}`}>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-muted-foreground">AD {i + 1}</span>
                          <button onClick={() => setApproved(prev => isApproved ? prev.filter(x => x !== i) : [...prev, i])}
                            className={`w-6 h-6 rounded-full flex items-center justify-center border transition-colors ${isApproved ? "bg-primary border-primary text-primary-foreground" : "border-border/60 text-muted-foreground hover:border-primary"}`}>
                            {isApproved ? <Check size={12} /> : <X size={12} />}
                          </button>
                        </div>
                        <p className="text-sm font-semibold">{ad.headline}</p>
                        <p className="text-xs text-muted-foreground leading-relaxed">{ad.primary_text}</p>
                        <Badge variant="outline" className="text-[10px]">{ad.cta}</Badge>
                      </div>
                    );
                  })}
                </div>
                <Button onClick={handleLaunch} disabled={launching || approved.length === 0 || !connected}
                  className="bg-emerald-600 hover:bg-emerald-700 gap-1.5">
                  {launching ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                  Launch {approved.length} Approved Ad{approved.length !== 1 ? "s" : ""}
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>

      {/* ── Autopilot ─────────────────────────────────────────────── */}
      <Card className="border-border/40 bg-card/60">
        <CardHeader className="pb-4">
          <CardTitle className="text-base flex items-center gap-2">
            <Settings2 size={18} className="text-primary" /> Ads Autopilot
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Switch checked={autopilot.enabled} onCheckedChange={v => setAutopilot(p => ({ ...p, enabled: v }))} />
            <div>
              <p className="text-sm font-medium">Auto-Boost Top-Performing Blog Posts</p>
              <p className="text-xs text-muted-foreground">Automatically create Traffic campaigns for posts that exceed the pageview threshold</p>
            </div>
          </div>
          <AnimatePresence>
            {autopilot.enabled && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">Pageview Threshold (per day)</Label>
                  <Input type="number" min={1} value={autopilot.pageview_threshold}
                    onChange={e => setAutopilot(p => ({ ...p, pageview_threshold: Number(e.target.value) }))}
                    className="bg-muted/30 border-border/50" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">Max Daily Budget ($)</Label>
                  <Input type="number" min={1} value={autopilot.max_daily_budget}
                    onChange={e => setAutopilot(p => ({ ...p, max_daily_budget: Number(e.target.value) }))}
                    className="bg-muted/30 border-border/50" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <Button size="sm" onClick={handleSaveAutopilot} disabled={savingAutopilot} className="gap-1.5">
            {savingAutopilot ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Save Settings
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// GOOGLE ADS TAB
// ═══════════════════════════════════════════════════════════════════
function GoogleAdsTab() {
  const [customerId, setCustomerId]   = useState("");
  const [connected, setConnected]     = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [campaigns, setCampaigns]     = useState([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);

  // AI Generator
  const [gen, setGen]       = useState({ landing_url: "", keywords: "", goal: "MAXIMIZE_CONVERSIONS", budget_daily: 20, location: "IN" });
  const [generating, setGenerating] = useState(false);
  const [preview, setPreview]       = useState(null);
  const [approved, setApproved]     = useState([]);
  const [launching, setLaunching]   = useState(false);

  // Bid suggestions
  const [bidSuggestions, setBidSuggestions] = useState(null);
  const [loadingBids, setLoadingBids]       = useState(false);

  // Search terms
  const [searchTerms, setSearchTerms]     = useState([]);
  const [loadingTerms, setLoadingTerms]   = useState(false);
  const [showTerms, setShowTerms]         = useState(false);

  const loadCampaigns = useCallback(async () => {
    if (!connected) return;
    setLoadingCampaigns(true);
    try {
      const r = await adsApi.googleCampaigns();
      setCampaigns(r.data?.campaigns || []);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to load Google campaigns");
    } finally { setLoadingCampaigns(false); }
  }, [connected]);

  useEffect(() => { loadCampaigns(); }, [loadCampaigns]);

  const handleOAuth = async () => {
    setOauthLoading(true);
    try {
      const r = await adsApi.googleOAuthUrl();
      const url = r.data?.auth_url;
      if (!url) throw new Error("No auth URL returned");
      const popup = window.open(url, "google_oauth", "width=600,height=700");
      // Listen for the OAuth callback message
      const handler = async (event) => {
        if (event.data?.type === "google_ads_oauth_callback" && event.data?.code) {
          window.removeEventListener("message", handler);
          popup?.close();
          try {
            await adsApi.googleConnect({ code: event.data.code, customer_id: customerId });
            setConnected(true);
            toast.success("Google Ads connected");
            loadCampaigns();
          } catch (err) {
            toast.error(err.response?.data?.detail || "Failed to connect Google Ads");
          }
        }
      };
      window.addEventListener("message", handler);
    } catch (e) {
      toast.error(e.response?.data?.detail || "OAuth flow failed");
    } finally { setOauthLoading(false); }
  };

  const handleCampaignAction = async (action, id) => {
    try {
      if (action === "pause")  await adsApi.googlePause(id);
      if (action === "resume") await adsApi.googleResume(id);
      if (action === "delete") await adsApi.googleDelete(id);
      toast.success(`Campaign ${action}d`);
      loadCampaigns();
    } catch (e) { toast.error(e.response?.data?.detail || `Failed to ${action} campaign`); }
  };

  const handleGenerate = async () => {
    if (!gen.landing_url) return toast.error("Enter a landing page URL");
    setGenerating(true);
    setPreview(null);
    try {
      const r = await adsApi.googleGenerate(gen);
      setPreview(r.data);
      setApproved(r.data?.ad_groups?.map((_, i) => i) || []);
    } catch (e) { toast.error(e.response?.data?.detail || "AI generation failed"); }
    finally { setGenerating(false); }
  };

  const handleLaunch = async () => {
    if (!preview) return;
    setLaunching(true);
    try {
      const approvedGroups = preview.ad_groups?.filter((_, i) => approved.includes(i));
      await adsApi.googleCreate({ ...preview, ad_groups: approvedGroups });
      toast.success("Campaign launched on Google Ads!");
      setPreview(null);
      loadCampaigns();
    } catch (e) { toast.error(e.response?.data?.detail || "Launch failed"); }
    finally { setLaunching(false); }
  };

  const handleBidSuggestions = async () => {
    setLoadingBids(true);
    setBidSuggestions(null);
    try {
      const r = await adsApi.googleBidSuggestions({ campaigns });
      setBidSuggestions(r.data?.suggestions || []);
    } catch (e) { toast.error(e.response?.data?.detail || "Bid analysis failed"); }
    finally { setLoadingBids(false); }
  };

  const loadSearchTerms = async () => {
    setLoadingTerms(true);
    try {
      const r = await adsApi.googleSearchTerms();
      setSearchTerms(r.data?.terms || []);
      setShowTerms(true);
    } catch (e) { toast.error(e.response?.data?.detail || "Failed to load search terms"); }
    finally { setLoadingTerms(false); }
  };

  const handleNegativeKw = async (term, campaignId) => {
    try {
      await adsApi.googleNegativeKw({ keyword: term, campaign_id: campaignId });
      toast.success(`"${term}" added as negative keyword`);
    } catch (e) { toast.error(e.response?.data?.detail || "Failed to add negative keyword"); }
  };

  return (
    <div className="space-y-6">
      {/* ── Connect ──────────────────────────────────────────────── */}
      <Card className="border-border/40 bg-card/60">
        <CardHeader className="pb-4">
          <CardTitle className="text-base flex items-center gap-2">
            <Search size={18} className="text-primary" /> Connect Google Ads Account
            <StatusBadge status={connected ? "connected" : "disconnected"} />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-sm">
            <Label className="text-xs text-muted-foreground mb-1 block">Google Ads Customer ID</Label>
            <Input placeholder="123-456-7890" value={customerId} onChange={e => setCustomerId(e.target.value)}
              disabled={connected} className="bg-muted/30 border-border/50" />
          </div>
          <div className="flex gap-2">
            {!connected
              ? <Button onClick={handleOAuth} disabled={oauthLoading || !customerId} size="sm" className="gap-1.5">
                  {oauthLoading ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
                  Connect with Google OAuth
                </Button>
              : <Button onClick={() => { setConnected(false); setCampaigns([]); }} variant="destructive" size="sm" className="gap-1.5">
                  <XCircle size={14} /> Disconnect
                </Button>
            }
          </div>
        </CardContent>
      </Card>

      {/* ── Campaigns Table ───────────────────────────────────────── */}
      <Card className="border-border/40 bg-card/60">
        <CardHeader className="pb-4 flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 size={18} className="text-primary" /> Campaign Overview
          </CardTitle>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={loadCampaigns} disabled={loadingCampaigns || !connected} className="gap-1.5">
              {loadingCampaigns ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={handleBidSuggestions} disabled={loadingBids || !connected} className="gap-1.5">
              {loadingBids ? <Loader2 size={14} className="animate-spin" /> : <TrendingUp size={14} />}
              {loadingBids ? "Analyzing..." : "Bid Suggestions"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!connected ? (
            <p className="text-muted-foreground text-sm text-center py-8">Connect your Google Ads account first</p>
          ) : loadingCampaigns ? (
            <div className="flex items-center justify-center py-12"><Loader2 size={24} className="animate-spin text-primary" /></div>
          ) : campaigns.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-8">No campaigns found. Create one below.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/40 text-muted-foreground text-xs">
                    {["Campaign","Status","Type","Daily Budget","Impressions","Clicks","CTR","Avg CPC","Conversions","Cost","Actions"].map(h => (
                      <th key={h} className="text-left pb-3 pr-4 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map(c => (
                    <tr key={c.id} className="border-b border-border/20 hover:bg-muted/20 transition-colors">
                      <td className="py-3 pr-4 font-medium max-w-[140px] truncate">{c.name}</td>
                      <td className="py-3 pr-4"><StatusBadge status={c.status} /></td>
                      <td className="py-3 pr-4 text-muted-foreground text-xs">{c.type}</td>
                      <td className="py-3 pr-4">{fmt.money(c.daily_budget)}</td>
                      <td className="py-3 pr-4">{fmt.num(c.impressions)}</td>
                      <td className="py-3 pr-4">{fmt.num(c.clicks)}</td>
                      <td className="py-3 pr-4">{fmt.pct(c.ctr)}</td>
                      <td className="py-3 pr-4">{fmt.money(c.avg_cpc)}</td>
                      <td className="py-3 pr-4">{fmt.num(c.conversions)}</td>
                      <td className="py-3 pr-4">{fmt.money(c.cost)}</td>
                      <td className="py-3 pr-4">
                        <div className="flex gap-1">
                          {c.status === "ENABLED"
                            ? <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleCampaignAction("pause", c.id)} title="Pause"><Pause size={13}/></Button>
                            : <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleCampaignAction("resume", c.id)} title="Resume"><Play size={13}/></Button>
                          }
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-red-400 hover:text-red-300" onClick={() => handleCampaignAction("delete", c.id)} title="Delete"><Trash2 size={13}/></Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Bid Suggestions */}
          <AnimatePresence>
            {bidSuggestions && bidSuggestions.length > 0 && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-4 space-y-2">
                <p className="text-sm font-semibold text-foreground flex items-center gap-2"><TrendingUp size={14} className="text-primary" /> AI Bid Adjustment Suggestions</p>
                {bidSuggestions.map((s, i) => (
                  <div key={i} className="bg-muted/30 border border-border/40 rounded-lg p-3 text-sm">
                    <p className="font-medium">{s.campaign_name}</p>
                    <ul className="mt-1 space-y-0.5">
                      {s.suggestions?.map((tip, j) => (
                        <li key={j} className="text-muted-foreground text-xs flex items-start gap-1.5">
                          <span className="text-primary mt-0.5">→</span> {tip}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>

      {/* ── AI Campaign Generator ─────────────────────────────────── */}
      <Card className="border-border/40 bg-card/60">
        <CardHeader className="pb-4">
          <CardTitle className="text-base flex items-center gap-2">
            <Bot size={18} className="text-primary" /> AI Campaign Generator
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Landing Page URL</Label>
              <Input placeholder="https://yoursite.com/product" value={gen.landing_url}
                onChange={e => setGen(p => ({ ...p, landing_url: e.target.value }))}
                className="bg-muted/30 border-border/50" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Keywords (comma-separated)</Label>
              <Input placeholder="SEO tool, rank tracker, keyword research" value={gen.keywords}
                onChange={e => setGen(p => ({ ...p, keywords: e.target.value }))}
                className="bg-muted/30 border-border/50" />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Goal</Label>
              <Select value={gen.goal} onValueChange={v => setGen(p => ({ ...p, goal: v }))}>
                <SelectTrigger className="bg-muted/30 border-border/50"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MAXIMIZE_CONVERSIONS">Maximize Conversions</SelectItem>
                  <SelectItem value="TARGET_CPA">Target CPA</SelectItem>
                  <SelectItem value="MANUAL_CPC">Manual CPC</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Daily Budget ($)</Label>
              <Input type="number" min={1} value={gen.budget_daily}
                onChange={e => setGen(p => ({ ...p, budget_daily: Number(e.target.value) }))}
                className="bg-muted/30 border-border/50" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Location (country code)</Label>
              <Input placeholder="IN" value={gen.location}
                onChange={e => setGen(p => ({ ...p, location: e.target.value }))}
                className="bg-muted/30 border-border/50" />
            </div>
          </div>
          <Button onClick={handleGenerate} disabled={generating} className="gap-1.5">
            {generating ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            {generating ? "Generating..." : "Generate with AI"}
          </Button>

          {/* Preview */}
          <AnimatePresence>
            {preview && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4 mt-2">
                <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 text-sm space-y-1">
                  <p><span className="text-muted-foreground">Campaign:</span> <strong>{preview.campaign_name}</strong></p>
                  <p><span className="text-muted-foreground">Bidding:</span> {preview.bidding_strategy}</p>
                </div>
                <p className="text-sm font-semibold">Ad Groups — approve what you want to launch:</p>
                <div className="space-y-3">
                  {preview.ad_groups?.map((grp, i) => {
                    const isApproved = approved.includes(i);
                    return (
                      <div key={i} className={`rounded-lg border p-4 transition-all ${isApproved ? "border-primary/50 bg-primary/5" : "border-border/40 bg-card/40 opacity-60"}`}>
                        <div className="flex items-center justify-between mb-3">
                          <span className="font-semibold text-sm">{grp.name}</span>
                          <button onClick={() => setApproved(prev => isApproved ? prev.filter(x => x !== i) : [...prev, i])}
                            className={`w-6 h-6 rounded-full flex items-center justify-center border transition-colors ${isApproved ? "bg-primary border-primary text-primary-foreground" : "border-border/60 text-muted-foreground hover:border-primary"}`}>
                            {isApproved ? <Check size={12} /> : <X size={12} />}
                          </button>
                        </div>
                        {/* Keywords */}
                        <div className="mb-3">
                          <p className="text-xs text-muted-foreground mb-1.5 font-medium">Keywords ({grp.keywords?.length})</p>
                          <div className="flex flex-wrap gap-1.5">
                            {grp.keywords?.slice(0, 8).map((kw, j) => (
                              <Badge key={j} variant="outline" className="text-[10px]">
                                {kw.match_type === "EXACT" ? "[" : kw.match_type === "PHRASE" ? '"' : ""}{kw.text}{kw.match_type === "EXACT" ? "]" : kw.match_type === "PHRASE" ? '"' : ""}
                              </Badge>
                            ))}
                            {grp.keywords?.length > 8 && <span className="text-xs text-muted-foreground">+{grp.keywords.length - 8} more</span>}
                          </div>
                        </div>
                        {/* Ads */}
                        {grp.ads?.[0] && (
                          <div>
                            <p className="text-xs text-muted-foreground mb-1.5 font-medium">Responsive Search Ad</p>
                            <div className="bg-muted/20 rounded p-3 text-xs space-y-1">
                              <p className="font-medium text-primary">{grp.ads[0].headlines?.[0]}</p>
                              <p className="text-muted-foreground">{grp.ads[0].descriptions?.[0]}</p>
                              <p className="text-muted-foreground opacity-70">{preview.landing_url || gen.landing_url}</p>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <Button onClick={handleLaunch} disabled={launching || approved.length === 0 || !connected}
                  className="bg-emerald-600 hover:bg-emerald-700 gap-1.5">
                  {launching ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                  Launch {approved.length} Ad Group{approved.length !== 1 ? "s" : ""}
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>

      {/* ── Search Term Report ───────────────────────────────────── */}
      <Card className="border-border/40 bg-card/60">
        <CardHeader className="pb-4 flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Search size={18} className="text-primary" /> Search Term Report
          </CardTitle>
          <Button variant="outline" size="sm" onClick={loadSearchTerms} disabled={loadingTerms || !connected} className="gap-1.5">
            {loadingTerms ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
            {loadingTerms ? "Loading..." : "Load Report"}
          </Button>
        </CardHeader>
        <AnimatePresence>
          {showTerms && (
            <CardContent>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                {searchTerms.length === 0 ? (
                  <p className="text-muted-foreground text-sm text-center py-4">No search term data available</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border/40 text-muted-foreground text-xs">
                          {["Search Term","Campaign","Impressions","Clicks","Cost","Actions"].map(h => (
                            <th key={h} className="text-left pb-3 pr-4 font-medium">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {searchTerms.map((t, i) => (
                          <tr key={i} className="border-b border-border/20 hover:bg-muted/20 transition-colors">
                            <td className="py-3 pr-4 font-mono text-xs">{t.search_term}</td>
                            <td className="py-3 pr-4 text-muted-foreground text-xs">{t.campaign_name}</td>
                            <td className="py-3 pr-4">{fmt.num(t.impressions)}</td>
                            <td className="py-3 pr-4">{fmt.num(t.clicks)}</td>
                            <td className="py-3 pr-4">{fmt.money(t.cost)}</td>
                            <td className="py-3 pr-4">
                              <div className="flex gap-1">
                                <Button size="sm" variant="ghost" className="h-7 text-xs gap-1 text-red-400 hover:text-red-300"
                                  onClick={() => handleNegativeKw(t.search_term, t.campaign_id)}>
                                  <XCircle size={12} /> Negative KW
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </motion.div>
            </CardContent>
          )}
        </AnimatePresence>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════
export default function AdsManager() {
  const [tab, setTab] = useState("meta");

  // Handle Google OAuth callback in URL params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const tabParam = params.get("tab");
    if (code && tabParam === "google") {
      window.opener?.postMessage({ type: "google_ads_oauth_callback", code }, window.location.origin);
      window.close();
    }
    if (tabParam === "google") setTab("google");
  }, []);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-heading font-bold text-foreground flex items-center gap-3">
            <Megaphone size={26} className="text-primary" /> Ads Manager
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage Meta and Google Ads campaigns with AI-powered automation
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-muted/40 rounded-lg w-fit border border-border/40">
        {[
          { id: "meta",   label: "Meta Ads",   icon: Megaphone },
          { id: "google", label: "Google Ads", icon: Search },
        ].map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
              tab === id
                ? "bg-background text-foreground shadow-sm border border-border/40"
                : "text-muted-foreground hover:text-foreground"
            }`}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <AnimatePresence mode="wait">
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          {tab === "meta"   && <MetaAdsTab />}
          {tab === "google" && <GoogleAdsTab />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
