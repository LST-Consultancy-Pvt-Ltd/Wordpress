import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Bug, Play, Loader2, RefreshCw, CheckCircle2, AlertTriangle,
  XCircle, Info, Wrench, ChevronDown, ChevronRight, ExternalLink
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";
import { getSites, triggerCrawl, getLatestCrawl, subscribeToTask, listItems, apiErrorMessage } from "../lib/api";
import GatedButton from "../components/sa/GatedButton";

const METADATA_ISSUES = new Set(["missing_meta", "duplicate_title"]);

/** Route path ("/blog/post") of an absolute or relative URL. */
function routeOf(url) {
  if (!url) return "/";
  try {
    return new URL(url, "http://placeholder.local").pathname || "/";
  } catch {
    return "/";
  }
}

/** Editor link for an issue: metadata issues → metadata editor, others → content editor. */
function editorLinkFor(siteId, issue) {
  if (METADATA_ISSUES.has(issue?.issue_type)) {
    return `/sites/${siteId}/content?tab=metadata&route=${encodeURIComponent(routeOf(issue?.url))}`;
  }
  return `/sites/${siteId}/content`;
}

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
  const [expanded, setExpanded] = useState({});
  const [filterType, setFilterType] = useState("all");

  useEffect(() => {
    getSites().then(r => {
      const list = listItems(r.data);
      setSites(list);
      if (list.length > 0) setSelectedSite(list[0].id);
    }).catch(() => {});
  }, []);

  const loadReport = useCallback(async () => {
    if (!selectedSite) return;
    setLoading(true);
    try {
      const r = await getLatestCrawl(selectedSite);
      setReport(r.data);
    } catch {
      setReport(null);
    } finally { setLoading(false); }
  }, [selectedSite]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

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
      toast.error(apiErrorMessage(e, "Crawl failed"));
      setCrawling(false); setCrawlProgress("");
    }
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
          <p className="page-description">Automated site audit: broken links, missing meta, thin content and more. Issues are read-only here — fix them in the site's editors, which create change sets for review.</p>
        </div>
        <div className="flex gap-2 items-center">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-44" aria-label="Site"><SelectValue placeholder="Select site" /></SelectTrigger>
            <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <GatedButton minRole="editor" className="btn-primary" onClick={handleCrawl} disabled={crawling || !selectedSite}>
            {crawling ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Play size={14} className="mr-2" />}
            Run Crawl
          </GatedButton>
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
                  <SelectTrigger className="w-44 h-8 text-xs" aria-label="Filter by issue type"><SelectValue /></SelectTrigger>
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
                      <button type="button" className="w-full flex items-center gap-3 p-3 text-left"
                        aria-expanded={!!expanded[issue.id]}
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
                            <Button asChild size="sm" variant="outline" className="text-xs h-7">
                              <Link to={editorLinkFor(selectedSite, issue)}>
                                <ExternalLink size={10} className="mr-1" aria-hidden="true" />
                                {METADATA_ISSUES.has(issue.issue_type) ? "Edit metadata" : "Open in editor"}
                              </Link>
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

    </div>
  );
}
