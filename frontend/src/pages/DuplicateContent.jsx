import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Copy,
  ScanLine,
  Loader2,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  FileText,
  PencilLine,
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
import { getSites, scanDuplicateContent, getDuplicateContent, listItems, apiErrorMessage } from "../lib/api";
import SSEProgressDrawer, { useSSETask } from "../components/SSEProgressDrawer";
import GatedButton from "../components/sa/GatedButton";
import { toast } from "sonner";

/** Title cell: links to the public page when the scan reported its URL. */
function PageTitle({ title, fallback, url }) {
  const label = title || fallback;
  if (!url) return <span className="text-sm font-medium truncate block">{label}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:text-primary flex items-center gap-1 text-sm font-medium truncate"
    >
      {label}
      <ExternalLink size={11} className="shrink-0 opacity-60" aria-hidden="true" />
      <span className="sr-only">(opens live page in a new tab)</span>
    </a>
  );
}

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
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const timerRef = useRef(null);

  const { tasks, startTask, dismissTask } = useSSETask();

  useEffect(() => {
    getSites()
      .then((r) => {
        const list = listItems(r.data);
        setSites(list);
        if (list.length > 0) setSelectedSite(list[0].id);
      })
      .catch(() => toast.error("Failed to load sites"));
  }, []);

  const loadResults = useCallback(async () => {
    if (!selectedSite) return;
    setLoading(true);
    try {
      const r = await getDuplicateContent(selectedSite);
      setResults(listItems(r.data));
    } catch {
      toast.error("Failed to load duplicate content results");
    } finally {
      setLoading(false);
    }
  }, [selectedSite]);

  useEffect(() => {
    loadResults();
  }, [loadResults]);

  // Clean up the pending reload on unmount
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const handleScan = async () => {
    if (!selectedSite) return;
    setScanning(true);
    try {
      const r = await scanDuplicateContent(selectedSite);
      startTask(r.data.task_id, "Scanning for duplicate content");
      // Reload results after a short delay; the progress drawer shows live status.
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(async () => {
        timerRef.current = null;
        await loadResults();
        setScanning(false);
      }, 3000);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to start scan"));
      setScanning(false);
    }
  };

  const contentEditorUrl = `/sites/${selectedSite}/content`;

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
          Detect near-duplicate and exact-duplicate content across your site. Results are read-only — rewrite a page in the content editor, which creates a change set for review.
        </motion.p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-4 mb-6">
        <div>
          <p id="dup-site-label" className="text-sm text-muted-foreground mb-1.5">Select Site</p>
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-[240px]" data-testid="site-select" aria-labelledby="dup-site-label">
              <SelectValue placeholder="Select a site" />
            </SelectTrigger>
            <SelectContent>
              {sites.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <GatedButton
          minRole="editor"
          onClick={handleScan}
          disabled={!selectedSite || scanning}
          className="btn-primary"
          data-testid="scan-btn"
        >
          {scanning
            ? <Loader2 size={15} className="mr-2 animate-spin" />
            : <ScanLine size={15} className="mr-2" />}
          Scan for Duplicates
        </GatedButton>

        <Button
          variant="outline"
          size="sm"
          onClick={loadResults}
          disabled={!selectedSite || loading}
          data-testid="refresh-btn"
          title="Refresh results"
          aria-label="Refresh results"
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
                  <TableHead>Page A</TableHead>
                  <TableHead>Page B (to rewrite)</TableHead>
                  <TableHead>Similarity</TableHead>
                  <TableHead>Detected</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((item) => (
                  <TableRow
                    key={item.id}
                    className={item.resolved ? "opacity-50" : ""}
                  >
                    <TableCell className="max-w-[180px]">
                      <PageTitle title={item.post_a_title} fallback={`#${item.post_a_id}`} url={item.post_a_url} />
                    </TableCell>
                    <TableCell className="max-w-[180px]">
                      <PageTitle title={item.post_b_title} fallback={`#${item.post_b_id}`} url={item.post_b_url} />
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
                        <Button asChild size="sm" variant="outline" className="h-8 text-xs">
                          <Link to={contentEditorUrl} data-testid={`edit-${item.id}`}>
                            <PencilLine size={13} className="mr-1.5 text-primary" aria-hidden="true" />
                            Open in editor
                          </Link>
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <SSEProgressDrawer tasks={tasks} dismissTask={dismissTask} />
    </div>
  );
}
