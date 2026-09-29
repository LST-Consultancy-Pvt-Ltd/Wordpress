import { useMemo, useState } from "react";
import { Loader2, RotateCcw, Image as ImageIcon, Type } from "lucide-react";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import GatedButton from "../sa/GatedButton";
import ReadState from "../sa/ReadState";
import ErrorCallout from "../sa/ErrorCallout";
import { ToneBadge } from "../sa/StatusBadge";
import SourceOfTruth from "./SourceOfTruth";
import { useProposeChangeSet } from "./useProposeChangeSet";
import { useBridgeRead } from "../../hooks/useBridgeRead";
import { getInventory, listItems } from "../../lib/api";
import { writeBlockedReason } from "../../lib/capabilities";

/**
 * Registered-block editor. `mode="text"` edits text/rich-text blocks
 * (block.set / block.clear); `mode="images"` edits image alt text
 * (image.alt.set / image.alt.clear). All edits for a route go into one change set.
 */
export default function BlocksEditor({ site, mode = "text" }) {
  const isImages = mode === "images";
  const capability = isImages ? "images.alt.write" : "blocks.write";
  const state = useBridgeRead(() => getInventory(site.id, "blocks"), [site.id]);
  const all = listItems(state.data).filter((b) => (isImages ? b.kind === "image" : b.kind === "text" || b.kind === "rich-text"));
  const routes = useMemo(() => [...new Set(all.map((b) => b.route))].sort(), [all]);
  const [route, setRoute] = useState("__all");
  const [edits, setEdits] = useState({}); // id -> value
  const [clears, setClears] = useState({}); // id -> true
  const { propose, busy, error } = useProposeChangeSet(site.id);
  const blocked = writeBlockedReason(site, capability);

  const visible = all.filter((b) => route === "__all" || b.route === route);
  const current = (b) => (isImages ? b.alt ?? "" : b.value ?? b.default ?? "");
  const errFor = (b, v) => {
    if (isImages && v.length > 250) return `Alt text is ${v.length} characters; the maximum is 250.`;
    return null;
  };
  const dirtyIds = Object.keys(edits).filter((id) => {
    const b = all.find((x) => x.id === id);
    return b && edits[id] !== current(b);
  });
  const clearIds = Object.keys(clears).filter((id) => clears[id]);
  const hasErrors = dirtyIds.some((id) => errFor(all.find((b) => b.id === id), edits[id]));

  const save = async () => {
    const operations = [
      ...dirtyIds.map((id) => {
        const b = all.find((x) => x.id === id);
        return isImages
          ? { op: "image.alt.set", image_id: id, alt: edits[id] }
          : { op: "block.set", block_id: id, value: edits[id], format: b.kind === "rich-text" ? "rich-text" : "text" };
      }),
      ...clearIds.filter((id) => !dirtyIds.includes(id)).map((id) => (isImages ? { op: "image.alt.clear", image_id: id } : { op: "block.clear", block_id: id })),
    ];
    const cs = await propose({
      title: `${isImages ? "Image alt text" : "Block copy"}: ${operations.length} change${operations.length === 1 ? "" : "s"}${route !== "__all" ? ` on ${route}` : ""}`,
      operations,
    });
    if (cs) {
      setEdits({});
      setClears({});
    }
  };

  return (
    <ReadState
      state={state}
      site={site}
      capability="inventory"
      isEmpty={!all.length}
      empty={isImages ? "No image blocks are registered. Register images in the site's block manifest to edit their alt text." : "No text blocks are registered. Register editable blocks in the site's block manifest."}
    >
      <div className="space-y-4" data-testid={isImages ? "images-editor" : "blocks-editor"}>
        <SourceOfTruth>
          the registered block manifest (defaults in code) merged with the bridge's overrides store. Saving creates{" "}
          <code>{isImages ? "image.alt.set" : "block.set"}</code> operations; rich text is sanitised by the bridge on write and render.
        </SourceOfTruth>
        {blocked && <ErrorCallout title="Editing unavailable" message={blocked} />}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1 min-w-[220px]">
            <Label htmlFor={`${mode}-route`} className="text-xs">Route</Label>
            <Select value={route} onValueChange={setRoute}>
              <SelectTrigger id={`${mode}-route`}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All routes</SelectItem>
                {routes.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <GatedButton minRole="editor" blocked={blocked || (hasErrors ? "Fix the validation errors first" : null)} onClick={save} disabled={busy || (!dirtyIds.length && !clearIds.length)} data-testid={`save-${mode}`}>
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            Create change set ({dirtyIds.length + clearIds.filter((id) => !dirtyIds.includes(id)).length})
          </GatedButton>
        </div>
        <ul className="space-y-3">
          {visible.map((b) => {
            const v = edits[b.id] ?? current(b);
            const err = errFor(b, v);
            const id = `blk-${b.id.replace(/[^a-z0-9_-]/gi, "_")}`;
            const Icon = isImages ? ImageIcon : Type;
            return (
              <li key={b.id} className="rounded-md border border-border/50 p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Icon size={12} aria-hidden="true" />
                  <Label htmlFor={id} className="font-mono">{b.id}</Label>
                  <span className="text-muted-foreground font-mono">{b.route}</span>
                  <ToneBadge tone="muted">{b.kind}</ToneBadge>
                  {(isImages ? b.alt != null : b.value != null) && <ToneBadge tone="info">overridden</ToneBadge>}
                  {clears[b.id] && <ToneBadge tone="warn">reset proposed</ToneBadge>}
                </div>
                {isImages || b.kind === "text" ? (
                  <Input id={id} value={v} onChange={(e) => setEdits((s) => ({ ...s, [b.id]: e.target.value }))} disabled={!!blocked} aria-invalid={!!err} />
                ) : (
                  <Textarea id={id} rows={4} className="font-mono text-xs" value={v} onChange={(e) => setEdits((s) => ({ ...s, [b.id]: e.target.value }))} disabled={!!blocked} aria-describedby={`${id}-help`} />
                )}
                {!isImages && b.kind === "rich-text" && (
                  <p id={`${id}-help`} className="text-[11px] text-muted-foreground">Allowed: p, br, strong, em, b, i, u, a, ul, ol, li, h2–h4, blockquote, code.</p>
                )}
                {b.default != null && !isImages && <p className="text-[11px] text-muted-foreground truncate">Default: {b.default}</p>}
                {err && <p className="text-xs text-red-500" role="alert">{err}</p>}
                {(isImages ? b.alt != null : b.value != null) && (
                  <GatedButton minRole="editor" variant="ghost" size="sm" blocked={blocked} onClick={() => setClears((s) => ({ ...s, [b.id]: !s[b.id] }))}>
                    <RotateCcw size={12} aria-hidden="true" /> {clears[b.id] ? "Keep override" : "Reset to default"}
                  </GatedButton>
                )}
              </li>
            );
          })}
        </ul>
        {error && <ErrorCallout title="Change set not created" message={error.message} code={error.code} correlationId={error.correlationId} />}
      </div>
    </ReadState>
  );
}
