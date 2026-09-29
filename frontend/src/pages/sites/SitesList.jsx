import { Link, useNavigate } from "react-router-dom";
import { Globe, Plus, RefreshCw, Loader2, Lock, Unlock } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import GatedButton from "../../components/sa/GatedButton";
import ErrorCallout from "../../components/sa/ErrorCallout";
import { ConnectionBadge, EnvironmentBadge } from "../../components/sa/StatusBadge";
import { useSites } from "../../hooks/useSite";
import { formatDate } from "../../lib/changesets";

export default function SitesList() {
  const { sites, loading, error, reload } = useSites();
  const navigate = useNavigate();

  return (
    <div className="page-container" data-testid="sites-page">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="page-title">Sites</h1>
          <p className="page-description mb-0">
            Next.js sites connected through the automation bridge. Each connection starts read-only.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={reload} disabled={loading} aria-label="Refresh sites">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden="true" />
          </Button>
          <GatedButton minRole="admin" onClick={() => navigate("/sites/new")} data-testid="connect-site-btn">
            <Plus size={14} aria-hidden="true" /> Connect a site
          </GatedButton>
        </div>
      </div>

      <ErrorCallout message={error} title="Could not load sites" />

      <Card className="content-card">
        <CardContent className="p-0">
          {loading && !sites.length ? (
            <div className="flex justify-center py-16" role="status">
              <Loader2 className="animate-spin text-primary" size={28} aria-label="Loading" />
            </div>
          ) : !sites.length ? (
            <div className="flex flex-col items-center py-16 text-center gap-3" data-testid="sites-empty">
              <Globe size={44} className="text-muted-foreground/30" aria-hidden="true" />
              <p className="text-muted-foreground">No sites connected yet.</p>
              <GatedButton minRole="admin" onClick={() => navigate("/sites/new")}>
                <Plus size={14} aria-hidden="true" /> Connect your first site
              </GatedButton>
            </div>
          ) : (
            <Table className="data-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Site</TableHead>
                  <TableHead>Environment</TableHead>
                  <TableHead>Connection</TableHead>
                  <TableHead>Writes</TableHead>
                  <TableHead>Last handshake</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sites.map((s) => (
                  <TableRow key={s.id} data-testid="site-row">
                    <TableCell>
                      <Link to={`/sites/${s.id}`} className="font-medium hover:text-primary">{s.name}</Link>
                      <div className="text-xs text-muted-foreground truncate max-w-[280px]">{s.base_url}</div>
                    </TableCell>
                    <TableCell><EnvironmentBadge environment={s.environment} /></TableCell>
                    <TableCell><ConnectionBadge status={s.connection?.status} /></TableCell>
                    <TableCell>
                      {s.writes_enabled ? (
                        <span className="inline-flex items-center gap-1 text-emerald-500 text-xs"><Unlock size={12} aria-hidden="true" />Write-enabled</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-yellow-500 text-xs"><Lock size={12} aria-hidden="true" />Read-only</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDate(s.connection?.last_handshake_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
