import { Badge } from "../ui/badge";
import { STATUS_LABELS, STATUS_TONE } from "../../lib/changesets";

const TONES = {
  ok: "border-emerald-500/40 text-emerald-500 bg-emerald-500/10",
  warn: "border-yellow-500/40 text-yellow-500 bg-yellow-500/10",
  error: "border-red-500/40 text-red-500 bg-red-500/10",
  info: "border-primary/40 text-primary bg-primary/10",
  muted: "border-border text-muted-foreground bg-muted/30",
};

export function ToneBadge({ tone = "muted", children, className = "", ...props }) {
  return (
    <Badge variant="outline" className={`${TONES[tone] || TONES.muted} ${className}`} {...props}>
      {children}
    </Badge>
  );
}

export default function StatusBadge({ status, ...props }) {
  return (
    <ToneBadge tone={STATUS_TONE[status] || "muted"} data-testid="changeset-status" {...props}>
      {STATUS_LABELS[status] || status || "unknown"}
    </ToneBadge>
  );
}

const CONNECTION_TONE = {
  connected: "ok",
  degraded: "warn",
  unverified: "muted",
  unreachable: "error",
  revoked: "error",
};

export function ConnectionBadge({ status, ...props }) {
  return (
    <ToneBadge tone={CONNECTION_TONE[status] || "muted"} {...props}>
      {status || "unknown"}
    </ToneBadge>
  );
}

const ENV_TONE = { production: "error", staging: "warn", development: "info" };

export function EnvironmentBadge({ environment, ...props }) {
  return (
    <ToneBadge tone={ENV_TONE[environment] || "muted"} {...props}>
      {environment || "unknown"}
    </ToneBadge>
  );
}

const RISK_TONE = { low: "ok", medium: "warn", high: "error" };

export function RiskBadge({ level, ...props }) {
  return (
    <ToneBadge tone={RISK_TONE[level] || "muted"} {...props}>
      risk: {level || "unknown"}
    </ToneBadge>
  );
}
