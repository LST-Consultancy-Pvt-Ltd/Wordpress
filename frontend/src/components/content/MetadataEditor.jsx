import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Eraser } from "lucide-react";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import GatedButton from "../sa/GatedButton";
import ReadState from "../sa/ReadState";
import ErrorCallout from "../sa/ErrorCallout";
import { OptInBadge } from "../../pages/sites/SiteInventory";
import SourceOfTruth from "./SourceOfTruth";
import { useProposeChangeSet } from "./useProposeChangeSet";
import { useBridgeRead } from "../../hooks/useBridgeRead";
import { getInventory, listItems } from "../../lib/api";
import { writeBlockedReason } from "../../lib/capabilities";
import { EMPTY_FORM, fieldsToForm, formToFields, validateMetadataForm } from "../../lib/metadata";

function Field({ id, label, error, hint, children }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-red-500" role="alert" id={`${id}-err`}>{error}</p>}
    </div>
  );
}

/** Metadata editor per route: title, description, canonical, robots, OG, JSON-LD. */
export default function MetadataEditor({ site, initialRoute }) {
  const routesState = useBridgeRead(() => getInventory(site.id, "routes"), [site.id]);
  const metaState = useBridgeRead(() => getInventory(site.id, "metadata"), [site.id]);
  const routes = listItems(routesState.data).filter((r) => r.kind === "page");
  const overrides = useMemo(() => Object.fromEntries(listItems(metaState.data).map((m) => [m.route, m])), [metaState.data]);
  const [route, setRoute] = useState(initialRoute || "");
  const [form, setForm] = useState(EMPTY_FORM);
  const [touched, setTouched] = useState(false);
  const { propose, busy, error } = useProposeChangeSet(site.id);

  const current = routes.find((r) => r.route === route);
  const override = overrides[route];

  useEffect(() => {
    if (!route && routes.length) setRoute(initialRoute && routes.some((r) => r.route === initialRoute) ? initialRoute : routes[0].route);
  }, [routes, route, initialRoute]);

  useEffect(() => {
    setForm(fieldsToForm(override?.fields || {}));
    setTouched(false);
  }, [route, override]);

  const errors = validateMetadataForm(form);
  const invalid = Object.keys(errors).length > 0;
  const set = (k) => (e) => {
    setTouched(true);
    const v = e?.target ? e.target.value : e;
    setForm((f) => ({ ...f, [k]: v }));
  };
  const blocked = writeBlockedReason(site, "metadata.write");
  const notOptedIn = current && current.metadata !== "generateMetadata-optin";

  const save = () =>
    propose({
      title: `Metadata for ${route}`,
      source: "manual",
      operations: [{ op: "metadata.set", route, fields: formToFields(form) }],
    });
  const clear = () =>
    propose({ title: `Clear metadata override on ${route}`, operations: [{ op: "metadata.clear", route }] });

  return (
    <ReadState state={routesState} site={site} capability="inventory" isEmpty={!routes.length} empty="No page routes reported by the bridge.">
      <div className="space-y-4" data-testid="metadata-editor">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1 min-w-[260px]">
            <Label htmlFor="meta-route">Route</Label>
            <Select value={route} onValueChange={setRoute}>
              <SelectTrigger id="meta-route" data-testid="meta-route"><SelectValue placeholder="Choose a route" /></SelectTrigger>
              <SelectContent>
                {routes.map((r) => <SelectItem key={r.route} value={r.route}>{r.route}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {current && <OptInBadge status={current.metadata} />}
        </div>

        <SourceOfTruth>
          the bridge's runtime override store (<code>overrides</code> root), read by{" "}
          <code>withAutomationMetadata</code> in {current?.source ? <code>{current.source.root}/{current.source.path}</code> : "the route's page file"}.
          {override ? <> Last override revision <code>{override.revision_id || "—"}</code>.</> : " No override stored yet — the page's own metadata is used."}
        </SourceOfTruth>

        {notOptedIn && (
          <div className="flex gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs" role="alert" data-testid="not-opted-in">
            <AlertTriangle size={14} className="text-yellow-500 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              <strong>This route has not opted in.</strong> An override can be saved, but the plan will warn{" "}
              <code>METADATA_NOT_OPTED_IN</code> and the apply result will mark it <code>effective: false</code>. Wrap the route's
              metadata with <code>withAutomationMetadata</code> (a code change set in the Code workspace) to make overrides take effect.
            </span>
          </div>
        )}

        {!blocked || blocked.includes("does not offer") ? null : <ErrorCallout title="Writes blocked" message={blocked} />}

        <div className="grid md:grid-cols-2 gap-4">
          <Field id="meta-title" label={`Title (${form.title.length}/300)`} error={errors.title} hint="Recommended 30–60 characters.">
            <Input id="meta-title" value={form.title} onChange={set("title")} aria-invalid={!!errors.title} data-testid="meta-title" />
          </Field>
          <Field id="meta-canonical" label="Canonical" error={errors.canonical} hint="Absolute https:// URL or a path starting with /.">
            <Input id="meta-canonical" value={form.canonical} onChange={set("canonical")} aria-invalid={!!errors.canonical} data-testid="meta-canonical" />
          </Field>
          <div className="md:col-span-2">
            <Field id="meta-description" label={`Description (${form.description.length}/1000)`} error={errors.description} hint="Recommended 70–160 characters.">
              <Textarea id="meta-description" rows={3} value={form.description} onChange={set("description")} aria-invalid={!!errors.description} data-testid="meta-description" />
            </Field>
          </div>
          <fieldset className="md:col-span-2 rounded-md border border-border/50 p-3 space-y-2">
            <legend className="text-sm font-medium px-1">Robots</legend>
            <div className="flex flex-wrap items-center gap-6">
              <div className="flex items-center gap-2">
                <Switch id="meta-robots-set" checked={form.robotsSet} onCheckedChange={(v) => { setTouched(true); setForm((f) => ({ ...f, robotsSet: v })); }} />
                <Label htmlFor="meta-robots-set">Override robots</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="meta-index" checked={form.index} disabled={!form.robotsSet} onCheckedChange={(v) => setForm((f) => ({ ...f, index: v }))} data-testid="meta-index" />
                <Label htmlFor="meta-index">index</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="meta-follow" checked={form.follow} disabled={!form.robotsSet} onCheckedChange={(v) => setForm((f) => ({ ...f, follow: v }))} />
                <Label htmlFor="meta-follow">follow</Label>
              </div>
            </div>
            {form.robotsSet && !form.index && (
              <p className="text-xs text-yellow-500" role="alert">noindex removes this page from search results — the plan flags it as robots-noindex.</p>
            )}
          </fieldset>
          <Field id="meta-og-title" label="Open Graph title">
            <Input id="meta-og-title" value={form.ogTitle} onChange={set("ogTitle")} />
          </Field>
          <Field id="meta-og-image" label="Open Graph image" error={errors.ogImage}>
            <Input id="meta-og-image" value={form.ogImage} onChange={set("ogImage")} aria-invalid={!!errors.ogImage} />
          </Field>
          <div className="md:col-span-2">
            <Field id="meta-og-description" label="Open Graph description">
              <Textarea id="meta-og-description" rows={2} value={form.ogDescription} onChange={set("ogDescription")} />
            </Field>
          </div>
          <div className="md:col-span-2">
            <Field id="meta-jsonld" label="JSON-LD (object or array of objects, each with @type)" error={errors.jsonLd}>
              <Textarea id="meta-jsonld" rows={8} className="font-mono text-xs" value={form.jsonLd} onChange={set("jsonLd")} aria-invalid={!!errors.jsonLd} data-testid="meta-jsonld" placeholder='{"@context": "https://schema.org", "@type": "Article", "headline": "…"}' />
            </Field>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <GatedButton minRole="editor" blocked={blocked || (invalid ? "Fix the validation errors first" : null)} onClick={save} disabled={busy || !route || !touched} data-testid="save-metadata">
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Create change set
          </GatedButton>
          {override && (
            <GatedButton minRole="editor" variant="outline" blocked={blocked} onClick={clear} disabled={busy}>
              <Eraser size={14} aria-hidden="true" /> Propose clearing override
            </GatedButton>
          )}
        </div>
        {error && <ErrorCallout title="Change set not created" message={error.message} code={error.code} correlationId={error.correlationId} />}
      </div>
    </ReadState>
  );
}
