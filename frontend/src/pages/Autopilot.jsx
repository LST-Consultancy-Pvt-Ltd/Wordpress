import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bot, Play, Loader2,
  RefreshCw, ChevronDown, ChevronUp, ExternalLink,
  Search, PenLine, TrendingUp, GitPullRequest,
  Settings2, CalendarDays, ZapOff, DollarSign, Zap
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Label } from "../components/ui/label";
import { Input } from "../components/ui/input";
import { Slider } from "../components/ui/slider";
import { Separator } from "../components/ui/separator";
import { toast } from "sonner";
import GatedButton from "../components/sa/GatedButton";
import StatusBadge from "../components/sa/StatusBadge";
import { useRole } from "../hooks/useRole";
import { openEventStream } from "../lib/stream";
import { writeBlockedReason } from "../lib/capabilities";
import {
  apiErrorMessage,
  listItems,
  getSites,
  autopilotGetSettings,
  autopilotSaveSettings,
  autopilotRunPipeline,
  autopilotGetHistory,
  autopilotGetJobs,
  getAutopilotTriggers,
  saveAutopilotTriggers,
} from "../lib/api";

// ─── Stage definitions ───────────────────────────────────────────
// The last stage proposes a draft `content.upsert` change set that waits for
// approval in Change Sets. The pipeline never applies anything itself.
const STAGES = [
  { id: "keyword_picking",  done: "keyword_picked",  label: "Keywords",   icon: Search,         short: "AI Keyword Picker" },
  { id: "content_writing",  done: "content_written", label: "Write",      icon: PenLine,        short: "AI Blog Writer"    },
  { id: "seo_optimizing",   done: "seo_optimized",   label: "SEO",        icon: TrendingUp,     short: "SEO Optimizer"     },
  { id: "proposing",        done: "completed",       label: "Change set", icon: GitPullRequest, short: "Draft change set"  },
];

// ─── Helpers ──────────────────────────────────────────────────────
const statusColor = {
  idle:    "text-muted-foreground bg-muted/30 border-border/30",
  running: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30",
  done:    "text-emerald-400 bg-emerald-400/10 border-emerald-400/30",
  failed:  "text-red-400 bg-red-400/10 border-red-400/30",
  skipped: "text-muted-foreground bg-muted/20 border-border/30",
};
const logColor = { done: "text-emerald-400", failed: "text-red-400", running: "text-yellow-400" };

function countdownStr(isoDate) {
  if (!isoDate) return null;
  const diff = new Date(isoDate) - Date.now();
  if (diff <= 0) return "Now";
  const days  = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins  = Math.floor((diff % 3600000)  / 60000);
  const parts = [];
  if (days)  parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins)  parts.push(`${mins}m`);
  return parts.join(" ");
}

const SEO_COLOR = (s) =>
  s >= 80 ? "text-emerald-400" : s >= 60 ? "text-yellow-400" : "text-red-400";

function buildSummary(stageId, data) {
  if (!data) return null;
  if (stageId === "keyword_picking") return data.keyword ? `"${data.keyword}" · ${data.estimated_difficulty || ""} difficulty` : null;
  if (stageId === "content_writing") return data.estimated_word_count ? `~${data.estimated_word_count} words written` : null;
  if (stageId === "seo_optimizing") return data.seo_score != null ? `SEO score: ${data.seo_score}/100` : null;
  if (stageId === "proposing") return data.changeset_id ? "Draft change set pending approval" : null;
  return null;
}

function rowDate(row) {
  const v = row.created_at || row.completed_at;
  return v ? new Date(v).toLocaleDateString() : "—";
}

// ─── Stage Card ───────────────────────────────────────────────────
function StageCard({ stage, stageStatus, summary }) {
  const Icon = stage.icon;
  const cls = statusColor[stageStatus] || statusColor.idle;
  const isRunning = stageStatus === "running";
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex flex-col items-center gap-2 px-4 py-3 rounded-xl border ${cls} transition-all duration-300 min-w-0 flex-1`}
    >
      <div className="relative">
        <Icon size={20} aria-hidden="true" />
        {isRunning && (
          <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-yellow-400 rounded-full animate-pulse" />
        )}
      </div>
      <span className="text-xs font-semibold whitespace-nowrap">{stage.label}</span>
      <Badge variant="outline" className={`text-[10px] capitalize ${cls}`}>{stageStatus}</Badge>
      {summary && <p className="text-[10px] text-center leading-tight opacity-80 max-w-[110px]">{summary}</p>}
    </motion.div>
  );
}

// ─── Log line ─────────────────────────────────────────────────────
function LogLine({ entry }) {
  const col = logColor[entry.status] || "text-muted-foreground";
  return (
    <div className="flex items-start gap-2 text-xs font-mono">
      <span className="text-muted-foreground/60 shrink-0">{entry.time}</span>
      <span className={`shrink-0 uppercase text-[10px] font-bold ${col}`}>[{entry.stage}]</span>
      <span className="break-all">{entry.message}</span>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────
export default function Autopilot() {
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState("");
  const [settings, setSettings] = useState(null);
  const [localSettings, setLocalSettings] = useState(null);  // form state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  // Pipeline state
  const [stageStatuses, setStageStatuses] = useState({});        // { stage_id: "idle"|"running"|"done"|"failed"|"skipped" }
  const [stageSummaries, setStageSummaries] = useState({});      // { stage_id: "summary text" }
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState([]);
  const [countdown, setCountdown] = useState(null);
  const [lastChangesetId, setLastChangesetId] = useState(null);

  // Event triggers
  const [localTriggers, setLocalTriggers] = useState(null);
  const [savingTriggers, setSavingTriggers] = useState(false);

  // History table
  const [history, setHistory] = useState([]);
  const [histTotal, setHistTotal] = useState(0);
  const [histPage, setHistPage] = useState(1);
  const [histLoading, setHistLoading] = useState(false);

  const { can } = useRole();
  const canEdit = can("editor");
  const site = sites.find((s) => s.id === siteId) || null;
  const runBlocked = writeBlockedReason(site, "content.write");

  const logEndRef = useRef(null);

  // ── Load sites ──
  useEffect(() => {
    getSites().then((r) => {
      const list = listItems(r.data);
      setSites(list);
      if (list.length > 0) setSiteId(list[0].id);
    }).catch(() => {});
  }, []);

  const addLog = useCallback((stage, status, message, ts = null) => {
    const time = ts
      ? new Date(ts).toLocaleTimeString()
      : new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-199), { time, stage, status, message }]);
  }, []);

  const loadTriggers = useCallback(async () => {
    try {
      const r = await getAutopilotTriggers(siteId);
      setLocalTriggers({ ...r.data });
    } catch {
      setLocalTriggers({ rank_drop_enabled: false, rank_drop_threshold: 5, new_keyword_enabled: false });
    }
  }, [siteId]);

  const loadSettings = useCallback(async () => {
    try {
      const r = await autopilotGetSettings(siteId);
      setSettings(r.data);
      setLocalSettings({ ...r.data });
    } catch { /* ignore */ }
  }, [siteId]);

  const loadHistory = useCallback(async (page) => {
    setHistLoading(true);
    try {
      const r = await autopilotGetHistory(siteId, page);
      setHistory(r.data?.items || []);
      setHistTotal(r.data?.total || 0);
      setHistPage(page);
    } catch { /* ignore */ }
    finally { setHistLoading(false); }
  }, [siteId]);

  const loadJobs = useCallback(async () => {
    try {
      const r = await autopilotGetJobs(siteId);
      const latest = listItems(r.data)[0];
      if (!latest) return;
      if (latest.changeset_id) setLastChangesetId(latest.changeset_id);
      // Restore stage statuses from a run that is still in flight
      const statusMap = {
        keyword_picked: { keyword_picking: "done" },
        content_written: { keyword_picking: "done", content_writing: "done" },
        seo_optimized: { keyword_picking: "done", content_writing: "done", seo_optimizing: "done" },
      };
      if (statusMap[latest.status]) setStageStatuses(statusMap[latest.status]);
    } catch { /* ignore */ }
  }, [siteId]);

  // ── Load settings when site changes ──
  useEffect(() => {
    if (!siteId) return;
    setLastChangesetId(null);
    setStageStatuses({});
    setStageSummaries({});
    loadSettings();
    loadHistory(1);
    loadJobs();
    loadTriggers();
  }, [siteId, loadSettings, loadHistory, loadJobs, loadTriggers]);

  // ── Countdown tick ──
  useEffect(() => {
    const interval = setInterval(() => {
      if (settings?.next_run_at) setCountdown(countdownStr(settings.next_run_at));
    }, 30000);
    if (settings?.next_run_at) setCountdown(countdownStr(settings.next_run_at));
    return () => clearInterval(interval);
  }, [settings?.next_run_at]);

  // ── Auto-scroll log ──
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // ── Live stream (short-lived stream token; the session token never goes in a URL) ──
  const handleStreamMessage = useCallback((ev) => {
    let payload;
    try { payload = JSON.parse(ev.data); } catch { return; }
    const { stage, status, data: d, timestamp } = payload || {};
    if (!stage || stage === "connected") return;
    if (stage === "pipeline_complete") {
      setIsRunning(false);
      setStageStatuses((prev) => ({ ...prev, proposing: "done" }));
      if (d?.changeset_id) setLastChangesetId(d.changeset_id);
      const titlePart = d?.title ? ` for "${d.title}"` : "";
      const seoPart = d?.seo_score != null ? ` · SEO: ${d.seo_score}%` : "";
      addLog("pipeline", "done", `Draft change set created${titlePart}${seoPart} — pending approval in Change Sets`);
      toast.success("Change set created", { description: "Review and approve it in Change Sets." });
      loadHistory(1);
      loadSettings();
      return;
    }
    const matchStage = STAGES.find((s) => s.id === stage || s.done === stage);
    if (!matchStage) return;
    const stageId = matchStage.id;
    setStageStatuses((prev) => ({ ...prev, [stageId]: status }));
    if (status === "done" && d) {
      if (d.changeset_id) setLastChangesetId(d.changeset_id);
      const sum = buildSummary(stageId, d);
      if (sum) setStageSummaries((prev) => ({ ...prev, [stageId]: sum }));
    }
    const msg = status === "done"
      ? (buildSummary(stageId, d) || "Completed")
      : status === "failed"
      ? (d?.error || "Failed")
      : status === "skipped"
      ? (d?.reason || "Skipped")
      : "Running…";
    addLog(matchStage.label, status, msg, timestamp);
    if (status === "failed") {
      setIsRunning(false);
      toast.error(`Autopilot failed at "${matchStage.label}" stage`);
    }
  }, [addLog, loadHistory, loadSettings]);

  useEffect(() => {
    if (!siteId) return undefined;
    let source = null;
    let cancelled = false;
    openEventStream(`/autopilot/${siteId}/stream`, { task_id: `autopilot:${siteId}` })
      .then((es) => {
        if (cancelled) { es.close(); return; }
        source = es;
        es.onmessage = handleStreamMessage;
        es.onerror = () => { /* EventSource auto-reconnects */ };
      })
      .catch(() => {
        if (!cancelled) addLog("system", "failed", "Could not open the live activity stream");
      });
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [siteId, handleStreamMessage, addLog]);

  const handleSaveTriggers = async () => {
    setSavingTriggers(true);
    try {
      const r = await saveAutopilotTriggers(siteId, localTriggers);
      setLocalTriggers({ ...r.data });
      toast.success("Event triggers saved");
    } catch { toast.error("Failed to save triggers"); }
    finally { setSavingTriggers(false); }
  };

  const handleToggleAutopilot = async (val) => {
    try {
      const r = await autopilotSaveSettings(siteId, { enabled: val });
      setSettings(r.data);
      setLocalSettings({ ...r.data });
      toast.success(val ? "Autopilot enabled" : "Autopilot disabled");
    } catch { toast.error("Failed to update autopilot"); }
  };

  const handleRunNow = async () => {
    if (isRunning) return;
    setIsRunning(true);
    setStageStatuses({});
    setStageSummaries({});
    setLogs([]);
    addLog("system", "running", "Manual run triggered…");
    try {
      const r = await autopilotRunPipeline(siteId);
      addLog("system", "running", `Job ${r.data?.job_id || ""} started`);
    } catch (e) {
      setIsRunning(false);
      toast.error(apiErrorMessage(e, "Failed to start pipeline"));
      addLog("system", "failed", "Could not start pipeline");
    }
  };

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      const r = await autopilotSaveSettings(siteId, {
        posting_frequency: localSettings.posting_frequency,
        tone: localSettings.tone,
        word_count_target: localSettings.word_count_target,
      });
      setSettings(r.data);
      setLocalSettings({ ...r.data });
      toast.success("Settings saved");
      setSettingsOpen(false);
    } catch { toast.error("Failed to save settings"); }
    finally { setSavingSettings(false); }
  };

  if (!siteId) return (
    <div className="page-container flex items-center justify-center h-64 text-muted-foreground">
      <Loader2 size={24} className="animate-spin mr-2" /> Loading…
    </div>
  );

  const totalPages = Math.ceil(histTotal / 10);

  return (
    <div className="page-container space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
            Autopilot Engine
          </motion.h1>
          <p className="page-description">
            Keyword → write → SEO → draft change set. Every article is proposed as a change set that waits for approval — nothing goes live automatically.
          </p>
        </div>
        <Select value={siteId} onValueChange={setSiteId}>
          <SelectTrigger className="w-44" aria-label="Site"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {/* ── Control Card ── */}
      <Card className="content-card border-primary/20">
        <CardContent className="pt-5 pb-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 justify-between mb-5">
            {/* Toggle */}
            <div className="flex items-center gap-3">
              <Switch
                checked={settings?.enabled ?? false}
                onCheckedChange={handleToggleAutopilot}
                disabled={!canEdit}
                aria-label="Scheduled autopilot runs"
                title={canEdit ? undefined : "Requires the Editor role"}
                className="data-[state=checked]:bg-emerald-500"
              />
              <div>
                <span className="font-semibold text-sm">
                  {settings?.enabled ? "Autopilot ON" : "Autopilot OFF"}
                </span>
                {settings?.enabled && countdown && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                    <CalendarDays size={11} aria-hidden="true" /> Next run in {countdown}
                  </p>
                )}
                {!settings?.enabled && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Toggle on to run on a schedule (each run proposes a draft change set)
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {lastChangesetId && (
                <Button asChild variant="outline" size="sm">
                  <Link to={`/changesets/${lastChangesetId}`}>
                    <GitPullRequest size={14} className="mr-2" aria-hidden="true" />Review change set
                  </Link>
                </Button>
              )}
              <GatedButton
                minRole="editor"
                blocked={runBlocked}
                className="btn-primary"
                onClick={handleRunNow}
                disabled={isRunning}
              >
                {isRunning
                  ? <><Loader2 size={14} className="mr-2 animate-spin" />Running…</>
                  : <><Play size={14} className="mr-2" />Run Now</>}
              </GatedButton>
            </div>
          </div>

          {/* Pipeline stage cards */}
          <div className="flex gap-2 flex-wrap sm:flex-nowrap">
            {STAGES.map((stage) => (
              <StageCard
                key={stage.id}
                stage={stage}
                stageStatus={stageStatuses[stage.id] || "idle"}
                summary={stageSummaries[stage.id]}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Live Log ── */}
      <Card className="content-card">
        <CardHeader className="pb-2">
          <CardTitle className="font-heading text-sm flex items-center gap-2">
            <Bot size={14} className="text-primary" /> Live Activity Log
            <Badge variant="secondary" className="ml-auto text-xs">{logs.length} events</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="bg-black/40 rounded-lg border border-border/20 p-3 h-44 overflow-y-auto space-y-1 font-mono" role="log" aria-live="polite">
            {logs.length === 0 ? (
              <p className="text-xs text-muted-foreground/50 italic">Waiting for pipeline events…</p>
            ) : (
              logs.map((entry, i) => <LogLine key={i} entry={entry} />)
            )}
            <div ref={logEndRef} />
          </div>
        </CardContent>
      </Card>

      {/* ── Settings Panel ── */}
      <Card className="content-card">
        <CardHeader className="pb-2">
          <CardTitle className="font-heading text-sm">
            <button
              type="button"
              className="flex items-center gap-2 w-full text-left"
              onClick={() => setSettingsOpen((p) => !p)}
              aria-expanded={settingsOpen}
            >
              <Settings2 size={14} className="text-primary" /> Autopilot Settings
              {settingsOpen ? <ChevronUp size={14} className="ml-auto" /> : <ChevronDown size={14} className="ml-auto" />}
            </button>
          </CardTitle>
        </CardHeader>
        <AnimatePresence>
          {settingsOpen && localSettings && (
            <motion.div key="settings" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <CardContent className="pb-5 space-y-5">
                <Separator className="mb-4" />

                {/* Run frequency */}
                <div>
                  <Label className="text-sm font-medium mb-2 block">Run Frequency</Label>
                  <div className="flex gap-2 flex-wrap">
                    {[
                      { val: "daily",   label: "Daily" },
                      { val: "3x_week", label: "3× Week" },
                      { val: "weekly",  label: "Weekly" },
                    ].map((opt) => (
                      <button
                        key={opt.val}
                        type="button"
                        aria-pressed={localSettings.posting_frequency === opt.val}
                        onClick={() => setLocalSettings((p) => ({ ...p, posting_frequency: opt.val }))}
                        className={`px-4 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                          localSettings.posting_frequency === opt.val
                            ? "bg-primary text-white border-primary"
                            : "border-border/40 text-muted-foreground hover:border-primary/50"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Tone */}
                <div>
                  <Label className="text-sm font-medium mb-2 block">Writing Tone</Label>
                  <Select value={localSettings.tone || "professional"} onValueChange={(v) => setLocalSettings((p) => ({ ...p, tone: v }))}>
                    <SelectTrigger className="w-52" aria-label="Writing tone"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="professional">Professional</SelectItem>
                      <SelectItem value="conversational">Conversational</SelectItem>
                      <SelectItem value="technical">Technical</SelectItem>
                      <SelectItem value="persuasive">Persuasive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Word count slider */}
                <div>
                  <Label className="text-sm font-medium mb-2 block">
                    Target Word Count: <span className="text-primary">{localSettings.word_count_target || 1200}</span>
                  </Label>
                  <Slider
                    min={800} max={2000} step={200}
                    value={[localSettings.word_count_target || 1200]}
                    onValueChange={([v]) => setLocalSettings((p) => ({ ...p, word_count_target: v }))}
                    className="w-full max-w-xs"
                    aria-label="Target word count"
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground max-w-xs mt-1">
                    <span>800</span><span>1200</span><span>1600</span><span>2000</span>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground max-w-md">
                  Each run creates a draft content change set that stays pending approval. Review, validate and apply it in Change Sets.
                </p>

                <GatedButton minRole="editor" className="btn-primary" onClick={handleSaveSettings} disabled={savingSettings}>
                  {savingSettings ? <><Loader2 size={14} className="mr-2 animate-spin" />Saving…</> : "Save Settings"}
                </GatedButton>
              </CardContent>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>

      {/* ── Event Triggers ── */}
      <Card className="content-card">
        <CardHeader className="pb-2">
          <CardTitle className="font-heading text-sm flex items-center gap-2">
            <Zap size={14} className="text-primary" /> Event Triggers
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {localTriggers && (
            <>
              <div className="flex items-center justify-between max-w-md">
                <div>
                  <p className="text-sm font-medium">Rank Drop Alert</p>
                  <p className="text-xs text-muted-foreground">Propose a content refresh change set when rank drops</p>
                </div>
                <Switch
                  aria-label="Rank drop alert"
                  checked={localTriggers.rank_drop_enabled ?? false}
                  onCheckedChange={(v) => setLocalTriggers((p) => ({ ...p, rank_drop_enabled: v }))}
                  className="data-[state=checked]:bg-emerald-500"
                />
              </div>
              {localTriggers.rank_drop_enabled && (
                <div className="flex items-center gap-3 max-w-md pl-4">
                  <Label htmlFor="ap-rank-threshold" className="text-xs text-muted-foreground whitespace-nowrap">Drop threshold (positions):</Label>
                  <Input
                    id="ap-rank-threshold"
                    type="number"
                    min={1}
                    max={50}
                    className="w-20 h-8 text-sm"
                    value={localTriggers.rank_drop_threshold ?? 5}
                    onChange={(e) => setLocalTriggers((p) => ({ ...p, rank_drop_threshold: parseInt(e.target.value, 10) || 5 }))}
                  />
                </div>
              )}
              <Separator />
              <div className="flex items-center justify-between max-w-md">
                <div>
                  <p className="text-sm font-medium">New Keyword Discovery</p>
                  <p className="text-xs text-muted-foreground">Propose a draft article change set when a new keyword opportunity is found</p>
                </div>
                <Switch
                  aria-label="New keyword discovery"
                  checked={localTriggers.new_keyword_enabled ?? false}
                  onCheckedChange={(v) => setLocalTriggers((p) => ({ ...p, new_keyword_enabled: v }))}
                  className="data-[state=checked]:bg-emerald-500"
                />
              </div>
              <GatedButton minRole="editor" className="btn-primary" size="sm" onClick={handleSaveTriggers} disabled={savingTriggers}>
                {savingTriggers ? <><Loader2 size={14} className="mr-2 animate-spin" />Saving…</> : "Save Triggers"}
              </GatedButton>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── History Table ── */}
      <Card className="content-card">
        <CardHeader className="pb-2">
          <CardTitle className="font-heading text-sm flex items-center gap-2">
            <RefreshCw size={14} className="text-primary" /> Proposed Articles
            <Badge variant="secondary" className="ml-auto">{histTotal} total</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {histLoading ? (
            <div className="flex justify-center py-8"><Loader2 size={24} className="animate-spin text-primary" /></div>
          ) : history.length === 0 ? (
            <div className="flex flex-col items-center py-8 text-muted-foreground">
              <ZapOff size={32} className="mb-2 opacity-30" />
              <p className="text-sm">No articles proposed yet. Run the pipeline to create your first draft change set.</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/30 text-xs text-muted-foreground">
                      <th className="text-left py-2 pr-4 font-medium">Date</th>
                      <th className="text-left py-2 pr-4 font-medium">Title</th>
                      <th className="text-left py-2 pr-4 font-medium">Keyword</th>
                      <th className="text-right py-2 pr-4 font-medium">SEO</th>
                      <th className="text-right py-2 pr-4 font-medium">Words</th>
                      <th className="text-right py-2 pr-4 font-medium"><DollarSign size={11} className="inline mr-0.5" />Cost</th>
                      <th className="text-left py-2 font-medium">Change set</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((row, i) => (
                      <tr key={row.id || i} className="border-b border-border/10 hover:bg-muted/10 transition-colors">
                        <td className="py-2 pr-4 text-xs text-muted-foreground whitespace-nowrap">{rowDate(row)}</td>
                        <td className="py-2 pr-4 max-w-[180px]">
                          {row.changeset_id ? (
                            <Link
                              to={`/changesets/${row.changeset_id}`}
                              className="hover:text-primary flex items-center gap-1 truncate"
                            >
                              <span className="truncate">{row.title || "Untitled"}</span>
                              <ExternalLink size={10} className="shrink-0" aria-hidden="true" />
                            </Link>
                          ) : (
                            <span className="truncate block">{row.title || "Untitled"}</span>
                          )}
                        </td>
                        <td className="py-2 pr-4 text-xs">
                          <Badge variant="secondary" className="text-[10px]">{row.keyword}</Badge>
                        </td>
                        <td className={`py-2 pr-4 text-right font-bold text-sm ${SEO_COLOR(row.seo_score)}`}>
                          {row.seo_score ?? "—"}
                        </td>
                        <td className="py-2 pr-4 text-right text-xs text-muted-foreground">
                          {row.word_count?.toLocaleString() || "—"}
                        </td>
                        <td className="py-2 pr-4 text-right text-xs text-muted-foreground">
                          {row.token_usage?.estimated_cost_usd != null
                            ? `$${row.token_usage.estimated_cost_usd.toFixed(4)}`
                            : "—"}
                        </td>
                        <td className="py-2">
                          {row.changeset_id ? (
                            <Link to={`/changesets/${row.changeset_id}`} aria-label={`Open change set for ${row.title || "article"}`}>
                              <StatusBadge status={row.changeset_status || "pending_approval"} className="text-[10px]" />
                            </Link>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {histTotal > 10 && (
                <div className="flex items-center justify-between mt-4 text-xs text-muted-foreground">
                  <span>Page {histPage} of {totalPages}</span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="h-7 text-xs"
                      disabled={histPage <= 1} onClick={() => loadHistory(histPage - 1)}>
                      Previous
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs"
                      disabled={histPage >= totalPages} onClick={() => loadHistory(histPage + 1)}>
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
