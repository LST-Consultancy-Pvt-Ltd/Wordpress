import { useMemo, useState } from "react";
import { Columns2, Rows3, FileDiff } from "lucide-react";
import { parseUnifiedDiff, toSideBySideRows } from "../../lib/diff";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

const CELL = "px-2 py-0 font-mono text-xs whitespace-pre-wrap break-all align-top";
const NUM = "select-none text-right text-muted-foreground/60 px-2 font-mono text-[11px] align-top w-10";

const lineClass = (type) =>
  type === "add" ? "bg-emerald-500/10" : type === "del" ? "bg-red-500/10" : "";
const sign = (type) => (type === "add" ? "+" : type === "del" ? "-" : " ");

function UnifiedHunk({ hunk }) {
  return (
    <tbody>
      <tr className="bg-primary/5">
        <td colSpan={3} className="px-2 py-1 font-mono text-[11px] text-primary">{hunk.header}</td>
      </tr>
      {hunk.lines.map((l, i) => (
        <tr key={i} className={lineClass(l.type)} data-line-type={l.type}>
          <td className={NUM}>{l.oldNo ?? ""}</td>
          <td className={NUM}>{l.newNo ?? ""}</td>
          <td className={CELL}>
            <span aria-hidden="true" className="select-none opacity-60">{sign(l.type)}</span>
            <span className="sr-only">{l.type === "add" ? "added: " : l.type === "del" ? "removed: " : ""}</span>
            {l.text}
          </td>
        </tr>
      ))}
    </tbody>
  );
}

function SplitHunk({ hunk }) {
  const rows = useMemo(() => toSideBySideRows(hunk), [hunk]);
  return (
    <tbody>
      <tr className="bg-primary/5">
        <td colSpan={4} className="px-2 py-1 font-mono text-[11px] text-primary">{hunk.header}</td>
      </tr>
      {rows.map((r, i) => (
        <tr key={i} data-testid="diff-split-row">
          <td className={`${NUM} ${r.left ? lineClass(r.left.type) : "bg-muted/20"}`}>{r.left?.oldNo ?? ""}</td>
          <td className={`${CELL} border-r border-border/40 ${r.left ? lineClass(r.left.type) : "bg-muted/20"}`} data-side="left">
            {r.left ? (
              <>
                <span className="sr-only">{r.left.type === "del" ? "removed: " : ""}</span>
                {r.left.text}
              </>
            ) : null}
          </td>
          <td className={`${NUM} ${r.right ? lineClass(r.right.type) : "bg-muted/20"}`}>{r.right?.newNo ?? ""}</td>
          <td className={`${CELL} ${r.right ? lineClass(r.right.type) : "bg-muted/20"}`} data-side="right">
            {r.right ? (
              <>
                <span className="sr-only">{r.right.type === "add" ? "added: " : ""}</span>
                {r.right.text}
              </>
            ) : null}
          </td>
        </tr>
      ))}
    </tbody>
  );
}

/**
 * Renders a unified diff as unified or side-by-side tables, per file.
 * `mode` can be controlled; otherwise the viewer toggles it.
 */
export default function DiffView({ diff, defaultMode = "split", emptyText = "No changes." }) {
  const [mode, setMode] = useState(defaultMode);
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);

  if (!files.length) {
    return <p className="text-sm text-muted-foreground py-6 text-center" data-testid="diff-empty">{emptyText}</p>;
  }

  return (
    <div className="space-y-4" data-testid="diff-view" data-mode={mode}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </p>
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(v) => v && setMode(v)}
          aria-label="Diff layout"
          size="sm"
        >
          <ToggleGroupItem value="split" aria-label="Side-by-side diff" data-testid="diff-mode-split">
            <Columns2 size={14} /> <span className="text-xs">Side by side</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="unified" aria-label="Unified diff" data-testid="diff-mode-unified">
            <Rows3 size={14} /> <span className="text-xs">Unified</span>
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {files.map((f, fi) => (
        <section key={fi} className="rounded-md border border-border/50 overflow-hidden" aria-label={`Diff for ${f.path}`}>
          <header className="flex items-center gap-2 px-3 py-2 bg-muted/40 border-b border-border/50">
            <FileDiff size={14} className="text-muted-foreground" aria-hidden="true" />
            <span className="font-mono text-xs truncate" data-testid="diff-file-path">{f.path}</span>
            <span className="ml-auto text-[11px] text-emerald-500">+{f.additions}</span>
            <span className="text-[11px] text-red-500">-{f.deletions}</span>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse table-fixed">
              <colgroup>
                {mode === "split" ? (
                  <>
                    <col className="w-10" /><col /><col className="w-10" /><col />
                  </>
                ) : (
                  <>
                    <col className="w-10" /><col className="w-10" /><col />
                  </>
                )}
              </colgroup>
              {f.hunks.map((h, hi) =>
                mode === "split" ? <SplitHunk key={hi} hunk={h} /> : <UnifiedHunk key={hi} hunk={h} />
              )}
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
