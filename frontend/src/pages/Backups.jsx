import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Archive, Plus, RotateCcw, Trash2, Loader2, RefreshCw, CheckCircle, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "../components/ui/alert-dialog";
import SSEProgressDrawer, { useSSETask } from "../components/SSEProgressDrawer";
import { getSites, listBackups, createBackup, restoreBackup, deleteBackup } from "../lib/api";
import { toast } from "sonner";

export default function Backups() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState(null); // { type: "restore"|"delete", id, label }
  const { tasks, startTask, dismissTask } = useSSETask();

  useEffect(() => { loadSites(); }, []);
  useEffect(() => { if (selectedSite) loadBackups(); }, [selectedSite]);

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data || []);
      if (r.data?.length) setSelectedSite(r.data[0].id);
    } catch { }
  };

  const loadBackups = async () => {
    setLoading(true);
    try {
      const r = await listBackups(selectedSite);
      setBackups(Array.isArray(r.data) ? r.data : []);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to load backups");
    } finally { setLoading(false); }
  };

  const handleCreate = async () => {
    try {
      const r = await createBackup(selectedSite);
      startTask(r.data.task_id, "Creating site backup...");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to start backup");
    }
  };

  const handleRestore = async () => {
    if (!confirm) return;
    setConfirm(null);
    try {
      const r = await restoreBackup(selectedSite, confirm.id);
      startTask(r.data.task_id, `Restoring backup: ${confirm.label}`);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to start restore");
    }
  };

  const handleDelete = async () => {
    if (!confirm) return;
    const id = confirm.id;
    setConfirm(null);
    try {
      await deleteBackup(selectedSite, id);
      setBackups(prev => prev.filter(b => b.id !== id));
      toast.success("Backup deleted");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to delete backup");
    }
  };

  const sizeLabel = (bytes) => {
    if (!bytes) return "—";
    if (bytes > 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes > 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  };

  const lastBackup = backups[0];
  const daysSince = lastBackup
    ? Math.floor((Date.now() - new Date(lastBackup.created_at)) / 86400000)
    : null;

  return (
    <div className="page-container">
      <div className="mb-8">
        <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          Backups
        </motion.h1>
        <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
          Create, schedule and restore site backups
        </motion.p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
        <Button onClick={loadBackups} variant="outline" size="sm" disabled={!selectedSite}>
          <RefreshCw size={14} className="mr-2" />Refresh
        </Button>
        <Button onClick={handleCreate} disabled={!selectedSite} size="sm">
          <Plus size={14} className="mr-2" />Create Backup
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <Card className="stat-card">
          <p className="stat-value">{backups.length}</p>
          <p className="stat-label">Total Backups</p>
        </Card>
        <Card className="stat-card">
          <p className="stat-value">{daysSince !== null ? `${daysSince}d ago` : "—"}</p>
          <p className="stat-label">Last Backup</p>
        </Card>
        <Card className="stat-card">
          <p className="stat-value">{sizeLabel(backups.reduce((acc, b) => acc + (b.size_bytes || 0), 0))}</p>
          <p className="stat-label">Total Size</p>
        </Card>
      </div>

      {/* Backup list */}
      <Card className="content-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Archive size={14} className="text-primary" />Backup History
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-primary" /></div>
          ) : backups.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              {selectedSite ? "No backups yet — create your first backup" : "Select a site"}
            </div>
          ) : (
            <div className="divide-y divide-border/30">
              {backups.map(b => (
                <div key={b.id} className="p-4 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                      {b.status === "complete" ? (
                        <CheckCircle size={14} className="text-emerald-500" />
                      ) : b.status === "in_progress" ? (
                        <Loader2 size={14} className="text-primary animate-spin" />
                      ) : (
                        <Clock size={14} className="text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-sm">{b.label || `Backup ${b.id?.slice(-6)}`}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(b.created_at).toLocaleString()} · {sizeLabel(b.size_bytes)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Badge variant="outline" className={`text-xs ${b.status === "complete" ? "border-emerald-500/30 text-emerald-500" : "border-gray-500/30 text-gray-400"}`}>
                      {b.status || "complete"}
                    </Badge>
                    <Button variant="outline" size="sm" className="h-7 text-xs"
                      onClick={() => setConfirm({ type: "restore", id: b.id, label: b.label || b.id })}>
                      <RotateCcw size={12} className="mr-1" />Restore
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs text-red-400 border-red-500/30"
                      onClick={() => setConfirm({ type: "delete", id: b.id, label: b.label || b.id })}>
                      <Trash2 size={12} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirm dialog */}
      <AlertDialog open={!!confirm} onOpenChange={() => setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.type === "restore" ? "Restore Backup?" : "Delete Backup?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.type === "restore"
                ? `This will restore your site to the state of "${confirm?.label}". The current site will be overwritten. This cannot be undone.`
                : `Delete backup "${confirm?.label}"? This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={confirm?.type === "delete" ? "bg-red-600 hover:bg-red-700" : ""}
              onClick={confirm?.type === "restore" ? handleRestore : handleDelete}>
              {confirm?.type === "restore" ? "Restore" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SSEProgressDrawer tasks={tasks} dismissTask={dismissTask} />
    </div>
  );
}
