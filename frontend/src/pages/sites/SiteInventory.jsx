import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Plus, Trash2, CheckCircle2, AlertTriangle, MinusCircle } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Switch } from "../../components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import SiteHeader from "../../components/sa/SiteHeader";
import GatedButton from "../../components/sa/GatedButton";
import ReadState from "../../components/sa/ReadState";
import { ToneBadge } from "../../components/sa/StatusBadge";
import { useSite } from "../../hooks/useSite";
import { useBridgeRead } from "../../hooks/useBridgeRead";
import {
  apiErrorMessage,
  createChangeSet,
  getContentCollections,
  getInventory,
  getRevisions,
  getSiteHealth,
  listItems,
} from "../../lib/api";
import { extractChangeSet, formatDate, notifyChangeSetCreated } from "../../lib/changesets";
import { missingCapabilityReason } from "../../lib/capabilities";

const TABS = ["routes", "content", "metadata", "components", "assets", "redirects", "unsupported", "revision"];
const TAB_LABELS = {
  routes: "Routes",
  content: "Content collections",
  metadata: "Metadata coverage",
  components: "Editable components",
  assets: "Assets",
  redirects: "Redirects",
  unsupported: "Unsupported",
  revision: "Revision & deployment",
};

export function OptInBadge({ status }) {
  if (status === "generateMetadata-optin") return <ToneBadge tone="ok"><CheckCircle2 size={11} aria-hidden="true" /> opted in</ToneBadge>;
  if (status === "static") return <ToneBadge tone="warn"><AlertTriangle size={11} aria-hidden="true" /> static — not opted in</ToneBadge>;
  if (status === "none") return <ToneBadge tone="muted"><MinusCircle size={11} aria-hidden="true" /> no metadata</ToneBadge>;
  return <ToneBadge tone="muted">{status || "unknown"}</ToneBadge>;
}

function RoutesTab({ site, state }) {
  const items = listItems(state.data);
  return (
    <ReadState state={state} site={site} capability="inventory" isEmpty={!items.length} empty="No routes reported.">
      <Table className="data-table" data-testid="routes-table">
        <TableHeader>
          <TableRow>
            <TableHead>Route</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Metadata</TableHead>
            <TableHead>Blocks</TableHead>
            <TableHead>Adapter</TableHead>
            <TableHead>Source</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((r) => (
            <TableRow key={`${r.route}-${r.kind}`}>
              <TableCell className="font-mono text-xs">
                {r.route}
                {r.dynamic && <span className="ml-1 text-muted-foreground">(dynamic)</span>}
              </TableCell>
              <TableCell className="text-xs">{r.kind} · {r.router}</TableCell>
              <TableCell><OptInBadge status={r.metadata} /></TableCell>
              <TableCell className="text-xs">{(r.blocks || []).length ? r.blocks.join(", ") : "—"}</TableCell>
              <TableCell className="text-xs">{r.adapter || "—"}</TableCell>
              <TableCell className="text-xs font-mono">{r.source ? `${r.source.root}/${r.source.path}` : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ReadState>
  );
}

function ContentTab({ site, state }) {
  const items = listItems(state.data);
  return (
    <ReadState state={state} site={site} capability="content.read" isEmpty={!items.length} empty="No content adapters configured.">
      <Table className="data-table">
        <TableHeader>
          <TableRow>
            <TableHead>Collection</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Root</TableHead>
            <TableHead>Operations</TableHead>
            <TableHead>Front matter schema</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((c) => (
            <TableRow key={c.id}>
              <TableCell>
                <Link to={`/sites/${site.id}/content?collection=${encodeURIComponent(c.id)}`} className="text-primary hover:underline font-mono text-xs">{c.id}</Link>
              </TableCell>
              <TableCell className="text-xs">{c.kind}</TableCell>
              <TableCell className="text-xs font-mono">{c.root}</TableCell>
              <TableCell className="text-xs">{(c.operations || []).join(", ")}</TableCell>
              <TableCell className="text-xs">{c.frontmatter_schema ? `${Object.keys(c.frontmatter_schema.properties || {}).length} fields` : "none"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ReadState>
  );
}

function MetadataTab({ site, routesState, metaState }) {
  const routes = listItems(routesState.data).filter((r) => r.kind === "page");
  const overrides = useMemo(() => Object.fromEntries(listItems(metaState.data).map((m) => [m.route, m])), [metaState.data]);
  const optedIn = routes.filter((r) => r.metadata === "generateMetadata-optin").length;
  const withOverride = routes.filter((r) => overrides[r.route]).length;
  const pct = routes.length ? Math.round((optedIn / routes.length) * 100) : 0;
  return (
    <ReadState state={routesState} site={site} capability="inventory" isEmpty={!routes.length} empty="No page routes reported.">
      <div className="grid sm:grid-cols-3 gap-4 mb-4" data-testid="metadata-coverage">
        <div className="stat-card"><div className="stat-value">{pct}%</div><div className="stat-label">page routes opted in ({optedIn}/{routes.length})</div></div>
        <div className="stat-card"><div className="stat-value">{withOverride}</div><div className="stat-label">routes with an override</div></div>
        <div className="stat-card"><div className="stat-value">{routes.length - optedIn}</div><div className="stat-label">overrides would not take effect</div></div>
      </div>
      <Table className="data-table">
        <TableHeader>
          <TableRow>
            <TableHead>Route</TableHead>
            <TableHead>Opt-in</TableHead>
            <TableHead>Override</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead><span className="sr-only">Edit</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {routes.map((r) => {
            const o = overrides[r.route];
            return (
              <TableRow key={r.route}>
                <TableCell className="font-mono text-xs">{r.route}</TableCell>
                <TableCell><OptInBadge status={r.metadata} /></TableCell>
                <TableCell className="text-xs">{o ? Object.keys(o.fields || {}).join(", ") || "empty" : "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{o ? formatDate(o.updated_at) : "—"}</TableCell>
                <TableCell>
                  <Link className="text-xs text-primary hover:underline" to={`/sites/${site.id}/content?tab=metadata&route=${encodeURIComponent(r.route)}`}>Edit</Link>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ReadState>
  );
}

function ComponentsTab({ site, state }) {
  const items = listItems(state.data);
  return (
    <ReadState state={state} site={site} capability="inventory" isEmpty={!items.length} empty="No editable components registered. Register blocks in the site's block manifest.">
      <Table className="data-table">
        <TableHeader>
          <TableRow>
            <TableHead>Block id</TableHead>
            <TableHead>Route</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Current value</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((b) => (
            <TableRow key={b.id}>
              <TableCell className="font-mono text-xs">{b.id}</TableCell>
              <TableCell className="font-mono text-xs">{b.route}</TableCell>
              <TableCell className="text-xs">{b.kind}</TableCell>
              <TableCell className="text-xs max-w-md truncate">{b.kind === "image" ? `alt: ${b.alt ?? "—"}` : b.value ?? b.default ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ReadState>
  );
}

function AssetsTab({ site, state }) {
  const items = listItems(state.data);
  return (
    <ReadState state={state} site={site} capability="inventory" isEmpty={!items.length} empty="No assets reported.">
      <Table className="data-table">
        <TableHeader>
          <TableRow>
            <TableHead>Path</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>sha256</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((a) => (
            <TableRow key={`${a.root}/${a.path}`}>
              <TableCell className="font-mono text-xs">{a.root}/{a.path}</TableCell>
              <TableCell className="text-xs">{a.bytes != null ? `${(a.bytes / 1024).toFixed(1)} KiB` : "—"}</TableCell>
              <TableCell className="font-mono text-[11px] text-muted-foreground">{a.sha256 ? `${a.sha256.slice(0, 16)}…` : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ReadState>
  );
}

function RedirectsTab({ site, state }) {
  const navigate = useNavigate();
  const items = listItems(state.data);
  const [form, setForm] = useState({ source: "", destination: "", permanent: true });
  const [busy, setBusy] = useState(false);
  const blocked = missingCapabilityReason(site, "redirects.write");
  const srcErr = form.source && !/^\/[^\s?#]*$/.test(form.source) ? "Source must be a path starting with /" : null;
  const dstErr = form.destination && !/^(\/[^\s]*|https:\/\/\S+)$/.test(form.destination) ? "Destination must be a path or an https:// URL" : null;

  const propose = async (operations, title) => {
    setBusy(true);
    try {
      const { data } = await createChangeSet(site.id, { title, source: "redirects", operations });
      notifyChangeSetCreated(extractChangeSet(data), navigate);
      setForm({ source: "", destination: "", permanent: true });
    } catch (e) {
      toast.error("Could not create change set", { description: apiErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <form
        className="grid md:grid-cols-[1fr_1fr_auto_auto] gap-3 items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (!form.source || !form.destination || srcErr || dstErr) return;
          propose([{ op: "redirect.upsert", source: form.source, destination: form.destination, permanent: form.permanent }], `Redirect ${form.source} → ${form.destination}`);
        }}
        aria-label="Propose a redirect"
      >
        <div className="space-y-1">
          <Label htmlFor="redir-src" className="text-xs">Source path</Label>
          <Input id="redir-src" value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value.trim() }))} placeholder="/old-page" aria-invalid={!!srcErr} />
          {srcErr && <p className="text-xs text-red-500" role="alert">{srcErr}</p>}
        </div>
        <div className="space-y-1">
          <Label htmlFor="redir-dst" className="text-xs">Destination</Label>
          <Input id="redir-dst" value={form.destination} onChange={(e) => setForm((f) => ({ ...f, destination: e.target.value.trim() }))} placeholder="/new-page" aria-invalid={!!dstErr} />
          {dstErr && <p className="text-xs text-red-500" role="alert">{dstErr}</p>}
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch id="redir-perm" checked={form.permanent} onCheckedChange={(v) => setForm((f) => ({ ...f, permanent: v }))} />
          <Label htmlFor="redir-perm" className="text-xs">Permanent</Label>
        </div>
        <GatedButton type="submit" minRole="editor" blocked={blocked} disabled={busy || !form.source || !form.destination || !!srcErr || !!dstErr} data-testid="add-redirect">
          <Plus size={14} aria-hidden="true" /> Create change set
        </GatedButton>
      </form>
      <ReadState state={state} site={site} capability="inventory" isEmpty={!items.length} empty="No redirects configured.">
        <Table className="data-table">
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead>Type</TableHead>
              <TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((r) => (
              <TableRow key={r.source}>
                <TableCell className="font-mono text-xs">{r.source}</TableCell>
                <TableCell className="font-mono text-xs">{r.destination}</TableCell>
                <TableCell className="text-xs">{r.permanent ? "permanent (308)" : "temporary (307)"}</TableCell>
                <TableCell>
                  <GatedButton
                    variant="ghost"
                    size="sm"
                    minRole="editor"
                    blocked={blocked}
                    disabled={busy}
                    onClick={() => propose([{ op: "redirect.delete", source: r.source }], `Remove redirect ${r.source}`)}
                    aria-label={`Remove redirect ${r.source}`}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </GatedButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ReadState>
    </div>
  );
}

function UnsupportedTab({ site, state, routesState }) {
  const items = listItems(state.data);
  const routeUnsupported = routesState.data?.unsupported || [];
  return (
    <ReadState state={state} site={site} capability="inventory" isEmpty={!items.length && !routeUnsupported.length} empty="Nothing unsupported — everything the bridge found can be managed.">
      <ul className="space-y-2" data-testid="unsupported-list">
        {items.map((u, i) => (
          <li key={`f${i}`} className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3 text-sm">
            <strong>{u.feature}</strong>
            <span className="block text-xs text-muted-foreground">{u.reason}</span>
          </li>
        ))}
        {routeUnsupported.map((u, i) => (
          <li key={`r${i}`} className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3 text-sm">
            <code className="text-xs">{u.route}</code>
            <span className="block text-xs text-muted-foreground">{u.reason}</span>
          </li>
        ))}
      </ul>
    </ReadState>
  );
}

function RevisionTab({ site }) {
  const health = useBridgeRead(() => getSiteHealth(site.id), [site.id]);
  const revs = useBridgeRead(() => getRevisions(site.id), [site.id]);
  const items = listItems(revs.data);
  const dep = site.capabilities?.deployment;
  const repo = site.capabilities?.repository;
  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className="space-y-2 text-sm">
        <h3 className="font-semibold">Current</h3>
        <p>Revision: <code data-testid="current-revision">{health.data?.current_revision || "none"}</code></p>
        <p>Commit: <code>{repo?.commit || "—"}</code>{repo?.branch ? ` on ${repo.branch}` : ""}{repo?.dirty ? " (dirty)" : ""}</p>
        <p>Image: <code className="break-all">{dep?.image || "—"}</code></p>
        <p>Container: <code>{dep?.container_id || "—"}</code></p>
        <Link to={`/sites/${site.id}/operations`} className="text-primary text-xs hover:underline">Deployments & operations →</Link>
      </div>
      <div className="lg:col-span-2">
        <h3 className="font-semibold text-sm mb-2">Revision history</h3>
        <ReadState state={revs} site={site} isEmpty={!items.length} empty="No revisions yet.">
          <Table className="data-table">
            <TableHeader>
              <TableRow>
                <TableHead>Revision</TableHead>
                <TableHead>Change set</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Files</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((r) => (
                <TableRow key={r.revision_id}>
                  <TableCell className="font-mono text-xs">{r.revision_id}</TableCell>
                  <TableCell className="text-xs">{r.change_id ? <Link to={`/changesets/${r.change_id}`} className="text-primary hover:underline font-mono">{r.change_id}</Link> : "—"}</TableCell>
                  <TableCell><ToneBadge tone={r.status === "applied" ? "ok" : "muted"}>{r.status}</ToneBadge></TableCell>
                  <TableCell className="text-xs">{r.files}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(r.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ReadState>
      </div>
    </div>
  );
}

export default function SiteInventory() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = TABS.includes(params.get("tab")) ? params.get("tab") : "routes";
  const { site, loading, error } = useSite(id);

  const routes = useBridgeRead(() => getInventory(id, "routes"), [id]);
  const metadata = useBridgeRead(() => getInventory(id, "metadata"), [id], { enabled: tab === "metadata" });
  const blocks = useBridgeRead(() => getInventory(id, "blocks"), [id], { enabled: tab === "components" });
  const assets = useBridgeRead(() => getInventory(id, "assets"), [id], { enabled: tab === "assets" });
  const redirects = useBridgeRead(() => getInventory(id, "redirects"), [id], { enabled: tab === "redirects" });
  const unsupported = useBridgeRead(() => getInventory(id, "unsupported"), [id], { enabled: tab === "unsupported" });
  const collections = useBridgeRead(() => getContentCollections(id), [id], { enabled: tab === "content" });

  return (
    <div className="page-container" data-testid="site-inventory">
      <SiteHeader site={site} loading={loading} error={error} title="Inventory" />
      {site && (
        <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
          <TabsList className="flex flex-wrap h-auto mb-4">
            {TABS.map((t) => (
              <TabsTrigger key={t} value={t} data-testid={`inv-tab-${t}`}>{TAB_LABELS[t]}</TabsTrigger>
            ))}
          </TabsList>
          <Card className="content-card">
            <CardContent className="p-4 overflow-x-auto">
              <TabsContent value="routes" className="mt-0"><RoutesTab site={site} state={routes} /></TabsContent>
              <TabsContent value="content" className="mt-0"><ContentTab site={site} state={collections} /></TabsContent>
              <TabsContent value="metadata" className="mt-0"><MetadataTab site={site} routesState={routes} metaState={metadata} /></TabsContent>
              <TabsContent value="components" className="mt-0"><ComponentsTab site={site} state={blocks} /></TabsContent>
              <TabsContent value="assets" className="mt-0"><AssetsTab site={site} state={assets} /></TabsContent>
              <TabsContent value="redirects" className="mt-0"><RedirectsTab site={site} state={redirects} /></TabsContent>
              <TabsContent value="unsupported" className="mt-0"><UnsupportedTab site={site} state={unsupported} routesState={routes} /></TabsContent>
              <TabsContent value="revision" className="mt-0">{tab === "revision" && <RevisionTab site={site} />}</TabsContent>
            </CardContent>
          </Card>
        </Tabs>
      )}
    </div>
  );
}
