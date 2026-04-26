import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { DollarSign, Phone, TrendingUp, BarChart3, Download, Settings2, Loader2, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";
import {
  getSites, getRevenueAttribution, getMonthlySummary,
  updateRevenueSettings, getRevenueSettings, exportRevenuePDF
} from "../lib/api";

function StatCard({ label, value, icon: Icon, color = "text-primary", sub }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-start gap-3">
          <div className={`p-2 rounded-lg bg-muted/40 ${color}`}>
            <Icon size={18} />
          </div>
          <div>
            <p className="text-xl font-bold">{value}</p>
            <p className="text-xs text-muted-foreground">{label}</p>
            {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function RevenueDashboard() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [attribution, setAttribution] = useState(null);
  const [summary, setSummary] = useState(null);
  const [settings, setSettings] = useState({ callrail_webhook_url: "", avg_job_value: 350 });
  const [savedSettings, setSavedSettings] = useState(null);
  const [loading, setLoading] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSite) loadData();
  }, [selectedSite]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [attrRes, sumRes, setRes] = await Promise.all([
        getRevenueAttribution(selectedSite).catch(() => ({ data: null })),
        getMonthlySummary(selectedSite).catch(() => ({ data: null })),
        getRevenueSettings(selectedSite).catch(() => ({ data: null })),
      ]);
      if (attrRes.data) setAttribution(attrRes.data);
      if (sumRes.data) setSummary(sumRes.data);
      if (setRes.data) {
        setSavedSettings(setRes.data);
        setSettings({ callrail_webhook_url: setRes.data.callrail_webhook_url || "", avg_job_value: setRes.data.avg_job_value || 350 });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!selectedSite) return;
    setSavingSettings(true);
    try {
      const r = await updateRevenueSettings(selectedSite, settings);
      setSavedSettings(r.data);
      toast.success("Settings saved");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to save settings");
    } finally {
      setSavingSettings(false);
    }
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      const r = await exportRevenuePDF(selectedSite);
      const url = window.URL.createObjectURL(new Blob([r.data], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `revenue-report-${selectedSite}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success("PDF downloaded");
    } catch (e) {
      toast.error("PDF export failed");
    } finally {
      setExporting(false);
    }
  };

  const conversionRate = attribution?.total_calls > 0
    ? ((attribution.total_conversions / attribution.total_calls) * 100).toFixed(1)
    : "0";

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><DollarSign size={24} />Revenue Dashboard</h1>
          <p className="page-description">Track call attribution, conversions, and revenue from organic SEO traffic</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
            <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" onClick={loadData} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </Button>
          <Button onClick={handleExportPDF} disabled={exporting || !selectedSite}>
            {exporting ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Download size={14} className="mr-2" />}
            Export PDF
          </Button>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard label="Total Calls" value={attribution?.total_calls ?? "—"} icon={Phone} color="text-blue-400" />
        <StatCard label="Conversions" value={attribution?.total_conversions ?? "—"} icon={TrendingUp} color="text-emerald-400" />
        <StatCard label="Conversion Rate" value={`${conversionRate}%`} icon={BarChart3} color="text-purple-400" />
        <StatCard label="Attributed Revenue" value={attribution?.total_revenue ? `$${attribution.total_revenue.toLocaleString()}` : "—"} icon={DollarSign} color="text-yellow-400" />
        <StatCard label="Projected Monthly" value={summary?.projected_revenue ? `$${summary.projected_revenue.toLocaleString()}` : "—"} icon={TrendingUp} color="text-emerald-400" sub="at current rate" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Attribution Table */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Keyword Attribution</CardTitle></CardHeader>
          <CardContent>
            {attribution?.keywords?.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 text-xs text-muted-foreground font-medium">Keyword</th>
                      <th className="text-right py-2 text-xs text-muted-foreground font-medium">Calls</th>
                      <th className="text-right py-2 text-xs text-muted-foreground font-medium">Conv.</th>
                      <th className="text-right py-2 text-xs text-muted-foreground font-medium">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attribution.keywords.map((kw, i) => (
                      <tr key={i} className="border-b border-border/50 hover:bg-muted/20">
                        <td className="py-2 max-w-[180px] truncate">{kw.keyword}</td>
                        <td className="py-2 text-right tabular-nums">{kw.calls}</td>
                        <td className="py-2 text-right tabular-nums">{kw.conversions}</td>
                        <td className="py-2 text-right tabular-nums text-emerald-400">${(kw.revenue || 0).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-8">
                <Phone size={32} className="mx-auto mb-2 text-muted-foreground opacity-40" />
                <p className="text-sm text-muted-foreground">No attribution data yet</p>
                <p className="text-xs text-muted-foreground mt-1">Configure call tracking to get started</p>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          {/* Top GSC Keywords */}
          {summary?.top_keywords?.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Top Keywords (GSC)</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-1 max-h-52 overflow-y-auto">
                  {summary.top_keywords.map((kw, i) => (
                    <div key={i} className="flex items-center justify-between p-2 rounded hover:bg-muted/20">
                      <p className="text-sm truncate flex-1">{kw.keyword}</p>
                      <div className="flex gap-4 text-xs text-muted-foreground shrink-0">
                        <span>pos {kw.position?.toFixed(1) ?? "—"}</span>
                        <span>{kw.clicks} clicks</span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Settings */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Settings2 size={16} />Settings</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">CallRail Webhook URL</label>
                <Input
                  placeholder="https://api.callrail.com/..."
                  value={settings.callrail_webhook_url}
                  onChange={e => setSettings(p => ({ ...p, callrail_webhook_url: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground mt-1">Paste this URL into CallRail as a webhook destination.</p>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Average Job Value ($)</label>
                <Input
                  type="number"
                  placeholder="350"
                  value={settings.avg_job_value}
                  onChange={e => setSettings(p => ({ ...p, avg_job_value: parseInt(e.target.value) || 0 }))}
                />
              </div>
              <Button className="w-full" onClick={handleSaveSettings} disabled={savingSettings}>
                {savingSettings ? <><Loader2 size={14} className="mr-2 animate-spin" />Saving...</> : "Save Settings"}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </motion.div>
  );
}
