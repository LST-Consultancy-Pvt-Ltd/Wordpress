import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { GitPullRequest, Loader2, RefreshCw } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import StatusBadge, { RiskBadge } from "../../components/sa/StatusBadge";
import ErrorCallout from "../../components/sa/ErrorCallout";
import { useSites } from "../../hooks/useSite";
import { apiErrorMessage, listAllChangeSets, listItems } from "../../lib/api";
import { STATUS_FILTERS, formatDate } from "../../lib/changesets";

export default function ChangeSetList() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") || "all";
  const siteId = params.get("site") || "all";
  const { sites } = useSites();
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const siteName = useMemo(() => Object.fromEntries(sites.map((s) => [s.id, s.name])), [sites]);

  const load = useCallback(
    async (after) => {
      setLoading(true);
      try {
        const { data } = await listAllChangeSets({
          status: status === "all" ? undefined : status,
          site_id: siteId === "all" ? undefined : siteId,
          cursor: after || undefined,
        });
        const page = listItems(data);
        setItems((prev) => (after ? [...prev, ...page] : page));
        setCursor(data?.next_cursor || null);
        setError(null);
      } catch (e) {
        setError(apiErrorMessage(e, "Could not load change sets"));
      } finally {
        setLoading(false);
      }
    },
    [status, siteId]
  );

  useEffect(() => {
    load(null);
  }, [load]);

  const setFilter = (k, v) => {
    const next = new URLSearchParams(params);
    if (v === "all") next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
  };

  return (
    <div className="page-container" data-testid="changesets-page">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="page-title">Change sets</h1>
          <p className="page-description mb-0">
            Every site change is a reviewable change set: planned, validated, approved, applied — and reversible.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="cs-status-filter" className="text-xs">Status</Label>
            <Select value={status} onValueChange={(v) => setFilter("status", v)}>
              <SelectTrigger id="cs-status-filter" className="w-[190px]" data-testid="status-filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cs-site-filter" className="text-xs">Site</Label>
            <Select value={siteId} onValueChange={(v) => setFilter("site", v)}>
              <SelectTrigger id="cs-site-filter" className="w-[190px]" data-testid="site-filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sites</SelectItem>
                {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="icon" onClick={() => load(null)} disabled={loading} aria-label="Refresh change sets">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden="true" />
          </Button>
        </div>
      </div>

      <ErrorCallout message={error} title="Could not load change sets" />

      <Card className="content-card">
        <CardContent className="p-0">
          {loading && !items.length ? (
            <div className="flex justify-center py-16" role="status"><Loader2 className="animate-spin text-primary" size={28} aria-label="Loading" /></div>
          ) : !items.length ? (
            <div className="flex flex-col items-center py-16 gap-2 text-center" data-testid="changesets-empty">
              <GitPullRequest size={44} className="text-muted-foreground/30" aria-hidden="true" />
              <p className="text-muted-foreground">No change sets match these filters.</p>
              <p className="text-xs text-muted-foreground">Edits in Content, Code, On-Page SEO and the generators create change sets here.</p>
            </div>
          ) : (
            <Table className="data-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Change set</TableHead>
                  <TableHead>Site</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Risk</TableHead>
                  <TableHead>Ops</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((cs) => (
                  <TableRow key={cs.id} data-testid="changeset-row">
                    <TableCell>
                      <Link to={`/changesets/${cs.id}`} className="font-medium hover:text-primary">{cs.title || cs.id}</Link>
                      <div className="text-xs text-muted-foreground">{cs.source || "manual"} · {cs.created_by || "—"}</div>
                    </TableCell>
                    <TableCell className="text-sm">{siteName[cs.site_id] || cs.site_id}</TableCell>
                    <TableCell><StatusBadge status={cs.status} /></TableCell>
                    <TableCell>{cs.plan?.risk ? <RiskBadge level={cs.plan.risk.level} /> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="text-sm">{cs.operations?.length ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(cs.created_at)}</TableCell>
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
