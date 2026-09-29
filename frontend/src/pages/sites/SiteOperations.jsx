import { useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { Rocket, RotateCcw, RefreshCw, Loader2, TerminalSquare } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Label } from "../../components/ui/label";
import { Button } from "../../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import SiteHeader from "../../components/sa/SiteHeader";
import GatedButton from "../../components/sa/GatedButton";
import ConfirmDialog from "../../components/sa/ConfirmDialog";
import ReadState from "../../components/sa/ReadState";
import CapabilityNotice from "../../components/sa/CapabilityNotice";
import ErrorCallout from "../../components/sa/ErrorCallout";
import { ToneBadge } from "../../components/sa/StatusBadge";
import { CapabilitiesTable, HealthChecks } from "../../components/sa/HandshakeDetails";
import { useSite } from "../../hooks/useSite";
import { useBridgeRead } from "../../hooks/useBridgeRead";
import { useTaskStream } from "../../hooks/useTaskStream";
import {
  apiErrorDetails,
  createDeployment,
  getDeploymentProfiles,
  getOpsLogs,
  getOpsStatus,
  getSiteHealth,
  listDeployments,
  listItems,
  rollbackDeployment,
} from "../../lib/api";
import { formatDate } from "../../lib/changesets";
import { hasCapability, missingCapabilityReason } from "../../lib/capabilities";

const DEPLOY_TONE = { succeeded: "ok", running: "info", failed: "error", rolled_back: "warn", unknown: "muted" };

function LiveTask({ task, onDone }) {
  const { events, status, message } = useTaskStream(task?.id, { onDone });
  if (!task) return null;
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm" role="status" aria-live="polite" data-testid="deploy-progress">
      <p className="flex items-center gap-2">
        {status === "running" && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
        <strong>{task.label}</strong> <span className="text-muted-foreground text-xs">{message}</span>
      </p>
      <ol className="mt-1 max-h-32 overflow-y-auto text-xs font-mono">
        {events.map((e, i) => <li key={i}>[{e.type}] {e.data?.message || e.data?.step || ""}</li>)}
      </ol>
    </div>
  );
}

function Logs({ site, services }) {
  const [service, setService] = useState(services[0] || "");
  const [lines, setLines] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const load = async () => {
    setLoading(true);
    try {
      const { data } = await getOpsLogs(site.id, service, 300);
      setLines(data?.lines || []);
      setError(null);
    } catch (e) {
      setError(apiErrorDetails(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="log-service" className="text-xs">Service</Label>
          <Select value={service} onValueChange={setService}>
            <SelectTrigger id="log-service" className="w-[200px]"><SelectValue placeholder="Service" /></SelectTrigger>
            <SelectContent>{services.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={!service || loading}>
          {loading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <TerminalSquare size={14} aria-hidden="true" />} Load last 300 lines
        </Button>
      </div>
      {error && <ErrorCallout title="Could not load logs" message={error.message} code={error.code} correlationId={error.correlationId} />}
      {lines && (
        <pre className="bg-black/60 text-xs font-mono p-3 rounded-md max-h-96 overflow-auto whitespace-pre-wrap" data-testid="container-logs" tabIndex={0} aria-label={`Logs for ${service}`}>
          {lines.join("\n") || "(no output)"}
        </pre>
      )}
    </div>
  );
}

export default function SiteOperations() {
  const { id } = useParams();
  const { site, loading, error, reload: reloadSite } = useSite(id);
  const status = useBridgeRead(() => getOpsStatus(id), [id]);
  const profiles = useBridgeRead(() => getDeploymentProfiles(id), [id]);
  const deployments = useBridgeRead(() => listDeployments(id), [id]);
  const health = useBridgeRead(() => getSiteHealth(id), [id]);
  const [profile, setProfile] = useState("");
  const [dialog, setDialog] = useState(null); // {kind:"deploy"} | {kind:"rollback", dep}
  const [task, setTask] = useState(null);
  const [actionError, setActionError] = useState(null);

  if (!site) {
    return (
      <div className="page-container">
        <SiteHeader site={site} loading={loading} error={error} title="Operations" />
      </div>
    );
  }

  const profileList = Array.isArray(profiles.data) ? profiles.data : listItems(profiles.data);
  const services = listItems(status.data);
  const deps = listItems(deployments.data);
  const production = site.environment === "production";
  const deployBlocked = missingCapabilityReason(site, "deploy");
  const chosen = profile || profileList[0]?.name || "";

  const runDeploy = async ({ typed, reason }) => {
    setActionError(null);
    try {
      const { data } = await createDeployment(site.id, { profile: chosen, reason, confirm: typed || undefined });
      setTask({ id: data.task_id, label: `Deploying ${chosen}` });
      toast.success("Deployment started");
    } catch (e) {
      const d = apiErrorDetails(e);
      setActionError(d);
      toast.error(d.message);
      throw e;
    }
  };
  const runRollback = async ({ typed, reason }) => {
    setActionError(null);
    try {
      const { data } = await rollbackDeployment(dialog.dep.deployment_id, typed || undefined, reason);
      if (data?.task_id) setTask({ id: data.task_id, label: `Rolling back ${dialog.dep.deployment_id}` });
      toast.success("Rollback started");
      deployments.reload();
    } catch (e) {
      const d = apiErrorDetails(e);
      setActionError(d);
      toast.error(d.message);
      throw e;
    }
  };

  return (
    <div className="page-container" data-testid="site-operations">
      <SiteHeader site={site} loading={loading} error={error} title="Operations" />
      <div className="grid lg:grid-cols-2 gap-6">
        <Card className="content-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Services</CardTitle>
            <Button variant="ghost" size="icon" onClick={status.reload} aria-label="Refresh service status"><RefreshCw size={14} aria-hidden="true" /></Button>
          </CardHeader>
          <CardContent>
            <ReadState state={status} site={site} isEmpty={!services.length} empty="No services in configured profiles.">
              <Table className="data-table">
                <TableHeader><TableRow><TableHead>Service</TableHead><TableHead>State</TableHead><TableHead>Image</TableHead><TableHead>Started</TableHead></TableRow></TableHeader>
                <TableBody>
                  {services.map((s) => (
                    <TableRow key={s.service}>
                      <TableCell className="font-mono text-xs">{s.service}</TableCell>
                      <TableCell><ToneBadge tone={s.health === "healthy" || s.state === "running" ? "ok" : "warn"}>{s.state}{s.health ? ` · ${s.health}` : ""}</ToneBadge></TableCell>
                      <TableCell className="text-xs font-mono break-all">{s.image}<span className="block text-muted-foreground">{s.image_id?.slice(0, 19)}</span></TableCell>
                      <TableCell className="text-xs">{formatDate(s.started_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ReadState>
            <p className="text-xs text-muted-foreground mt-3">
              Current revision <code>{health.data?.current_revision || "—"}</code> · image <code className="break-all">{site.capabilities?.deployment?.image || "—"}</code>
            </p>
          </CardContent>
        </Card>

        <Card className="content-card">
          <CardHeader><CardTitle className="text-base">Deploy</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {!hasCapability(site, "deploy") ? (
              <CapabilityNotice capability="deploy" site={site} compact />
            ) : (
              <ReadState state={profiles} site={site} isEmpty={!profileList.length} empty="No deployment profiles configured on the bridge.">
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="deploy-profile" className="text-xs">Profile</Label>
                    <Select value={chosen} onValueChange={setProfile}>
                      <SelectTrigger id="deploy-profile" className="w-[240px]" data-testid="deploy-profile"><SelectValue /></SelectTrigger>
                      <SelectContent>{profileList.map((p) => <SelectItem key={p.name} value={p.name}>{p.name} ({p.strategy})</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  {profileList.filter((p) => p.name === chosen).map((p) => (
                    <p key={p.name} className="text-xs text-muted-foreground">
                      Services: {(p.services || []).join(", ") || "—"} · smoke paths: {(p.smoke_paths || []).join(", ") || "—"}. Failed smoke checks roll back automatically.
                    </p>
                  ))}
                </div>
              </ReadState>
            )}
            <GatedButton minRole="deployer" blocked={deployBlocked || (!chosen ? "No deployment profile" : null)} onClick={() => setDialog({ kind: "deploy" })} data-testid="deploy-btn">
              <Rocket size={14} aria-hidden="true" /> Deploy…
            </GatedButton>
            {actionError && <ErrorCallout title="Operation failed" message={actionError.message} code={actionError.code} correlationId={actionError.correlationId} />}
            <LiveTask task={task} onDone={() => { deployments.reload(); status.reload(); }} />
          </CardContent>
        </Card>

        <Card className="content-card lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Deployment history</CardTitle>
            <Button variant="ghost" size="icon" onClick={deployments.reload} aria-label="Refresh deployments"><RefreshCw size={14} aria-hidden="true" /></Button>
          </CardHeader>
          <CardContent>
            <ReadState state={deployments} site={site} isEmpty={!deps.length} empty="No deployments yet.">
              <ul className="space-y-2" data-testid="deployment-history">
                {deps.map((d) => (
                  <li key={d.deployment_id} className="rounded-md border border-border/40 p-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <code className="text-xs">{d.deployment_id}</code>
                      <ToneBadge tone={DEPLOY_TONE[d.status] || "muted"}>{d.status}</ToneBadge>
                      <span className="text-xs text-muted-foreground">{d.profile} · {formatDate(d.started_at)} → {formatDate(d.finished_at)}</span>
                      {d.requested_by && <span className="text-xs text-muted-foreground">by {d.requested_by}</span>}
                      {d.job_status && <span className="text-xs text-muted-foreground">job: {d.job_status}</span>}
                      <span className="ml-auto">
                        <GatedButton
                          minRole="deployer"
                          variant="outline"
                          size="sm"
                          blocked={deployBlocked || (!d.previous_image_id ? "No previous image recorded" : null)}
                          onClick={() => setDialog({ kind: "rollback", dep: d })}
                          aria-label={`Roll back deployment ${d.deployment_id}`}
                        >
                          <RotateCcw size={12} aria-hidden="true" /> Roll back
                        </GatedButton>
                      </span>
                    </div>
                    {d.recovery && (
                      <p className="text-xs text-yellow-500 mt-1" data-testid="deployment-recovery">
                        Recovery: {typeof d.recovery === "string" ? d.recovery : d.recovery.status || JSON.stringify(d.recovery)}
                      </p>
                    )}
                    <p className="text-[11px] font-mono text-muted-foreground mt-1 break-all">
                      {d.previous_image_id?.slice(0, 19) || "—"} → {d.new_image_id?.slice(0, 19) || "—"}
                    </p>
                    {d.steps?.length > 0 && (
                      <details className="mt-2">
                        <summary className="text-xs cursor-pointer">Step logs ({d.steps.length})</summary>
                        <ol className="mt-1 space-y-1">
                          {d.steps.map((s, i) => (
                            <li key={i} className="text-xs">
                              <span className={s.status === "failed" ? "text-red-500" : s.status === "succeeded" ? "text-emerald-500" : ""}>{s.name}: {s.status}</span>
                              {s.output_tail && <pre className="text-[11px] font-mono bg-muted/30 rounded p-2 mt-1 max-h-40 overflow-auto whitespace-pre-wrap">{s.output_tail}</pre>}
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </ReadState>
          </CardContent>
        </Card>

        <Card className="content-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Bridge diagnostics</CardTitle>
            <Button variant="ghost" size="icon" onClick={() => { health.reload(); reloadSite(); }} aria-label="Refresh diagnostics"><RefreshCw size={14} aria-hidden="true" /></Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Last handshake {formatDate(site.connection?.last_handshake_at)} · agent {site.capabilities?.agent_version || "—"} · protocol v{site.capabilities?.protocol_version || "?"}
            </p>
            {site.connection?.last_error && <ErrorCallout title="Last bridge error" message={site.connection.last_error} />}
            <ReadState state={health} site={site}><HealthChecks health={health.data} /></ReadState>
          </CardContent>
        </Card>

        <Card className="content-card">
          <CardHeader><CardTitle className="text-base">Capability snapshot</CardTitle></CardHeader>
          <CardContent><CapabilitiesTable capabilities={site.capabilities} /></CardContent>
        </Card>

        <Card className="content-card lg:col-span-2">
          <CardHeader><CardTitle className="text-base">Container logs</CardTitle></CardHeader>
          <CardContent>
            {hasCapability(site, "ops.logs") ? <Logs site={site} services={services.map((s) => s.service)} /> : <CapabilityNotice capability="ops.logs" site={site} compact />}
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={dialog?.kind === "deploy"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Deploy profile “${chosen}” to ${site.name}?`}
        description="The bridge rebuilds and recreates the profile's services, waits for health and smoke checks, and rolls back automatically on failure."
        confirmText={production ? site.name : undefined}
        confirmLabel="Deploy"
        reasonLabel="Reason"
        reasonRequired
        testId="deploy-dialog"
        onConfirm={runDeploy}
      />
      <ConfirmDialog
        open={dialog?.kind === "rollback"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Roll back deployment ${dialog?.dep?.deployment_id || ""}?`}
        description="Redeploys the previously recorded image."
        confirmText={site.name}
        confirmLabel="Roll back"
        destructive
        reasonLabel="Reason"
        reasonRequired
        testId="deploy-rollback-dialog"
        onConfirm={runRollback}
      />
    </div>
  );
}
