import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Smartphone, ScanLine, Loader2, AlertCircle, CheckCircle2, RefreshCw, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Progress } from "../components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../components/ui/accordion";
import { toast } from "sonner";
import { getSites, checkMobileUsability, getMobileCheckResults, subscribeToTask } from "../lib/api";

const ScoreCircle = ({ score }) => {
  const color = score == null ? "text-muted-foreground" : score >= 90 ? "text-emerald-500" : score >= 50 ? "text-yellow-500" : "text-red-500";
  return (
    <div className="flex flex-col items-center gap-1">
      <span className={`text-3xl font-bold ${color}`}>{score ?? "—"}</span>
      <span className="text-xs text-muted-foreground">/ 100</span>
    </div>
  );
};

export default function MobileChecker() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data || []);
      if (r.data?.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSite) loadResults();
  }, [selectedSite]); // eslint-disable-line

  const loadResults = async () => {
    setLoading(true);
    try {
      const r = await getMobileCheckResults(selectedSite);
      setData(r.data);
    } catch { setData(null); }
    finally { setLoading(false); }
  };

  const handleCheck = async () => {
    setChecking(true);
    toast.info("Mobile check started — this may take a minute…");
    try {
      const r = await checkMobileUsability(selectedSite);
      const unsub = subscribeToTask(r.data.task_id, (ev) => {
        if (ev.type === "status" && ev.data?.step === ev.data?.total && ev.data?.total > 0) {
          unsub();
          setChecking(false);
          loadResults();
          toast.success("Mobile check complete!");
        }
        if (ev.type === "error") {
          unsub();
          setChecking(false);
          toast.error(ev.data?.message || "Check failed");
        }
      });
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to start check");
      setChecking(false);
    }
  };

  const results = data?.results || [];

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Mobile Responsiveness Checker</h1>
          <p className="text-sm text-muted-foreground mt-1">Check mobile usability scores using Google PageSpeed Insights</p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Select site" /></SelectTrigger>
            <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={loadResults} disabled={loading}>
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </Button>
          <Button className="btn-primary" size="sm" onClick={handleCheck} disabled={checking || !selectedSite}>
            {checking ? <Loader2 size={14} className="mr-1 animate-spin" /> : <ScanLine size={14} className="mr-1" />}
            {checking ? "Checking…" : "Run Check"}
          </Button>
        </div>
      </div>

      {data?.checked_at && (
        <p className="text-xs text-muted-foreground">
          Last checked: {new Date(data.checked_at).toLocaleString()}
        </p>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-muted-foreground" /></div>
      ) : results.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Smartphone size={40} className="mx-auto mb-3 text-muted-foreground opacity-40" />
            <p className="text-muted-foreground text-sm">No mobile check data yet. Click "Run Check" to analyse your pages.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {results.map((result, i) => (
            <Card key={i} className="flex flex-col">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center justify-between gap-2">
                  <a href={result.url} target="_blank" rel="noopener noreferrer"
                    className="truncate hover:text-primary flex items-center gap-1">
                    <ExternalLink size={12} className="shrink-0" />
                    <span className="truncate">{result.url}</span>
                  </a>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 space-y-4">
                <div className="flex items-center gap-4">
                  <ScoreCircle score={result.score} />
                  <div className="flex-1 space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground mb-1">
                      <span>Performance</span>
                      <span>{result.score ?? "N/A"}/100</span>
                    </div>
                    <Progress value={result.score ?? 0} className="h-2" />
                    <div className="flex gap-1 mt-1">
                      {result.score == null ? (
                        <Badge className="bg-muted text-muted-foreground text-xs">No data</Badge>
                      ) : result.score >= 90 ? (
                        <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-xs">
                          <CheckCircle2 size={10} className="mr-1" /> Good
                        </Badge>
                      ) : result.score >= 50 ? (
                        <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20 text-xs">Needs Work</Badge>
                      ) : (
                        <Badge className="bg-red-500/10 text-red-500 border-red-500/20 text-xs">
                          <AlertCircle size={10} className="mr-1" /> Poor
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>

                {result.error && (
                  <p className="text-xs text-red-400">{result.error}</p>
                )}

                {result.failing_audits?.length > 0 && (
                  <Accordion type="single" collapsible className="w-full">
                    <AccordionItem value="audits" className="border-0">
                      <AccordionTrigger className="py-1 text-xs text-muted-foreground hover:text-foreground">
                        {result.failing_audits.length} failing audit{result.failing_audits.length !== 1 ? "s" : ""}
                      </AccordionTrigger>
                      <AccordionContent>
                        <ul className="space-y-1.5 mt-1">
                          {result.failing_audits.map((audit, j) => (
                            <li key={j} className="text-xs text-muted-foreground flex gap-1.5">
                              <AlertCircle size={11} className="text-yellow-500 shrink-0 mt-0.5" />
                              <span>{audit.title}</span>
                            </li>
                          ))}
                        </ul>
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </motion.div>
  );
}
