import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ScrollText, Loader2, RefreshCw, Search } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { ToneBadge } from "../components/sa/StatusBadge";
import ErrorCallout from "../components/sa/ErrorCallout";
import { useSites } from "../hooks/useSite";
import { apiErrorMessage, listAudit, listItems } from "../lib/api";
import { formatDate } from "../lib/changesets";

const OUTCOME_TONE = { ok: "ok", denied: "warn", error: "error" };

export default function Audit() {
  const { sites } = useSites();
  const [siteId, setSiteId] = useState("all");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [applied, setApplied] = useState({ actor: "", action: "" });
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const siteName = useMemo(() => Object.fromEntries(sites.map((s) => [s.id, s.name])), [sites]);

  const load = useCallback(
    async (after) => {
      setLoading(true);
      try {
        const { data } = await listAudit({
          site_id: siteId === "all" ? undefined : siteId,
          actor: applied.actor || undefined,
          action: applied.action || undefined,
          cursor: after || undefined,
        });
        const page = listItems(data);
        setItems((prev) => (after ? [...prev, ...page] : page));
        setCursor(data?.next_cursor || null);
        setError(null);
      } catch (e) {
        setError(apiErrorMessage(e, "Could not load audit events"));
      } finally {
        setLoading(false);
      }
    },
    [siteId, applied]
  );

  useEffect(() => {
    load(null);
  }, [load]);

  return (
    <div className="page-container" data-testid="audit-page">
      <div className="mb-6">
        <h1 className="page-title">Audit</h1>
        <p className="page-description mb-0">
          Every mutation — including denied attempts and failures — with who requested, approved and applied it.
        </p>
      </div>

      <form
        className="flex flex-wrap items-end gap-3 mb-4"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ actor: actor.trim(), action: action.trim() });
        }}
        aria-label="Filter audit events"
      >
        <div className="space-y-1">
          <Label htmlFor="audit-site" className="text-xs">Site</Label>
          <Select value={siteId} onValueChange={setSiteId}>
            <SelectTrigger id="audit-site" className="w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sites</SelectItem>
              {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-actor" className="text-xs">Actor</Label>
          <Input id="audit-actor" value={actor} onChange={(e) => setActor(e.target.value)} placeholder="email or user id" className="w-[200px]" data-testid="audit-actor" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-action" className="text-xs">Action</Label>
          <Input id="audit-action" value={action} onChange={(e) => setAction(e.target.value)} placeholder="e.g. changeset.apply" className="w-[200px]" data-testid="audit-action" />
        </div>
        <Button type="submit" variant="outline" size="sm"><Search size={14} aria-hidden="true" /> Filter</Button>
        <Button type="button" variant="ghost" size="icon" onClick={() => load(null)} aria-label="Refresh audit events">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden="true" />
        </Button>
      </form>

      <ErrorCallout message={error} title="Could not load audit events" />

      <Card className="content-card">
        <CardContent className="p-0 overflow-x-auto">
          {loading && !items.length ? (
            <div className="flex justify-center py-16" role="status"><Loader2 className="animate-spin text-primary" size={28} aria-label="Loading" /></div>
          ) : !items.length ? (
            <div className="flex flex-col items-center py-16 gap-2" data-testid="audit-empty">
              <ScrollText size={44} className="text-muted-foreground/30" aria-hidden="true" />
              <p className="text-muted-foreground">No audit events.</p>
            </div>
          ) : (
            <Table className="data-table">
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Site</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Revision</TableHead>
                  <TableHead>Correlation id</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((ev) => (
                  <TableRow key={ev.id} data-testid="audit-row">
                    <TableCell className="text-xs whitespace-nowrap">{formatDate(ev.at)}</TableCell>
                    <TableCell className="text-sm">
                      {ev.actor_email || ev.actor_id || "system"}
                      {ev.role && <span className="block text-[11px] text-muted-foreground">{ev.role}</span>}
                    </TableCell>
                    <TableCell><code className="text-xs">{ev.action}</code></TableCell>
                    <TableCell><ToneBadge tone={OUTCOME_TONE[ev.outcome] || "muted"}>{ev.outcome}</ToneBadge></TableCell>
                    <TableCell className="text-sm">
                      {ev.site_id ? siteName[ev.site_id] || ev.site_id : "—"}
                      {ev.environment && <span className="block text-[11px] text-muted-foreground">{ev.environment}</span>}
                    </TableCell>
                    <TableCell className="text-xs">
                      {ev.change_id ? (
                        <Link to={`/changesets/${ev.change_id}`} className="text-primary hover:underline font-mono">{ev.change_id}</Link>
                      ) : (
                        <span className="font-mono">{ev.target_type ? `${ev.target_type}:${ev.target_id || ""}` : "—"}</span>
                      )}
                      {ev.detail && <span className="block text-[11px] text-muted-foreground max-w-[240px] truncate" title={typeof ev.detail === "string" ? ev.detail : JSON.stringify(ev.detail)}>{typeof ev.detail === "string" ? ev.detail : JSON.stringify(ev.detail)}</span>}
                    </TableCell>
                    <TableCell className="text-xs font-mono">{ev.revision_id || "—"}</TableCell>
                    <TableCell className="text-[11px] font-mono text-muted-foreground">{ev.correlation_id || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {cursor && (
        <div className="flex justify-center mt-4">
          <Button variant="outline" onClick={() => load(cursor)} disabled={loading}>Load more</Button>
        </div>
      )}
    </div>
  );
}
