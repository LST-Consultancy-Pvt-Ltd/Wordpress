import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  LinkIcon,
  ScanLine,
  Loader2,
  Trash2,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  Filter,
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
import { getSites, scanBrokenLinks, getBrokenLinks, dismissBrokenLink } from "../lib/api";
import ImpactBadge from "../components/ImpactBadge";
import SSEProgressDrawer, { useSSETask } from "../components/SSEProgressDrawer";
import { toast } from "sonner";

function StatusBadge({ status, statusCode }) {
  if (status === "ok") {
    return (
      <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
        <CheckCircle2 size={11} className="mr-1" />
        OK {statusCode ? `(${statusCode})` : ""}
      </Badge>
    );
  }
  if (status === "timeout") {
    return (
      <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">
        <Clock size={11} className="mr-1" />
        Timeout
      </Badge>
    );
  }
  return (
    <Badge className="bg-red-500/10 text-red-500 border-red-500/20">
      <XCircle size={11} className="mr-1" />
      Broken {statusCode ? `(${statusCode})` : ""}
    </Badge>
  );
}

export default function BrokenLinks() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [dismissing, setDismissing] = useState({});

  const { tasks, startTask, dismissTask } = useSSETask();

  useEffect(() => { loadSites(); }, []);
  useEffect(() => { if (selectedSite) loadLinks(); }, [selectedSite, statusFilter]); // eslint-disable-line

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    } catch {
      toast.error("Failed to load sites");
    }
  };

  const loadLinks = async () => {
    setLoading(true);
    try {
      const filter = statusFilter === "all" ? undefined : statusFilter;
      const r = await getBrokenLinks(selectedSite, filter);
      setLinks(r.data || []);
    } catch {
      toast.error("Failed to load broken links");
    } finally {
      setLoading(false);
    }
  };

  const handleScan = async () => {
    if (!selectedSite) return;
    setScanning(true);
    try {
      const r = await scanBrokenLinks(selectedSite);
      startTask(r.data.task_id, "Scanning for broken links");
      // Reload results once the drawer task completes
      // We poll after a short delay; the SSE drawer shows live progress
      const poll = setInterval(async () => {
        const stillRunning = tasks.some(
          (t) => t.id === r.data.task_id && t.status === "running"
        );
        if (!stillRunning) {
          clearInterval(poll);
          await loadLinks();
          setScanning(false);
        }
      }, 2000);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to start scan");
      setScanning(false);
    }
  };

  const handleDismiss = async (linkId) => {
    setDismissing((prev) => ({ ...prev, [linkId]: true }));
    try {
      await dismissBrokenLink(selectedSite, linkId);
      setLinks((prev) => prev.filter((l) => l.id !== linkId));
      toast.success("Link dismissed");
    } catch {
      toast.error("Failed to dismiss link");
    } finally {
      setDismissing((prev) => ({ ...prev, [linkId]: false }));
    }
  };

  const selectedSiteData = sites.find((s) => s.id === selectedSite);

  const brokenCount = links.filter((l) => l.status === "broken").length;
  const timeoutCount = links.filter((l) => l.status === "timeout").length;
  const okCount = links.filter((l) => l.status === "ok").length;

  return (
    <div className="page-container" data-testid="broken-links-page">
      <div className="mb-8">
        <motion.h1
          className="page-title"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          Broken Links
        </motion.h1>
        <motion.p
          className="page-description"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
        >
          Detect and manage broken links across your WordPress site's content
        </motion.p>
      </div>

      {/* Site selector + scan button */}
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
          Scan for Broken Links
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={loadLinks}
          disabled={!selectedSite || loading}
          data-testid="refresh-btn"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      {/* Summary cards */}
      {links.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          {[
            { label: "Broken", count: brokenCount, color: "text-red-500" },
            { label: "Timeout", count: timeoutCount, color: "text-yellow-500" },
            { label: "OK", count: okCount, color: "text-emerald-500" },
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

      {links.length > 0 && (
        <ImpactBadge
          impact={{
            traffic_change: "+2–5%",
            ranking_impact: "Better crawlability",
            ctr_change: "+0.5%",
            confidence: "medium",
          }}
          className="mb-6"
        />
      )}

      {/* Filter + table */}
      <Card className="content-card">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <CardTitle className="font-heading flex items-center gap-2">
                <LinkIcon size={18} className="text-primary" />
                Scan Results
              </CardTitle>
              <CardDescription>
                {links.length} link{links.length !== 1 ? "s" : ""} found
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Filter size={14} className="text-muted-foreground" />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[140px] h-8 text-sm" data-testid="filter-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="broken">Broken</SelectItem>
                  <SelectItem value="timeout">Timeout</SelectItem>
                  <SelectItem value="ok">OK</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={28} className="animate-spin text-primary" />
            </div>
          ) : links.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <LinkIcon size={48} className="text-muted-foreground/20 mb-4" />
              <p className="text-muted-foreground text-sm">
                {selectedSite
                  ? "No results yet. Click \"Scan for Broken Links\" to start."
                  : "Select a site to view broken links."}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Post / Page</TableHead>
                  <TableHead>Broken URL</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Scanned</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {links.map((link) => {
                  const wpEditUrl = selectedSiteData
                    ? `${selectedSiteData.url.replace(/\/$/, "")}/wp-admin/post.php?post=${link.post_id}&action=edit`
                    : null;
                  return (
                    <TableRow key={link.id}>
                      <TableCell className="font-medium max-w-[180px] truncate">
                        {wpEditUrl ? (
                          <a
                            href={wpEditUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-primary flex items-center gap-1"
                          >
                            {link.post_title || `Post #${link.post_id}`}
                            <ExternalLink size={11} className="shrink-0 opacity-60" />
                          </a>
                        ) : (
                          link.post_title || `Post #${link.post_id}`
                        )}
                      </TableCell>
                      <TableCell className="max-w-[280px]">
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-muted-foreground hover:text-primary break-all flex items-start gap-1"
                        >
                          <span className="truncate">{link.url}</span>
                          <ExternalLink size={11} className="shrink-0 mt-0.5 opacity-60" />
                        </a>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={link.status} statusCode={link.status_code} />
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        {link.scanned_at
                          ? new Date(link.scanned_at).toLocaleString()
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDismiss(link.id)}
                          disabled={!!dismissing[link.id]}
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          title="Dismiss"
                          data-testid={`dismiss-${link.id}`}
                        >
                          {dismissing[link.id]
                            ? <Loader2 size={13} className="animate-spin" />
                            : <Trash2 size={13} />}
                        </Button>
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
    </div>
  );
}
