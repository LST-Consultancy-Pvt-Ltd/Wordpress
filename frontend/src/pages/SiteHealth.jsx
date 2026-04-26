import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { HeartPulse, RefreshCw, Loader2, CheckCircle, AlertTriangle, XCircle, Shield, Clock, Server, Wrench, Globe } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Progress } from "../components/ui/progress";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import { ScrollArea } from "../components/ui/scroll-area";
import { getSites, getHealthData, runHealthCheck, getHealthFix, multiRegionUptimeCheck } from "../lib/api";
import { toast } from "sonner";

const SEVERITY_CONFIG = {
  good: { icon: CheckCircle, color: "text-emerald-500", bg: "bg-emerald-500/10", border: "border-emerald-500/30" },
  warning: { icon: AlertTriangle, color: "text-yellow-500", bg: "bg-yellow-500/10", border: "border-yellow-500/30" },
  critical: { icon: XCircle, color: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/30" },
  info: { icon: Shield, color: "text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500/30" },
};

export default function SiteHealth() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [fixingKey, setFixingKey] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyData, setHistoryData] = useState([]);
  const [multiRegionLoading, setMultiRegionLoading] = useState(false);
  const [multiRegionResults, setMultiRegionResults] = useState(null);

  useEffect(() => { loadSites(); }, []);
  useEffect(() => { if (selectedSite) loadHealth(); }, [selectedSite]);

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data || []);
      if (r.data?.length) setSelectedSite(r.data[0].id);
    } catch { }
  };

  const loadHealth = async () => {
    setLoading(true);
    try {
      const r = await getHealthData(selectedSite);
      setHealth(r.data);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to load health data");
    } finally { setLoading(false); }
  };

  const handleCheck = async () => {
    setChecking(true);
    try {
      const r = await runHealthCheck(selectedSite);
      setHealth(r.data);
      toast.success("Health check complete");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Health check failed");
    } finally { setChecking(false); }
  };

  const handleFix = async (issueKey, issueLabel) => {
    setFixingKey(issueKey);
    try {
      const r = await getHealthFix(selectedSite, issueKey);
      toast.success(`Fixed: ${issueLabel}`);
      loadHealth();
    } catch (err) {
      toast.error(err.response?.data?.detail || `Could not auto-fix: ${issueLabel}`);
    } finally { setFixingKey(null); }
  };

  const sslDays = health?.ssl_expiry_days ?? null;
  const sslColor = sslDays === null ? "text-muted-foreground" : sslDays < 14 ? "text-red-400" : sslDays < 30 ? "text-yellow-500" : "text-emerald-500";

  const issues = Array.isArray(health?.issues) ? health.issues : [];
  const criticalCount = issues.filter(i => i.severity === "critical").length;
  const warningCount = issues.filter(i => i.severity === "warning").length;
  const goodCount = issues.filter(i => i.severity === "good").length;
  const healthScore = issues.length === 0 ? 100 : Math.max(0, Math.round(((goodCount) / issues.length) * 100));

  return (
    <div className="page-container">
      <div className="mb-8">
        <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          Site Health
        </motion.h1>
        <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
          Monitor uptime, performance, SSL and WordPress health checks
        </motion.p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
        <Button onClick={loadHealth} variant="outline" size="sm" disabled={!selectedSite}>
          <RefreshCw size={14} className="mr-2" />Refresh
        </Button>
        <Button onClick={handleCheck} disabled={!selectedSite || checking} size="sm">
          {checking ? <Loader2 size={14} className="animate-spin mr-2" /> : <HeartPulse size={14} className="mr-2" />}
          Run Check
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-primary" /></div>
      ) : !health ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Select a site to view health data</div>
      ) : (
        <>
          {/* Score + stat cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <Card className="stat-card col-span-1">
              <div className="relative w-16 h-16 mx-auto mb-2">
                <svg className="w-16 h-16 -rotate-90" viewBox="0 0 64 64">
                  <circle cx="32" cy="32" r="26" fill="none" stroke="currentColor" strokeWidth="6" className="text-border" />
                  <circle cx="32" cy="32" r="26" fill="none" strokeWidth="6"
                    className={criticalCount > 0 ? "text-red-400" : warningCount > 0 ? "text-yellow-500" : "text-emerald-500"}
                    strokeDasharray={`${(healthScore / 100) * 163.4} 163.4`}
                    strokeLinecap="round" stroke="currentColor" />
                </svg>
                <span className={`absolute inset-0 flex items-center justify-center text-lg font-bold ${criticalCount > 0 ? "text-red-400" : warningCount > 0 ? "text-yellow-500" : "text-emerald-500"}`}>
                  {healthScore}
                </span>
              </div>
              <p className="stat-label">Health Score</p>
            </Card>

            <Card className="stat-card">
              <Server size={16} className={`mb-1 ${health.online ? "text-emerald-500" : "text-red-400"}`} />
              <p className={`stat-value ${health.online ? "text-emerald-500" : "text-red-400"}`}>{health.online ? "Online" : "Down"}</p>
              <p className="stat-label">Status</p>
            </Card>

            <Card className="stat-card">
              <Clock size={16} className="text-primary mb-1" />
              <p className="stat-value">{health.response_time_ms ? `${health.response_time_ms}ms` : "—"}</p>
              <p className="stat-label">Response Time</p>
            </Card>

            <Card className="stat-card">
              <Shield size={16} className={`mb-1 ${sslColor}`} />
              <p className={`stat-value ${sslColor}`}>{sslDays !== null ? `${sslDays}d` : "—"}</p>
              <p className="stat-label">SSL Expires</p>
            </Card>
          </div>

          {/* More details row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            {[
              { label: "WordPress", value: health.wp_version || "—" },
              { label: "PHP", value: health.php_version || "—" },
              { label: "Critical Issues", value: criticalCount, color: criticalCount > 0 ? "text-red-400" : "" },
              { label: "Warnings", value: warningCount, color: warningCount > 0 ? "text-yellow-500" : "" },
            ].map(s => (
              <Card key={s.label} className="stat-card">
                <p className={`stat-value ${s.color || ""}`}>{s.value}</p>
                <p className="stat-label">{s.label}</p>
              </Card>
            ))}
          </div>

          {/* Health score bar */}
          <Card className="content-card mb-6">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Overall Health</span>
                <span className={`text-sm font-bold ${criticalCount > 0 ? "text-red-400" : warningCount > 0 ? "text-yellow-500" : "text-emerald-500"}`}>
                  {criticalCount > 0 ? "Needs Attention" : warningCount > 0 ? "Fair" : "Good"}
                </span>
              </div>
              <Progress value={healthScore} className="h-2" />
              <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
                <span className="text-emerald-500">{goodCount} passed</span>
                <span className="text-yellow-500">{warningCount} warnings</span>
                <span className="text-red-400">{criticalCount} critical</span>
              </div>
            </CardContent>
          </Card>

          {/* Issues list */}
          <Card className="content-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Health Checks ({issues.length})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {issues.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  {health ? "All checks passed — your site is healthy!" : "Run a check to see results"}
                </div>
              ) : (
                <ScrollArea className="max-h-[500px]">
                  <div className="divide-y divide-border/30">
                    {issues.map((issue, i) => {
                      const cfg = SEVERITY_CONFIG[issue.severity] || SEVERITY_CONFIG.info;
                      const Icon = cfg.icon;
                      return (
                        <div key={i} className={`p-4 flex items-start gap-3 ${cfg.bg}`}>
                          <Icon size={16} className={`${cfg.color} flex-shrink-0 mt-0.5`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="font-medium text-sm">{issue.label || issue.test || "Issue"}</span>
                              <Badge variant="outline" className={`text-xs ${cfg.border} ${cfg.color}`}>{issue.severity}</Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">{issue.description || issue.details || ""}</p>
                            {issue.actions?.length > 0 && (
                              <p className="text-xs text-muted-foreground mt-1">Action: {issue.actions[0]?.label || issue.actions[0]}</p>
                            )}
                          </div>
                          {issue.auto_fix && issue.key && (
                            <Button variant="outline" size="sm" className="h-6 text-xs flex-shrink-0"
                              disabled={fixingKey === issue.key}
                              onClick={() => handleFix(issue.key, issue.label || issue.key)}>
                              {fixingKey === issue.key ? <Loader2 size={10} className="animate-spin mr-1" /> : <Wrench size={10} className="mr-1" />}
                              Fix
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>

          {/* Multi-Region Availability */}
          <Card className="content-card">
            <CardHeader>
              <CardTitle className="font-heading text-sm flex items-center justify-between">
                <span className="flex items-center gap-2"><Globe size={16} className="text-primary" /> Global Availability Check</span>
                <Button onClick={async () => {
                  setMultiRegionLoading(true);
                  try {
                    const r = await multiRegionUptimeCheck(selectedSite);
                    setMultiRegionResults(r.data?.regions || r.data || []);
                  } catch (e) { toast.error(e.response?.data?.detail || "Multi-region check failed"); }
                  finally { setMultiRegionLoading(false); }
                }} disabled={multiRegionLoading || !selectedSite} size="sm">
                  {multiRegionLoading ? <><Loader2 size={14} className="mr-2 animate-spin" /> Checking...</> : <><Globe size={14} className="mr-2" /> Run Multi-Region Check</>}
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {multiRegionLoading ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  <Loader2 size={24} className="animate-spin mx-auto mb-2 text-primary" />
                  Checking from multiple regions...
                </div>
              ) : !multiRegionResults ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  Click "Run Multi-Region Check" to test your site's availability worldwide
                </div>
              ) : (
                <div className="space-y-4">
                  {(() => {
                    const regions = Array.isArray(multiRegionResults) ? multiRegionResults : [];
                    const onlineCount = regions.filter(r => r.online || r.status === "online" || (r.http_status >= 200 && r.http_status < 400)).length;
                    const avgLatency = regions.length > 0 ? Math.round(regions.reduce((s, r) => s + (r.latency_ms || r.latency || 0), 0) / regions.length) : 0;
                    const allOnline = onlineCount === regions.length;
                    return (
                      <>
                        {allOnline ? (
                          <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 text-emerald-500 text-sm">
                            <CheckCircle size={16} /> Site is globally available
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
                            <AlertTriangle size={16} /> Issues detected in {regions.length - onlineCount} region(s)
                          </div>
                        )}
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                          {regions.map((r, i) => {
                            const isOnline = r.online || r.status === "online" || (r.http_status >= 200 && r.http_status < 400);
                            return (
                              <Card key={i} className={`border ${isOnline ? "border-emerald-500/30" : "border-red-500/30"}`}>
                                <CardContent className="p-3 space-y-1">
                                  <div className="flex items-center gap-2">
                                    <span className={`w-2.5 h-2.5 rounded-full ${isOnline ? "bg-emerald-500" : "bg-red-500"}`} />
                                    <span className="text-sm font-medium">{r.region || r.name}</span>
                                  </div>
                                  <div className="text-xs text-muted-foreground space-y-0.5">
                                    <p>Latency: <span className="font-mono">{r.latency_ms || r.latency || 0}ms</span></p>
                                    <p>HTTP: <span className="font-mono">{r.http_status || r.status_code || "—"}</span></p>
                                  </div>
                                </CardContent>
                              </Card>
                            );
                          })}
                        </div>
                        <p className="text-xs text-muted-foreground text-center">
                          {onlineCount}/{regions.length} regions online — Avg latency: {avgLatency}ms
                        </p>
                      </>
                    );
                  })()}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
