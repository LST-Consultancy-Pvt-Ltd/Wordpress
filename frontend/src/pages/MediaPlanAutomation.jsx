import { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  FileSpreadsheet, UploadCloud, Loader2, CheckCircle2, XCircle,
  ChevronDown, ChevronUp, Play, Pause, RefreshCw, BarChart3,
  Calendar, Search, Target, DollarSign, Users, TrendingUp,
  AlertCircle, Upload, Eye, Zap, Bot, Clock, ListChecks,
  Instagram, Youtube, Linkedin, Globe, ShoppingBag, Video,
  ArrowRight, CircleDot, CheckSquare, PauseCircle, AlertTriangle,
  LayoutGrid, SlidersHorizontal, Activity, Link2, Link2Off, ExternalLink
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Switch } from "../components/ui/switch";
import { Label } from "../components/ui/label";
import { Progress } from "../components/ui/progress";
import { Separator } from "../components/ui/separator";
import { toast } from "sonner";
import api from "../lib/api";

// ─── API helpers ─────────────────────────────────────────────────
const mpApi = {
  parse:               (formData) => api.post("/media-plan/parse", formData, { headers: { "Content-Type": "multipart/form-data" } }),
  activate:            (d)        => api.post("/media-plan/activate", d),
  tasks:               (planId)   => api.get(`/media-plan/tasks/${planId}`),
  executeTask:         (taskId)   => api.post(`/media-plan/tasks/${taskId}/execute`),
  updateStatus:        (taskId, status) => api.put(`/media-plan/tasks/${taskId}/status`, { status }),
  pausePlan:           (planId)   => api.post(`/media-plan/pause/${planId}`),
  resumePlan:          (planId)   => api.post(`/media-plan/resume/${planId}`),
  performance:         (planId)   => api.get(`/media-plan/performance/${planId}`),
  platformConnections: ()         => api.get("/media-plan/platform-connections"),
};

// ─── Platform icon/color map ──────────────────────────────────────
const PLATFORM_META = {
  meta:             { label: "Meta (Insta+FB)", color: "text-blue-400",   bg: "bg-blue-500/15 border-blue-500/30" },
  instagram:        { label: "Instagram",       color: "text-pink-400",   bg: "bg-pink-500/15 border-pink-500/30" },
  facebook:         { label: "Facebook",        color: "text-blue-400",   bg: "bg-blue-500/15 border-blue-500/30" },
  google_search:    { label: "Google Search",   color: "text-green-400",  bg: "bg-green-500/15 border-green-500/30" },
  google_shopping:  { label: "Google Shopping", color: "text-emerald-400",bg: "bg-emerald-500/15 border-emerald-500/30" },
  youtube:          { label: "YouTube",         color: "text-red-400",    bg: "bg-red-500/15 border-red-500/30" },
  linkedin:         { label: "LinkedIn",        color: "text-sky-400",    bg: "bg-sky-500/15 border-sky-500/30" },
  influencer:       { label: "Influencer",      color: "text-purple-400", bg: "bg-purple-500/15 border-purple-500/30" },
  threads:          { label: "Threads",         color: "text-gray-300",   bg: "bg-gray-500/15 border-gray-500/30" },
  seo:              { label: "SEO",             color: "text-amber-400",  bg: "bg-amber-500/15 border-amber-500/30" },
};
const pInfo = (p) => PLATFORM_META[p?.toLowerCase()] || { label: p, color: "text-muted-foreground", bg: "bg-muted/30 border-border/40" };

// ─── Platform → connection key (null = no external connection needed) ──
const PLATFORM_TO_CONNECTION = {
  meta:            "meta",
  instagram:       "meta",
  facebook:        "meta",
  threads:         "meta",
  google_search:   "google",
  google_shopping: "google",
  youtube:         "youtube",
  linkedin:        "linkedin",
  influencer:      null,
  seo:             null,
};

// ─── Connection type config (one entry per external account) ─────
const CONNECTION_CONFIG = {
  meta: {
    label:    "Meta Ads",
    subLabel: "Instagram · Facebook · Threads",
    abbrev:   "M",
    color:    "text-blue-400",
    bg:       "bg-blue-500/15 border-blue-500/30",
    covers:   ["meta", "instagram", "facebook", "threads"],
    fields: [
      { key: "business_manager_id", label: "Business Manager ID", placeholder: "123456789012345", type: "text" },
      { key: "ad_account_id",       label: "Ad Account ID",       placeholder: "act_123456789",    type: "text" },
      { key: "access_token",        label: "Access Token",        placeholder: "EAAGm0PX4ZC…",     type: "password" },
    ],
    connectEndpoint:    "/ads/meta/connect",
    disconnectEndpoint: "/ads/meta/disconnect",
  },
  google: {
    label:    "Google Ads",
    subLabel: "Search · Shopping",
    abbrev:   "G",
    color:    "text-green-400",
    bg:       "bg-green-500/15 border-green-500/30",
    covers:   ["google_search", "google_shopping"],
    oauth:    true,
    fields: [
      { key: "customer_id", label: "Google Ads Customer ID", placeholder: "123-456-7890", type: "text" },
    ],
    oauthUrlEndpoint:   "/ads/google/oauth-url",
    connectEndpoint:    "/ads/google/connect",
    disconnectEndpoint: "/ads/google/disconnect",
  },
  youtube: {
    label:    "YouTube",
    subLabel: "Video ads & analytics",
    abbrev:   "YT",
    color:    "text-red-400",
    bg:       "bg-red-500/15 border-red-500/30",
    covers:   ["youtube"],
    fields: [
      { key: "api_key", label: "YouTube Data API Key", placeholder: "AIzaSy…", type: "password" },
    ],
    connectEndpoint:    "/ads/youtube/connect",
    disconnectEndpoint: "/ads/youtube/disconnect",
  },
  linkedin: {
    label:    "LinkedIn",
    subLabel: "B2B ads & organic",
    abbrev:   "LI",
    color:    "text-sky-400",
    bg:       "bg-sky-500/15 border-sky-500/30",
    covers:   ["linkedin"],
    fields: [
      { key: "access_token",    label: "Access Token",           placeholder: "AQV…",      type: "password" },
      { key: "organization_id", label: "Organization ID (opt.)", placeholder: "12345678",  type: "text" },
    ],
    connectEndpoint:    "/ads/linkedin/connect",
    disconnectEndpoint: "/ads/linkedin/disconnect",
  },
};

// ─── Status badge ─────────────────────────────────────────────────
const StatusBadge = ({ status }) => {
  const map = {
    scheduled:            "bg-blue-500/15 text-blue-400 border-blue-500/30",
    in_progress:          "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    completed:            "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    failed:               "bg-red-500/15 text-red-400 border-red-500/30",
    awaiting_asset:       "bg-orange-500/15 text-orange-400 border-orange-500/30",
    requires_approval:    "bg-amber-500/15 text-amber-400 border-amber-500/30",
    awaiting_connection:  "bg-violet-500/15 text-violet-400 border-violet-500/30",
    paused:               "bg-muted/40 text-muted-foreground border-border/40",
    pending:              "bg-muted/40 text-muted-foreground border-border/40",
  };
  const label = {
    in_progress:         "In Progress",
    awaiting_asset:      "Awaiting Asset",
    requires_approval:   "Needs Approval",
    awaiting_connection: "Connect Platform",
  };
  return (
    <Badge variant="outline" className={`text-[10px] capitalize ${map[status] || "bg-muted/40 text-muted-foreground border-border/40"}`}>
      {label[status] || status?.replace(/_/g, " ")}
    </Badge>
  );
};

// ─── INR formatter ────────────────────────────────────────────────
const inr  = (v) => v == null ? "—" : `₹${Number(v).toLocaleString("en-IN")}`;
const num  = (v) => v == null ? "—" : Number(v).toLocaleString("en-IN");
const pct  = (v) => v == null ? "—" : `${(Number(v) * 100).toFixed(1)}%`;

// ─── Collapsible section ──────────────────────────────────────────
function Section({ title, icon: Icon, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card className="border-border/40 bg-card/60">
      <button onClick={() => setOpen(p => !p)}
        className="w-full flex items-center justify-between p-5 pb-4 text-left">
        <div className="flex items-center gap-2 font-semibold text-sm text-foreground">
          {Icon && <Icon size={16} className="text-primary" />} {title}
        </div>
        {open ? <ChevronUp size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }}>
            <CardContent className="pt-0">{children}</CardContent>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SECTION 1 — UPLOAD ZONE
// ═══════════════════════════════════════════════════════════════════
function UploadZone({ onParsed }) {
  const [dragging, setDragging]   = useState(false);
  const [parsing, setParsing]     = useState(false);
  const [fileName, setFileName]   = useState("");
  const inputRef                  = useRef(null);

  const handleFile = async (file) => {
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();
    if (!["xlsx", "xls", "csv"].includes(ext)) {
      return toast.error("Please upload a .xlsx, .xls, or .csv file");
    }
    setFileName(file.name);
    setParsing(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await mpApi.parse(fd);
      toast.success("Media plan parsed successfully");
      onParsed(r.data);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to parse media plan");
    } finally {
      setParsing(false);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files?.[0]);
  };

  return (
    <Card className="border-border/40 bg-card/60">
      <CardContent className="p-8">
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => !parsing && inputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-12 flex flex-col items-center gap-4 cursor-pointer transition-all ${
            dragging ? "border-primary bg-primary/5" : "border-border/50 hover:border-primary/50 hover:bg-muted/20"
          }`}
        >
          <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0])} />
          {parsing ? (
            <>
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Loader2 size={32} className="animate-spin text-primary" />
              </div>
              <div className="text-center">
                <p className="font-semibold text-foreground">Parsing with AI…</p>
                <p className="text-sm text-muted-foreground mt-1">Extracting budgets, tasks, KPIs, and schedule from <strong>{fileName}</strong></p>
              </div>
            </>
          ) : (
            <>
              <div className={`w-16 h-16 rounded-full flex items-center justify-center transition-all ${dragging ? "bg-primary/20" : "bg-muted/40"}`}>
                <UploadCloud size={32} className={dragging ? "text-primary" : "text-muted-foreground"} />
              </div>
              <div className="text-center">
                <p className="font-semibold text-foreground">Drop your Media Plan here</p>
                <p className="text-sm text-muted-foreground mt-1">Supports <strong>.xlsx</strong>, <strong>.xls</strong>, <strong>.csv</strong> — any layout, Claude AI will parse it</p>
              </div>
              <Button variant="outline" size="sm" className="gap-2 pointer-events-none">
                <Upload size={14} /> Browse File
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PLATFORM CONNECT CARD — inline expand form per connection type
// ═══════════════════════════════════════════════════════════════════
function PlatformConnectCard({ connKey, config, status, onRefresh }) {
  const [expanded, setExpanded]         = useState(false);
  const [fields, setFields]             = useState({});
  const [connecting, setConnecting]     = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);

  const isConnected = !!status?.connected;

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await api.post(config.connectEndpoint, fields);
      toast.success(`${config.label} connected successfully`);
      setExpanded(false);
      setFields({});
      onRefresh();
    } catch (e) {
      toast.error(e.response?.data?.detail || `Failed to connect ${config.label}`);
    } finally { setConnecting(false); }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await api.delete(config.disconnectEndpoint);
      toast.success(`${config.label} disconnected`);
      onRefresh();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Disconnect failed");
    } finally { setDisconnecting(false); }
  };

  const handleGoogleOAuth = async () => {
    if (!fields.customer_id?.trim()) return toast.error("Enter your Google Ads Customer ID first");
    setOauthLoading(true);
    try {
      const r   = await api.get(config.oauthUrlEndpoint);
      const url = r.data?.auth_url;
      if (!url) throw new Error("No auth URL returned from server");
      const popup   = window.open(url, "google_oauth", "width=600,height=700");
      const handler = async (event) => {
        if (event.data?.type === "google_ads_oauth_callback" && event.data?.code) {
          window.removeEventListener("message", handler);
          popup?.close();
          try {
            await api.post(config.connectEndpoint, { code: event.data.code, customer_id: fields.customer_id });
            toast.success("Google Ads connected");
            setExpanded(false);
            setFields({});
            onRefresh();
          } catch (err) {
            toast.error(err.response?.data?.detail || "Google connect failed");
          }
        }
      };
      window.addEventListener("message", handler);
    } catch (e) {
      toast.error(e.response?.data?.detail || "OAuth flow failed");
    } finally { setOauthLoading(false); }
  };

  return (
    <div className={`rounded-xl border transition-all ${
      isConnected
        ? "border-emerald-500/30 bg-emerald-500/5"
        : expanded
          ? "border-primary/40 bg-primary/5"
          : "border-border/40 bg-muted/10 hover:border-border/60"
    }`}>
      {/* Header row */}
      <div className="flex items-center gap-3 p-4">
        <div className={`w-9 h-9 rounded-lg border flex items-center justify-center flex-shrink-0 ${config.bg}`}>
          <span className={`text-[11px] font-bold ${config.color}`}>{config.abbrev}</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold ${config.color}`}>{config.label}</p>
          <p className="text-xs text-muted-foreground truncate">{config.subLabel}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isConnected ? (
            <>
              <Badge variant="outline" className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px] gap-1">
                <CheckCircle2 size={9} /> Connected
              </Badge>
              <button
                onClick={() => setExpanded(p => !p)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors underline-offset-2 hover:underline">
                {expanded ? "Cancel" : "Edit"}
              </button>
            </>
          ) : (
            <Button
              size="sm"
              variant={expanded ? "outline" : "default"}
              className="h-8 text-xs gap-1.5"
              onClick={() => setExpanded(p => !p)}>
              <Link2 size={12} />{expanded ? "Cancel" : "Connect"}
            </Button>
          )}
        </div>
      </div>

      {/* Expandable form */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }}
            className="overflow-hidden">
            <div className="px-4 pb-4 space-y-3 border-t border-border/30 pt-3">
              {/* Fields */}
              {config.fields.map(f => (
                <div key={f.key}>
                  <label className="text-xs text-muted-foreground mb-1.5 block">{f.label}</label>
                  <input
                    type={f.type}
                    placeholder={f.placeholder}
                    value={fields[f.key] || ""}
                    onChange={e => setFields(prev => ({ ...prev, [f.key]: e.target.value }))}
                    autoComplete="off"
                    className="w-full text-sm bg-background border border-border/40 rounded-lg px-3 py-2 outline-none focus:border-primary/60 transition-colors placeholder:text-muted-foreground/50"
                  />
                </div>
              ))}

              {/* Action buttons */}
              <div className="flex gap-2 pt-1">
                {config.oauth ? (
                  <Button onClick={handleGoogleOAuth} disabled={oauthLoading} className="flex-1 gap-2" size="sm">
                    {oauthLoading ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                    {oauthLoading ? "Opening OAuth…" : "Authorize with Google"}
                  </Button>
                ) : (
                  <Button onClick={handleConnect} disabled={connecting} className="flex-1 gap-2" size="sm">
                    {connecting ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
                    {connecting ? "Connecting…" : `Connect ${config.label}`}
                  </Button>
                )}
                {isConnected && (
                  <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={disconnecting}
                    className="text-red-400 border-red-500/30 hover:bg-red-500/10 hover:text-red-400 px-3">
                    {disconnecting ? <Loader2 size={13} className="animate-spin" /> : <Link2Off size={13} />}
                  </Button>
                )}
              </div>
              {isConnected && status?.connected_at && (
                <p className="text-[10px] text-muted-foreground">
                  Connected {new Date(status.connected_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                  {status.connected_by ? ` by ${status.connected_by}` : ""}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PLATFORM CONNECTIONS SECTION — shows all required connections
// ═══════════════════════════════════════════════════════════════════
function PlatformConnectionsSection({ plan, connections, loadingConnections, onRefresh }) {
  const neededKeys = new Set();
  for (const b of (plan.platform_budgets || [])) {
    const k = PLATFORM_TO_CONNECTION[b.platform];
    if (k) neededKeys.add(k);
  }
  for (const t of (plan.content_tasks || [])) {
    const k = PLATFORM_TO_CONNECTION[t.platform];
    if (k) neededKeys.add(k);
  }

  const connectedCount = [...neededKeys].filter(k => connections[k]?.connected).length;
  const totalNeeded    = neededKeys.size;
  const allConnected   = totalNeeded > 0 && connectedCount === totalNeeded;

  return (
    <Section title="Platform Connections" icon={Link2}>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className={`text-xs font-medium px-3 py-1 rounded-full border ${
          allConnected
            ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
            : connectedCount > 0
              ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30"
              : "bg-red-500/15 text-red-400 border-red-500/30"
        }`}>
          {connectedCount}/{totalNeeded} connected
        </div>
        <p className="text-xs text-muted-foreground flex-1">
          Connect each platform below. Tasks auto-execute only for connected accounts. Influencer &amp; SEO tasks run without external connections.
        </p>
        {loadingConnections && <Loader2 size={13} className="animate-spin text-muted-foreground" />}
        {!loadingConnections && (
          <button onClick={onRefresh} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors">
            <RefreshCw size={11} /> Refresh
          </button>
        )}
      </div>

      {neededKeys.size === 0 ? (
        <p className="text-sm text-muted-foreground italic">No external platform connections required for this plan.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[...neededKeys].map(key => (
            <PlatformConnectCard
              key={key}
              connKey={key}
              config={CONNECTION_CONFIG[key]}
              status={connections[key]}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SECTION 2 — PARSED PLAN PREVIEW
// ═══════════════════════════════════════════════════════════════════
function ParsedPlanPreview({ plan, onActivate }) {
  const [connections, setConnections]   = useState({});
  const [loadingConns, setLoadingConns] = useState(true);
  const [activating, setActivating]     = useState(false);

  const loadConnections = async () => {
    setLoadingConns(true);
    try {
      const r = await mpApi.platformConnections();
      setConnections(r.data || {});
    } catch (e) {
      // silently fail — user can still see the UI
    } finally { setLoadingConns(false); }
  };

  useEffect(() => { loadConnections(); }, []); // eslint-disable-line

  // ─── Determine which platforms will activate vs be skipped ───────
  const allPlanPlatforms = new Set([
    ...(plan.platform_budgets || []).map(b => b.platform),
    ...(plan.content_tasks || []).map(t => t.platform),
  ]);
  if ((plan.seo_tasks || []).length > 0) allPlanPlatforms.add("seo");

  const activatablePlatforms = [...allPlanPlatforms].filter(p => {
    const connKey = PLATFORM_TO_CONNECTION[p];
    return connKey === null || !!connections[connKey]?.connected;
  });
  const pendingPlatforms = [...allPlanPlatforms].filter(p => {
    const connKey = PLATFORM_TO_CONNECTION[p];
    return connKey !== null && !connections[connKey]?.connected;
  });

  const handleActivate = async () => {
    if (activatablePlatforms.length === 0)
      return toast.error("Connect at least one platform before activating");
    setActivating(true);
    try {
      const r = await mpApi.activate({
        plan_id:           plan.plan_id,
        site_id:           plan.site_id || "global",
        enabled_platforms: activatablePlatforms,
      });
      toast.success(`${r.data.tasks_created} tasks scheduled across ${activatablePlatforms.length} platform(s)`);
      onActivate(r.data);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Activation failed");
    } finally { setActivating(false); }
  };

  const totalBudget = plan.total_budget || (plan.platform_budgets || []).reduce((s, b) => s + (b.monthly_budget || 0), 0);

  return (
    <div className="space-y-5">
      {/* Plan header */}
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="p-5 flex flex-wrap items-center gap-6">
          <div>
            <p className="text-xs text-muted-foreground">Brand</p>
            <p className="font-bold text-lg text-foreground">{plan.brand_name || "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Month</p>
            <p className="font-semibold text-foreground">{plan.month || "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Total Budget</p>
            <p className="font-bold text-emerald-400 text-lg">{inr(totalBudget)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Daily Burn</p>
            <p className="font-semibold text-foreground">{inr(plan.daily_total_budget)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Platforms</p>
            <p className="font-semibold text-foreground">{plan.platform_budgets?.length || 0}</p>
          </div>
        </CardContent>
      </Card>

      {/* ─── PLATFORM CONNECTIONS (primary action section) ─── */}
      <PlatformConnectionsSection
        plan={plan}
        connections={connections}
        loadingConnections={loadingConns}
        onRefresh={loadConnections}
      />

      {/* Budget Overview */}
      <Section title="Budget Overview" icon={DollarSign}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/40 text-muted-foreground text-xs">
                {["Platform","Monthly Budget","Daily Budget","Target Orders","ROAS","Reach","Clicks","Notes"].map(h => (
                  <th key={h} className="text-left pb-3 pr-4 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(plan.platform_budgets || []).map((b, i) => {
                const pi      = pInfo(b.platform);
                const connKey = PLATFORM_TO_CONNECTION[b.platform];
                const isConn  = connKey === null || !!connections[connKey]?.connected;
                return (
                  <tr key={i} className={`border-b border-border/20 hover:bg-muted/20 transition-colors ${!isConn ? "opacity-50" : ""}`}>
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className={`text-[11px] ${pi.bg}`}>{pi.label}</Badge>
                        {!isConn && <span className="text-[9px] text-amber-400 font-medium">not connected</span>}
                      </div>
                    </td>
                    <td className="py-3 pr-4 font-medium text-foreground">{inr(b.monthly_budget)}</td>
                    <td className="py-3 pr-4 text-muted-foreground">{inr(b.daily_budget)}</td>
                    <td className="py-3 pr-4">{num(b.orders_estimate)}</td>
                    <td className="py-3 pr-4">{b.roas_target ? `${b.roas_target}x` : "—"}</td>
                    <td className="py-3 pr-4">{num(b.reach_target)}</td>
                    <td className="py-3 pr-4">{num(b.clicks_target)}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs max-w-[200px]">{b.notes || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {/* Budget share bars */}
        <div className="mt-5 space-y-2.5">
          {(plan.platform_budgets || []).map((b, i) => {
            const share = totalBudget > 0 ? (b.monthly_budget / totalBudget) * 100 : 0;
            const pi    = pInfo(b.platform);
            return (
              <div key={i} className="flex items-center gap-3">
                <div className="w-28 text-xs text-muted-foreground truncate">{pi.label}</div>
                <div className="flex-1 bg-muted/30 rounded-full h-2">
                  <div className="h-2 rounded-full bg-primary/70 transition-all" style={{ width: `${share.toFixed(1)}%` }} />
                </div>
                <div className="w-12 text-xs text-right text-muted-foreground">{share.toFixed(0)}%</div>
              </div>
            );
          })}
        </div>
      </Section>

      {/* Content Schedule */}
      <Section title="Content Schedule" icon={Calendar} defaultOpen={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/40 text-muted-foreground text-xs">
                {["Platform","Task","Frequency","Per Week","Output"].map(h => (
                  <th key={h} className="text-left pb-3 pr-4 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(plan.content_tasks || []).map((t, i) => {
                const pi      = pInfo(t.platform);
                const connKey = PLATFORM_TO_CONNECTION[t.platform];
                const isConn  = connKey === null || !!connections[connKey]?.connected;
                return (
                  <tr key={i} className={`border-b border-border/20 hover:bg-muted/20 transition-colors ${!isConn ? "opacity-50" : ""}`}>
                    <td className="py-3 pr-4">
                      <Badge variant="outline" className={`text-[11px] ${pi.bg}`}>{pi.label}</Badge>
                    </td>
                    <td className="py-3 pr-4 font-medium">{t.task}</td>
                    <td className="py-3 pr-4 text-muted-foreground capitalize">{t.frequency}</td>
                    <td className="py-3 pr-4 text-center">{t.frequency_per_week ?? "—"}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{t.output}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {/* SEO Tasks */}
      <Section title="SEO Tasks" icon={Search} defaultOpen={false}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(plan.seo_tasks || []).map((t, i) => (
            <div key={i} className="bg-muted/20 border border-border/40 rounded-lg p-3 flex items-start gap-3">
              <div className="mt-0.5"><StatusBadge status="pending" /></div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{t.task}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t.output} · <span className="text-primary">{t.duration}</span></p>
              </div>
              <Badge variant="outline" className={`text-[10px] flex-shrink-0 ${
                t.priority === "high"   ? "bg-red-500/15 text-red-400 border-red-500/30" :
                t.priority === "medium" ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" :
                "bg-muted/40 text-muted-foreground border-border/40"
              }`}>{t.priority}</Badge>
            </div>
          ))}
        </div>
      </Section>

      {/* KPI Targets */}
      <Section title="KPI Targets" icon={Target} defaultOpen={false}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Orders Target",       value: num(plan.kpi_targets?.orders_target),          suffix: "/mo" },
            { label: "Instagram Followers", value: num(plan.kpi_targets?.instagram_followers),    suffix: "+" },
            { label: "YouTube Subscribers", value: num(plan.kpi_targets?.youtube_subscribers),    suffix: "+" },
            { label: "LinkedIn Followers",  value: num(plan.kpi_targets?.linkedin_followers),     suffix: "+" },
            { label: "Threads Followers",   value: num(plan.kpi_targets?.threads_followers),      suffix: "+" },
            { label: "B2B Inquiries",       value: num(plan.kpi_targets?.b2b_inquiries),          suffix: "" },
            { label: "Keyword Rankings",    value: num(plan.kpi_targets?.keyword_ranking_target), suffix: " keywords" },
          ].filter(k => k.value !== "—").map((k, i) => (
            <div key={i} className="bg-muted/20 border border-border/40 rounded-lg p-4">
              <p className="text-xs text-muted-foreground mb-1">{k.label}</p>
              <p className="text-xl font-bold text-foreground">{k.value}<span className="text-sm font-normal text-muted-foreground">{k.suffix}</span></p>
            </div>
          ))}
        </div>
      </Section>

      {/* Objectives */}
      {plan.objectives?.length > 0 && (
        <Section title="Objectives" icon={ListChecks} defaultOpen={false}>
          <ul className="space-y-1.5">
            {plan.objectives.map((o, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <ArrowRight size={13} className="text-primary mt-0.5 flex-shrink-0" />
                <span className="text-muted-foreground">{o}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* ─── ACTIVATE SECTION ───────────────────────────────────────── */}
      <Card className="border-border/40 bg-card/60">
        <CardContent className="p-5 space-y-4">
          {/* Will activate */}
          {activatablePlatforms.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground flex items-center gap-2">
                <CheckCircle2 size={14} className="text-emerald-400" />
                Will activate — {activatablePlatforms.length} platform{activatablePlatforms.length !== 1 ? "s" : ""}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {activatablePlatforms.map(p => (
                  <Badge key={p} variant="outline" className={`text-[11px] ${pInfo(p).bg}`}>{pInfo(p).label}</Badge>
                ))}
              </div>
            </div>
          )}
          {/* Pending connection */}
          {pendingPlatforms.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <AlertTriangle size={14} className="text-amber-400" />
                Skipped — awaiting connection ({pendingPlatforms.length})
              </p>
              <div className="flex flex-wrap gap-1.5">
                {pendingPlatforms.map(p => (
                  <Badge key={p} variant="outline" className="text-[11px] bg-muted/30 text-muted-foreground border-border/40 opacity-60">
                    {pInfo(p).label}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          <Button
            onClick={handleActivate}
            disabled={activating || activatablePlatforms.length === 0}
            size="lg"
            className="gap-2 bg-emerald-600 hover:bg-emerald-700 w-full sm:w-auto">
            {activating ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />}
            {activating
              ? "Activating…"
              : activatablePlatforms.length === 0
                ? "Connect a platform first"
                : `Activate ${activatablePlatforms.length} Platform${activatablePlatforms.length !== 1 ? "s" : ""}`}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SECTION 3 — LIVE EXECUTION DASHBOARD
// ═══════════════════════════════════════════════════════════════════
function ExecutionDashboard({ planId, plan }) {
  const [tasks, setTasks]     = useState({ scheduled: [], in_progress: [], completed: [], failed: [] });
  const [loading, setLoading] = useState(false);
  const [paused, setPaused]   = useState(false);
  const pollRef               = useRef(null);

  const loadTasks = useCallback(async () => {
    try {
      const r = await mpApi.tasks(planId);
      setTasks(r.data || { scheduled: [], in_progress: [], completed: [], failed: [] });
    } catch (e) {
      // silently fail on auto-poll
    }
  }, [planId]);

  useEffect(() => {
    loadTasks();
    pollRef.current = setInterval(loadTasks, 30000);
    return () => clearInterval(pollRef.current);
  }, [loadTasks]);

  const handlePause = async () => {
    try {
      await mpApi.pausePlan(planId);
      setPaused(true);
      toast.success("Plan paused");
    } catch (e) { toast.error(e.response?.data?.detail || "Failed to pause"); }
  };

  const handleResume = async () => {
    try {
      await mpApi.resumePlan(planId);
      setPaused(false);
      toast.success("Plan resumed");
    } catch (e) { toast.error(e.response?.data?.detail || "Failed to resume"); }
  };

  const handleExecuteTask = async (taskId) => {
    try {
      await mpApi.executeTask(taskId);
      toast.success("Task triggered");
      loadTasks();
    } catch (e) { toast.error(e.response?.data?.detail || "Execution failed"); }
  };

  const handleApprove = async (taskId) => {
    try {
      await mpApi.updateStatus(taskId, "scheduled");
      toast.success("Task approved and queued");
      loadTasks();
    } catch (e) { toast.error(e.response?.data?.detail || "Failed to approve"); }
  };

  const allTasks   = [
    ...(tasks.awaiting_connection || []),
    ...(tasks.scheduled || []),
    ...(tasks.in_progress || []),
    ...(tasks.completed || []),
    ...(tasks.failed || []),
    ...(tasks.awaiting_asset || []),
    ...(tasks.requires_approval || []),
    ...(tasks.paused || []),
  ];
  const totalCount = allTasks.length;
  const doneCount  = (tasks.completed || []).length;
  const progress   = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const columns = [
    { key: "awaiting_connection", label: "Connect Platform", color: "text-violet-400",  border: "border-violet-500/30" },
    { key: "scheduled",           label: "Scheduled",        color: "text-blue-400",    border: "border-blue-500/30" },
    { key: "completed",           label: "Completed",        color: "text-emerald-400", border: "border-emerald-500/30" },
    { key: "failed",              label: "Failed",           color: "text-red-400",     border: "border-red-500/30" },
  ];

  return (
    <div className="space-y-5">
      {/* Progress header */}
      <Card className="border-border/40 bg-card/60">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="font-semibold text-foreground">Execution Progress</p>
              <p className="text-sm text-muted-foreground">{doneCount} of {totalCount} tasks completed</p>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={loadTasks} disabled={loading} className="gap-1.5">
                {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
              </Button>
              {paused
                ? <Button size="sm" onClick={handleResume} className="gap-1.5 bg-emerald-600 hover:bg-emerald-700">
                    <Play size={13} /> Resume All
                  </Button>
                : <Button size="sm" variant="destructive" onClick={handlePause} className="gap-1.5">
                    <Pause size={13} /> Pause All
                  </Button>
              }
            </div>
          </div>
          <Progress value={progress} className="h-2" />
          <p className="text-xs text-muted-foreground mt-2 text-right">{progress}% complete</p>
        </CardContent>
      </Card>

      {/* Kanban board */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {columns.map(col => (
          <div key={col.key} className={`rounded-xl border ${col.border} bg-card/40 flex flex-col`}>
            <div className={`px-4 py-3 border-b ${col.border} flex items-center justify-between`}>
              <span className={`text-sm font-semibold ${col.color}`}>{col.label}</span>
              <Badge variant="outline" className={`text-[10px] ${col.color}`}>{(tasks[col.key] || []).length}</Badge>
            </div>
            <div className="flex flex-col gap-2 p-3 min-h-[200px] max-h-[500px] overflow-y-auto">
              {(tasks[col.key] || []).length === 0
                ? <p className="text-xs text-muted-foreground text-center py-4">No tasks</p>
                : (tasks[col.key] || []).map((t) => (
                  <TaskCard key={t.task_id} task={t} colKey={col.key}
                    onExecute={() => handleExecuteTask(t.task_id)}
                    onApprove={() => handleApprove(t.task_id)} />
                ))
              }
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TaskCard({ task, colKey, onExecute, onApprove }) {
  const [showResult, setShowResult] = useState(false);
  const pi = pInfo(task.platform);
  const scheduledDate = task.scheduled_date
    ? new Date(task.scheduled_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
    : "";
  const hasResult = !!task.result && Object.keys(task.result).length > 0;

  // ── Render structured result ──────────────────────────────────
  const renderResult = (r) => {
    if (!r) return null;
    const content = r.content || r;

    // Caption / copy
    const caption = r.copy_to_post || r.caption || content?.caption || content?.primary_text || content?.intro_text;
    const headline = r.headline || content?.headline || content?.video_ad_title;
    const hashtags = content?.hashtags;
    const note = r.note;
    const postId = r.post_id;
    const platformUrl = r.platform_url;
    const keywords = content?.keywords;
    const steps = r.action_plan;

    return (
      <div className="space-y-2 text-[11px]">
        {headline && (
          <div>
            <span className="text-muted-foreground">Headline: </span>
            <span className="font-medium text-foreground">{headline}</span>
          </div>
        )}
        {caption && (
          <div>
            <span className="text-muted-foreground block mb-0.5">Caption / Copy:</span>
            <p className="bg-muted/30 rounded p-2 text-foreground leading-snug whitespace-pre-wrap break-words">{caption}</p>
          </div>
        )}
        {hashtags?.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {hashtags.slice(0, 12).map((h, i) => (
              <span key={i} className="text-primary text-[10px]">#{h.replace(/^#/, "")}</span>
            ))}
          </div>
        )}
        {keywords?.length > 0 && (
          <div>
            <span className="text-muted-foreground block mb-0.5">Keywords ({keywords.length}):</span>
            <p className="text-foreground">{keywords.slice(0, 8).join(", ")}{keywords.length > 8 ? "…" : ""}</p>
          </div>
        )}
        {steps?.length > 0 && (
          <ol className="list-decimal list-inside space-y-0.5 text-muted-foreground">
            {steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        )}
        {note && <p className="text-amber-400 italic">{note}</p>}
        {postId && (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Post ID:</span>
            <code className="text-[10px] text-emerald-400">{postId}</code>
            {platformUrl && (
              <a href={platformUrl} target="_blank" rel="noopener noreferrer"
                className="text-primary hover:underline flex items-center gap-0.5">
                <ExternalLink size={9} /> View
              </a>
            )}
          </div>
        )}
      </div>
    );
  };

  const isConnectNeeded = task.status === "awaiting_connection";

  return (
    <div className={`rounded-lg border text-xs space-y-2 transition-all overflow-hidden ${
      isConnectNeeded                     ? "bg-violet-500/5 border-violet-500/30" :
      task.status === "awaiting_asset"    ? "bg-orange-500/5 border-orange-500/30" :
      task.status === "requires_approval" ? "bg-amber-500/5 border-amber-500/30" :
      task.status === "completed"         ? "bg-emerald-500/5 border-emerald-500/20" :
      task.status === "failed"            ? "bg-red-500/5 border-red-500/30" :
      "bg-muted/20 border-border/30"
    }`}>
      <div className="p-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <span className={`font-medium ${pi.color} flex-shrink-0`}>{pi.label}</span>
          {scheduledDate && <span className="text-muted-foreground">{scheduledDate}</span>}
        </div>
        <p className="font-medium text-foreground leading-snug">{task.task_name}</p>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <StatusBadge status={task.status} />
          <div className="flex gap-1">
            {colKey === "scheduled" && (
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] gap-0.5" onClick={onExecute}>
                <Play size={10} /> Run
              </Button>
            )}
            {isConnectNeeded && (
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] gap-0.5 text-violet-400 border-violet-500/30 hover:bg-violet-500/10" onClick={onExecute}>
                <Link2 size={10} /> Retry After Connect
              </Button>
            )}
            {task.status === "requires_approval" && (
              <Button size="sm" className="h-6 px-2 text-[10px] bg-amber-600 hover:bg-amber-700 gap-0.5" onClick={onApprove}>
                <CheckSquare size={10} /> Approve
              </Button>
            )}
            {task.status === "awaiting_asset" && (
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] gap-0.5">
                <Upload size={10} /> Upload
              </Button>
            )}
            {task.status === "completed" && hasResult && (
              <button
                onClick={() => setShowResult(p => !p)}
                className="h-6 px-2 text-[10px] gap-0.5 flex items-center text-emerald-400 hover:text-emerald-300 transition-colors">
                <Eye size={10} className="mr-0.5" />
                {showResult ? "Hide" : "View"}
                {showResult ? <ChevronUp size={9} /> : <ChevronDown size={9} />}
              </button>
            )}
          </div>
        </div>
        {isConnectNeeded && task.connection_required && (
          <p className="text-violet-300 text-[10px]">
            Go to <strong>Plan Preview → Platform Connections</strong> and connect <strong>{task.connection_required}</strong>, then click "Retry After Connect"
          </p>
        )}
        {task.error && !isConnectNeeded && (
          <p className="text-red-400 text-[10px] break-words">{task.error}</p>
        )}
      </div>

      {/* Expandable result */}
      <AnimatePresence>
        {showResult && hasResult && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }}>
            <div className="border-t border-emerald-500/20 p-3 bg-emerald-500/5">
              <p className="text-[10px] font-semibold text-emerald-400 mb-2 uppercase tracking-wide">Result</p>
              {renderResult(task.result)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SECTION 4 — PERFORMANCE TRACKER
// ═══════════════════════════════════════════════════════════════════
function PerformanceTracker({ planId, plan }) {
  const [perf, setPerf]         = useState(null);
  const [loading, setLoading]   = useState(false);

  const loadPerf = async () => {
    setLoading(true);
    try {
      const r = await mpApi.performance(planId);
      setPerf(r.data);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to load performance data");
    } finally { setLoading(false); }
  };

  if (!perf) {
    return (
      <Card className="border-border/40 bg-card/60">
        <CardContent className="p-8 text-center space-y-4">
          <Activity size={32} className="text-muted-foreground mx-auto" />
          <div>
            <p className="font-semibold text-foreground">Performance data not yet available</p>
            <p className="text-sm text-muted-foreground">Launch campaigns first, then sync live metrics</p>
          </div>
          <Button onClick={loadPerf} disabled={loading} className="gap-2">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {loading ? "Syncing…" : "Sync Live Data"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Last synced: {perf.synced_at ? new Date(perf.synced_at).toLocaleString() : "—"}</p>
        <Button size="sm" variant="outline" onClick={loadPerf} disabled={loading} className="gap-1.5">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Sync Live Data
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/40 text-muted-foreground text-xs">
              {["Platform","Budget Spent","Orders","ROAS","vs Target"].map(h => (
                <th key={h} className="text-left pb-3 pr-4 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(perf.platforms || []).map((p, i) => {
              const pi = pInfo(p.platform);
              const vsTarget = p.orders && p.orders_target
                ? ((p.orders / p.orders_target) * 100).toFixed(0) + "%"
                : "—";
              const onTrack = p.orders >= (p.orders_target * 0.85);
              return (
                <tr key={i} className="border-b border-border/20 hover:bg-muted/20 transition-colors">
                  <td className="py-3 pr-4">
                    <Badge variant="outline" className={`text-[11px] ${pi.bg}`}>{pi.label}</Badge>
                  </td>
                  <td className="py-3 pr-4">{inr(p.spend)}</td>
                  <td className="py-3 pr-4">{num(p.orders)}</td>
                  <td className="py-3 pr-4">{p.roas ? `${Number(p.roas).toFixed(2)}x` : "—"}</td>
                  <td className="py-3 pr-4">
                    <Badge variant="outline" className={onTrack
                      ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                      : "bg-red-500/15 text-red-400 border-red-500/30"}>
                      {vsTarget} {onTrack ? "✓" : "↓"}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════
export default function MediaPlanAutomation() {
  const [plan, setPlan]           = useState(null);   // parsed plan
  const [activation, setActivation] = useState(null); // activation result
  const [activeTab, setActiveTab] = useState("upload");

  const handleParsed = (data) => {
    setPlan(data);
    setActiveTab("preview");
  };

  const handleActivated = (data) => {
    setActivation(data);
    setActiveTab("execution");
  };

  const tabs = [
    { id: "upload",      label: "Upload",      icon: UploadCloud,    available: true },
    { id: "preview",     label: "Plan Preview", icon: Eye,           available: !!plan },
    { id: "execution",   label: "Execution",   icon: LayoutGrid,     available: !!activation },
    { id: "performance", label: "Performance", icon: TrendingUp,     available: !!activation },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-heading font-bold text-foreground flex items-center gap-3">
          <FileSpreadsheet size={26} className="text-primary" /> Media Plan Automation
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Upload your monthly marketing media plan — AI parses it and auto-executes every campaign, content task, and SEO action
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-muted/40 rounded-lg w-fit border border-border/40">
        {tabs.map(({ id, label, icon: Icon, available }) => (
          <button key={id} onClick={() => available && setActiveTab(id)} disabled={!available}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
              activeTab === id
                ? "bg-background text-foreground shadow-sm border border-border/40"
                : available
                  ? "text-muted-foreground hover:text-foreground"
                  : "text-muted-foreground/40 cursor-not-allowed"
            }`}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <AnimatePresence mode="wait">
        <motion.div key={activeTab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          {activeTab === "upload"     && <UploadZone onParsed={handleParsed} />}
          {activeTab === "preview"    && plan && <ParsedPlanPreview plan={plan} onActivate={handleActivated} />}
          {activeTab === "execution"  && activation && <ExecutionDashboard planId={plan?.plan_id} plan={plan} />}
          {activeTab === "performance"&& activation && <PerformanceTracker planId={plan?.plan_id} plan={plan} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
