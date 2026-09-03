import { AlertTriangle, Download, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScoreRing, scoreChip, scoreBg, scoreTone, ItemList, sevChip, STATUS_META } from "./shared";
import { cn } from "../../lib/utils";
import { useState } from "react";

function ActionRow({ action, index }) {
  const [open, setOpen] = useState(false);
  const meta = STATUS_META[action.status] || STATUS_META.info;
  return (
    <div className="border-b border-border/40 last:border-0">
      <div className={cn("flex items-start gap-3 px-3 py-2.5",
                         action.items?.length && "cursor-pointer hover:bg-muted/30")}
           onClick={() => action.items?.length && setOpen((o) => !o)}>
        <span className="text-xs font-mono text-muted-foreground w-5 shrink-0 mt-0.5">{index}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className={cn("text-[10px] px-1.5 py-0", meta.chip)}>{action.status}</Badge>
            <Badge className={cn("text-[10px] px-1.5 py-0", sevChip[action.severity])}>
              {action.severity}
            </Badge>
            <span className="text-sm font-medium">{action.label}</span>
            <span className="text-[11px] text-muted-foreground">· {action.category}</span>
            {action.affected > 0 && (
              <span className="text-[11px] font-mono text-muted-foreground">
                {action.affected} page{action.affected === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{action.detail}</p>
        </div>
      </div>
      {open && action.items?.length > 0 && <ItemList items={action.items} />}
    </div>
  );
}

export default function OverviewPanel({ summary, report, history, onOpenCategory, onExport }) {
  const cats = (summary?.categories || []).filter((c) => c.key !== "reporting");
  const actions = report?.actions || [];
  const failing = actions.filter((a) => a.status === "fail");
  const trend = (history || []).filter((h) => h.overall_score != null || h.site_score != null);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Overall SEO health</CardTitle>
            <CardDescription className="text-xs">
              The average of every category that could be measured
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-4">
              <ScoreRing score={summary?.overall_score ?? null} />
              <div className="text-sm space-y-1">
                <p className="text-muted-foreground text-xs">
                  {summary?.pages_audited ?? 0} pages audited
                </p>
                {summary?.pages_failed > 0 && (
                  <p className="text-yellow-500 text-xs flex items-center gap-1">
                    <AlertTriangle size={11} />{summary.pages_failed} unreachable
                  </p>
                )}
                {summary?.url_source && (
                  <p className="text-xs text-muted-foreground">Pages from {summary.url_source}</p>
                )}
                {summary?.site_score != null && (
                  <p className="text-xs text-muted-foreground">
                    Per-page average {summary.site_score}/100
                  </p>
                )}
                {summary?.created_at && (
                  <p className="text-[11px] text-muted-foreground">
                    {new Date(summary.created_at).toLocaleString()}
                  </p>
                )}
              </div>
            </div>

            {summary?.factor_summary?.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <p className="text-xs font-medium text-muted-foreground">Weakest page factors</p>
                {summary.factor_summary.slice(0, 6).map((f) => (
                  <div key={f.key} className="space-y-0.5">
                    <div className="flex justify-between text-xs">
                      <span>{f.label}</span>
                      <span className={cn("font-mono", scoreTone(f.average))}>{f.average}</span>
                    </div>
                    <div className="h-1 rounded bg-muted overflow-hidden">
                      <div className={cn("h-full rounded", scoreBg(f.average))}
                           style={{ width: `${f.average}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {trend.length > 1 && (
              <div className="pt-1 space-y-1">
                <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  <TrendingUp size={11} />Score over time
                </p>
                <div className="flex items-end gap-1 h-14">
                  {trend.slice(-24).map((h, i) => {
                    const v = h.overall_score ?? h.site_score ?? 0;
                    return (
                      <div key={i} className={cn("flex-1 rounded-t min-w-[3px]", scoreBg(v))}
                           style={{ height: `${Math.max(4, v)}%` }}
                           title={`${new Date(h.created_at).toLocaleDateString()} — ${v}/100`} />
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Every SEO area</CardTitle>
            <CardDescription className="text-xs">
              Click an area to see its checks and the pages behind them
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2">
            {cats.length === 0 && (
              <p className="text-xs text-muted-foreground col-span-full py-6 text-center">
                No audit yet — run one to populate all 20 areas.
              </p>
            )}
            {cats.map((c) => (
              <button key={c.key} onClick={() => onOpenCategory(c.key)}
                      className="text-left rounded-md border border-border/60 p-2.5 hover:border-primary/50
                                 hover:bg-muted/30 transition-colors">
                <div className="flex items-start justify-between gap-1">
                  <span className="text-xs font-medium leading-tight">{c.label}</span>
                  <Badge className={cn("text-[10px] font-mono shrink-0", scoreChip(c.score))}>
                    {c.score ?? "—"}
                  </Badge>
                </div>
                <div className="flex items-center gap-1.5 mt-1.5 text-[10px] font-mono">
                  {c.failing > 0 && <span className="text-red-400">{c.failing} fail</span>}
                  {c.warning > 0 && <span className="text-yellow-500">{c.warning} warn</span>}
                  {!c.failing && !c.warning && <span className="text-emerald-500">clear</span>}
                </div>
              </button>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between pb-3 gap-4">
          <div>
            <CardTitle className="text-base">
              What to fix first ({actions.length})
            </CardTitle>
            <CardDescription className="text-xs">
              {failing.length} failing and {actions.length - failing.length} warning checks, ordered by
              severity then by how many pages each one affects. Expand a row for the specific pages.
            </CardDescription>
          </div>
          <div className="flex gap-1.5 shrink-0">
            {["actions", "pages", "checks"].map((k) => (
              <Button key={k} size="sm" variant="outline" className="h-7 text-xs"
                      onClick={() => onExport(k)}>
                <Download size={11} className="mr-1" />{k}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {actions.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-12">
              {summary?.overall_score == null
                ? "Run an audit to build the fix list."
                : "Nothing failing or warning — every check passed."}
            </p>
          ) : (
            <div className="border-t max-h-[600px] overflow-y-auto">
              {actions.map((a, i) => <ActionRow key={a.category_key + a.id} action={a} index={i + 1} />)}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
