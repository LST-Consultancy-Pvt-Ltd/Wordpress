import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import {
  Copy,
  ScanLine,
  Loader2,
  Sparkles,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  FileText,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { Progress } from "../components/ui/progress";
import { getSites, scanDuplicateContent, getDuplicateContent, fixDuplicateContent, fixDuplicateContentDryRun } from "../lib/api";
import ImpactBadge from "../components/ImpactBadge";
import SSEProgressDrawer, { useSSETask } from "../components/SSEProgressDrawer";
import ManualApplySheet from "../components/ManualApplySheet";
import { useApplyMode } from "../hooks/useApplyMode";
import { toast } from "sonner";

function SimilarityBadge({ score, type }) {
  const pct = Math.round(score * 100);
  if (type === "title") {
    return (
      <Badge className="bg-purple-500/10 text-purple-400 border-purple-500/20 gap-1">
        <FileText size={11} />
        Exact Title
      </Badge>
    );
  }
  const color =
    pct >= 95
      ? "bg-red-500/10 text-red-400 border-red-500/20"
      : pct >= 85
      ? "bg-orange-500/10 text-orange-400 border-orange-500/20"
      : "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
  return (
    <div className="flex items-center gap-2">
      <Badge className={color}>{pct}% similar</Badge>
      <Progress value={pct} className="h-1.5 w-20" />
    </div>
  );
}

export default function DuplicateContent() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [results, setResults] = useState([]);
  const [lastFixImpact, setLastFixImpact] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [fixing, setFixing] = useState({});
  const pollRef = useRef(null);

  const { tasks, startTask, dismissTask } = useSSETask();

  // Apply Mode
  const { isManual } = useApplyMode();
  const [manualSheet, setManualSheet] = useState({ open: false, title: "", wpAdminUrl: "", fields: [], instructions: "" });
  const openManualSheet = (config) => setManualSheet({ open: true, ...config });
  const closeManualSheet = () => setManualSheet((prev) => ({ ...prev, open: false }));

  useEffect(() => { loadSites(); }, []);
  useEffect(() => {
    if (selectedSite) loadResults();
  }, [selectedSite]); // eslint-disable-line

  // Clean up polling on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    } catch {
      toast.error("Failed to load sites");
    }
  };

  const loadResults = async () => {
    setLoading(true);
    try {
      const r = await getDuplicateContent(selectedSite);
      setResults(r.data || []);
    } catch {
      toast.error("Failed to load duplicate content results");
    } finally {
      setLoading(false);
    }
  };

  const handleScan = async () => {
    if (!selectedSite) return;
    setScanning(true);
    try {
      const r = await scanDuplicateContent(selectedSite);
      const taskId = r.data.task_id;
      startTask(taskId, "Scanning for duplicate content");

      // Poll until the SSE task finishes, then reload results
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        setFixing((prev) => {
          // hack: read tasks via ref — we use setResults as a trigger instead
          return prev;
        });
      }, 500);

      // Simple approach: wait for the "complete" event by watching task status
      const checkDone = () => {
        // tasks state update is async; we store taskId and reload after a fixed delay
      };
      checkDone();
      // Reload results after a delay allowing the scan to complete for small sites,
      // and after each SSE complete event handled by the drawer's onComplete callback
      setTimeout(async () => {
        await loadResults();
        setScanning(false);
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, 3000);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to start scan");
      setScanning(false);
    }
  };

  const handleFix = async (item) => {
    const siteData = sites.find((s) => s.id === selectedSite);
    const siteUrl = siteData?.url || "";
    if (isManual) {
      setFixing((prev) => ({ ...prev, [item.id]: true }));
      try {
        const r = await fixDuplicateContentDryRun(selectedSite, item.id);
        openManualSheet({
          title: "AI Fix Duplicate Content",
          wpAdminUrl: `${siteUrl}/wp-admin/post.php?post=${r.data.wp_id || item.wp_id}&action=edit`,
          fields: [
            { label: "Original Title", value: item.title_a || item.title || "", type: "text" },
            { label: "New Rewritten Title", value: r.data.new_title || "", type: "text" },
            { label: "New Rewritten Content (HTML)", value: r.data.new_content || "", type: "html" },
          ],
          instructions: "Replace the post title and paste the new content into the WordPress editor for this post.",
        });
      } catch (err) {
        toast.error(err.response?.data?.detail || "AI rewrite failed.");
      } finally {
        setFixing((prev) => ({ ...prev, [item.id]: false }));
      }
      return;
    }
    setFixing((prev) => ({ ...prev, [item.id]: true }));
    try {
      const r = await fixDuplicateContent(selectedSite, item.id);
      toast.success(`Rewritten: "${r.data.new_title}"`);
      setLastFixImpact(r.data?.impact_estimate || {
        traffic_change: "+3–7%",
        ranking_impact: "Reduced content overlap",
        ctr_change: "+1%",
        confidence: "medium",
      });
      // Mark resolved in local state
      setResults((prev) =>
        prev.map((res) =>
          res.id === item.id ? { ...res, resolved: true } : res
        )
      );
    } catch (err) {
      toast.error(err.response?.data?.detail || "AI rewrite failed. Try again.");
    } finally {
      setFixing((prev) => ({ ...prev, [item.id]: false }));
    }
  };

  const selectedSiteData = sites.find((s) => s.id === selectedSite);

  const unresolvedResults = results.filter((r) => !r.resolved);
  const contentCount = unresolvedResults.filter((r) => r.type === "content").length;
  const titleCount = unresolvedResults.filter((r) => r.type === "title").length;

  return (
    <div className="page-container" data-testid="duplicate-content-page">
      <div className="mb-8">
        <motion.h1
          className="page-title"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          Duplicate Content
        </motion.h1>
        <motion.p
          className="page-description"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
        >
          Detect near-duplicate and exact-duplicate content across your site and rewrite it with AI
        </motion.p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-4 mb-6">
        <div>
          <p className="text-sm text-muted-foreground mb-1.5">Select Site</p>
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-[240px]" data-testid="site-select">
              <SelectValue placeholder="Select a site" />
            </SelectTrigger>
            <SelectContent>
              {sites.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          onClick={handleScan}
          disabled={!selectedSite || scanning}
          className="btn-primary"
          data-testid="scan-btn"
        >
          {scanning
            ? <Loader2 size={15} className="mr-2 animate-spin" />
            : <ScanLine size={15} className="mr-2" />}
          Scan for Duplicates
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={loadResults}
          disabled={!selectedSite || loading}
          data-testid="refresh-btn"
          title="Refresh results"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      {/* Summary cards */}
      {results.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          {[
            { label: "Content Duplicates", count: contentCount, color: "text-orange-400" },
            { label: "Title Duplicates", count: titleCount, color: "text-purple-400" },
            { label: "Resolved", count: results.filter((r) => r.resolved).length, color: "text-emerald-500" },
          ].map(({ label, count, color }) => (
            <Card key={label} className="content-card">
              <CardContent className="pt-5 pb-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
                <p className={`text-2xl font-bold font-heading mt-1 ${color}`}>{count}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {lastFixImpact && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6"
        >
          <ImpactBadge impact={lastFixImpact} />
        </motion.div>
      )}

      {/* Results table */}
      <Card className="content-card">
        <CardHeader className="pb-3">
          <CardTitle className="font-heading flex items-center gap-2">
            <Copy size={18} className="text-primary" />
            Duplicate Pairs
          </CardTitle>
          <CardDescription>
            {unresolvedResults.length} unresolved pair{unresolvedResults.length !== 1 ? "s" : ""}
            {results.filter((r) => r.resolved).length > 0 &&
              ` · ${results.filter((r) => r.resolved).length} resolved`}
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={28} className="animate-spin text-primary" />
            </div>
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Copy size={48} className="text-muted-foreground/20 mb-4" />
              <p className="text-muted-foreground text-sm">
                {selectedSite
                  ? "No duplicates found. Click \"Scan for Duplicates\" to start."
                  : "Select a site to get started."}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Post A</TableHead>
                  <TableHead>Post B (to rewrite)</TableHead>
                  <TableHead>Similarity</TableHead>
                  <TableHead>Detected</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((item) => {
                  const editUrlA = selectedSiteData
                    ? `${selectedSiteData.url.replace(/\/$/, "")}/wp-admin/post.php?post=${item.post_a_id}&action=edit`
                    : null;
                  const editUrlB = selectedSiteData
                    ? `${selectedSiteData.url.replace(/\/$/, "")}/wp-admin/post.php?post=${item.post_b_id}&action=edit`
                    : null;

                  return (
                    <TableRow
                      key={item.id}
                      className={item.resolved ? "opacity-50" : ""}
                    >
                      <TableCell className="max-w-[180px]">
                        <a
                          href={editUrlA}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-primary flex items-center gap-1 text-sm font-medium truncate"
                        >
                          {item.post_a_title || `#${item.post_a_id}`}
                          <ExternalLink size={11} className="shrink-0 opacity-60" />
                        </a>
                      </TableCell>
                      <TableCell className="max-w-[180px]">
                        <a
                          href={editUrlB}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-primary flex items-center gap-1 text-sm font-medium truncate"
                        >
                          {item.post_b_title || `#${item.post_b_id}`}
                          <ExternalLink size={11} className="shrink-0 opacity-60" />
                        </a>
                      </TableCell>
                      <TableCell>
                        <SimilarityBadge score={item.similarity_score} type={item.type} />
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        {item.detected_at
                          ? new Date(item.detected_at).toLocaleString()
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.resolved ? (
                          <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
                            <CheckCircle2 size={11} className="mr-1" />
                            Resolved
                          </Badge>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleFix(item)}
                            disabled={!!fixing[item.id]}
                            className="h-8 text-xs"
                            data-testid={`fix-${item.id}`}
                          >
                            {fixing[item.id] ? (
                              <Loader2 size={13} className="mr-1.5 animate-spin" />
                            ) : (
                              <Sparkles size={13} className="mr-1.5 text-primary" />
                            )}
                            Rewrite with AI
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <SSEProgressDrawer tasks={tasks} dismissTask={dismissTask} />

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
