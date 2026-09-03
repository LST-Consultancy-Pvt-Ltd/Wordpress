import { useState } from "react";
import { CheckCircle2, AlertTriangle, XCircle, Info, ChevronDown, ExternalLink } from "lucide-react";
import { Badge } from "../ui/badge";
import { cn } from "../../lib/utils";

/** A score is only ever green when it has actually earned it. `null` means the
 *  category could not be evaluated — deliberately neutral rather than zero,
 *  because "we could not measure this" is not the same as "this is broken". */
export const scoreTone = (s) =>
  s == null ? "text-muted-foreground"
    : s >= 90 ? "text-emerald-500"
    : s >= 75 ? "text-lime-500"
    : s >= 50 ? "text-yellow-500"
    : "text-red-400";

export const scoreBg = (s) =>
  s == null ? "bg-muted"
    : s >= 90 ? "bg-emerald-500"
    : s >= 75 ? "bg-lime-500"
    : s >= 50 ? "bg-yellow-500"
    : "bg-red-500";

export const scoreChip = (s) =>
  s == null ? "bg-muted text-muted-foreground"
    : s >= 90 ? "bg-emerald-500/10 text-emerald-500"
    : s >= 75 ? "bg-lime-500/10 text-lime-500"
    : s >= 50 ? "bg-yellow-500/10 text-yellow-500"
    : "bg-red-500/10 text-red-400";

export const STATUS_META = {
  pass: { icon: CheckCircle2, cls: "text-emerald-500", chip: "bg-emerald-500/10 text-emerald-500", label: "Pass" },
  warn: { icon: AlertTriangle, cls: "text-yellow-500", chip: "bg-yellow-500/10 text-yellow-500", label: "Warning" },
  fail: { icon: XCircle, cls: "text-red-400", chip: "bg-red-500/10 text-red-400", label: "Fail" },
  info: { icon: Info, cls: "text-blue-400", chip: "bg-blue-500/10 text-blue-400", label: "Info" },
};

export const sevChip = {
  high: "bg-red-500/10 text-red-400",
  medium: "bg-yellow-500/10 text-yellow-500",
  low: "bg-muted text-muted-foreground",
};

export function ScoreRing({ score, size = 112, label = "/ 100" }) {
  const pct = score == null ? 0 : score;
  const stroke =
    score == null ? "#6b7280"
      : score >= 90 ? "#10b981"
      : score >= 75 ? "#84cc16"
      : score >= 50 ? "#eab308"
      : "#ef4444";
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 36 36" className="-rotate-90" style={{ width: size, height: size }}>
        <circle cx="18" cy="18" r="15.5" fill="none" stroke="currentColor" strokeWidth="3"
                className="text-muted/30" />
        <circle cx="18" cy="18" r="15.5" fill="none" stroke={stroke} strokeWidth="3"
                strokeLinecap="round" strokeDasharray={`${(pct / 100) * 97.4} 97.4`} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn("font-bold font-mono", size > 90 ? "text-3xl" : "text-lg", scoreTone(score))}>
          {score ?? "—"}
        </span>
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</span>
      </div>
    </div>
  );
}

/** One finding. The affected pages live behind a disclosure because the whole
 *  point of listing them is to be able to go and fix them — a count alone
 *  sends you hunting. */
export function CheckRow({ check, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const meta = STATUS_META[check.status] || STATUS_META.info;
  const Icon = meta.icon;
  const hasItems = (check.items || []).length > 0;

  return (
    <div className="border-b border-border/40 last:border-0">
      <div
        className={cn("flex items-start gap-3 py-2.5 px-3", hasItems && "cursor-pointer hover:bg-muted/30")}
        onClick={() => hasItems && setOpen((o) => !o)}
      >
        <Icon size={15} className={cn("shrink-0 mt-0.5", meta.cls)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{check.label}</span>
            {check.status !== "pass" && check.status !== "info" && (
              <Badge className={cn("text-[10px] px-1.5 py-0", sevChip[check.severity] || "")}>
                {check.severity}
              </Badge>
            )}
            {check.value != null && String(check.value) !== "" && (
              <span className="text-[11px] font-mono text-muted-foreground truncate max-w-[240px]">
                {String(check.value)}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{check.detail}</p>
        </div>
        {hasItems && (
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[11px] text-muted-foreground font-mono">{check.items.length}</span>
            <ChevronDown size={12} className={cn("transition-transform", !open && "-rotate-90")} />
          </div>
        )}
      </div>
      {open && hasItems && <ItemList items={check.items} />}
    </div>
  );
}

/** The specific offenders behind a finding. Every row links out, because the
 *  next action after reading a finding is always to open the page. */
export function ItemList({ items, max = 200 }) {
  return (
    <div className="bg-muted/20 border-t border-border/40 max-h-72 overflow-y-auto">
      {items.slice(0, max).map((it, i) => (
        <div key={i} className="flex items-start gap-2 px-3 py-1.5 text-xs border-b border-border/20 last:border-0">
          {it.url ? (
            <a href={it.url} target="_blank" rel="noopener noreferrer"
               className="text-primary hover:underline flex items-center gap-1 shrink-0 max-w-[45%] truncate"
               onClick={(e) => e.stopPropagation()}>
              <ExternalLink size={9} className="shrink-0" />
              <span className="truncate">{it.path || it.url}</span>
            </a>
          ) : (
            <span className="font-mono shrink-0 max-w-[45%] truncate">{it.path}</span>
          )}
          {it.detail && <span className="text-muted-foreground break-all">{it.detail}</span>}
        </div>
      ))}
      {items.length > max && (
        <p className="px-3 py-1.5 text-[11px] text-muted-foreground">
          …and {items.length - max} more (the export has the full list).
        </p>
      )}
    </div>
  );
}

export function StatusPill({ counts }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-mono">
      {counts.failing > 0 && <span className="text-red-400">{counts.failing} fail</span>}
      {counts.warning > 0 && <span className="text-yellow-500">{counts.warning} warn</span>}
      {!counts.failing && !counts.warning && counts.passing > 0 && (
        <span className="text-emerald-500">all clear</span>
      )}
    </div>
  );
}

export const fmtMs = (v) => (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
