import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Bug, Play, Loader2, RefreshCw, CheckCircle2, AlertTriangle,
  XCircle, Info, Wrench, ChevronDown, ChevronRight
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";
import { getSites, triggerCrawl, getLatestCrawl, fixCrawlIssue, fixCrawlIssueDryRun, subscribeToTask } from "../lib/api";

import ManualApplySheet from "../components/ManualApplySheet";
import { useApplyMode } from "../hooks/useApplyMode";

const SeverityBadge = ({ severity }) => {
  const map = {
    critical: "bg-red-600/10 text-red-600 border-red-600/20",
    high: "bg-red-500/10 text-red-500 border-red-500/20",
    medium: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
    low: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  };
  return <Badge className={`text-xs capitalize ${map[severity] || map.medium}`}>{severity}</Badge>;
};

const TypeBadge = ({ type }) => {
  const labels = {
    broken_link: "Broken Link",
    missing_meta: "Missing Meta",
    duplicate_title: "Dup. Title",
    no_alt_text: "No Alt Text",
    thin_content: "Thin Content",
  };
  return <Badge variant="secondary" className="text-xs">{labels[type] || type}</Badge>;
};

const IssueIcon = ({ type }) => {
  const icons = {
    broken_link: XCircle,
    missing_meta: Info,
    duplicate_title: RefreshCw,
    no_alt_text: Info,
    thin_content: AlertTriangle,
  };
  const Icon = icons[type] || AlertTriangle;
  return <Icon size={14} className="text-muted-foreground" />;
};

export default function CrawlReport() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [crawling, setCrawling] = useState(false);
  const [crawlProgress, setCrawlProgress] = useState("");
  const [fixing, setFixing] = useState({});
  const [expanded, setExpanded] = useState({});
  const [filterType, setFilterType] = useState("all");

  // Apply Mode
  const { isManual } = useApplyMode();
  const [manualSheet, setManualSheet] = useState({ open: false, title: "", wpAdminUrl: "", fields: [], instructions: "" });
  const openManualSheet = (config) => setManualSheet({ open: true, ...config });
  const closeManualSheet = () => setManualSheet((prev) => ({ ...prev, open: false }));

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSite) loadReport();
  }, [selectedSite]);

  const loadReport = async () => {
    setLoading(true);
    try {
      const r = await getLatestCrawl(selectedSite);
      setReport(r.data);
    } catch {
      setReport(null);
    } finally { setLoading(false); }
  };

  const handleCrawl = async () => {
    setCrawling(true);
    setCrawlProgress("Starting crawl…");
    try {
      const r = await triggerCrawl(selectedSite);
      const unsub = subscribeToTask(r.data.task_id, (ev) => {
        if (ev.type === "status") {
          setCrawlProgress(ev.data?.message || "");
          if (ev.data?.step === ev.data?.total && ev.data?.total > 0) {
            unsub();
            setCrawling(false);
            setCrawlProgress("");
            loadReport();
            toast.success("Crawl complete!");
          }
        }
        if (ev.type === "error") {
          unsub(); setCrawling(false); setCrawlProgress("");
          toast.error(ev.data?.message || "Crawl error");
        }
      });
    } catch (e) {
      toast.error(e.response?.data?.detail || "Crawl failed");
      setCrawling(false); setCrawlProgress("");
    }
  };

  const handleFix = async (issueId) => {
    const issue = (report?.issues || []).find(i => i.id === issueId);
    const siteData = sites.find((s) => s.id === selectedSite);
    const siteUrl = siteData?.url || "";
    if (isManual) {
      setFixing(prev => ({ ...prev, [issueId]: true }));
      try {
        // Attempt dry run to get fix payload; fall back to static fields if endpoint doesn't support it
        let fixPayload = null;
        try {
          const r = await fixCrawlIssueDryRun(selectedSite, issueId);
          fixPayload = r.data;
        } catch { /* ignore dry_run errors, use issue data */ }

        const issueInstructions = {
          broken_link: "Edit the source post/page in WordPress and remove or fix the broken link.",
          missing_meta: "In the WordPress editor for this post/page, find the SEO plugin panel (Yoast/RankMath) and fill in the missing meta title and description.",
          duplicate_title: "Rename the title of one of the posts to make it unique.",
          no_alt_text: "In Media Library, find each image and paste an alt text.",
          thin_content: "Edit the post in WordPress and expand the content to at least 300 words.",
        };

        openManualSheet({
          title: `Fix Crawl Issue — ${issue?.issue_type?.replace(/_/g, " ") || issueId}`,
          wpAdminUrl: issue?.wp_id
            ? `${siteUrl}/wp-admin/post.php?post=${issue.wp_id}&action=edit`
            : `${siteUrl}/wp-admin/`,
          fields: [
            { label: "Issue Type", value: issue?.issue_type || "", type: "text" },
            { label: "Affected URL", value: issue?.url || "", type: "url" },
            { label: "Recommended Fix", value: fixPayload?.recommendation || issue?.description || "", type: "text" },
            ...(fixPayload?.new_title ? [{ label: "New Title", value: fixPayload.new_title, type: "text" }] : []),
            ...(fixPayload?.new_meta ? [{ label: "New Meta Description", value: fixPayload.new_meta, type: "text" }] : []),
          ],
          instructions: issueInstructions[issue?.issue_type] || "Review the issue and apply the fix in WordPress.",
        });
      } catch (e) {
        toast.error(e.response?.data?.detail || "Failed to get fix details");
      } finally {
        setFixing(prev => ({ ...prev, [issueId]: false }));
      }
      return;
    }
    setFixing(prev => ({ ...prev, [issueId]: true }));
    try {
      const r = await fixCrawlIssue(selectedSite, issueId);
      toast.success(r.data.message || "Fix applied!");
      loadReport();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Fix failed");
    } finally { setFixing(prev => ({ ...prev, [issueId]: false })); }
  };

  const toggleExpand = (id) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  const filteredIssues = (report?.issues || []).filter(i =>
    filterType === "all" || i.issue_type === filterType
  );

  const issueTypes = [...new Set((report?.issues || []).map(i => i.issue_type))];

  return (
    <div className="page-container">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
            Crawl Report
          </motion.h1>
          <p className="page-description">Automated site audit: broken links, missing meta, thin content and more</p>
        </div>
        <div className="flex gap-2 items-center">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Select site" /></SelectTrigger>
            <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button className="btn-primary" onClick={handleCrawl} disabled={crawling || !selectedSite}>
            {crawling ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Play size={14} className="mr-2" />}
            Run Crawl
          </Button>
        </div>
      </div>

      {crawling && crawlProgress && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          className="mb-4 px-4 py-2.5 rounded-lg bg-primary/10 border border-primary/25 text-sm text-primary flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> {crawlProgress}
        </motion.div>
      )}

      {loading ? (
        <div className="flex justify-center py-24"><Loader2 size={32} className="animate-spin text-primary" /></div>
      ) : !report ? (
        <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground">
          <Bug size={48} className="mb-4 opacity-30" />
          <p>No crawl report yet. Click "Run Crawl" to scan your site.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: "Total Issues", value: report.summary?.total_issues ?? 0, color: "text-foreground" },
              { label: "Critical", value: report.summary?.critical ?? 0, color: "text-red-600" },
              { label: "High", value: report.summary?.high ?? 0, color: "text-red-500" },
              { label: "Pages Crawled", value: report.total_urls ?? 0, color: "text-primary" },
            ].map((stat, i) => (
              <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.07 }}>
                <Card className="content-card text-center">
                  <CardContent className="pt-4 pb-3">
                    <div className={`text-3xl font-bold ${stat.color}`}>{stat.value}</div>
                    <div className="text-xs text-muted-foreground mt-1">{stat.label}</div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>

          {/* AI Recommendations */}
          {report.recommendations?.length > 0 && (
            <Card className="content-card border-primary/20">
              <CardHeader className="pb-2">
                <CardTitle className="font-heading text-sm flex items-center gap-2">
                  <Wrench size={14} className="text-primary" /> AI Priority Recommendations
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {report.recommendations.map((rec, i) => (
                  <div key={i} className="flex gap-2 items-start text-sm">
                    <span className="w-5 h-5 rounded-full bg-primary text-white text-xs flex items-center justify-center flex-shrink-0 mt-0.5 font-bold">{i + 1}</span>
                    <p>{rec}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Issues Table */}
          <Card className="content-card">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <CardTitle className="font-heading flex items-center gap-2">
                  <Bug size={16} className="text-primary" /> Issues
                  <Badge variant="secondary">{filteredIssues.length}</Badge>
                </CardTitle>
                <Select value={filterType} onValueChange={setFilterType}>
                  <SelectTrigger className="w-44 h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    {issueTypes.map(t => (
                      <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {filteredIssues.length === 0 ? (
                <div className="flex flex-col items-center py-8 text-muted-foreground">
                  <CheckCircle2 size={32} className="mb-2 text-emerald-500" />
                  <p>No issues found!</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredIssues.map((issue) => (
                    <div key={issue.id}
                      className={`rounded-lg border transition-colors ${issue.fixed ? "border-emerald-500/20 bg-emerald-500/5" : "border-border/40 bg-muted/10"}`}>
                      <button className="w-full flex items-center gap-3 p-3 text-left"
                        onClick={() => toggleExpand(issue.id)}>
                        <IssueIcon type={issue.issue_type} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{issue.url}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{issue.description}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <TypeBadge type={issue.issue_type} />
                          <SeverityBadge severity={issue.severity} />
                          {issue.fixed && <Badge className="bg-emerald-500/10 text-emerald-500 text-xs">Fixed</Badge>}
                          {expanded[issue.id] ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
                        </div>
                      </button>
                      {expanded[issue.id] && (
                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
                          className="px-3 pb-3 border-t border-border/20">
                          <p className="text-xs text-muted-foreground mt-2 mb-2">
                            <span className="font-medium text-foreground">Recommended fix: </span>
                            {issue.recommended_fix}
                          </p>
                          {!issue.fixed && (
                            <Button size="sm" variant="outline" className="text-xs h-7"
                              onClick={() => handleFix(issue.id)} disabled={fixing[issue.id]}>
                              {fixing[issue.id]
                                ? <><Loader2 size={10} className="mr-1 animate-spin" /> Fixing…</>
                                : <><Wrench size={10} className="mr-1" /> Fix with AI</>}
                            </Button>
                          )}
                        </motion.div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground text-center">
            Last crawled: {new Date(report.crawled_at).toLocaleString()}
          </p>
        </div>
      )}

      <ManualApplySheet
        open={manualSheet.open}
        onClose={closeManualSheet}
        title={manualSheet.title}
        wpAdminUrl={manualSheet.wpAdminUrl}
        fields={manualSheet.fields}
        instructions={manualSheet.instructions}
      />
    </div>
  );
}
