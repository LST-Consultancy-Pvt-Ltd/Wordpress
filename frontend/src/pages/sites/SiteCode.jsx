import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { FileCode, Folder, Loader2, Undo2, FilePlus2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { Button } from "../../components/ui/button";
import SiteHeader from "../../components/sa/SiteHeader";
import GatedButton from "../../components/sa/GatedButton";
import CapabilityNotice from "../../components/sa/CapabilityNotice";
import ErrorCallout from "../../components/sa/ErrorCallout";
import DiffView from "../../components/sa/DiffView";
import ChangeSetPanel from "../../components/sa/ChangeSetPanel";
import SourceOfTruth from "../../components/content/SourceOfTruth";
import { useProposeChangeSet } from "../../components/content/useProposeChangeSet";
import { useSite } from "../../hooks/useSite";
import { useBridgeRead } from "../../hooks/useBridgeRead";
import { apiErrorDetails, getInventory, getSiteFile, listItems } from "../../lib/api";
import { hasCapability, writeBlockedReason } from "../../lib/capabilities";
import { simpleFileDiff } from "../../lib/diff";

const TEXT_EXT = /\.(tsx?|jsx?|mjs|cjs|css|scss|json|md|mdx|txt|svg|html|ya?ml)$/i;
const key = (f) => `${f.root}/${f.path}`;
const PATH_OK = (p) => p && !p.startsWith("/") && !p.split("/").includes("..") && !p.includes("\0") && p.length <= 240;

function groupByDir(files) {
  const groups = {};
  files.forEach((f) => {
    const dir = `${f.root}/${f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}`;
    (groups[dir] ||= []).push(f);
  });
  return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
}

export default function SiteCode() {
  const { id } = useParams();
  const { site, loading, error } = useSite(id);
  const routes = useBridgeRead(() => getInventory(id, "routes"), [id]);
  const assets = useBridgeRead(() => getInventory(id, "assets"), [id]);
  const [selected, setSelected] = useState(null); // {root, path}
  const [files, setFiles] = useState({}); // key -> {root, path, original, sha256, draft, isNew}
  const [openError, setOpenError] = useState(null);
  const [opening, setOpening] = useState(false);
  const [newFile, setNewFile] = useState({ root: "code", path: "" });
  const [filter, setFilter] = useState("");
  const [title, setTitle] = useState("");
  const [created, setCreated] = useState(null);
  const { propose, busy, error: proposeError } = useProposeChangeSet(id);

  const routeItems = listItems(routes.data);
  const explorer = useMemo(() => {
    const map = new Map();
    routeItems.forEach((r) => r.source && map.set(key(r.source), { root: r.source.root, path: r.source.path }));
    listItems(assets.data).forEach((a) => TEXT_EXT.test(a.path) && map.set(key(a), { root: a.root, path: a.path, sha256: a.sha256 }));
    Object.values(files).forEach((f) => map.set(key(f), { root: f.root, path: f.path }));
    return [...map.values()].filter((f) => !filter || key(f).toLowerCase().includes(filter.toLowerCase()));
  }, [routeItems, assets.data, files, filter]);

  if (!site) {
    return (
      <div className="page-container">
        <SiteHeader site={site} loading={loading} error={error} title="Code" />
      </div>
    );
  }

  const canRead = hasCapability(site, "files.read");
  const patchBlocked = writeBlockedReason(site, "files.patch");
  const current = selected ? files[key(selected)] : null;
  const changed = Object.values(files).filter((f) => f.draft !== f.original);
  const diffText = changed.map((f) => simpleFileDiff(key(f), f.original, f.draft)).join("");
  const affected = [...new Set(routeItems.filter((r) => r.source && changed.some((f) => key(f) === key(r.source))).map((r) => r.route))];

  const open = async (f) => {
    setSelected(f);
    setOpenError(null);
    if (files[key(f)]) return;
    setOpening(true);
    try {
      const { data } = await getSiteFile(site.id, f.root, f.path);
      setFiles((s) => ({ ...s, [key(f)]: { root: f.root, path: f.path, original: data.content ?? "", draft: data.content ?? "", sha256: data.sha256 ?? null, isNew: false } }));
    } catch (e) {
      setOpenError(apiErrorDetails(e));
    } finally {
      setOpening(false);
    }
  };

  const addNew = () => {
    if (!PATH_OK(newFile.path)) return;
    const f = { root: newFile.root, path: newFile.path, original: "", draft: "", sha256: null, isNew: true };
    setFiles((s) => ({ ...s, [key(f)]: f }));
    setSelected({ root: f.root, path: f.path });
    setNewFile((n) => ({ ...n, path: "" }));
  };

  const submit = async () => {
    const cs = await propose({
      title: title.trim() || `Code change: ${changed.map((f) => f.path).join(", ").slice(0, 120)}`,
      source: "manual",
      operations: changed.map((f) => ({ op: "file.write", root: f.root, path: f.path, content: f.draft, base_sha256: f.isNew ? null : f.sha256 })),
    });
    if (cs) setCreated(cs.id);
  };

  const codeRoots = (site.capabilities?.writable_roots || []).filter((r) => r.kind === "code" || r.kind === "assets");

  return (
    <div className="page-container" data-testid="site-code">
      <SiteHeader site={site} loading={loading} error={error} title="Code" />
      {!canRead ? (
        <CapabilityNotice capability="files.read" site={site} />
      ) : (
        <div className="grid xl:grid-cols-[300px_1fr] gap-6">
          <Card className="content-card">
            <CardHeader><CardTitle className="text-base">Files</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">Allow-listed files from route sources and text assets. The bridge enforces its allow/deny globs on every write.</p>
              <Label htmlFor="file-filter" className="sr-only">Filter files</Label>
              <Input id="file-filter" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <nav aria-label="File explorer" className="max-h-[420px] overflow-y-auto text-sm" data-testid="file-explorer">
                {groupByDir(explorer).map(([dir, list]) => (
                  <div key={dir} className="mb-2">
                    <p className="flex items-center gap-1 text-xs text-muted-foreground"><Folder size={12} aria-hidden="true" />{dir}</p>
                    <ul>
                      {list.map((f) => {
                        const k = key(f);
                        const dirty = files[k] && files[k].draft !== files[k].original;
                        return (
                          <li key={k}>
                            <button
                              type="button"
                              className={`w-full text-left pl-4 py-0.5 rounded hover:bg-muted/50 flex items-center gap-1 ${selected && key(selected) === k ? "text-primary" : ""}`}
                              onClick={() => open(f)}
                              aria-current={selected && key(selected) === k ? "true" : undefined}
                            >
                              <FileCode size={12} aria-hidden="true" />
                              <span className="truncate font-mono text-xs">{f.path.split("/").pop()}</span>
                              {dirty && <span className="ml-auto text-yellow-500 text-xs" aria-label="modified">●</span>}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
                {!explorer.length && <p className="text-xs text-muted-foreground">{routes.loading ? "Loading…" : "No files."}</p>}
              </nav>
              <form className="space-y-1 border-t border-border/30 pt-3" onSubmit={(e) => { e.preventDefault(); addNew(); }} aria-label="New file">
                <Label htmlFor="new-file-path" className="text-xs">New file</Label>
                <div className="flex gap-1">
                  <select
                    aria-label="Root"
                    className="rounded-md border border-input bg-transparent text-xs px-1"
                    value={newFile.root}
                    onChange={(e) => setNewFile((n) => ({ ...n, root: e.target.value }))}
                  >
                    {(codeRoots.length ? codeRoots : [{ id: "code" }]).map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
                  </select>
                  <Input id="new-file-path" className="h-8 text-xs font-mono" placeholder="components/Banner.tsx" value={newFile.path} onChange={(e) => setNewFile((n) => ({ ...n, path: e.target.value.trim() }))} />
                  <Button type="submit" size="sm" variant="outline" disabled={!PATH_OK(newFile.path)} aria-label="Add new file"><FilePlus2 size={14} aria-hidden="true" /></Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <div className="space-y-6 min-w-0">
            <Card className="content-card">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 gap-2">
                <CardTitle className="text-base font-mono truncate">{selected ? key(selected) : "No file selected"}</CardTitle>
                {current && current.draft !== current.original && (
                  <Button variant="ghost" size="sm" onClick={() => setFiles((s) => ({ ...s, [key(current)]: { ...current, draft: current.original } }))}>
                    <Undo2 size={14} aria-hidden="true" /> Discard
                  </Button>
                )}
              </CardHeader>
              <CardContent className="space-y-2">
                {opening && <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Opening…</p>}
                {openError && <ErrorCallout title="Could not read file" message={openError.message} code={openError.code} correlationId={openError.correlationId} />}
                {current && (
                  <>
                    <SourceOfTruth>
                      <code>{key(current)}</code> in the site repository{current.sha256 ? <> (sha256 <code>{current.sha256.slice(0, 12)}…</code>; the write is refused if it changes before apply)</> : " (new file — must not exist yet)"}.
                    </SourceOfTruth>
                    <Label htmlFor="code-editor" className="sr-only">File content</Label>
                    <Textarea
                      id="code-editor"
                      className="font-mono text-xs min-h-[360px]"
                      spellCheck={false}
                      value={current.draft}
                      readOnly={!!patchBlocked}
                      onChange={(e) => setFiles((s) => ({ ...s, [key(current)]: { ...current, draft: e.target.value } }))}
                      data-testid="code-editor"
                    />
                    {patchBlocked && <p className="text-xs text-muted-foreground">Read-only: {patchBlocked}.</p>}
                  </>
                )}
              </CardContent>
            </Card>

            <Card className="content-card">
              <CardHeader><CardTitle className="text-base">Proposed changes ({changed.length} file{changed.length === 1 ? "" : "s"})</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                {!hasCapability(site, "files.patch") && <CapabilityNotice capability="files.patch" site={site} compact />}
                <DiffView diff={diffText} emptyText="Edit a file to see the side-by-side diff." />
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1">Affected routes (from inventory)</p>
                  <p className="text-xs font-mono" data-testid="affected-routes">{affected.length ? affected.join(", ") : "none detected — the plan will report impacted routes"}</p>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1 flex-1 min-w-[240px]">
                    <Label htmlFor="code-cs-title" className="text-xs">Change set title</Label>
                    <Input id="code-cs-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Describe the change" />
                  </div>
                  <GatedButton minRole="editor" blocked={patchBlocked} onClick={submit} disabled={busy || !changed.length} data-testid="propose-code">
                    {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Create change set
                  </GatedButton>
                </div>
                {proposeError && <ErrorCallout title="Change set not created" message={proposeError.message} code={proposeError.code} correlationId={proposeError.correlationId} />}
                <p className="text-xs text-muted-foreground">
                  Code changes are flagged <code>code-change</code>; policy requires validation{hasCapability(site, "validate") ? "" : " (not available on this bridge — the change set can still be reviewed)"} before approval.
                </p>
              </CardContent>
            </Card>

            {created && (
              <Card className="content-card" data-testid="code-changeset">
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-base">Review: validate, approve, apply</CardTitle>
                  <Link to={`/changesets/${created}`} className="text-xs text-primary hover:underline">Open full page →</Link>
                </CardHeader>
                <CardContent>
                  <ChangeSetPanel changesetId={created} compact />
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
