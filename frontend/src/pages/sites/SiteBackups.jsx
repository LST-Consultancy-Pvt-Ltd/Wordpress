import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Archive, Loader2, RefreshCw, History, Lock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import SiteHeader from "../../components/sa/SiteHeader";
import GatedButton from "../../components/sa/GatedButton";
import ReadState from "../../components/sa/ReadState";
import CapabilityNotice from "../../components/sa/CapabilityNotice";
import DiffView from "../../components/sa/DiffView";
import ErrorCallout from "../../components/sa/ErrorCallout";
import { ToneBadge } from "../../components/sa/StatusBadge";
import { useSite } from "../../hooks/useSite";
import { useBridgeRead } from "../../hooks/useBridgeRead";
import { useTaskStream } from "../../hooks/useTaskStream";
import { apiErrorDetails, createBackup, listBackups, listItems, restoreBackup } from "../../lib/api";
import { formatDate } from "../../lib/changesets";
import { hasCapability } from "../../lib/capabilities";

function fmtBytes(b) {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KiB`;
  return `${(b / 1024 / 1024).toFixed(1)} MiB`;
}

function RestoreDialog({ site, backup, onClose, onStarted }) {
  const [dry, setDry] = useState(null);
  const [loadingDry, setLoadingDry] = useState(false);
  const [confirmId, setConfirmId] = useState("");
  const [confirmSite, setConfirmSite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const runDry = async () => {
    setLoadingDry(true);
    setError(null);
    try {
      const { data } = await restoreBackup(site.id, backup.backup_id, { confirm: backup.backup_id, dry_run: true });
      setDry(data);
    } catch (e) {
      setError(apiErrorDetails(e));
    } finally {
      setLoadingDry(false);
    }
  };
  const ready = confirmId === backup.backup_id && confirmSite === site.name && !busy;
  const restore = async (e) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await restoreBackup(site.id, backup.backup_id, { confirm: backup.backup_id, confirm_site: site.name, dry_run: false });
      toast.success("Restore started");
      onStarted?.(data);
      onClose();
    } catch (err) {
      setError(apiErrorDetails(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="restore-dialog">
        <DialogHeader>
          <DialogTitle>Restore backup {backup.backup_id}</DialogTitle>
          <DialogDescription>
            A restore is applied like a change set (a new revision) and followed by a health check. Preview the diff first.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={restore}>
          <Button type="button" variant="outline" size="sm" onClick={runDry} disabled={loadingDry} data-testid="restore-dry-run">
            {loadingDry && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Dry run (show diff)
          </Button>
          {dry && <DiffView diff={dry.diff || ""} emptyText="The backup matches the current state." />}
          <div className="grid md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="restore-confirm-id">Type the backup id <code>{backup.backup_id}</code></Label>
              <Input id="restore-confirm-id" value={confirmId} onChange={(e) => setConfirmId(e.target.value)} autoComplete="off" data-testid="restore-confirm-id" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="restore-confirm-site">Type the site name <strong>{site.name}</strong></Label>
              <Input id="restore-confirm-site" value={confirmSite} onChange={(e) => setConfirmSite(e.target.value)} autoComplete="off" data-testid="restore-confirm-site" />
            </div>
          </div>
          {error && <ErrorCallout title="Restore failed" message={error.message} code={error.code} correlationId={error.correlationId} />}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" variant="destructive" disabled={!ready} data-testid="restore-confirm">
              {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Restore
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RestoreProgress({ task, onDone }) {
  const { status, message } = useTaskStream(task?.id, { onDone });
  if (!task) return null;
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm" role="status" aria-live="polite" data-testid="restore-progress">
      {status === "running" && <Loader2 size={14} className="inline animate-spin mr-2" aria-hidden="true" />}
      Recovery: <strong>{status}</strong> <span className="text-muted-foreground text-xs">{message}</span>
    </div>
  );
}

export default function SiteBackups() {
  const { id } = useParams();
  const { site, loading, error } = useSite(id);
  const backups = useBridgeRead(() => listBackups(id), [id]);
  const [kind, setKind] = useState("overrides");
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(null);
  const [task, setTask] = useState(null);

  if (!site) {
    return (
      <div className="page-container">
        <SiteHeader site={site} loading={loading} error={error} title="Backups" />
      </div>
    );
  }
  const items = listItems(backups.data);

  const create = async () => {
    setCreating(true);
    try {
      await createBackup(site.id, kind);
      toast.success("Backup created");
      backups.reload();
    } catch (e) {
      toast.error("Backup failed", { description: apiErrorDetails(e).message });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="page-container" data-testid="site-backups">
      <SiteHeader site={site} loading={loading} error={error} title="Backups" />
      {!hasCapability(site, "backups") ? (
        <CapabilityNotice capability="backups" site={site} />
      ) : (
        <div className="space-y-6">
          <Card className="content-card">
            <CardHeader><CardTitle className="text-base">Create a backup</CardTitle></CardHeader>
            <CardContent className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="backup-kind" className="text-xs">Kind</Label>
                <Select value={kind} onValueChange={setKind}>
                  <SelectTrigger id="backup-kind" className="w-[200px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="overrides">Overrides (metadata, blocks, redirects)</SelectItem>
                    <SelectItem value="content">Content roots</SelectItem>
                    <SelectItem value="full">Full (includes code)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <GatedButton minRole="deployer" onClick={create} disabled={creating} data-testid="create-backup">
                {creating ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />} Create backup
              </GatedButton>
              <p className="text-xs text-muted-foreground basis-full">Archives are encrypted with AES-256-GCM when the bridge has a backup key. Retention is set on the bridge.</p>
            </CardContent>
          </Card>
          <RestoreProgress task={task} onDone={() => backups.reload()} />
          <Card className="content-card">
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Backups</CardTitle>
              <Button variant="ghost" size="icon" onClick={backups.reload} aria-label="Refresh backups"><RefreshCw size={14} aria-hidden="true" /></Button>
            </CardHeader>
            <CardContent>
              <ReadState state={backups} site={site} isEmpty={!items.length} empty="No backups yet.">
                <Table className="data-table" data-testid="backups-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Backup</TableHead>
                      <TableHead>Kind</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Revision</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Requested by</TableHead>
                      <TableHead><span className="sr-only">Restore</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((b) => (
                      <TableRow key={b.backup_id}>
                        <TableCell className="font-mono text-xs">
                          {b.backup_id}
                          {b.encrypted && <Lock size={11} className="inline ml-1 text-emerald-500" aria-label="encrypted" />}
                        </TableCell>
                        <TableCell><ToneBadge tone="muted">{b.kind}</ToneBadge></TableCell>
                        <TableCell className="text-xs">{fmtBytes(b.bytes)}</TableCell>
                        <TableCell className="font-mono text-xs">{b.revision_id || "—"}</TableCell>
                        <TableCell className="text-xs">{formatDate(b.created_at)}</TableCell>
                        <TableCell className="text-xs">{b.requested_by || b.created_by || "—"}</TableCell>
                        <TableCell>
                          <GatedButton minRole="deployer" variant="outline" size="sm" onClick={() => setRestoring(b)} aria-label={`Restore ${b.backup_id}`}>
                            <History size={12} aria-hidden="true" /> Restore…
                          </GatedButton>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ReadState>
              <p className="text-xs text-muted-foreground mt-3">
                Restores and backups are recorded in the <Link to={`/audit?site_id=${site.id}`} className="text-primary hover:underline">audit log</Link> with correlation ids.
              </p>
            </CardContent>
          </Card>
        </div>
      )}
      {restoring && (
        <RestoreDialog
          site={site}
          backup={restoring}
          onClose={() => setRestoring(null)}
          onStarted={(data) => data?.task_id && setTask({ id: data.task_id })}
        />
      )}
    </div>
  );
}
