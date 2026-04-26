import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  FileText, Download, Calendar, Loader2, FileBarChart2,
  BarChart3, Search, Activity, Clock
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "../components/ui/dialog";
import { toast } from "sonner";
import { getSites, listReports, generateReport, scheduleReport } from "../lib/api";

const TEMPLATES = [
  {
    id: "monthly_seo",
    title: "Monthly SEO Summary",
    description: "Keyword rankings, SEO scores, impressions and clicks overview",
    icon: Search,
    color: "text-blue-500",
    bg: "bg-blue-500/10",
  },
  {
    id: "content_performance",
    title: "Content Performance",
    description: "Published posts, engagement metrics and top pages",
    icon: FileBarChart2,
    color: "text-purple-500",
    bg: "bg-purple-500/10",
  },
  {
    id: "keyword_rankings",
    title: "Keyword Rankings Report",
    description: "Full keyword list with current and previous rankings",
    icon: BarChart3,
    color: "text-emerald-500",
    bg: "bg-emerald-500/10",
  },
  {
    id: "site_health",
    title: "Site Health Report",
    description: "Speed audit, activity log and overall health summary",
    icon: Activity,
    color: "text-orange-500",
    bg: "bg-orange-500/10",
  },
];

export default function Reports() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [history, setHistory] = useState([]);
  const [generating, setGenerating] = useState({});
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleData, setScheduleData] = useState({ frequency: "monthly", email: "" });
  const [scheduling, setScheduling] = useState(false);

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSite) loadHistory();
  }, [selectedSite]);

  const loadHistory = async () => {
    try {
      const r = await listReports(selectedSite);
      setHistory(r.data || []);
    } catch { setHistory([]); }
  };

  const handleGenerate = async (template) => {
    setGenerating(prev => ({ ...prev, [template]: true }));
    toast.info("Generating report PDF…");
    try {
      const r = await generateReport(selectedSite, { template });
      const url = URL.createObjectURL(new Blob([r.data], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${template}_${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Report downloaded!");
      loadHistory();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to generate report");
    } finally { setGenerating(prev => ({ ...prev, [template]: false })); }
  };

  const handleSchedule = async () => {
    if (!scheduleData.email.trim()) { toast.error("Email is required"); return; }
    setScheduling(true);
    try {
      await scheduleReport(selectedSite, scheduleData);
      setScheduleOpen(false);
      toast.success(`Report scheduled ${scheduleData.frequency} to ${scheduleData.email}`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to schedule report");
    } finally { setScheduling(false); }
  };

  return (
    <div className="page-container">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
            Standard Reports
          </motion.h1>
          <p className="page-description">Generate and schedule PDF reports from real data</p>
        </div>
        <div className="flex gap-2 items-center">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
            <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => setScheduleOpen(true)} disabled={!selectedSite}>
            <Calendar size={14} className="mr-1.5" /> Schedule
          </Button>
        </div>
      </div>

      {/* Template Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
        {TEMPLATES.map((tpl, i) => (
          <motion.div key={tpl.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.07 }}>
            <Card className="content-card h-full">
              <CardContent className="pt-4 flex flex-col h-full">
                <div className="flex items-start gap-3 mb-3">
                  <div className={`w-10 h-10 rounded-lg ${tpl.bg} flex items-center justify-center flex-shrink-0`}>
                    <tpl.icon size={18} className={tpl.color} />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-medium">{tpl.title}</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">{tpl.description}</p>
                  </div>
                </div>
                <div className="mt-auto pt-3 border-t border-border/30">
                  <Button className="w-full btn-primary" size="sm"
                    onClick={() => handleGenerate(tpl.id)}
                    disabled={generating[tpl.id] || !selectedSite}>
                    {generating[tpl.id]
                      ? <><Loader2 size={13} className="mr-2 animate-spin" /> Generating…</>
                      : <><Download size={13} className="mr-2" /> Download PDF</>}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Report History */}
      {history.length > 0 && (
        <Card className="content-card">
          <CardHeader>
            <CardTitle className="font-heading flex items-center gap-2">
              <Clock size={16} className="text-primary" /> Report History
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {history.map((r, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-border/20 last:border-0">
                  <div className="flex items-center gap-2">
                    <FileText size={14} className="text-muted-foreground" />
                    <span className="text-sm">{r.title}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(r.generated_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Schedule Dialog */}
      <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle className="font-heading">Schedule Auto-Reports</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>Frequency</Label>
              <Select value={scheduleData.frequency} onValueChange={v => setScheduleData(p => ({ ...p, frequency: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Email Address</Label>
              <Input type="email" placeholder="you@example.com" value={scheduleData.email}
                onChange={e => setScheduleData(p => ({ ...p, email: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setScheduleOpen(false)}>Cancel</Button>
            <Button className="btn-primary" onClick={handleSchedule} disabled={scheduling}>
              {scheduling ? <Loader2 size={13} className="mr-1 animate-spin" /> : null} Save Schedule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
