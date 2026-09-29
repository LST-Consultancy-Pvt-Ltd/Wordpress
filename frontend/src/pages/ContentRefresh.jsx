import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  RefreshCw,
  Loader2,
  AlertCircle,
  Calendar,
  TrendingDown,
  Sparkles,
  CheckCircle2,
  Clock,
  ExternalLink,
  Search,
  Eye,
  GitPullRequest,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  getSites,
  getContentRefreshItems,
  scanForRefresh,
  refreshContent,
  refreshContentDryRun,
  listItems,
  apiErrorMessage,
} from "../lib/api";
import { extractChangeSet, notifyChangeSetCreated } from "../lib/changesets";
import { writeBlockedReason } from "../lib/capabilities";
import GatedButton from "../components/sa/GatedButton";
import { toast } from "sonner";

export default function ContentRefresh() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [refreshing, setRefreshing] = useState({});
  const [previewing, setPreviewing] = useState({});
  const [preview, setPreview] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    getSites()
      .then((response) => {
        const list = listItems(response.data);
        setSites(list);
        if (list.length > 0) setSelectedSite(list[0].id);
      })
      .catch(() => toast.error("Failed to load sites"));
  }, []);

  const loadItems = useCallback(async () => {
    if (!selectedSite) return;
    setLoading(true);
    try {
      const response = await getContentRefreshItems(selectedSite);
      setItems(listItems(response.data));
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [selectedSite]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const site = sites.find((s) => s.id === selectedSite) || null;
  const writeBlocked = writeBlockedReason(site, "content.write");

  const handleScan = async () => {
    setScanning(true);
    try {
      const response = await scanForRefresh(selectedSite);
      setItems(listItems(response.data?.items));
      toast.success(`Found ${response.data?.items_found ?? 0} items needing refresh`);
    } catch (error) {
      toast.error(apiErrorMessage(error, "Failed to scan content"));
    } finally {
      setScanning(false);
    }
  };

  const handlePreview = async (item) => {
    setPreviewing((prev) => ({ ...prev, [item.id]: true }));
    try {
      const r = await refreshContentDryRun(selectedSite, item.id);
      setPreview({
        item,
        title: r.data?.post_title || item.title || "",
        content: r.data?.new_content || "",
      });
    } catch (error) {
      toast.error(apiErrorMessage(error, "Failed to preview refreshed content"));
    } finally {
      setPreviewing((prev) => ({ ...prev, [item.id]: false }));
    }
  };

  const handleRefresh = async (itemId) => {
    setRefreshing((prev) => ({ ...prev, [itemId]: true }));
    try {
      const r = await refreshContent(selectedSite, itemId);
      notifyChangeSetCreated(extractChangeSet(r.data), navigate, {
        title: "Change set created → review in Change Sets",
      });
      setPreview(null);
      loadItems();
    } catch (error) {
      toast.error(apiErrorMessage(error, "Failed to create change set"));
    } finally {
      setRefreshing((prev) => ({ ...prev, [itemId]: false }));
    }
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case "needs_refresh":
        return (
          <Badge variant="destructive" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">
            <Clock size={12} className="mr-1" />
            Needs Refresh
          </Badge>
        );
      case "refreshed":
        return (
          <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
            <CheckCircle2 size={12} className="mr-1" />
            Refreshed
          </Badge>
        );
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  return (
    <div className="page-container" data-testid="content-refresh-page">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <motion.h1
            className="page-title"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
          >
            Content Refresh
          </motion.h1>
          <motion.p
            className="page-description"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1 }}
          >
            Find outdated content and propose AI refreshes as draft change sets for review
          </motion.p>
        </div>

        <div className="flex items-center gap-3">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-[200px]" data-testid="site-select" aria-label="Site">
              <SelectValue placeholder="Select a site" />
            </SelectTrigger>
            <SelectContent>
              {sites.map((site) => (
                <SelectItem key={site.id} value={site.id}>
                  {site.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <GatedButton
            minRole="editor"
            className="btn-primary"
            onClick={handleScan}
            disabled={!selectedSite || scanning}
            data-testid="scan-content-btn"
          >
            {scanning ? (
              <Loader2 size={16} className="mr-2 animate-spin" />
            ) : (
              <Search size={16} className="mr-2" />
            )}
            Scan Content
          </GatedButton>
        </div>
      </div>

      {!selectedSite ? (
        <Card className="content-card">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <AlertCircle size={48} className="text-muted-foreground/30 mb-4" />
            <p className="text-muted-foreground">Please select a site to view content</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <Card className="stat-card">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="stat-value">{items.length}</p>
                    <p className="stat-label">Items to Review</p>
                  </div>
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <RefreshCw size={20} className="text-primary" />
                  </div>
                </div>
              </Card>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <Card className="stat-card">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="stat-value">
                      {items.filter(i => i.status === "needs_refresh").length}
                    </p>
                    <p className="stat-label">Needs Refresh</p>
                  </div>
                  <div className="w-10 h-10 rounded-lg bg-yellow-500/10 flex items-center justify-center">
                    <Calendar size={20} className="text-yellow-500" />
                  </div>
                </div>
              </Card>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
            >
              <Card className="stat-card">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="stat-value">
                      {items.filter(i => i.status === "refreshed").length}
                    </p>
                    <p className="stat-label">Refreshed</p>
                  </div>
                  <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                    <CheckCircle2 size={20} className="text-emerald-500" />
                  </div>
                </div>
              </Card>
            </motion.div>
          </div>

          {/* Content Table */}
          <Card className="content-card">
            <CardHeader>
              <CardTitle className="text-lg font-heading flex items-center gap-2">
                <RefreshCw size={18} className="text-primary" />
                Outdated Content
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 size={32} className="animate-spin text-primary" />
                </div>
              ) : items.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16">
                  <RefreshCw size={48} className="text-muted-foreground/30 mb-4" />
                  <h3 className="font-heading font-medium mb-1">No content to refresh</h3>
                  <p className="text-muted-foreground text-sm text-center max-w-md mb-4">
                    Click "Scan Content" to find posts and pages that may need updating.
                    Sync your site first if you haven't already.
                  </p>
                </div>
              ) : (
                <Table className="data-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Title</TableHead>
                      <TableHead>Age</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead className="text-right">Refresh</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          <div>
                            <p className="font-medium">{item.title}</p>
                            {item.url && (
                              <a
                                href={item.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 mt-1"
                              >
                                View <ExternalLink size={10} aria-hidden="true" />
                              </a>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Calendar size={14} className="text-muted-foreground" />
                            <span className={item.age_days > 365 ? "text-red-500" : "text-muted-foreground"}>
                              {item.age_days} days
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>{getStatusBadge(item.status)}</TableCell>
                        <TableCell>
                          <span className="text-sm text-muted-foreground">
                            {item.recommended_action || "Review content"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <GatedButton
                              minRole="editor"
                              size="sm"
                              variant="outline"
                              onClick={() => handlePreview(item)}
                              disabled={!!previewing[item.id]}
                              data-testid={`preview-${item.id}`}
                            >
                              {previewing[item.id] ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <>
                                  <Eye size={14} className="mr-1" aria-hidden="true" />
                                  Preview
                                </>
                              )}
                            </GatedButton>
                            <GatedButton
                              minRole="editor"
                              blocked={writeBlocked}
                              size="sm"
                              className="btn-primary"
                              onClick={() => handleRefresh(item.id)}
                              disabled={!!refreshing[item.id] || item.status === "refreshed"}
                              data-testid={`refresh-${item.id}`}
                            >
                              {refreshing[item.id] ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <>
                                  <GitPullRequest size={14} className="mr-1" aria-hidden="true" />
                                  Create change set
                                </>
                              )}
                            </GatedButton>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* How it works */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="mt-6"
          >
            <Card className="content-card">
              <CardHeader>
                <CardTitle className="text-lg font-heading">How Content Refresh Works</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="text-center">
                    <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
                      <Search size={24} className="text-primary" />
                    </div>
                    <h4 className="font-medium mb-1">1. Scan</h4>
                    <p className="text-sm text-muted-foreground">
                      AI scans your content for outdated posts older than 6 months
                    </p>
                  </div>
                  <div className="text-center">
                    <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
                      <TrendingDown size={24} className="text-primary" />
                    </div>
                    <h4 className="font-medium mb-1">2. Analyze</h4>
                    <p className="text-sm text-muted-foreground">
                      Identifies declining content based on age and performance metrics
                    </p>
                  </div>
                  <div className="text-center">
                    <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
                      <Sparkles size={24} className="text-primary" />
                    </div>
                    <h4 className="font-medium mb-1">3. Propose</h4>
                    <p className="text-sm text-muted-foreground">
                      AI rewrites the content and saves it as a draft change set; nothing changes on the site until it is reviewed, approved and applied in Change Sets
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </>
      )}

      <Dialog open={!!preview} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Refresh preview</DialogTitle>
            <DialogDescription>
              Dry run for “{preview?.title}”. Nothing has been changed. Create a change set to propose this version for review.
            </DialogDescription>
          </DialogHeader>
          <pre
            className="bg-muted/30 border border-border/40 rounded-lg p-3 text-xs font-mono whitespace-pre-wrap max-h-[50vh] overflow-y-auto"
            tabIndex={0}
            aria-label="Refreshed content preview"
          >
            {preview?.content || "The preview returned no content."}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)}>Close</Button>
            {preview?.item && (
              <GatedButton
                minRole="editor"
                blocked={writeBlocked}
                className="btn-primary"
                onClick={() => handleRefresh(preview.item.id)}
                disabled={!!refreshing[preview.item.id] || preview.item.status === "refreshed"}
              >
                {refreshing[preview.item.id] ? (
                  <Loader2 size={14} className="mr-1 animate-spin" />
                ) : (
                  <GitPullRequest size={14} className="mr-1" aria-hidden="true" />
                )}
                Create change set
              </GatedButton>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
