import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { ArrowRightLeft, Plus, Trash2, Bot, CheckCircle, Loader2, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import { ScrollArea } from "../components/ui/scroll-area";
import { getSites, listRedirects, createRedirect, deleteRedirect, aiSuggestRedirects, bulkCreateRedirects } from "../lib/api";
import { toast } from "sonner";
import ManualApplySheet from "../components/ManualApplySheet";
import { useApplyMode } from "../hooks/useApplyMode";

export default function Redirects() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [redirects, setRedirects] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [bulkCreating, setBulkCreating] = useState(false);
  const [accepted, setAccepted] = useState(new Set());
  const [form, setForm] = useState({ from: "", to: "", type: "301" });
  const [adding, setAdding] = useState(false);

  // Apply Mode
  const { isManual } = useApplyMode();
  const [manualSheet, setManualSheet] = useState({ open: false, title: "", wpAdminUrl: "", fields: [], instructions: "" });
  const openManualSheet = (config) => setManualSheet({ open: true, ...config });
  const closeManualSheet = () => setManualSheet((prev) => ({ ...prev, open: false }));

  useEffect(() => { loadSites(); }, []);
  useEffect(() => { if (selectedSite) loadRedirects(); }, [selectedSite]);

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data || []);
      if (r.data?.length) setSelectedSite(r.data[0].id);
    } catch { }
  };

  const loadRedirects = async () => {
    setLoading(true);
    try {
      const r = await listRedirects(selectedSite);
      setRedirects(Array.isArray(r.data) ? r.data : []);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to load redirects");
    } finally { setLoading(false); }
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!form.from || !form.to) return;
    const siteData = sites.find((s) => s.id === selectedSite);
    const siteUrl = siteData?.url || "";
    if (isManual) {
      openManualSheet({
        title: "Add Single Redirect",
        wpAdminUrl: `${siteUrl}/wp-admin/tools.php?page=redirection.php`,
        fields: [
          { label: "From URL", value: form.from, type: "url" },
          { label: "To URL", value: form.to, type: "url" },
          { label: "Redirect Type", value: form.type, type: "text" },
        ],
        instructions: "Add this redirect in your WordPress redirect plugin (Redirection, Yoast, or .htaccess).",
      });
      return;
    }
    setAdding(true);
    try {
      const r = await createRedirect(selectedSite, form);
      setRedirects(prev => [r.data, ...prev]);
      setForm({ from: "", to: "", type: "301" });
      toast.success("Redirect created");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to create redirect");
    } finally { setAdding(false); }
  };

  const handleDelete = async (id) => {
    try {
      await deleteRedirect(selectedSite, id);
      setRedirects(prev => prev.filter(r => r.id !== id));
      toast.success("Redirect deleted");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to delete redirect");
    }
  };

  const handleSuggest = async () => {
    setSuggesting(true);
    setSuggestions([]);
    setAccepted(new Set());
    try {
      const r = await aiSuggestRedirects(selectedSite);
      setSuggestions(Array.isArray(r.data) ? r.data : (r.data?.suggestions || []));
      if (!r.data?.length && !r.data?.suggestions?.length) toast.info("No suggestions from AI — site looks clean");
    } catch (err) {
      toast.error(err.response?.data?.detail || "AI suggestion failed");
    } finally { setSuggesting(false); }
  };

  const toggleAccepted = (i) => {
    setAccepted(prev => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  const handleBulkCreate = async () => {
    const toCreate = suggestions.filter((_, i) => accepted.has(i));
    if (!toCreate.length) return;
    const siteData = sites.find((s) => s.id === selectedSite);
    const siteUrl = siteData?.url || "";
    if (isManual) {
      openManualSheet({
        title: "Bulk Create AI Redirects",
        wpAdminUrl: `${siteUrl}/wp-admin/tools.php?page=redirection.php`,
        fields: toCreate.flatMap((s, i) => [
          { label: `Redirect ${i + 1} — From`, value: s.from, type: "url" },
          { label: `Redirect ${i + 1} — To`, value: s.to, type: "url" },
          { label: `Redirect ${i + 1} — Type`, value: s.type || "301", type: "text" },
        ]),
        instructions: "Add each of these redirects in your redirect plugin or .htaccess.",
      });
      return;
    }
    setBulkCreating(true);
    try {
      const r = await bulkCreateRedirects(selectedSite, toCreate);
      toast.success(`Created ${r.data.created || toCreate.length} redirects`);
      setSuggestions([]);
      setAccepted(new Set());
      loadRedirects();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Bulk create failed");
    } finally { setBulkCreating(false); }
  };

  return (
    <div className="page-container">
      <div className="mb-8">
        <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          Redirects
        </motion.h1>
        <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
          Manage 301/302 redirects and let AI suggest fixes for broken URLs
        </motion.p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
        <Button onClick={loadRedirects} variant="outline" size="sm" disabled={!selectedSite}>
          <RefreshCw size={14} className="mr-2" />Refresh
        </Button>
        <Button onClick={handleSuggest} disabled={!selectedSite || suggesting}
          className="border-primary/30 text-primary" variant="outline" size="sm">
          {suggesting ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Bot size={14} className="mr-2" />}
          AI Suggest
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: "Total Redirects", value: redirects.length },
          { label: "301 Permanent", value: redirects.filter(r => r.type === "301").length },
          { label: "Total Hits", value: redirects.reduce((acc, r) => acc + (r.hits || 0), 0) },
        ].map(s => (
          <Card key={s.label} className="stat-card">
            <p className="stat-value">{s.value}</p>
            <p className="stat-label">{s.label}</p>
          </Card>
        ))}
      </div>

      {/* Add form */}
      <Card className="content-card mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Add Redirect</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[160px]">
              <Label className="text-xs mb-1 block">From (old URL)</Label>
              <Input value={form.from} onChange={e => setForm(p => ({ ...p, from: e.target.value }))}
                placeholder="/old-page" className="h-8 text-sm" />
            </div>
            <div className="flex-1 min-w-[160px]">
              <Label className="text-xs mb-1 block">To (new URL)</Label>
              <Input value={form.to} onChange={e => setForm(p => ({ ...p, to: e.target.value }))}
                placeholder="/new-page" className="h-8 text-sm" />
            </div>
            <div className="w-24">
              <Label className="text-xs mb-1 block">Type</Label>
              <Select value={form.type} onValueChange={v => setForm(p => ({ ...p, type: v }))}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="301">301</SelectItem>
                  <SelectItem value="302">302</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" size="sm" className="h-8" disabled={adding || !form.from || !form.to}>
              {adding ? <Loader2 size={14} className="animate-spin mr-1" /> : <Plus size={14} className="mr-1" />}
              Add
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* AI Suggestions */}
      {suggestions.length > 0 && (
        <Card className="content-card mb-6 border-primary/20">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Bot size={14} className="text-primary" />AI Suggestions ({suggestions.length})
              </CardTitle>
              <Button size="sm" className="h-7 text-xs" disabled={!accepted.size || bulkCreating} onClick={handleBulkCreate}>
                {bulkCreating ? <Loader2 size={12} className="animate-spin mr-1" /> : <CheckCircle size={12} className="mr-1" />}
                Create {accepted.size} Selected
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {suggestions.map((s, i) => (
              <div key={i} className={`flex items-center gap-3 p-2 rounded-md cursor-pointer transition-colors ${accepted.has(i) ? "bg-primary/10 border border-primary/30" : "hover:bg-muted/20"}`}
                onClick={() => toggleAccepted(i)}>
                <input type="checkbox" checked={accepted.has(i)} onChange={() => toggleAccepted(i)} className="flex-shrink-0" />
                <div className="flex-1 min-w-0 text-sm">
                  <span className="text-red-400 font-mono text-xs">{s.from}</span>
                  <span className="text-muted-foreground mx-2">→</span>
                  <span className="text-emerald-400 font-mono text-xs">{s.to}</span>
                </div>
                <Badge variant="outline" className="text-xs flex-shrink-0">{s.type || "301"}</Badge>
                {s.reason && <span className="text-xs text-muted-foreground hidden md:block max-w-[200px] truncate">{s.reason}</span>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Redirects table */}
      <Card className="content-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">All Redirects</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-primary" /></div>
          ) : redirects.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              {selectedSite ? "No redirects configured" : "Select a site"}
            </div>
          ) : (
            <ScrollArea className="max-h-[400px]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50">
                    <th className="text-left p-3 text-xs font-medium text-muted-foreground">From</th>
                    <th className="text-left p-3 text-xs font-medium text-muted-foreground">To</th>
                    <th className="text-left p-3 text-xs font-medium text-muted-foreground">Type</th>
                    <th className="text-left p-3 text-xs font-medium text-muted-foreground">Hits</th>
                    <th className="p-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {redirects.map(r => (
                    <tr key={r.id} className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                      <td className="p-3 font-mono text-xs text-muted-foreground">{r.from}</td>
                      <td className="p-3 font-mono text-xs">{r.to}</td>
                      <td className="p-3">
                        <Badge variant="outline" className="text-xs">{r.type || "301"}</Badge>
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">{r.hits || 0}</td>
                      <td className="p-3">
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-red-400"
                          onClick={() => handleDelete(r.id)}>
                          <Trash2 size={12} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <ManualApplySheet
        open={manualSheet.open}
        onClose={closeManualSheet}
        title={manualSheet.title}
        wpAdminUrl={manualSheet.wpAdminUrl}
        fields={manualSheet.fields}
        instructions={manualSheet.instructions}
      />
    </div>
  );
}
