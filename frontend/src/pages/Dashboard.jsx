import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import {
  Globe,
  FileText,
  Newspaper,
  Sparkles,
  Activity,
  TrendingUp,
  Clock,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Zap,
  Package,
  AlertTriangle,
  Loader2,
  HeartPulse,
  MessageSquare,
  Share2,
  Archive,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Badge } from "../components/ui/badge";
import { ScrollArea } from "../components/ui/scroll-area";
import { getDashboardStats, auditPlugins, getPluginAudit, getSites, getHealthData, getComments, getSocialQueue, listBackups } from "../lib/api";
import { toast } from "sonner";

const StatCard = ({ icon: Icon, value, label, trend, color = "primary" }) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.3 }}
  >
    <Card className="stat-card">
      <div className="flex items-start justify-between">
        <div>
          <p className="stat-value">{value}</p>
          <p className="stat-label">{label}</p>
        </div>
        <div className={`w-10 h-10 rounded-lg bg-${color}/10 flex items-center justify-center`}>
          <Icon size={20} className={`text-${color}`} style={{ color: color === "primary" ? "hsl(var(--primary))" : color }} />
        </div>
      </div>
      {trend && (
        <div className="flex items-center gap-1 mt-3 text-xs text-emerald-500">
          <TrendingUp size={12} />
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
        return <CheckCircle2 size={14} className="text-emerald-500" />;
      case "error":
        return <AlertCircle size={14} className="text-red-500" />;
      default:
        return <Clock size={14} className="text-yellow-500" />;
    }
  };

  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  return (
    <div className="flex items-start gap-3 py-3 border-b border-border/30 last:border-0">
      {getStatusIcon()}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{log.action}</p>
        <p className="text-xs text-muted-foreground truncate">{log.details}</p>
      </div>
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {formatTime(log.created_at)}
      </span>
    </div>
  );
};

export default function Dashboard() {
  const [stats, setStats] = useState({
    total_sites: 0,
    total_pages: 0,
    total_posts: 0,
    ai_commands_executed: 0,
    recent_activity: [],
    sites: []
  });
  const [loading, setLoading] = useState(true);
  const [sites, setSites] = useState([]);
  const [selectedPluginSite, setSelectedPluginSite] = useState("");
  const [pluginAudit, setPluginAudit] = useState(null);
  const [auditingPlugins, setAuditingPlugins] = useState(false);
  const [loadingPluginAudit, setLoadingPluginAudit] = useState(false);
  const [extraStats, setExtraStats] = useState({ uptime: "—", pendingComments: "—", scheduledPosts: "—", lastBackup: "—" });

  useEffect(() => {
    loadStats();
    loadSiteList();
  }, []);

  const loadSiteList = async () => {
    try {
      const r = await getSites();
      const list = r.data || [];
      setSites(list);
      if (list.length > 0) {
        setSelectedPluginSite(list[0].id);
        loadPluginAudit(list[0].id);
        loadExtraStats(list[0].id);
      }
    } catch { /* ignore */ }
  };

  const loadExtraStats = async (siteId) => {
    try {
      const [healthR, commentsR, queueR, backupsR] = await Promise.allSettled([
        getHealthData(siteId),
        getComments(siteId, "hold"),
        getSocialQueue(siteId),
        listBackups(siteId),
      ]);
      const health = healthR.status === "fulfilled" ? healthR.value.data : null;
      const comments = commentsR.status === "fulfilled" ? (Array.isArray(commentsR.value.data) ? commentsR.value.data : []) : [];
      const queue = queueR.status === "fulfilled" ? (Array.isArray(queueR.value.data) ? queueR.value.data : []) : [];
      const backups = backupsR.status === "fulfilled" ? (Array.isArray(backupsR.value.data) ? backupsR.value.data : []) : [];
      const lastBackupDate = backups[0]?.created_at ? new Date(backups[0].created_at) : null;
      const daysSince = lastBackupDate ? Math.floor((Date.now() - lastBackupDate) / 86400000) : null;
      setExtraStats({
        uptime: health ? (health.online ? "Online" : "Down") : "—",
        pendingComments: comments.length,
        scheduledPosts: queue.filter(q => q.status === "pending").length,
        lastBackup: daysSince !== null ? `${daysSince}d ago` : "None",
      });
    } catch { }
  };

  const loadPluginAudit = async (siteId) => {
    setLoadingPluginAudit(true);
    try {
      const r = await getPluginAudit(siteId);
      setPluginAudit(r.data);
    } catch { setPluginAudit(null); }
    finally { setLoadingPluginAudit(false); }
  };

  const handleAuditPlugins = async () => {
    if (!selectedPluginSite) return;
    setAuditingPlugins(true);
    try {
      const r = await auditPlugins(selectedPluginSite);
      setPluginAudit(r.data);
      toast.success(`Plugin audit complete: ${r.data.total_plugins} plugins analysed`);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Plugin audit failed");
    } finally { setAuditingPlugins(false); }
  };

  const loadStats = async () => {
    try {
      const response = await getDashboardStats();
      setStats(response.data);
    } catch (error) {
      toast.error("Failed to load dashboard stats");
    } finally {
      setLoading(false);
    }
  };

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
          Overview of your AI-managed WordPress sites
        </motion.p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 mb-8">
        <StatCard
          icon={Globe}
          value={stats.total_sites}
          label="Connected Sites"
          trend={stats.total_sites > 0 ? "Active" : null}
        />
        <StatCard
          icon={FileText}
          value={stats.total_pages}
          label="Total Pages"
        />
        <StatCard
          icon={Newspaper}
          value={stats.total_posts}
          label="Total Posts"
        />
        <StatCard
          icon={Sparkles}
          value={stats.ai_commands_executed}
          label="AI Commands"
          color="primary"
        />
      </div>

      {/* Extra Stats Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 md:gap-6 mb-8">
        <StatCard
          icon={HeartPulse}
          value={extraStats.uptime}
          label="Site Status"
          color={extraStats.uptime === "Down" ? "#ef4444" : "primary"}
        />
        <StatCard
          icon={MessageSquare}
          value={extraStats.pendingComments}
          label="Pending Comments"
        />
        <StatCard
          icon={Share2}
          value={extraStats.scheduledPosts}
          label="Social Scheduled"
        />
        <StatCard
          icon={Archive}
          value={extraStats.lastBackup}
          label="Last Backup"
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
                <Zap size={18} className="text-primary" />
                Quick Actions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Link to="/sites" data-testid="quick-add-site">
                  <Button
                    variant="outline"
                    className="w-full justify-start gap-3 h-auto py-4 hover:border-primary/50"
                  >
                    <Globe size={20} className="text-primary" />
                    <div className="text-left">
                      <p className="font-medium">Add WordPress Site</p>
                      <p className="text-xs text-muted-foreground">Connect a new site</p>
                    </div>
                    <ArrowRight size={16} className="ml-auto text-muted-foreground" />
                  </Button>
                </Link>
                
                <Link to="/ai-command" data-testid="quick-ai-command">
                  <Button
                    variant="outline"
                    className="w-full justify-start gap-3 h-auto py-4 hover:border-primary/50"
                  >
                    <Sparkles size={20} className="text-primary" />
                    <div className="text-left">
                      <p className="font-medium">AI Command</p>
                      <p className="text-xs text-muted-foreground">Execute AI tasks</p>
                    </div>
                    <ArrowRight size={16} className="ml-auto text-muted-foreground" />
                  </Button>
                </Link>
                
                <Link to="/posts" data-testid="quick-create-post">
                  <Button
                    variant="outline"
                    className="w-full justify-start gap-3 h-auto py-4 hover:border-primary/50"
                  >
                    <Newspaper size={20} className="text-primary" />
                    <div className="text-left">
                      <p className="font-medium">Generate Blog Post</p>
                      <p className="text-xs text-muted-foreground">AI-powered content</p>
                    </div>
                    <ArrowRight size={16} className="ml-auto text-muted-foreground" />
                  </Button>
                </Link>
                
                <Link to="/seo" data-testid="quick-seo">
                  <Button
                    variant="outline"
                    className="w-full justify-start gap-3 h-auto py-4 hover:border-primary/50"
                  >
                    <TrendingUp size={20} className="text-primary" />
                    <div className="text-left">
                      <p className="font-medium">SEO Analysis</p>
                      <p className="text-xs text-muted-foreground">Optimize rankings</p>
                    </div>
                    <ArrowRight size={16} className="ml-auto text-muted-foreground" />
                  </Button>
                </Link>
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
                  <Activity size={18} className="text-primary" />
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
                {stats.recent_activity.length > 0 ? (
                  stats.recent_activity.map((log, index) => (
                    <ActivityItem key={log.id || index} log={log} />
                  ))
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-center py-8">
                    <Activity size={32} className="text-muted-foreground/30 mb-3" />
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
                  <Globe size={18} className="text-primary" />
                  Connected Sites
                </span>
                <Link to="/sites">
                  <Button variant="outline" size="sm" data-testid="view-all-sites">
                    Manage Sites
                  </Button>
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {stats.sites.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {stats.sites.map((site) => (
                    <div
                      key={site.id}
                      className="p-4 rounded-lg border border-border/50 hover:border-primary/30 transition-colors"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <Globe size={16} className="text-primary" />
                          <span className="font-medium text-sm truncate max-w-[150px]">
                            {site.name}
                          </span>
                        </div>
                        <Badge
                          variant={site.status === "connected" ? "default" : "secondary"}
                          className={site.status === "connected" ? "bg-emerald-500/10 text-emerald-500" : ""}
                        >
                          {site.status}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{site.url}</p>
                      {site.last_sync && (
                        <p className="text-xs text-muted-foreground mt-2">
                          Last sync: {new Date(site.last_sync).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Globe size={48} className="text-muted-foreground/30 mb-4" />
                  <h3 className="font-medium text-foreground mb-1">No sites connected</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    Connect your first WordPress site to start managing it with AI
                  </p>
                  <Link to="/sites">
                    <Button className="btn-primary" data-testid="add-first-site">
                      <Globe size={16} className="mr-2" />
                      Add Your First Site
                    </Button>
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Plugin Health Audit */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
        className="mt-6"
      >
        <Card className="content-card">
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <CardTitle className="text-lg font-heading flex items-center gap-2">
                <Package size={18} className="text-primary" />
                Plugin Health Audit
              </CardTitle>
              <div className="flex items-center gap-2">
                {sites.length > 1 && (
                  <Select value={selectedPluginSite} onValueChange={(v) => { setSelectedPluginSite(v); loadPluginAudit(v); }}>
                    <SelectTrigger className="w-44 h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                <Button size="sm" onClick={handleAuditPlugins} disabled={auditingPlugins || !selectedPluginSite} className="h-8">
                  {auditingPlugins ? <Loader2 size={13} className="animate-spin mr-1.5" /> : <Package size={13} className="mr-1.5" />}
                  Run Audit
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loadingPluginAudit ? (
              <div className="flex justify-center py-8"><Loader2 size={24} className="animate-spin text-primary" /></div>
            ) : !pluginAudit ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <Package size={36} className="text-muted-foreground/30 mb-3" />
                <p className="text-muted-foreground text-sm">No audit data yet. Click "Run Audit" to scan plugins.</p>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: "Total Plugins", value: pluginAudit.total_plugins, color: "text-foreground" },
                    { label: "High Issues", value: pluginAudit.high_issues, color: "text-red-500" },
                    { label: "Medium Issues", value: pluginAudit.medium_issues, color: "text-yellow-500" },
                    { label: "Last Audit", value: pluginAudit.audited_at ? new Date(pluginAudit.audited_at).toLocaleDateString() : "—", color: "text-muted-foreground" },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="p-3 rounded-lg bg-muted/30 border border-border/30">
                      <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
                      <p className={`text-lg font-semibold ${color}`}>{value}</p>
                    </div>
                  ))}
                </div>
                {pluginAudit.issues?.length > 0 ? (
                  <div>
                    <p className="text-sm font-medium mb-2">Issues Found</p>
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {pluginAudit.issues.map((issue, i) => (
                        <div key={i} className="flex items-start gap-2 p-2 rounded-lg bg-muted/20 border border-border/30 text-sm">
                          {issue.severity === "high" ? <AlertTriangle size={14} className="text-red-500 mt-0.5 shrink-0" /> : issue.severity === "medium" ? <AlertCircle size={14} className="text-yellow-500 mt-0.5 shrink-0" /> : <CheckCircle2 size={14} className="text-muted-foreground mt-0.5 shrink-0" />}
                          <div>
                            <span className="font-medium">{issue.plugin}</span>
                            <span className="text-muted-foreground"> — {issue.issue}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-emerald-500 text-sm">
                    <CheckCircle2 size={16} />No issues found — plugins look healthy!
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
