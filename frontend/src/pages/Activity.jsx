import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Activity as ActivityIcon, Clock, Globe, Loader2, AlertCircle,
  CheckCircle, XCircle, RefreshCw, Calendar, Bot, BarChart3,
  Image, Zap, Cpu
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "../components/ui/table";
import { getSites, getActivityLogs, getAllActivityLogs, getJobs } from "../lib/api";
import { toast } from "sonner";

const ACTION_META = {
  site_added:       { label: "Site Added",            color: "bg-blue-500/10 text-blue-400" },
  site_synced:      { label: "Site Synced",           color: "bg-blue-500/10 text-blue-400" },
  post_created:     { label: "Post Created",          color: "bg-emerald-500/10 text-emerald-400" },
  post_deleted:     { label: "Post Deleted",          color: "bg-red-500/10 text-red-400" },
  post_generated:   { label: "Post Generated (AI)",   color: "bg-violet-500/10 text-violet-400" },
  page_created:     { label: "Page Created",          color: "bg-emerald-500/10 text-emerald-400" },
  page_deleted:     { label: "Page Deleted",          color: "bg-red-500/10 text-red-400" },
  seo_analyzed:     { label: "SEO Analyzed",          color: "bg-amber-500/10 text-amber-400" },
  seo_healed:       { label: "SEO Self-Healed",       color: "bg-amber-500/10 text-amber-400" },
  seo_google_refresh: { label: "Google SEO Refresh",  color: "bg-sky-500/10 text-sky-400" },
  bulk_seo_audit:   { label: "Bulk SEO Audit",        color: "bg-amber-500/10 text-amber-400" },
  bulk_content_refresh: { label: "Bulk Content Refresh", color: "bg-violet-500/10 text-violet-400" },
  bulk_publish:     { label: "Bulk Publish",          color: "bg-emerald-500/10 text-emerald-400" },
  bulk_draft:       { label: "Bulk Unpublish",        color: "bg-orange-500/10 text-orange-400" },
  content_refreshed: { label: "Content Refreshed",   color: "bg-teal-500/10 text-teal-400" },
  ai_command:       { label: "AI Command",            color: "bg-violet-500/10 text-violet-400" },
  agent_turn:       { label: "AI Agent Turn",         color: "bg-violet-500/10 text-violet-400" },
  nav_synced:       { label: "Navigation Synced",     color: "bg-blue-500/10 text-blue-400" },
  settings_updated: { label: "Settings Updated",      color: "bg-slate-500/10 text-slate-400" },
  scheduled_freshness_scan: { label: "Freshness Scan (Scheduled)", color: "bg-teal-500/10 text-teal-400" },
  scheduled_seo_check: { label: "SEO Check (Scheduled)", color: "bg-amber-500/10 text-amber-400" },
  scheduled_publish: { label: "Scheduled Publish",   color: "bg-emerald-500/10 text-emerald-400" },
};

const JOB_TYPE_LABELS = {
  content_freshness: "Content Freshness Scan",
  seo_health: "SEO Health Check",
  scheduled_publish: "Scheduled Publish",
};

function ActionBadge({ action }) {
  const meta = ACTION_META[action] || { label: action, color: "bg-slate-500/10 text-slate-400" };
  return <Badge className={`text-xs ${meta.color}`}>{meta.label}</Badge>;
}

export default function Activity() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("all");
  const [activityLogs, setActivityLogs] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [activeTab, setActiveTab] = useState("activity");

  useEffect(() => { loadSites(); }, []);
  useEffect(() => { loadLogs(); if (activeTab === "jobs" && selectedSite !== "all") loadJobs(); }, [selectedSite, activeTab]);

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data);
    } catch { toast.error("Failed to load sites"); }
  };

  const loadLogs = async () => {
    setLoading(true);
    try {
      let r;
      if (selectedSite === "all") {
        r = await getAllActivityLogs();
      } else {
        r = await getActivityLogs(selectedSite);
      }
      setActivityLogs(r.data || []);
    } catch { toast.error("Failed to load activity logs"); }
    finally { setLoading(false); }
  };

  const loadJobs = async () => {
    if (selectedSite === "all") return;
    setLoadingJobs(true);
    try {
      const r = await getJobs(selectedSite);
      setJobs(r.data || []);
    } catch { setJobs([]); }
    finally { setLoadingJobs(false); }
  };

  return (
    <div className="page-container" data-testid="activity-page">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
            Activity
          </motion.h1>
          <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
            Activity logs and scheduled job status
          </motion.p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-[200px]" data-testid="site-select">
              <SelectValue placeholder="All Sites" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Sites</SelectItem>
              {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={loadLogs} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v); if (v === "jobs" && selectedSite !== "all") loadJobs(); }}>
        <TabsList className="mb-6">
          <TabsTrigger value="activity">
            <ActivityIcon size={14} className="mr-2" />Activity Log
          </TabsTrigger>
          <TabsTrigger value="jobs">
            <Clock size={14} className="mr-2" />Scheduled Jobs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="activity">
          <Card className="content-card">
            <CardContent className="p-0">
              {loading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 size={32} className="animate-spin text-primary" />
                </div>
              ) : activityLogs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16">
                  <ActivityIcon size={48} className="text-muted-foreground/30 mb-4" />
                  <p className="text-muted-foreground">No activity yet</p>
                </div>
              ) : (
                <Table className="data-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Action</TableHead>
                      <TableHead>Details</TableHead>
                      <TableHead>Site</TableHead>
                      <TableHead>Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {activityLogs.map((log, i) => (
                      <TableRow key={log.id || i}>
                        <TableCell><ActionBadge action={log.action} /></TableCell>
                        <TableCell className="max-w-[300px] truncate text-sm text-muted-foreground">
                          {log.details || "—"}
                        </TableCell>
                        <TableCell className="text-sm">
                          {log.site_id ? (
                            <span className="flex items-center gap-1 text-muted-foreground">
                              <Globe size={12} />{log.site_id}
                            </span>
                          ) : "All Sites"}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                          {log.timestamp ? new Date(log.timestamp).toLocaleString() : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="jobs">
          {selectedSite === "all" ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Globe size={40} className="text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground">Select a specific site to view scheduled jobs</p>
            </div>
          ) : (
            <Card className="content-card">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="font-heading flex items-center gap-2">
                    <Clock size={16} className="text-primary" />Scheduled Jobs
                  </CardTitle>
                  <Button variant="ghost" size="sm" onClick={loadJobs} disabled={loadingJobs}>
                    <RefreshCw size={14} className={loadingJobs ? "animate-spin" : ""} />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {loadingJobs ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 size={24} className="animate-spin text-primary" />
                  </div>
                ) : jobs.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12">
                    <Clock size={40} className="text-muted-foreground/30 mb-3" />
                    <p className="text-muted-foreground text-sm">No scheduled jobs for this site</p>
                    <p className="text-muted-foreground/60 text-xs mt-1">Go to Settings to create scheduled jobs</p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Job Type</TableHead>
                        <TableHead>Cron</TableHead>
                        <TableHead>Last Run</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Next Run</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {jobs.map((job) => (
                        <TableRow key={job.id}>
                          <TableCell className="font-medium">{JOB_TYPE_LABELS[job.job_type] || job.job_type}</TableCell>
                          <TableCell><code className="text-xs bg-muted px-1 py-0.5 rounded">{job.cron_expression}</code></TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {job.last_run ? new Date(job.last_run).toLocaleString() : "Never"}
                          </TableCell>
                          <TableCell>
                            {job.last_run_status === "success" ? (
                              <Badge className="bg-emerald-500/10 text-emerald-500 text-xs">
                                <CheckCircle size={10} className="mr-1" />Success
                              </Badge>
                            ) : job.last_run_status === "error" ? (
                              <Badge className="bg-red-500/10 text-red-500 text-xs">
                                <XCircle size={10} className="mr-1" />Error
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="text-xs">
                                <Clock size={10} className="mr-1" />Pending
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {job.next_run ? new Date(job.next_run).toLocaleString() : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
