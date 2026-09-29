import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import {
  Globe,
  FileText,
  Sparkles,
  Activity,
  TrendingUp,
  Clock,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Zap,
  Loader2,
  GitPullRequest,
  ShieldCheck,
  Lock,
  Plug,
  XCircle,
  CalendarClock,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { ScrollArea } from "../components/ui/scroll-area";
import { getDashboardStats, getSites, listAllChangeSets, listItems, apiErrorMessage } from "../lib/api";
import { formatDate } from "../lib/changesets";
import StatusBadge, { ConnectionBadge, EnvironmentBadge, ToneBadge } from "../components/sa/StatusBadge";
import { toast } from "sonner";

const StatCard = ({ icon: Icon, value, label, trend, color = "primary", testId }) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.3 }}
  >
    <Card className="stat-card" data-testid={testId}>
      <div className="flex items-start justify-between">
        <div>
          <p className="stat-value">{value}</p>
          <p className="stat-label">{label}</p>
        </div>
        <div className={`w-10 h-10 rounded-lg bg-${color}/10 flex items-center justify-center`}>
          <Icon size={20} className={`text-${color}`} style={{ color: color === "primary" ? "hsl(var(--primary))" : color }} aria-hidden="true" />
        </div>
      </div>
      {trend && (
        <div className="flex items-center gap-1 mt-3 text-xs text-emerald-500">
          <TrendingUp size={12} aria-hidden="true" />
          <span>{trend}</span>
        </div>
      )}
    </Card>
  </motion.div>
);

const ActivityItem = ({ log }) => {
  const getStatusIcon = () => {
    switch (log.status) {
      case "success":
        return <CheckCircle2 size={14} className="text-emerald-500" aria-label="Succeeded" />;
      case "error":
        return <AlertCircle size={14} className="text-red-500" aria-label="Failed" />;
      default:
        return <Clock size={14} className="text-yellow-500" aria-label="Pending" />;
    }
  };

  return (
    <div className="flex items-start gap-3 py-3 border-b border-border/30 last:border-0">
      {getStatusIcon()}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{log.action}</p>
        <p className="text-xs text-muted-foreground truncate">{log.details}</p>
      </div>
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {formatDate(log.created_at)}
      </span>
    </div>
  );
};

const EMPTY_STATS = {
  total_sites: 0,
  connected_sites: 0,
  write_enabled_sites: 0,
  content_items: 0,
  changesets_pending_approval: 0,
  changesets_failed: 0,
  ai_commands_executed: 0,
  scheduled_jobs: 0,
  recent_activity: [],
  sites: [],
};

export default function Dashboard() {
  const [stats, setStats] = useState(EMPTY_STATS);
  const [sites, setSites] = useState([]);
  const [loadingSites, setLoadingSites] = useState(true);
  const [pending, setPending] = useState([]);
  const [loadingPending, setLoadingPending] = useState(true);
  const [pendingError, setPendingError] = useState("");

  const loadStats = useCallback(async () => {
    try {
      const response = await getDashboardStats();
      setStats({ ...EMPTY_STATS, ...(response.data || {}) });
    } catch (error) {
      toast.error("Failed to load dashboard stats");
    }
  }, []);

  const loadSites = useCallback(async () => {
    setLoadingSites(true);
    try {
      const r = await getSites();
      setSites(listItems(r.data));
    } catch {
      setSites([]);
    } finally {
      setLoadingSites(false);
    }
  }, []);

  const loadPending = useCallback(async () => {
    setLoadingPending(true);
    setPendingError("");
    try {
      const r = await listAllChangeSets({ status: "pending_approval" });
      setPending(listItems(r.data));
    } catch (err) {
      setPending([]);
      setPendingError(apiErrorMessage(err, "Could not load change sets"));
    } finally {
      setLoadingPending(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
    loadSites();
    loadPending();
  }, [loadStats, loadSites, loadPending]);

  const siteName = (id) => sites.find((s) => s.id === id)?.name || id;
  const recentActivity = Array.isArray(stats.recent_activity) ? stats.recent_activity : [];

  return (
    <div className="page-container" data-testid="dashboard-page">
      {/* Header */}
      <div className="mb-8">
        <motion.h1
          className="page-title"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          Dashboard
        </motion.h1>
        <motion.p
          className="page-description"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
        >
          Overview of your connected Next.js sites, pending change sets and recent activity
        </motion.p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 mb-8">
        <StatCard
          icon={Globe}
          value={`${stats.connected_sites}/${stats.total_sites}`}
          label="Sites Connected"
          trend={stats.connected_sites > 0 ? "Bridge online" : null}
          testId="stat-connected-sites"
        />
        <StatCard
          icon={ShieldCheck}
          value={stats.write_enabled_sites}
          label="Write-enabled Sites"
          testId="stat-write-enabled"
        />
        <StatCard
          icon={FileText}
          value={stats.content_items}
          label="Content Items"
          testId="stat-content-items"
        />
        <StatCard
          icon={Sparkles}
          value={stats.ai_commands_executed}
          label="AI Commands"
          color="primary"
          testId="stat-ai-commands"
        />
      </div>

      {/* Change set / job stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 md:gap-6 mb-8">
        <StatCard
          icon={GitPullRequest}
          value={stats.changesets_pending_approval}
          label="Awaiting Approval"
          color={stats.changesets_pending_approval > 0 ? "#eab308" : "primary"}
          testId="stat-pending-approval"
        />
        <StatCard
          icon={XCircle}
          value={stats.changesets_failed}
          label="Failed Change Sets"
          color={stats.changesets_failed > 0 ? "#ef4444" : "primary"}
          testId="stat-failed-changesets"
        />
        <StatCard
          icon={CalendarClock}
          value={stats.scheduled_jobs}
          label="Scheduled Jobs"
          testId="stat-scheduled-jobs"
        />
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Quick Actions */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="lg:col-span-2"
        >
          <Card className="content-card">
            <CardHeader>
              <CardTitle className="text-lg font-heading flex items-center gap-2">
                <Zap size={18} className="text-primary" aria-hidden="true" />
                Quick Actions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Button asChild variant="outline" className="w-full justify-start gap-3 h-auto py-4 hover:border-primary/50">
                  <Link to="/sites" data-testid="quick-add-site">
                    <Plug size={20} className="text-primary" aria-hidden="true" />
                    <div className="text-left">
                      <p className="font-medium">Connect a Next.js Site</p>
                      <p className="text-xs text-muted-foreground">Pair a site through its bridge agent</p>
                    </div>
                    <ArrowRight size={16} className="ml-auto text-muted-foreground" aria-hidden="true" />
                  </Link>
                </Button>

                <Button asChild variant="outline" className="w-full justify-start gap-3 h-auto py-4 hover:border-primary/50">
                  <Link to="/ai-command" data-testid="quick-ai-command">
                    <Sparkles size={20} className="text-primary" aria-hidden="true" />
                    <div className="text-left">
                      <p className="font-medium">AI Command</p>
                      <p className="text-xs text-muted-foreground">Propose changes as a change set</p>
                    </div>
                    <ArrowRight size={16} className="ml-auto text-muted-foreground" aria-hidden="true" />
                  </Link>
                </Button>

                <Button asChild variant="outline" className="w-full justify-start gap-3 h-auto py-4 hover:border-primary/50">
                  <Link to="/auto-blog-generation" data-testid="quick-create-post">
                    <FileText size={20} className="text-primary" aria-hidden="true" />
                    <div className="text-left">
                      <p className="font-medium">Generate Content</p>
                      <p className="text-xs text-muted-foreground">AI drafts, reviewed before publishing</p>
                    </div>
                    <ArrowRight size={16} className="ml-auto text-muted-foreground" aria-hidden="true" />
                  </Link>
                </Button>

                <Button asChild variant="outline" className="w-full justify-start gap-3 h-auto py-4 hover:border-primary/50">
                  <Link to="/seo" data-testid="quick-seo">
                    <TrendingUp size={20} className="text-primary" aria-hidden="true" />
                    <div className="text-left">
                      <p className="font-medium">SEO Analysis</p>
                      <p className="text-xs text-muted-foreground">Optimize rankings</p>
                    </div>
                    <ArrowRight size={16} className="ml-auto text-muted-foreground" aria-hidden="true" />
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Recent Activity */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <Card className="content-card h-full">
            <CardHeader>
              <CardTitle className="text-lg font-heading flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Activity size={18} className="text-primary" aria-hidden="true" />
                  Recent Activity
                </span>
                <Link to="/activity">
                  <Badge variant="outline" className="cursor-pointer hover:bg-muted">
                    View All
                  </Badge>
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[300px] pr-4">
                {recentActivity.length > 0 ? (
                  recentActivity.map((log, index) => (
                    <ActivityItem key={log.id || index} log={log} />
                  ))
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-center py-8">
                    <Activity size={32} className="text-muted-foreground/30 mb-3" aria-hidden="true" />
                    <p className="text-sm text-muted-foreground">No recent activity</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Connect a site to get started
                    </p>
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </motion.div>

        {/* Change sets awaiting approval */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35 }}
          className="lg:col-span-3"
        >
          <Card className="content-card" data-testid="pending-approval-card">
            <CardHeader>
              <CardTitle className="text-lg font-heading flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <GitPullRequest size={18} className="text-primary" aria-hidden="true" />
                  Change sets awaiting approval
                </span>
                {pending.length > 0 && (
                  <ToneBadge tone="warn">{pending.length} pending</ToneBadge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loadingPending ? (
                <div className="flex justify-center py-8" role="status" aria-label="Loading change sets">
                  <Loader2 size={24} className="animate-spin text-primary" />
                </div>
              ) : pendingError ? (
                <div className="flex items-center gap-2 text-sm text-red-500 py-4" role="alert">
                  <AlertCircle size={16} aria-hidden="true" />
                  {pendingError}
                  <Button variant="outline" size="sm" className="ml-auto" onClick={loadPending}>
                    Retry
                  </Button>
                </div>
              ) : pending.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <CheckCircle2 size={32} className="text-muted-foreground/30 mb-3" aria-hidden="true" />
                  <p className="text-sm text-muted-foreground">Nothing is waiting for approval.</p>
                </div>
              ) : (
                <ul className="divide-y divide-border/30">
                  {pending.map((cs) => (
                    <li key={cs.id} className="flex flex-wrap items-center gap-3 py-3" data-testid="pending-changeset-row">
                      <div className="flex-1 min-w-0">
                        <Link to={`/changesets/${cs.id}`} className="text-sm font-medium text-foreground hover:text-primary hover:underline truncate block">
                          {cs.title || cs.id}
                        </Link>
                        <p className="text-xs text-muted-foreground truncate">
                          <Link to={`/sites/${cs.site_id}`} className="hover:underline">
                            {siteName(cs.site_id)}
                          </Link>
                          {" · "}
                          {Array.isArray(cs.operations) ? `${cs.operations.length} operation${cs.operations.length === 1 ? "" : "s"}` : "—"}
                          {" · submitted "}
                          {formatDate(cs.submitted_at || cs.updated_at || cs.created_at)}
                        </p>
                      </div>
                      <StatusBadge status={cs.status} />
                      <Button asChild variant="outline" size="sm">
                        <Link to={`/changesets/${cs.id}`}>Review</Link>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Connected Sites */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="lg:col-span-3"
        >
          <Card className="content-card">
            <CardHeader>
              <CardTitle className="text-lg font-heading flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Globe size={18} className="text-primary" aria-hidden="true" />
                  Connected Sites
                </span>
                <Button asChild variant="outline" size="sm">
                  <Link to="/sites" data-testid="view-all-sites">Manage Sites</Link>
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loadingSites ? (
                <div className="flex justify-center py-8" role="status" aria-label="Loading sites">
                  <Loader2 size={24} className="animate-spin text-primary" />
                </div>
              ) : sites.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {sites.map((site) => (
                    <Link
                      key={site.id}
                      to={`/sites/${site.id}`}
                      className="block p-4 rounded-lg border border-border/50 hover:border-primary/30 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      data-testid="dashboard-site-card"
                    >
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <Globe size={16} className="text-primary shrink-0" aria-hidden="true" />
                          <span className="font-medium text-sm truncate max-w-[150px]">
                            {site.name}
                          </span>
                        </div>
                        <ConnectionBadge status={site.connection?.status} />
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{site.base_url}</p>
                      <div className="flex flex-wrap items-center gap-2 mt-3">
                        <EnvironmentBadge environment={site.environment} />
                        {site.writes_enabled ? (
                          <ToneBadge tone="ok">
                            <ShieldCheck size={11} className="mr-1" aria-hidden="true" />
                            Writes enabled
                          </ToneBadge>
                        ) : (
                          <ToneBadge tone="muted">
                            <Lock size={11} className="mr-1" aria-hidden="true" />
                            Read-only
                          </ToneBadge>
                        )}
                      </div>
                      {site.connection?.last_handshake_at && (
                        <p className="text-xs text-muted-foreground mt-2">
                          Last handshake: {formatDate(site.connection.last_handshake_at)}
                        </p>
                      )}
                      {site.connection?.last_error && (
                        <p className="text-xs text-red-500 mt-1 truncate" title={site.connection.last_error}>
                          {site.connection.last_error}
                        </p>
                      )}
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Globe size={48} className="text-muted-foreground/30 mb-4" aria-hidden="true" />
                  <h3 className="font-medium text-foreground mb-1">No sites connected</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    Install the bridge agent on your first Next.js site and connect it here
                  </p>
                  <Button asChild className="btn-primary">
                    <Link to="/sites" data-testid="add-first-site">
                      <Globe size={16} className="mr-2" aria-hidden="true" />
                      Add Your First Site
                    </Link>
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
