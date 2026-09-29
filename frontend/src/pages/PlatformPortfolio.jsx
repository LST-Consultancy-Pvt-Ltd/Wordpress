import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { LayoutGrid, RefreshCw, Loader2, AlertTriangle, CheckCircle, HelpCircle, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { getPortfolioIntelligence } from "../lib/api";
import { ConnectionBadge, EnvironmentBadge } from "../components/sa/StatusBadge";

export default function PlatformPortfolio() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getPortfolioIntelligence();
      setData(r.data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const portfolio = data?.portfolio || [];

  return (
    <div className="p-6 space-y-6">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-heading font-bold flex items-center gap-2"><LayoutGrid size={22} />Portfolio</h1>
          <p className="text-sm text-muted-foreground">Cross-site view — every connected Next.js site in one place, sorted by what needs attention first.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw size={14} className={`mr-1.5 ${loading ? "animate-spin" : ""}`} />Refresh
        </Button>
      </motion.div>

      {loading && !data ? (
        <div className="flex justify-center py-16"><Loader2 className="animate-spin" size={28} /></div>
      ) : !data ? (
        <Card><CardContent className="py-10 text-center text-muted-foreground">Failed to load portfolio data.</CardContent></Card>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card><CardContent className="pt-5"><p className="text-2xl font-bold">{data.total_sites}</p><p className="text-xs text-muted-foreground">Total Sites</p></CardContent></Card>
            <Card><CardContent className="pt-5"><p className="text-2xl font-bold text-red-400">{data.sites_needing_attention}</p><p className="text-xs text-muted-foreground">Need Attention</p></CardContent></Card>
            <Card><CardContent className="pt-5"><p className="text-2xl font-bold text-muted-foreground">{data.sites_never_health_checked}</p><p className="text-xs text-muted-foreground">Never Health-Checked</p></CardContent></Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sites ({portfolio.length})</CardTitle>
              <CardDescription>Off-page score and backlinks come from the same real data used on the Off-Page Autopilot page for each site.</CardDescription>
            </CardHeader>
            <CardContent>
              {portfolio.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No sites yet — connect one from the Sites page.</p>
              ) : (
                <div className="space-y-2">
                  {portfolio.map((s) => (
                    <div key={s.site_id} className={`p-3 rounded-lg border flex items-center justify-between gap-3 ${s.needs_attention ? "border-red-500/30 bg-red-500/5" : ""}`}>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm truncate">{s.name || s.base_url}</p>
                          {s.needs_attention
                            ? <Badge className="bg-red-500/10 text-red-400 text-xs"><AlertTriangle size={10} className="mr-1" />Needs attention</Badge>
                            : <Badge className="bg-emerald-500/10 text-emerald-400 text-xs"><CheckCircle size={10} className="mr-1" />OK</Badge>}
                          {s.connection?.status && <ConnectionBadge status={s.connection.status} className="text-xs" />}
                          {s.environment && <EnvironmentBadge environment={s.environment} className="text-xs" />}
                        </div>
                        {s.base_url && (
                          <a href={s.base_url} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 truncate">
                            {s.base_url}<ExternalLink size={9} aria-hidden="true" />
                            <span className="sr-only">(opens in a new tab)</span>
                          </a>
                        )}
                        {s.why && <p className="text-xs text-red-400/80 mt-0.5">{s.why}</p>}
                      </div>
                      <div className="flex items-center gap-4 shrink-0 text-xs text-muted-foreground">
                        <div className="text-center">
                          <p className="font-semibold text-foreground">
                            {s.uptime?.online == null ? <HelpCircle size={14} className="inline text-muted-foreground" aria-label="Unknown" /> : s.uptime.online ? "Online" : "Down"}
                          </p>
                          <p>Uptime</p>
                        </div>
                        <div className="text-center">
                          <p className="font-semibold text-foreground">{s.offpage_score ?? "—"}</p>
                          <p>Off-Page Score</p>
                        </div>
                        <div className="text-center">
                          <p className="font-semibold text-foreground">{s.backlinks_acquired ?? "—"}</p>
                          <p>Backlinks</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
