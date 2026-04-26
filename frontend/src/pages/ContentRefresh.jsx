import { useState, useEffect } from "react";
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
  Search
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
import { getSites, getContentRefreshItems, scanForRefresh, refreshContent, refreshContentDryRun } from "../lib/api";
import ImpactBadge from "../components/ImpactBadge";
import ManualApplySheet from "../components/ManualApplySheet";
import { useApplyMode } from "../hooks/useApplyMode";
import { toast } from "sonner";

export default function ContentRefresh() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [refreshing, setRefreshing] = useState({});
  const [lastRefreshImpact, setLastRefreshImpact] = useState(null);

  // Apply Mode
  const { isManual } = useApplyMode();
  const [manualSheet, setManualSheet] = useState({ open: false, title: "", wpAdminUrl: "", fields: [], instructions: "" });
  const openManualSheet = (config) => setManualSheet({ open: true, ...config });
  const closeManualSheet = () => setManualSheet((prev) => ({ ...prev, open: false }));

  useEffect(() => {
    loadSites();
  }, []);

  useEffect(() => {
    if (selectedSite) {
      loadItems();
    }
  }, [selectedSite]);

  const loadSites = async () => {
    try {
      const response = await getSites();
      setSites(response.data);
      if (response.data.length > 0) {
        setSelectedSite(response.data[0].id);
      }
    } catch (error) {
      toast.error("Failed to load sites");
    }
  };

  const loadItems = async () => {
    setLoading(true);
    try {
      const response = await getContentRefreshItems(selectedSite);
      setItems(response.data);
    } catch (error) {
      console.error("Failed to load items");
    } finally {
      setLoading(false);
    }
  };

  const handleScan = async () => {
    setScanning(true);
    try {
      const response = await scanForRefresh(selectedSite);
      setItems(response.data.items);
      toast.success(`Found ${response.data.items_found} items needing refresh`);
    } catch (error) {
      toast.error("Failed to scan content");
    } finally {
      setScanning(false);
    }
  };

  const handleRefresh = async (itemId) => {
    const siteData = sites.find((s) => s.id === selectedSite);
    const siteUrl = siteData?.url || "";
    const item = items.find((i) => i.id === itemId);
    if (isManual) {
      setRefreshing({ ...refreshing, [itemId]: true });
      try {
        const r = await refreshContentDryRun(selectedSite, itemId);
        openManualSheet({
          title: "AI Refresh Content",
          wpAdminUrl: `${siteUrl}/wp-admin/post.php?post=${r.data.wp_id || item?.wp_id}&action=edit`,
          fields: [
            { label: "Post Title", value: r.data.post_title || item?.title || "", type: "text" },
            { label: "Refreshed Content (HTML)", value: r.data.new_content || "", type: "html" },
          ],
          instructions: "Replace the existing content in the WordPress editor for this post with the refreshed version below.",
        });
      } catch (error) {
        toast.error(error.response?.data?.detail || "Failed to get refreshed content");
      } finally {
        setRefreshing({ ...refreshing, [itemId]: false });
      }
      return;
    }
    setRefreshing({ ...refreshing, [itemId]: true });
    try {
      const r = await refreshContent(selectedSite, itemId);
      setLastRefreshImpact(r.data?.impact_estimate || null);
      toast.success("Content refreshed with AI!");
      loadItems();
    } catch (error) {
      toast.error(error.response?.data?.detail || "Failed to refresh content");
    } finally {
      setRefreshing({ ...refreshing, [itemId]: false });
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
            Keep your content fresh and up-to-date with AI
          </motion.p>
        </div>

        <div className="flex items-center gap-3">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-[200px]" data-testid="site-select">
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

          <Button
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
          </Button>
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

          {lastRefreshImpact && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-6"
            >
              <ImpactBadge impact={lastRefreshImpact} />
            </motion.div>
          )}

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
                                View <ExternalLink size={10} />
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
                          <Button
                            size="sm"
                            className="btn-primary"
                            onClick={() => handleRefresh(item.id)}
                            disabled={refreshing[item.id] || item.status === "refreshed"}
                            data-testid={`refresh-${item.id}`}
                          >
                            {refreshing[item.id] ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <>
                                <Sparkles size={14} className="mr-1" />
                                Refresh
                              </>
                            )}
                          </Button>
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
                    <h4 className="font-medium mb-1">3. Refresh</h4>
                    <p className="text-sm text-muted-foreground">
                      AI rewrites and updates content while maintaining the original message
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </>
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
