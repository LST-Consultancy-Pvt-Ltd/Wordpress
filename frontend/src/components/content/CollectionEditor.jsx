import { useEffect, useMemo, useState } from "react";
import { FileText, Plus, Loader2, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import GatedButton from "../sa/GatedButton";
import ReadState from "../sa/ReadState";
import ErrorCallout from "../sa/ErrorCallout";
import ConfirmDialog from "../sa/ConfirmDialog";
import { ToneBadge } from "../sa/StatusBadge";
import MarkdownPreview from "../../lib/markdown";
import SourceOfTruth from "./SourceOfTruth";
import { useProposeChangeSet } from "./useProposeChangeSet";
import { useBridgeRead } from "../../hooks/useBridgeRead";
import { apiErrorDetails, getContentCollections, getContentItem, getContentItems, listItems } from "../../lib/api";
import { writeBlockedReason } from "../../lib/capabilities";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Render front-matter inputs from the adapter's JSON Schema (flat fields). */
function FrontmatterFields({ schema, value, onChange, errors }) {
  const props = schema?.properties || {};
  const required = schema?.required || [];
  const keys = Object.keys(props);
  const extra = Object.keys(value || {}).filter((k) => !props[k]);

  const set = (k, v) => onChange({ ...value, [k]: v });
  if (!keys.length) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor="fm-json">Front matter (JSON)</Label>
        <Textarea
          id="fm-json"
          className="font-mono text-xs min-h-[120px]"
          value={JSON.stringify(value || {}, null, 2)}
          onChange={(e) => {
            try {
              onChange(JSON.parse(e.target.value || "{}"));
            } catch {
              /* keep last valid value while typing */
            }
          }}
        />
        <p className="text-xs text-muted-foreground">This adapter has no front-matter schema; fields are free-form.</p>
      </div>
    );
  }
  return (
    <div className="grid md:grid-cols-2 gap-3">
      {keys.map((k) => {
        const p = props[k];
        const id = `fm-${k}`;
        const label = `${p.title || k}${required.includes(k) ? " *" : ""}`;
        const err = errors[k];
        const v = value?.[k];
        let input;
        if (p.type === "boolean") {
          input = (
            <div className="flex items-center gap-2 pt-1">
              <Switch id={id} checked={!!v} onCheckedChange={(c) => set(k, c)} />
            </div>
          );
        } else if (Array.isArray(p.enum)) {
          input = (
            <Select value={v ?? ""} onValueChange={(nv) => set(k, nv)}>
              <SelectTrigger id={id}><SelectValue placeholder="Choose…" /></SelectTrigger>
              <SelectContent>{p.enum.map((o) => <SelectItem key={o} value={String(o)}>{String(o)}</SelectItem>)}</SelectContent>
            </Select>
          );
        } else if (p.type === "array") {
          input = (
            <Input id={id} value={Array.isArray(v) ? v.join(", ") : ""} onChange={(e) => set(k, e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} aria-describedby={`${id}-help`} />
          );
        } else if (p.type === "number" || p.type === "integer") {
          input = <Input id={id} type="number" value={v ?? ""} onChange={(e) => set(k, e.target.value === "" ? undefined : Number(e.target.value))} />;
        } else {
          input = (
            <Input
              id={id}
              type={p.format === "date" ? "date" : "text"}
              value={v ?? ""}
              onChange={(e) => set(k, e.target.value)}
              maxLength={p.maxLength}
              aria-invalid={!!err}
            />
          );
        }
        return (
          <div key={k} className="space-y-1">
            <Label htmlFor={id}>{label}</Label>
            {input}
            {p.type === "array" && <p id={`${id}-help`} className="text-[11px] text-muted-foreground">Comma-separated</p>}
            {p.description && <p className="text-[11px] text-muted-foreground">{p.description}</p>}
            {err && <p className="text-xs text-red-500" role="alert">{err}</p>}
          </div>
        );
      })}
      {extra.length > 0 && (
        <p className="md:col-span-2 text-xs text-muted-foreground">Other fields kept as-is: {extra.join(", ")}</p>
      )}
    </div>
  );
}

function validateFrontmatter(schema, fm) {
  const errors = {};
  const props = schema?.properties || {};
  (schema?.required || []).forEach((k) => {
    const v = fm?.[k];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) errors[k] = "Required.";
  });
  Object.entries(props).forEach(([k, p]) => {
    const v = fm?.[k];
    if (typeof v === "string" && p.maxLength && v.length > p.maxLength) errors[k] = `At most ${p.maxLength} characters.`;
  });
  return errors;
}

function ItemEditor({ site, collection, slug, isNew, onClose, onSaved }) {
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState(null);
  const [fm, setFm] = useState({});
  const [body, setBody] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [status, setStatus] = useState("draft");
  const [showErrors, setShowErrors] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { propose, busy, error } = useProposeChangeSet(site.id);
  const canDelete = (collection.operations || []).includes("delete");
  const blocked = writeBlockedReason(site, "content.write");

  useEffect(() => {
    if (isNew) {
      setItem(null);
      setFm({});
      setBody("");
      setStatus("draft");
      return;
    }
    setLoading(true);
    getContentItem(site.id, collection.id, slug)
      .then(({ data }) => {
        setItem(data);
        setFm(data.frontmatter || {});
        setBody(data.body || "");
        setStatus(data.status || "draft");
        setLoadError(null);
      })
      .catch((e) => setLoadError(apiErrorDetails(e)))
      .finally(() => setLoading(false));
  }, [site.id, collection.id, slug, isNew]);

  const fmErrors = validateFrontmatter(collection.frontmatter_schema, fm);
  const slugErr = isNew && !SLUG_RE.test(newSlug) ? "Lowercase letters, digits and single hyphens (max 120)." : null;
  const valid = !Object.keys(fmErrors).length && !slugErr;
  const targetSlug = isNew ? newSlug : slug;

  const save = async () => {
    setShowErrors(true);
    if (!valid) return;
    const cs = await propose({
      title: `${isNew ? "Create" : "Update"} ${collection.id}/${targetSlug}${status === "published" ? " (publish)" : " (draft)"}`,
      source: "manual",
      operations: [
        {
          op: "content.upsert",
          collection: collection.id,
          slug: targetSlug,
          status,
          frontmatter: fm,
          body,
          base_sha256: isNew ? null : item?.sha256 ?? null,
        },
      ],
    });
    if (cs) onSaved?.(cs);
  };

  const remove = async () => {
    const cs = await propose({
      title: `Delete ${collection.id}/${slug}`,
      operations: [{ op: "content.delete", collection: collection.id, slug, base_sha256: item?.sha256 }],
    });
    if (!cs) throw new Error("failed");
  };

  if (loading) {
    return <div className="flex items-center gap-2 py-8 text-muted-foreground" role="status"><Loader2 size={16} className="animate-spin" aria-hidden="true" /> Loading item…</div>;
  }
  if (loadError) return <ErrorCallout title="Could not load item" message={loadError.message} code={loadError.code} correlationId={loadError.correlationId} />;

  return (
    <div className="space-y-4" data-testid="item-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">
          {isNew ? `New item in ${collection.id}` : <>Editing <code>{collection.id}/{slug}</code></>}
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>
      <SourceOfTruth>
        {item?.path ? <code>{item.path.root}/{item.path.path}</code> : <>the <code>{collection.root}</code> root ({collection.kind})</>} in the site repository.
        Saving creates a <code>content.upsert</code> change set{item?.sha256 ? " pinned to the current file hash" : ""}; nothing changes until it is approved and applied.
      </SourceOfTruth>
      {isNew && (
        <div className="space-y-1 max-w-sm">
          <Label htmlFor="new-slug">Slug</Label>
          <Input id="new-slug" value={newSlug} onChange={(e) => setNewSlug(e.target.value.trim().toLowerCase())} maxLength={120} aria-invalid={showErrors && !!slugErr} data-testid="new-slug" />
          {showErrors && slugErr && <p className="text-xs text-red-500" role="alert">{slugErr}</p>}
        </div>
      )}
      <FrontmatterFields schema={collection.frontmatter_schema} value={fm} onChange={setFm} errors={showErrors ? fmErrors : {}} />
      <Tabs defaultValue="write">
        <TabsList>
          <TabsTrigger value="write">Write</TabsTrigger>
          <TabsTrigger value="preview" data-testid="body-preview-tab">Preview</TabsTrigger>
        </TabsList>
        <TabsContent value="write">
          <Label htmlFor="item-body" className="sr-only">Body</Label>
          <Textarea id="item-body" className="font-mono text-sm min-h-[320px]" value={body} onChange={(e) => setBody(e.target.value)} data-testid="item-body" />
        </TabsContent>
        <TabsContent value="preview">
          <div className="rounded-md border border-border/50 p-4 min-h-[320px]">
            <MarkdownPreview source={body} />
          </div>
        </TabsContent>
      </Tabs>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="item-status">Status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger id="item-status" className="w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="published">Published</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <GatedButton minRole="editor" blocked={blocked} onClick={save} disabled={busy} data-testid="save-item">
          {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Create change set
        </GatedButton>
        {!isNew && canDelete && (
          <GatedButton minRole="editor" variant="outline" blocked={blocked} onClick={() => setDeleteOpen(true)} disabled={busy}>
            <Trash2 size={14} aria-hidden="true" /> Propose deletion
          </GatedButton>
        )}
        {showErrors && !valid && <p className="text-xs text-red-500" role="alert">Fix the highlighted fields first.</p>}
      </div>
      {error && <ErrorCallout title="Change set not created" message={error.message} code={error.code} correlationId={error.correlationId} />}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Propose deleting ${collection.id}/${slug}?`}
        description="This creates a change set flagged deletes-content; it still needs approval before anything is removed."
        confirmLabel="Create change set"
        destructive
        onConfirm={remove}
      />
    </div>
  );
}

export default function CollectionEditor({ site, initialCollection }) {
  const cols = useBridgeRead(() => getContentCollections(site.id), [site.id]);
  const collections = listItems(cols.data);
  const [colId, setColId] = useState(initialCollection || "");
  const [statusFilter, setStatusFilter] = useState("all");
  const [editing, setEditing] = useState(null); // {slug} | {isNew:true}
  const collection = useMemo(() => collections.find((c) => c.id === colId) || collections[0], [collections, colId]);
  const items = useBridgeRead(
    () => (collection ? getContentItems(site.id, collection.id, { status: statusFilter }) : Promise.resolve({ data: { items: [] } })),
    [site.id, collection?.id, statusFilter]
  );
  const rows = listItems(items.data);
  const canCreate = (collection?.operations || []).includes("create");

  return (
    <ReadState state={cols} site={site} capability="content.read" isEmpty={!collections.length} empty="No content collections are configured on the bridge.">
      <div className="grid lg:grid-cols-[280px_1fr] gap-6">
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="collection-select" className="text-xs">Collection</Label>
            <Select value={collection?.id || ""} onValueChange={(v) => { setColId(v); setEditing(null); }}>
              <SelectTrigger id="collection-select" data-testid="collection-select"><SelectValue /></SelectTrigger>
              <SelectContent>{collections.map((c) => <SelectItem key={c.id} value={c.id}>{c.id} ({c.kind})</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="status-select" className="text-xs">Status</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger id="status-select"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <GatedButton
            minRole="editor"
            size="sm"
            variant="outline"
            className="w-full"
            blocked={!canCreate ? "This adapter does not allow creating items" : writeBlockedReason(site, "content.write")}
            onClick={() => setEditing({ isNew: true })}
            data-testid="new-item"
          >
            <Plus size={14} aria-hidden="true" /> New item
          </GatedButton>
          <ReadState state={items} site={site} isEmpty={!rows.length} empty="No items.">
            <ul className="space-y-1 max-h-[480px] overflow-y-auto" aria-label="Items" data-testid="item-list">
              {rows.map((it) => (
                <li key={it.slug}>
                  <button
                    type="button"
                    onClick={() => setEditing({ slug: it.slug })}
                    className={`w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-muted/50 ${editing?.slug === it.slug ? "bg-primary/10 text-primary" : ""}`}
                    aria-current={editing?.slug === it.slug ? "true" : undefined}
                  >
                    <span className="flex items-center gap-2">
                      <FileText size={12} aria-hidden="true" />
                      <span className="truncate">{it.title || it.slug}</span>
                      <ToneBadge tone={it.status === "published" ? "ok" : "muted"} className="ml-auto text-[10px]">{it.status}</ToneBadge>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </ReadState>
        </div>
        <div>
          {editing && collection ? (
            <ItemEditor
              key={`${collection.id}:${editing.slug || "new"}`}
              site={site}
              collection={collection}
              slug={editing.slug}
              isNew={!!editing.isNew}
              onClose={() => setEditing(null)}
            />
          ) : (
            <p className="text-sm text-muted-foreground py-12 text-center">Select an item to edit, or create a new one.</p>
          )}
        </div>
      </div>
    </ReadState>
  );
}

