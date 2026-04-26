import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Puzzle, Palette, ShieldAlert, Power, PowerOff, RefreshCw, Loader2, Bot } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "../components/ui/accordion";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  getSites, getPluginsThemes, activatePlugin, deactivatePlugin, getThemes, activateTheme, pluginSecurityScan,
} from "../lib/api";
import { toast } from "sonner";

const RISK_COLORS = {
  safe: "bg-emerald-500/10 text-emerald-500 border-emerald-500/30",
  warning: "bg-yellow-500/10 text-yellow-500 border-yellow-500/30",
  critical: "bg-red-500/10 text-red-500 border-red-500/30",
};

export default function PluginsThemes() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [plugins, setPlugins] = useState([]);
  const [themes, setThemes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState({});
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState(null);
  const [activeTab, setActiveTab] = useState("plugins");

  useEffect(() => { loadSites(); }, []);
  useEffect(() => {
    if (selectedSite) { loadPlugins(); loadThemes(); }
  }, [selectedSite]);

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data || []);
      if (r.data?.length) setSelectedSite(r.data[0].id);
    } catch { }
  };

  const loadPlugins = async () => {
    setLoading(true);
    try {
      const r = await getPluginsThemes(selectedSite);
      setPlugins(Array.isArray(r.data) ? r.data : []);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to load plugins");
    } finally { setLoading(false); }
  };

  const loadThemes = async () => {
    try {
      const r = await getThemes(selectedSite);
      setThemes(Array.isArray(r.data) ? r.data : []);
    } catch { }
  };

  const doPluginAction = async (slug, action) => {
    setActionLoading(prev => ({ ...prev, [slug]: action }));
    try {
      if (action === "activate") {
        await activatePlugin(selectedSite, slug);
        setPlugins(prev => prev.map(p => p.plugin === slug ? { ...p, status: "active" } : p));
        toast.success("Plugin activated");
      } else if (action === "deactivate") {
        await deactivatePlugin(selectedSite, slug);
        setPlugins(prev => prev.map(p => p.plugin === slug ? { ...p, status: "inactive" } : p));
        toast.success("Plugin deactivated");
      }
    } catch (err) {
      toast.error(err.response?.data?.detail || `Failed to ${action} plugin`);
    } finally { setActionLoading(prev => ({ ...prev, [slug]: null })); }
  };

  const doThemeActivate = async (stylesheet) => {
    setActionLoading(prev => ({ ...prev, [stylesheet]: "activate" }));
    try {
      await activateTheme(selectedSite, stylesheet);
      setThemes(prev => prev.map(t => ({ ...t, status: { ...t.status, theme_root_uri: t.stylesheet === stylesheet ? { ...t.status, active: true } : t.status } })));
      toast.success("Theme activation sent");
      loadThemes();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to activate theme");
    } finally { setActionLoading(prev => ({ ...prev, [stylesheet]: null })); }
  };

  const handleSecurityScan = async () => {
    setScanning(true);
    setScanResults(null);
    try {
      const r = await pluginSecurityScan(selectedSite);
      setScanResults(r.data);
      const critical = r.data.risks.filter(x => x.risk === "critical").length;
      if (critical > 0) toast.warning(`Security scan found ${critical} critical plugin(s)`);
      else toast.success("Security scan complete — no critical issues found");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Security scan failed");
    } finally { setScanning(false); }
  };

  return (
    <div className="page-container">
      <div className="mb-8">
        <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          Plugins & Themes
        </motion.h1>
        <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
          Manage WordPress plugins and themes, run AI-powered security scans
        </motion.p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
        <Button onClick={() => { loadPlugins(); loadThemes(); }} variant="outline" size="sm" disabled={!selectedSite}>
          <RefreshCw size={14} className="mr-2" />Refresh
        </Button>
        <Button onClick={handleSecurityScan} disabled={!selectedSite || scanning}
          className="border-primary/30 text-primary" variant="outline" size="sm">
          {scanning ? <Loader2 size={14} className="mr-2 animate-spin" /> : <ShieldAlert size={14} className="mr-2" />}
          AI Security Scan
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[
          { label: "Total Plugins", value: plugins.length },
          { label: "Active", value: plugins.filter(p => p.status === "active").length },
          { label: "Inactive", value: plugins.filter(p => p.status !== "active").length },
          { label: "Themes", value: themes.length },
        ].map(s => (
          <Card key={s.label} className="stat-card">
            <p className="stat-value">{s.value}</p>
            <p className="stat-label">{s.label}</p>
          </Card>
        ))}
      </div>

      {/* Security Scan Results */}
      {scanResults && (
        <Card className="content-card mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ShieldAlert size={14} className="text-primary" />
              Security Scan Results ({scanResults.plugins_scanned} plugins analyzed)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Accordion type="multiple">
              {scanResults.risks.map((r, i) => (
                <AccordionItem key={i} value={`r-${i}`}>
                  <AccordionTrigger className="text-sm">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={`text-xs ${RISK_COLORS[r.risk]}`}>{r.risk}</Badge>
                      {r.name}
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground">{r.reason}</AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="plugins"><Puzzle size={14} className="mr-2" />Plugins ({plugins.length})</TabsTrigger>
          <TabsTrigger value="themes"><Palette size={14} className="mr-2" />Themes ({themes.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="plugins">
          {loading ? (
            <div className="flex items-center justify-center py-20"><Loader2 size={32} className="animate-spin text-primary" /></div>
          ) : (
            <div className="space-y-2">
              {plugins.map(p => {
                const slug = p.plugin || p.slug || "";
                const isActive = p.status === "active";
                return (
                  <Card key={slug} className="content-card">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium text-sm">{p.name}</span>
                            <Badge variant="outline" className={`text-xs ${isActive ? "border-emerald-500/30 text-emerald-500" : "border-gray-500/30 text-gray-400"}`}>
                              {isActive ? "Active" : "Inactive"}
                            </Badge>
                            <span className="text-xs text-muted-foreground">v{p.version || "?"}</span>
                          </div>
                          <p className="text-xs text-muted-foreground truncate">{p.description?.raw || p.description || ""}</p>
                          <p className="text-xs text-muted-foreground mt-1">Author: {p.author || "—"}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {isActive ? (
                            <Button variant="outline" size="sm" className="h-7 text-xs"
                              disabled={actionLoading[slug] === "deactivate"}
                              onClick={() => doPluginAction(slug, "deactivate")}>
                              {actionLoading[slug] === "deactivate" ? <Loader2 size={12} className="animate-spin mr-1" /> : <PowerOff size={12} className="mr-1" />}
                              Deactivate
                            </Button>
                          ) : (
                            <Button variant="outline" size="sm" className="h-7 text-xs text-emerald-500 border-emerald-500/30"
                              disabled={actionLoading[slug] === "activate"}
                              onClick={() => doPluginAction(slug, "activate")}>
                              {actionLoading[slug] === "activate" ? <Loader2 size={12} className="animate-spin mr-1" /> : <Power size={12} className="mr-1" />}
                              Activate
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
              {plugins.length === 0 && !loading && (
                <div className="text-center py-12 text-muted-foreground">{selectedSite ? "No plugins found" : "Select a site"}</div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="themes">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {themes.map(t => {
              const stylesheet = t.stylesheet || t.slug || "";
              const isActive = t.status?.theme_root_uri ? true : (t.active === true);
              const screenshot = t.theme_uri || "";
              return (
                <Card key={stylesheet} className={`content-card ${isActive ? "ring-1 ring-primary/40" : ""}`}>
                  <div className="h-32 bg-muted/30 rounded-t-lg flex items-center justify-center overflow-hidden">
                    {screenshot ? (
                      <img src={screenshot} alt={t.name?.rendered || t.name || ""} className="w-full h-full object-cover" />
                    ) : (
                      <Palette size={32} className="text-muted-foreground/40" />
                    )}
                  </div>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium text-sm">{t.name?.rendered || t.name || stylesheet}</span>
                      {isActive && <Badge variant="outline" className="text-xs border-primary/30 text-primary">Active</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">v{t.version || "?"} · {t.author?.raw || "—"}</p>
                    {!isActive && (
                      <Button variant="outline" size="sm" className="w-full h-7 text-xs"
                        disabled={actionLoading[stylesheet] === "activate"}
                        onClick={() => doThemeActivate(stylesheet)}>
                        {actionLoading[stylesheet] === "activate" ? <Loader2 size={12} className="animate-spin mr-1" /> : <Power size={12} className="mr-1" />}
                        Activate Theme
                      </Button>
                    )}
                  </CardContent>
                </Card>
              );
            })}
            {themes.length === 0 && (
              <div className="col-span-3 text-center py-12 text-muted-foreground">{selectedSite ? "No themes found" : "Select a site"}</div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
