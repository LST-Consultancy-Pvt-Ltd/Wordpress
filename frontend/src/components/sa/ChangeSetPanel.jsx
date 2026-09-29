import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Play,
  RotateCcw,
  Send,
  ShieldCheck,
  Eye,
  RefreshCw,
  Ban,
  ThumbsUp,
  ThumbsDown,
  ExternalLink,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Progress } from "../ui/progress";
import GatedButton from "./GatedButton";
import ConfirmDialog from "./ConfirmDialog";
import DiffView from "./DiffView";
import ErrorCallout from "./ErrorCallout";
import StatusBadge, { EnvironmentBadge, RiskBadge, ToneBadge } from "./StatusBadge";
import { useRole } from "../../hooks/useRole";
import { useTaskStream } from "../../hooks/useTaskStream";
import {
  apiErrorDetails,
  applyChangeSet,
  approveChangeSet,
  cancelChangeSet,
  getChangeSet,
  getSite,
  planChangeSet,
  previewChangeSet,
  rejectChangeSet,
  rollbackChangeSet,
  submitChangeSet,
  validateChangeSet,
} from "../../lib/api";
import {
  canApply,
  canCancel,
  canDecide,
  canRollback,
  canSubmit,
  canValidate,
  describeOperation,
  formatDate,
  isEditable,
} from "../../lib/changesets";
import { hasCapability, missingCapabilityReason, OP_CAPABILITY } from "../../lib/capabilities";

const TERMINAL_OR_IDLE = ["draft", "planned", "plan_failed", "validated", "validation_failed", "pending_approval", "approved", "rejected", "applied", "apply_failed", "rolled_back", "cancelled"];

function Section({ title, children, testId, actions }) {
  return (
    <Card className="content-card" data-testid={testId}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        {actions}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function StepStatus({ status }) {
  if (status === "succeeded" || status === "ok" || status === "passed") return <CheckCircle2 size={14} className="text-emerald-500" aria-label="succeeded" />;
  if (status === "failed" || status === "error") return <XCircle size={14} className="text-red-500" aria-label="failed" />;
  if (status === "running" || status === "queued") return <Loader2 size={14} className="animate-spin text-primary" aria-label={status} />;
  return <span className="text-xs text-muted-foreground">{status || "—"}</span>;
}

function errorFields(error) {
  if (!error) return null;
  if (typeof error === "string") return { message: error };
  return {
    message: error.message || JSON.stringify(error),
    code: error.code,
    correlationId: error.correlation_id,
    revisionId: error.details?.revision_id || error.revision_id,
  };
}

/** Live progress of the current task (validate/preview/apply/rollback). */
function TaskProgress({ task, onDone }) {
  const { events, status, message } = useTaskStream(task?.id, { onDone });
  if (!task) return null;
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2" role="status" aria-live="polite" data-testid="task-progress">
      <div className="flex items-center gap-2 text-sm">
        {status === "running" ? <Loader2 size={14} className="animate-spin text-primary" aria-hidden="true" /> : status === "complete" ? <CheckCircle2 size={14} className="text-emerald-500" aria-hidden="true" /> : <XCircle size={14} className="text-red-500" aria-hidden="true" />}
        <span className="font-medium">{task.label}</span>
        <span className="text-muted-foreground text-xs truncate">{message}</span>
      </div>
      {status === "running" && <Progress value={events.length ? Math.min(95, events.length * 10) : 5} className="h-1" />}
      {events.length > 0 && (
        <ol className="max-h-40 overflow-y-auto text-xs font-mono space-y-0.5" data-testid="task-events">
          {events.map((ev, i) => (
            <li key={i}>
              <span className="text-foreground/60">[{ev.type}]</span> {ev.data?.message || ev.data?.step || ev.data?.content || ""}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * Full change-set review surface: operations, plan (policy checks, risk,
 * impacted routes, diff), validation, preview, approvals, apply, result and
 * rollback. Every control is role- and capability-gated.
 */
export default function ChangeSetPanel({ changesetId, onChange, compact = false }) {
  const { user, can } = useRole();
  const [cs, setCs] = useState(null);
  const [site, setSite] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [task, setTask] = useState(null);
  const [dialog, setDialog] = useState(null); // apply|rollback|reject|approve|cancel

  const load = useCallback(async () => {
    try {
      const { data } = await getChangeSet(changesetId);
      setCs(data);
      setLoadError(null);
      onChange?.(data);
      if (data?.site_id) {
        const s = await getSite(data.site_id).catch(() => null);
        if (s) setSite(s.data);
      }
      return data;
    } catch (e) {
      setLoadError(apiErrorDetails(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, [changesetId, onChange]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // Poll while the change set is in a transient state and no stream is attached.
  useEffect(() => {
    if (!cs || task || TERMINAL_OR_IDLE.includes(cs.status)) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [cs, task, load]);

  const act = async (key, fn, { success, taskLabel } = {}) => {
    setBusy(key);
    setActionError(null);
    try {
      const { data } = await fn();
      if (data?.task_id) setTask({ id: data.task_id, label: taskLabel || key });
      if (success) toast.success(success);
      if (data?.id && data?.status) {
        setCs(data);
        onChange?.(data);
      } else {
        await load();
      }
      return data;
    } catch (e) {
      const d = apiErrorDetails(e);
      setActionError({ ...d, action: key });
      toast.error(d.message);
      throw e;
    } finally {
      setBusy(null);
    }
  };
  const safe = (p) => p.catch(() => {});

  if (loading && !cs) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-8" role="status">
        <Loader2 size={18} className="animate-spin" aria-hidden="true" /> Loading change set…
      </div>
    );
  }
  if (loadError && !cs) {
    return <ErrorCallout title="Could not load change set" message={loadError.message} code={loadError.code} correlationId={loadError.correlationId} />;
  }
  if (!cs) return null;

  const plan = cs.plan;
  const production = site?.environment === "production";
  const ownChange = user && (cs.created_by === user.id || cs.created_by === user.email);
  const selfApprovalBlocked = ownChange && production ? "You cannot approve your own change set on production" : null;
  const writesBlocked = site && !site.writes_enabled ? "Writes are not enabled for this site (an admin must verify and enable them)" : null;
  const missingOpCaps = [...new Set((cs.operations || []).map((o) => OP_CAPABILITY[o.op]).filter(Boolean))].filter(
    (c) => site && !hasCapability(site, c)
  );
  const capBlocked = missingOpCaps.length ? `The bridge lacks: ${missingOpCaps.join(", ")}` : null;
  const applyError = errorFields(cs.apply?.error);
  const ineffective = (cs.apply?.result?.operations || []).filter((o) => o.effective === false);
  const verification = cs.apply?.result?.verification;
  const validationSteps = cs.validation?.steps || [];

  const onTaskDone = () => {
    load();
    setTimeout(() => setTask(null), 1500);
  };

  return (
    <div className="space-y-6" data-testid="changeset-panel" data-status={cs.status}>
      {/* Summary */}
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          {!compact && (
            <h1 className="page-title mb-1 break-words" data-testid="changeset-title">{cs.title || cs.id}</h1>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge status={cs.status} />
            {site && <EnvironmentBadge environment={site.environment} />}
            {plan?.risk && <RiskBadge level={plan.risk.level} data-testid="risk-level" />}
            {site && (
              <Link to={`/sites/${site.id}`} className="hover:text-foreground">{site.name}</Link>
            )}
            <span>source: {cs.source || "manual"}</span>
            <span>by {cs.created_by || "—"} · {formatDate(cs.created_at)}</span>
            {cs.correlation_id && <span className="font-mono">corr {cs.correlation_id}</span>}
          </div>
          {cs.description && <p className="text-sm text-muted-foreground max-w-2xl">{cs.description}</p>}
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Change set actions">
          {isEditable(cs) && (
            <GatedButton minRole="editor" variant="outline" size="sm" onClick={() => safe(act("plan", () => planChangeSet(cs.id), { success: "Re-planned against the current revision" }))} disabled={!!busy} data-testid="replan-btn">
              <RefreshCw size={14} aria-hidden="true" /> Re-plan
            </GatedButton>
          )}
          {canValidate(cs) && (
            <GatedButton
              minRole="editor"
              variant="outline"
              size="sm"
              blocked={site ? missingCapabilityReason(site, "validate") : null}
              onClick={() => safe(act("validate", () => validateChangeSet(cs.id), { taskLabel: "Validation" }))}
              disabled={!!busy}
              data-testid="validate-btn"
            >
              <ShieldCheck size={14} aria-hidden="true" /> Validate
            </GatedButton>
          )}
          {canValidate(cs) && (
            <GatedButton
              minRole="editor"
              variant="outline"
              size="sm"
              blocked={site ? missingCapabilityReason(site, "preview") : null}
              onClick={() => safe(act("preview", () => previewChangeSet(cs.id), { taskLabel: "Preview build" }))}
              disabled={!!busy}
              data-testid="preview-btn"
            >
              <Eye size={14} aria-hidden="true" /> Preview
            </GatedButton>
          )}
          {canSubmit(cs) && (
            <GatedButton minRole="editor" size="sm" onClick={() => safe(act("submit", () => submitChangeSet(cs.id), { success: "Submitted for approval" }))} disabled={!!busy} data-testid="submit-btn">
              <Send size={14} aria-hidden="true" /> Submit for approval
            </GatedButton>
          )}
          {canDecide(cs) && (
            <>
              <GatedButton minRole="deployer" size="sm" blocked={selfApprovalBlocked} onClick={() => setDialog("approve")} disabled={!!busy} data-testid="approve-btn">
                <ThumbsUp size={14} aria-hidden="true" /> Approve
              </GatedButton>
              <GatedButton minRole="deployer" variant="outline" size="sm" onClick={() => setDialog("reject")} disabled={!!busy} data-testid="reject-btn">
                <ThumbsDown size={14} aria-hidden="true" /> Reject
              </GatedButton>
            </>
          )}
          {canApply(cs) && (
            <GatedButton minRole="deployer" size="sm" blocked={writesBlocked || capBlocked} onClick={() => setDialog("apply")} disabled={!!busy} data-testid="apply-btn">
              <Play size={14} aria-hidden="true" /> Apply…
            </GatedButton>
          )}
          {canRollback(cs) && (
            <GatedButton minRole="deployer" variant="destructive" size="sm" blocked={writesBlocked} onClick={() => setDialog("rollback")} disabled={!!busy} data-testid="rollback-btn">
              <RotateCcw size={14} aria-hidden="true" /> Roll back…
            </GatedButton>
          )}
          {canCancel(cs) && (
            <GatedButton minRole="editor" variant="ghost" size="sm" onClick={() => setDialog("cancel")} disabled={!!busy} data-testid="cancel-btn">
              <Ban size={14} aria-hidden="true" /> Cancel
            </GatedButton>
          )}
        </div>
      </div>

      {canApply(cs) && !can("deployer") && (
        <p className="text-xs text-muted-foreground">This change set is approved; a deployer or admin can apply it.</p>
      )}

      {actionError && (
        <ErrorCallout
          title={`Could not ${actionError.action}`}
          message={actionError.message}
          code={actionError.code}
          correlationId={actionError.correlationId}
          testId="action-error"
        >
          {actionError.code === "CONFLICT_REVISION" && (
            <p className="text-xs">The site changed since this plan was made. Re-plan, review the new diff, and approve again.</p>
          )}
        </ErrorCallout>
      )}

      <TaskProgress task={task} onDone={onTaskDone} />

      {/* Apply result */}
      {(cs.apply || cs.status === "apply_failed") && (
        <Section title="Apply result" testId="apply-result">
          {applyError ? (
            <ErrorCallout title="Apply failed" message={applyError.message} code={applyError.code} correlationId={applyError.correlationId} testId="apply-error">
              {applyError.code === "VERIFY_FAILED" && (
                <p className="text-xs">
                  Verification failed after writing, so the bridge restored its snapshot
                  {applyError.revisionId ? <> (revision <code>{applyError.revisionId}</code> recorded as rolled back)</> : null}. The site is unchanged.
                </p>
              )}
              {applyError.code === "CONFLICT_REVISION" && <p className="text-xs">The site moved on since planning. Re-plan and get a fresh approval.</p>}
            </ErrorCallout>
          ) : (
            <dl className="grid md:grid-cols-2 gap-x-6 text-sm">
              <div className="flex justify-between py-1 border-b border-border/20"><dt className="text-muted-foreground">Revision</dt><dd className="font-mono text-xs" data-testid="apply-revision">{cs.apply?.revision_id || "—"}</dd></div>
              <div className="flex justify-between py-1 border-b border-border/20"><dt className="text-muted-foreground">Applied by</dt><dd>{cs.apply?.applied_by || "—"}</dd></div>
              <div className="flex justify-between py-1 border-b border-border/20"><dt className="text-muted-foreground">Applied at</dt><dd>{formatDate(cs.apply?.applied_at)}</dd></div>
              <div className="flex justify-between py-1 border-b border-border/20"><dt className="text-muted-foreground">Hashes verified</dt><dd>{verification ? (verification.hashes_ok ? "yes" : "NO") : "—"}</dd></div>
            </dl>
          )}
          {verification?.routes?.length > 0 && (
            <ul className="mt-3 text-xs space-y-0.5" aria-label="Route verification">
              {verification.routes.map((r) => (
                <li key={r.route} className="flex gap-2">
                  {r.status < 500 ? <CheckCircle2 size={12} className="text-emerald-500" aria-hidden="true" /> : <XCircle size={12} className="text-red-500" aria-hidden="true" />}
                  <code>{r.route}</code> → {r.status}
                </li>
              ))}
            </ul>
          )}
          {ineffective.length > 0 && (
            <div className="mt-3 flex gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs" role="alert" data-testid="ineffective-warning">
              <AlertTriangle size={14} className="text-yellow-500 flex-shrink-0" aria-hidden="true" />
              <div>
                <strong>{ineffective.length} operation{ineffective.length === 1 ? " was" : "s were"} written but will not take effect</strong>{" "}
                (<code>effective: false</code>):
                <ul className="list-disc ml-4 mt-1">
                  {ineffective.map((o) => (
                    <li key={o.index}>{describeOperation(cs.operations?.[o.index])} — the route has not opted in with <code>withAutomationMetadata</code>.</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {cs.rollback && (
            <p className="mt-3 text-xs text-muted-foreground" data-testid="rollback-info">
              Rolled back by {cs.rollback.by} at {formatDate(cs.rollback.at)} → revision <code>{cs.rollback.revision_id}</code>
              {cs.rollback.reason ? <> — “{cs.rollback.reason}”</> : null}
            </p>
          )}
        </Section>
      )}

      <div className="grid xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 space-y-6">
          <Section title={`Operations (${cs.operations?.length || 0})`} testId="operations">
            <ol className="space-y-2">
              {(cs.operations || []).map((op, i) => {
                const err = plan?.errors?.filter((e) => e.index === i) || [];
                const warn = plan?.warnings?.filter((w) => w.index === i) || [];
                return (
                  <li key={i} className="rounded-md border border-border/40 p-2">
                    <details>
                      <summary className="cursor-pointer text-sm flex flex-wrap items-center gap-2">
                        <code className="text-xs text-muted-foreground">#{i}</code>
                        <code className="text-xs">{op.op}</code>
                        <span>{describeOperation(op)}</span>
                        {err.length > 0 && <ToneBadge tone="error">error</ToneBadge>}
                        {warn.length > 0 && <ToneBadge tone="warn">warning</ToneBadge>}
                      </summary>
                      <pre className="mt-2 text-xs font-mono bg-muted/30 rounded p-2 overflow-x-auto max-h-64">{JSON.stringify(op, null, 2)}</pre>
                    </details>
                    {[...err, ...warn].map((m, k) => (
                      <p key={k} className={`text-xs mt-1 ${err.includes(m) ? "text-red-500" : "text-yellow-500"}`}>
                        <code>{m.code}</code> {m.message}
                      </p>
                    ))}
                  </li>
                );
              })}
            </ol>
          </Section>

          <Section title="Diff" testId="diff-section">
            {plan ? (
              <DiffView diff={plan.diff} emptyText={plan.valid === false ? "Planning failed — no diff." : "No file changes."} />
            ) : (
              <p className="text-sm text-muted-foreground">Not planned yet.</p>
            )}
          </Section>
        </div>

        <div className="space-y-6">
          <Section title="Plan" testId="plan-section">
            {plan ? (
              <div className="space-y-3 text-sm">
                <p className="flex items-center gap-2">
                  {plan.valid ? <CheckCircle2 size={14} className="text-emerald-500" aria-hidden="true" /> : <XCircle size={14} className="text-red-500" aria-hidden="true" />}
                  {plan.valid ? "Plan is valid" : "Plan has errors"}
                </p>
                {(plan.errors || []).filter((e) => e.index == null).map((e, i) => (
                  <p key={i} className="text-xs text-red-500"><code>{e.code}</code> {e.message}</p>
                ))}
                {(plan.warnings || []).filter((w) => w.index == null).map((w, i) => (
                  <p key={i} className="text-xs text-yellow-500"><code>{w.code}</code> {w.message}</p>
                ))}
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1">Risk flags</p>
                  <div className="flex flex-wrap gap-1" data-testid="risk-flags">
                    {(plan.risk?.flags || []).map((f) => (
                      <ToneBadge key={f} tone={f === "code-change" || f === "deletes-content" || f === "robots-noindex" ? "warn" : "muted"}>{f}</ToneBadge>
                    ))}
                    {!plan.risk?.flags?.length && <span className="text-xs text-muted-foreground">none</span>}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1">Impacted routes</p>
                  <ul className="text-xs font-mono space-y-0.5" data-testid="impacted-routes">
                    {(plan.impacted_routes || []).map((r) => <li key={r}>{r}</li>)}
                    {!plan.impacted_routes?.length && <li className="text-muted-foreground font-sans">none</li>}
                  </ul>
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1">Files</p>
                  <ul className="text-xs font-mono space-y-0.5">
                    {(plan.files || []).map((f) => (
                      <li key={`${f.root}/${f.path}`}>{f.change} {f.root}/{f.path}</li>
                    ))}
                  </ul>
                </div>
                <p className="text-xs text-muted-foreground">
                  Base revision <code>{plan.base_revision || "none"}</code> · planned {formatDate(plan.planned_at)}
                  {plan.diff_sha256 && <> · diff sha256 <code className="break-all">{plan.diff_sha256.slice(0, 12)}…</code></>}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Not planned.</p>
            )}
          </Section>

          <Section title="Policy checks" testId="policy-checks">
            <ul className="space-y-1">
              {(cs.policy_checks || []).map((p) => (
                <li key={p.name} className="flex items-start gap-2 text-sm" data-ok={p.ok ? "true" : "false"}>
                  {p.ok ? <CheckCircle2 size={14} className="text-emerald-500 mt-0.5" aria-label="passed" /> : <XCircle size={14} className="text-red-500 mt-0.5" aria-label="failed" />}
                  <span><code className="text-xs">{p.name}</code>{p.message && <span className="block text-xs text-muted-foreground">{p.message}</span>}</span>
                </li>
              ))}
              {!cs.policy_checks?.length && <li className="text-sm text-muted-foreground">No checks recorded.</li>}
            </ul>
          </Section>

          <Section title="Validation" testId="validation-section">
            {validationSteps.length ? (
              <ul className="space-y-2">
                {validationSteps.map((s) => (
                  <li key={s.name} className="text-sm">
                    <details>
                      <summary className="cursor-pointer flex items-center gap-2">
                        <StepStatus status={s.status} />
                        <code className="text-xs">{s.name}</code>
                        {s.exit_code != null && <span className="text-xs text-muted-foreground">exit {s.exit_code}</span>}
                        {s.duration_ms != null && <span className="text-xs text-muted-foreground">{Math.round(s.duration_ms / 100) / 10}s</span>}
                      </summary>
                      {s.output_tail && <pre className="mt-1 text-[11px] font-mono bg-muted/30 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap">{s.output_tail}</pre>}
                    </details>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {site && !hasCapability(site, "validate") ? "The bridge does not run validation steps for this site." : "Not validated yet."}
              </p>
            )}
            {cs.validation?.status && <p className="text-xs text-muted-foreground mt-2">Job status: {cs.validation.status}</p>}
          </Section>

          <Section title="Preview" testId="preview-section">
            {cs.preview ? (
              <p className="text-sm">
                {cs.preview.url ? (
                  <a href={cs.preview.url} target="_blank" rel="noopener noreferrer" className="text-primary inline-flex items-center gap-1">
                    Open preview <ExternalLink size={12} aria-hidden="true" />
                  </a>
                ) : (
                  <span className="text-muted-foreground">Preview {cs.preview.status || "pending"}</span>
                )}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{site && !hasCapability(site, "preview") ? "No preview profile configured on the bridge." : "No preview yet."}</p>
            )}
          </Section>

          <Section title="Approval history" testId="approvals">
            <ol className="space-y-2">
              {(cs.approvals || []).map((a, i) => (
                <li key={i} className="text-sm">
                  <span className={a.decision === "approved" ? "text-emerald-500" : "text-red-500"}>{a.decision}</span> by {a.user_email || a.user_id}
                  <span className="block text-xs text-muted-foreground">{formatDate(a.at)}{a.comment ? ` — “${a.comment}”` : ""}</span>
                </li>
              ))}
              {!cs.approvals?.length && <li className="text-sm text-muted-foreground">No decisions yet.</li>}
            </ol>
          </Section>
        </div>
      </div>

      {/* Dialogs */}
      <ConfirmDialog
        open={dialog === "approve"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Approve this change set?"
        description="Approval records your review of the exact diff shown. Applying is a separate step."
        confirmLabel="Approve"
        reasonLabel="Comment (optional)"
        testId="approve-dialog"
        onConfirm={({ reason }) => act("approve", () => approveChangeSet(cs.id, reason || undefined), { success: "Approved" })}
      />
      <ConfirmDialog
        open={dialog === "reject"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Reject this change set?"
        confirmLabel="Reject"
        destructive
        reasonLabel="Reason"
        reasonRequired
        testId="reject-dialog"
        onConfirm={({ reason }) => act("reject", () => rejectChangeSet(cs.id, reason), { success: "Rejected" })}
      />
      <ConfirmDialog
        open={dialog === "apply"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Apply to ${site?.name || "site"}?`}
        description={
          <div className="space-y-1">
            <p>
              {cs.operations?.length || 0} operation(s), {plan?.files?.length || 0} file(s), risk {plan?.risk?.level || "unknown"}. The bridge snapshots
              every file first and restores it automatically if verification fails.
            </p>
            {production && <p className="text-red-500 font-medium">This is a production site.</p>}
          </div>
        }
        confirmText={production ? site?.name : undefined}
        confirmLabel="Apply change set"
        testId="apply-dialog"
        onConfirm={({ typed }) => act("apply", () => applyChangeSet(cs.id, production ? typed : undefined), { taskLabel: "Applying change set" })}
      />
      <ConfirmDialog
        open={dialog === "rollback"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Roll back revision ${cs.apply?.revision_id || ""}?`}
        description="The bridge restores the files as they were before this change set, as a new revision. If any file changed since, the rollback is refused."
        confirmText={site?.name}
        confirmLabel="Roll back"
        destructive
        reasonLabel="Reason"
        reasonRequired
        testId="rollback-dialog"
        onConfirm={({ typed, reason }) => act("rollback", () => rollbackChangeSet(cs.id, typed, reason), { taskLabel: "Rolling back" })}
      />
      <ConfirmDialog
        open={dialog === "cancel"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Cancel this change set?"
        description="It will be kept for the record but can no longer be applied."
        confirmLabel="Cancel change set"
        destructive
        testId="cancel-dialog"
        onConfirm={() => act("cancel", () => cancelChangeSet(cs.id), { success: "Cancelled" })}
      />
    </div>
  );
}
