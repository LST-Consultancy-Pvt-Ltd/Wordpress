import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Search, Globe, CheckCircle2, XCircle, Loader2, RefreshCw, Send, BarChart3 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";
import { getSites, checkIndexingStatus, getIndexingReport, submitSitemapToGSC, subscribeToTask } from "../lib/api";

const priorityBadge = {
  high: "bg-red-500/10 text-red-400 border-red-500/20",
  medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  low: "bg-muted text-muted-foreground",
};

export default function IndexingTracker() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [report, setReport] = useState(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState("");
  const [sitemapUrl, setSitemapUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);

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
    setLoadingReport(true);
    try {
      const r = await getIndexingReport(selectedSite);
      setReport(r.data);
    } catch { setReport(null); }
    finally { setLoadingReport(false); }
  };

  const handleCheck = async () => {
    if (!selectedSite) return toast.error("Select a site");
    setChecking(true);
    setProgress("Starting indexing check...");
    try {
      const r = await checkIndexingStatus(selectedSite);
      const taskId = r.data.task_id;
      subscribeToTask(taskId, (event) => {
        if (event.type === "progress") setProgress(event.data?.message || "Checking...");
        if (event.type === "complete") {
          setProgress("");
          setChecking(false);
          loadReport();
          toast.success("Indexing check complete");
        }
        if (event.type === "error") {
          setProgress("");
          setChecking(false);
          toast.error(event.data?.message || "Check failed");
        }
      });
    } catch (e) {
      setChecking(false);
      setProgress("");
      toast.error(e.response?.data?.detail || "Failed to start check");
    }
  };

  const handleSubmitSitemap = async () => {
    if (!sitemapUrl.trim()) return toast.error("Enter a sitemap URL");
    setSubmitting(true);
    try {
      const r = await submitSitemapToGSC(selectedSite, { sitemap_url: sitemapUrl });
      toast.success(r.data.message || "Sitemap submitted");
      setSitemapUrl("");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Submission failed");
    } finally {
      setSubmitting(false);
    }
  };

  const indexRate = report && report.total_urls > 0
    ? Math.round((report.indexed_count / report.total_urls) * 100)
    : 0;

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Search size={24} />Indexing Tracker</h1>
          <p className="page-description">Monitor Google indexing status and submit sitemaps via Search Console</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
            <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button onClick={handleCheck} disabled={checking || !selectedSite}>
            {checking ? <><Loader2 size={14} className="mr-2 animate-spin" />Checking...</> : <><RefreshCw size={14} className="mr-2" />Run Check</>}
          </Button>
        </div>
      </div>

      {progress && (
        <Card className="border-blue-500/30 bg-blue-500/5">
          <CardContent className="py-3 flex items-center gap-3">
            <Loader2 size={14} className="animate-spin text-blue-400" />
            <p className="text-sm text-blue-400">{progress}</p>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total URLs", value: report?.total_urls ?? "—", icon: Globe, color: "text-blue-400" },
          { label: "Indexed", value: report?.indexed_count ?? "—", icon: CheckCircle2, color: "text-emerald-400" },
          { label: "Not Indexed", value: report?.not_indexed_count ?? "—", icon: XCircle, color: "text-red-400" },
          { label: "Index Rate", value: report ? `${indexRate}%` : "—", icon: BarChart3, color: "text-purple-400" },
        ].map(({ label, value, icon: Icon, color }) => (
          <Card key={label}>
            <CardContent className="pt-5">
              <div className="flex items-center gap-3">
                <Icon size={20} className={color} />
                <div>
                  <p className="text-xl font-bold">{value}</p>
                  <p className="text-xs text-muted-foreground">{label}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* URL Table */}
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-base">URL Indexing Status</CardTitle>
            <Button variant="ghost" size="sm" onClick={loadReport} disabled={loadingReport}>
              <RefreshCw size={12} className={loadingReport ? "animate-spin" : ""} />
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-1 max-h-96 overflow-y-auto">
              {report?.pages?.length > 0 ? report.pages.map((page, i) => (
                <div key={i} className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/20 group">
                  {page.indexed
                    ? <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />
                    : <XCircle size={14} className="text-red-400 shrink-0" />}
                  <p className="text-xs flex-1 truncate text-muted-foreground">{page.url}</p>
                  {page.priority && (
                    <Badge className={`text-xs ${priorityBadge[page.priority]}`}>{page.priority}</Badge>
                  )}
                </div>
              )) : (
                <div className="text-center py-8">
                  <Search size={32} className="mx-auto mb-2 text-muted-foreground opacity-40" />
                  <p className="text-sm text-muted-foreground">Run a check to see indexing status</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          {/* Submission Batches */}
          {report?.submission_batches?.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Submission Batches</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {report.submission_batches.map((batch, i) => (
                    <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-muted/20">
                      <div>
                        <p className="text-sm font-medium">Week {batch.week}</p>
                        <p className="text-xs text-muted-foreground">{batch.count} URLs</p>
                      </div>
                      <Badge variant={batch.submitted ? "default" : "outline"} className="text-xs">
                        {batch.submitted ? "Submitted" : "Pending"}
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Sitemap Submission */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Send size={16} />Submit Sitemap to GSC</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">Submit your sitemap directly to Google Search Console to request indexing.</p>
              <div className="flex gap-2">
                <Input
                  placeholder="https://example.com/sitemap.xml"
                  value={sitemapUrl}
                  onChange={e => setSitemapUrl(e.target.value)}
                  className="flex-1"
                />
                <Button onClick={handleSubmitSitemap} disabled={submitting} variant="outline">
                  {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </motion.div>
  );
}
