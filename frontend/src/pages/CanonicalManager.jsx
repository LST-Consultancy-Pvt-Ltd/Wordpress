import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Link2, RefreshCw, Loader2, Wrench, CheckCircle2, AlertCircle, Edit2, Check, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Input } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { toast } from "sonner";
import { getSites, getCanonicals, updateCanonical, bulkFixCanonicals, subscribeToTask } from "../lib/api";
import ImpactBadge from "../components/ImpactBadge";
import ManualApplySheet from "../components/ManualApplySheet";
import { useApplyMode } from "../hooks/useApplyMode";

export default function CanonicalManager() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [bulkFixing, setBulkFixing] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState({});
  const [lastImpact, setLastImpact] = useState(null);

  // Apply Mode
  const { isManual } = useApplyMode();
  const [manualSheet, setManualSheet] = useState({ open: false, title: "", wpAdminUrl: "", fields: [], instructions: "" });
  const openManualSheet = (config) => setManualSheet({ open: true, ...config });
  const closeManualSheet = () => setManualSheet((prev) => ({ ...prev, open: false }));

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data || []);
      if (r.data?.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSite) loadCanonicals();
  }, [selectedSite]); // eslint-disable-line

  const loadCanonicals = async () => {
    setLoading(true);
    try {
      const r = await getCanonicals(selectedSite);
      setItems(r.data || []);
    } catch { setItems([]); }
    finally { setLoading(false); }
  };

  const startEdit = (item) => {
    setEditingId(item.wp_id);
    setEditValue(item.canonical);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue("");
  };

  const handleSave = async (item) => {
    if (!editValue.trim()) return;
    const siteData = sites.find((s) => s.id === selectedSite);
    const siteUrl = siteData?.url || "";
    if (isManual) {
      openManualSheet({
        title: "Save Canonical URL",
        wpAdminUrl: `${siteUrl}/wp-admin/post.php?post=${item.wp_id}&action=edit`,
        fields: [
          { label: "Post / Page Title", value: item.title || `#${item.wp_id}`, type: "text" },
          { label: "Current URL", value: item.url || "", type: "url" },
          { label: "New Canonical URL", value: editValue.trim(), type: "url" },
        ],
        instructions: "In the WordPress editor for this post/page, find the SEO plugin panel (Yoast/RankMath) → Advanced → Canonical URL, and paste the value.",
      });
      cancelEdit();
      return;
    }
    setSaving(prev => ({ ...prev, [item.wp_id]: true }));
    try {
      const r = await updateCanonical(selectedSite, item.wp_id, {
        canonical_url: editValue.trim(),
        content_type: item.content_type,
      });
      setItems(prev => prev.map(i => i.wp_id === item.wp_id
        ? { ...i, canonical: editValue.trim(), is_missing: false, is_self_referencing: editValue.trim() === i.url }
        : i
      ));
      if (r.data?.impact_estimate) setLastImpact(r.data.impact_estimate);
      setEditingId(null);
      toast.success("Canonical updated!");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Update failed");
    } finally { setSaving(prev => ({ ...prev, [item.wp_id]: false })); }
  };

  const handleBulkFix = async () => {
    const siteData = sites.find((s) => s.id === selectedSite);
    const siteUrl = siteData?.url || "";
    const missingItems = items.filter(i => i.is_missing);
    if (isManual) {
      openManualSheet({
        title: "Bulk Fix Canonicals",
        wpAdminUrl: `${siteUrl}/wp-admin/`,
        fields: missingItems.flatMap((item) => [
          { label: `${item.title || `#${item.wp_id}`} — Canonical URL`, value: item.url || `${siteUrl}/?p=${item.wp_id}`, type: "url" },
        ]),
        instructions: "For each post/page below, go to the WordPress editor → SEO plugin panel (Yoast/RankMath) → Advanced → Canonical URL, and paste the self-referencing URL.",
      });
      return;
    }
    setBulkFixing(true);
    toast.info("Bulk canonical fix started…");
    try {
      const r = await bulkFixCanonicals(selectedSite);
      const unsub = subscribeToTask(r.data.task_id, (ev) => {
        if (ev.type === "status" && ev.data?.step === ev.data?.total && ev.data?.total > 0) {
          unsub();
          setBulkFixing(false);
          loadCanonicals();
          toast.success(ev.data.message || "Bulk fix complete!");
        }
        if (ev.type === "error") { unsub(); setBulkFixing(false); toast.error(ev.data?.message || "Fix failed"); }
      });
    } catch (e) {
      toast.error(e.response?.data?.detail || "Bulk fix failed");
      setBulkFixing(false);
    }
  };

  const missingCount = items.filter(i => i.is_missing).length;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Canonical Tag Manager</h1>
          <p className="text-sm text-muted-foreground mt-1">Review and fix canonical URLs across all pages and posts</p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Select site" /></SelectTrigger>
            <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={loadCanonicals} disabled={loading}>
            <RefreshCw size={13} className={loading ? "animate-spin mr-1" : "mr-1"} /> Refresh
          </Button>
          <Button className="btn-primary" size="sm" onClick={handleBulkFix} disabled={bulkFixing || !selectedSite || missingCount === 0}>
            {bulkFixing ? <Loader2 size={13} className="mr-1 animate-spin" /> : <Wrench size={13} className="mr-1" />}
            Bulk Fix ({missingCount} missing)
          </Button>
        </div>
      </div>

      {lastImpact && (
        <ImpactBadge impact={lastImpact} />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Link2 size={18} className="text-primary" />
            Canonical URLs
            <Badge variant="secondary" className="ml-auto">{items.length} pages</Badge>
            {missingCount > 0 && <Badge className="bg-red-500/10 text-red-500 border-red-500/20">{missingCount} missing</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>
          ) : items.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground text-sm">
              Select a site and click Refresh to load canonical data.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Canonical URL</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Edit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map(item => (
                  <TableRow key={`${item.content_type}-${item.wp_id}`}>
                    <TableCell className="font-medium max-w-[180px] truncate">{item.title || `#${item.wp_id}`}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize text-xs">{item.content_type}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[260px]">
                      {editingId === item.wp_id ? (
                        <Input
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          className="h-7 text-xs"
                          autoFocus
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground truncate block">{item.canonical}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {item.is_missing ? (
                        <Badge className="bg-red-500/10 text-red-500 border-red-500/20">
                          <AlertCircle size={10} className="mr-1" /> Missing
                        </Badge>
                      ) : item.is_self_referencing ? (
                        <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
                          <CheckCircle2 size={10} className="mr-1" /> Self-ref
                        </Badge>
                      ) : (
                        <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20">Custom</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {editingId === item.wp_id ? (
                        <div className="flex gap-1 justify-end">
                          <Button variant="ghost" size="sm" onClick={() => handleSave(item)} disabled={saving[item.wp_id]}>
                            {saving[item.wp_id] ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} className="text-emerald-500" />}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={cancelEdit}>
                            <X size={12} className="text-red-400" />
                          </Button>
                        </div>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => startEdit(item)}>
                          <Edit2 size={13} />
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

      <ManualApplySheet
        open={manualSheet.open}
        onClose={closeManualSheet}
        title={manualSheet.title}
        wpAdminUrl={manualSheet.wpAdminUrl}
        fields={manualSheet.fields}
        instructions={manualSheet.instructions}
      />
    </motion.div>
  );
}
