import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  LayoutGrid, Plus, X, GripVertical, BarChart3, Gauge, Zap,
  FileText, Activity, MapPin, TrendingUp, Loader2, Save, Download
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";
import { getSites } from "../lib/api";

const WIDGET_CATALOG = [
  { id: "keyword_rankings", label: "Keyword Rankings Table", icon: BarChart3, color: "text-blue-500", bg: "bg-blue-500/10" },
  { id: "seo_score", label: "SEO Score Gauge", icon: Gauge, color: "text-purple-500", bg: "bg-purple-500/10" },
  { id: "speed_score", label: "Speed Score Card", icon: Zap, color: "text-yellow-500", bg: "bg-yellow-500/10" },
  { id: "content_count", label: "Content Published Count", icon: FileText, color: "text-emerald-500", bg: "bg-emerald-500/10" },
  { id: "activity", label: "Activity Timeline", icon: Activity, color: "text-orange-500", bg: "bg-orange-500/10" },
  { id: "local_visibility", label: "Local Visibility Summary", icon: MapPin, color: "text-teal-500", bg: "bg-teal-500/10" },
  { id: "visibility_trend", label: "Visibility Trend Chart", icon: TrendingUp, color: "text-pink-500", bg: "bg-pink-500/10" },
];

const WidgetPreview = ({ widget }) => {
  const def = WIDGET_CATALOG.find(w => w.id === widget.id);
  if (!def) return null;
  return (
    <div className="relative group">
      <Card className="content-card h-full border-2 border-dashed border-border/40 hover:border-primary/40 transition-colors">
        <CardContent className="pt-4 pb-4 flex flex-col items-center justify-center min-h-[120px] gap-2">
          <div className={`w-10 h-10 rounded-lg ${def.bg} flex items-center justify-center`}>
            <def.icon size={18} className={def.color} />
          </div>
          <p className="text-sm font-medium text-center">{def.label}</p>
          <p className="text-xs text-muted-foreground">Preview data loads on export</p>
        </CardContent>
      </Card>
    </div>
  );
};

export default function ReportBuilder() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [canvas, setCanvas] = useState([]);
  const [layouts, setLayouts] = useState([]);
  const [saving, setSaving] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [draggingIdx, setDraggingIdx] = useState(null);

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSite) {
      const saved = localStorage.getItem(`report_builder_${selectedSite}`);
      if (saved) {
        try { setCanvas(JSON.parse(saved)); } catch { setCanvas([]); }
      } else {
        setCanvas([]);
      }
    }
  }, [selectedSite]);

  const addWidget = (widgetId) => {
    if (canvas.find(w => w.id === widgetId)) {
      toast.error("Widget already on canvas");
      return;
    }
    setCanvas(prev => [...prev, { id: widgetId, instanceId: `${widgetId}_${Date.now()}` }]);
  };

  const removeWidget = (instanceId) => {
    setCanvas(prev => prev.filter(w => w.instanceId !== instanceId));
  };

  const handleDragStart = (e, idx) => {
    setDraggingIdx(idx);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDrop = (e, targetIdx) => {
    e.preventDefault();
    if (draggingIdx === null || draggingIdx === targetIdx) return;
    const newCanvas = [...canvas];
    const [moved] = newCanvas.splice(draggingIdx, 1);
    newCanvas.splice(targetIdx, 0, moved);
    setCanvas(newCanvas);
    setDraggingIdx(null);
    setDragOver(false);
  };

  const handleSave = () => {
    setSaving(true);
    setTimeout(() => {
      localStorage.setItem(`report_builder_${selectedSite}`, JSON.stringify(canvas));
      setSaving(false);
      toast.success("Report layout saved");
    }, 400);
  };

  const handleExport = () => {
    if (canvas.length === 0) { toast.error("Add widgets to the canvas first"); return; }
    const content = `WP Autopilot — Custom Report\nSite: ${sites.find(s => s.id === selectedSite)?.name || selectedSite}\nGenerated: ${new Date().toLocaleString()}\n\nWidgets:\n${canvas.map(w => {
      const def = WIDGET_CATALOG.find(d => d.id === w.id);
      return `• ${def?.label || w.id}`;
    }).join("\n")}`;
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `custom_report_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Report exported");
  };

  return (
    <div className="page-container">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
            Report Builder
          </motion.h1>
          <p className="page-description">Drag and drop widgets to build a custom report layout</p>
        </div>
        <div className="flex gap-2 items-center">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Select site" /></SelectTrigger>
            <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 size={13} className="mr-1 animate-spin" /> : <Save size={13} className="mr-1" />}
            Save Layout
          </Button>
          <Button className="btn-primary" size="sm" onClick={handleExport}>
            <Download size={13} className="mr-1" /> Export
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Widget Palette */}
        <div className="lg:col-span-1">
          <Card className="content-card sticky top-6">
            <CardHeader className="pb-3">
              <CardTitle className="font-heading text-sm flex items-center gap-2">
                <LayoutGrid size={14} className="text-primary" /> Available Widgets
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {WIDGET_CATALOG.map(widget => (
                <button key={widget.id}
                  onClick={() => addWidget(widget.id)}
                  className={`w-full flex items-center gap-2 p-2 rounded-lg border text-left text-sm transition-all hover:bg-primary/5 hover:border-primary/30 ${canvas.find(w => w.id === widget.id) ? "opacity-40 cursor-not-allowed border-border/20" : "border-border/40 cursor-pointer"}`}
                  disabled={!!canvas.find(w => w.id === widget.id)}>
                  <div className={`w-7 h-7 rounded ${widget.bg} flex items-center justify-center flex-shrink-0`}>
                    <widget.icon size={13} className={widget.color} />
                  </div>
                  <span className="text-xs leading-tight">{widget.label}</span>
                  {canvas.find(w => w.id === widget.id) && (
                    <Badge className="ml-auto text-[10px] bg-muted/30">Added</Badge>
                  )}
                </button>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Canvas */}
        <div className="lg:col-span-3">
          <div
            className={`min-h-[400px] rounded-xl border-2 border-dashed p-4 transition-colors ${dragOver ? "border-primary bg-primary/5" : "border-border/40"}`}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); }}>
            {canvas.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-muted-foreground text-center gap-3">
                <LayoutGrid size={40} className="opacity-30" />
                <p className="text-sm">Click widgets on the left to add them here</p>
                <p className="text-xs">Drag to reorder once added</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {canvas.map((widget, idx) => (
                  <div key={widget.instanceId}
                    draggable
                    onDragStart={e => handleDragStart(e, idx)}
                    onDrop={e => handleDrop(e, idx)}
                    onDragOver={e => e.preventDefault()}
                    className="relative group cursor-grab active:cursor-grabbing">
                    <div className="absolute top-2 right-2 z-10 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => removeWidget(widget.instanceId)}
                        className="w-6 h-6 rounded-full bg-red-500/80 text-white flex items-center justify-center hover:bg-red-500">
                        <X size={10} />
                      </button>
                    </div>
                    <div className="absolute top-1/2 left-2 -translate-y-1/2 opacity-0 group-hover:opacity-40 transition-opacity">
                      <GripVertical size={14} className="text-muted-foreground" />
                    </div>
                    <WidgetPreview widget={widget} />
                  </div>
                ))}
              </div>
            )}
          </div>
          {canvas.length > 0 && (
            <p className="text-xs text-muted-foreground mt-2 text-center">
              {canvas.length} widget{canvas.length !== 1 ? "s" : ""} on canvas — drag to reorder
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
