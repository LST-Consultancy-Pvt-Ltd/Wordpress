import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { FileInput, Bot, FileText, ListFilter, RefreshCw, Loader2, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import { ScrollArea } from "../components/ui/scroll-area";
import { getSites, getForms, getFormEntries, analyzeFormEntries, createFaqPostFromForm } from "../lib/api";
import { toast } from "sonner";

export default function Forms() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [forms, setForms] = useState([]);
  const [selectedForm, setSelectedForm] = useState("");
  const [entries, setEntries] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [loadingForms, setLoadingForms] = useState(false);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [creatingPost, setCreatingPost] = useState(false);

  useEffect(() => { loadSites(); }, []);
  useEffect(() => { if (selectedSite) loadForms(); }, [selectedSite]);
  useEffect(() => { if (selectedForm) loadEntries(); }, [selectedForm]);

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data || []);
      if (r.data?.length) setSelectedSite(r.data[0].id);
    } catch { }
  };

  const loadForms = async () => {
    setLoadingForms(true);
    setForms([]);
    setSelectedForm("");
    setEntries([]);
    setAnalysis(null);
    try {
      const r = await getForms(selectedSite);
      const list = Array.isArray(r.data) ? r.data : (r.data?.forms || []);
      setForms(list);
      if (list.length) setSelectedForm(String(list[0].id));
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to load forms");
    } finally { setLoadingForms(false); }
  };

  const loadEntries = async () => {
    setLoadingEntries(true);
    try {
      const r = await getFormEntries(selectedSite, selectedForm);
      setEntries(Array.isArray(r.data) ? r.data : (r.data?.entries || []));
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to load entries");
    } finally { setLoadingEntries(false); }
  };

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setAnalysis(null);
    try {
      const r = await analyzeFormEntries(selectedSite, selectedForm);
      setAnalysis(r.data);
      toast.success("AI analysis complete");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Analysis failed");
    } finally { setAnalyzing(false); }
  };

  const handleCreateFaq = async () => {
    if (!analysis) return;
    setCreatingPost(true);
    try {
      const r = await createFaqPostFromForm(selectedSite, selectedForm);
      toast.success(`FAQ post created: ${r.data.post_title || "Post published"}`);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to create FAQ post");
    } finally { setCreatingPost(false); }
  };

  const currentForm = forms.find(f => String(f.id) === selectedForm);
  const allFields = entries.length > 0
    ? Object.keys(typeof entries[0].fields === "object" ? entries[0].fields : {})
    : [];

  return (
    <div className="page-container">
      <div className="mb-8">
        <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          Forms & Entries
        </motion.h1>
        <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
          Browse form submissions and use AI to extract insights and generate FAQ posts
        </motion.p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>

        {forms.length > 0 && (
          <Select value={selectedForm} onValueChange={setSelectedForm}>
            <SelectTrigger className="w-[220px]"><SelectValue placeholder="Select form" /></SelectTrigger>
            <SelectContent>
              {forms.map(f => <SelectItem key={f.id} value={String(f.id)}>{f.title || f.name || `Form ${f.id}`}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Button onClick={loadForms} variant="outline" size="sm" disabled={!selectedSite}>
          <RefreshCw size={14} className="mr-2" />Refresh
        </Button>
        {selectedForm && (
          <Button onClick={handleAnalyze} disabled={analyzing || !entries.length}
            className="border-primary/30 text-primary" variant="outline" size="sm">
            {analyzing ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Bot size={14} className="mr-2" />}
            AI Analyze
          </Button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        {[
          { label: "Total Forms", value: forms.length },
          { label: "Total Entries", value: entries.length },
          { label: "Fields", value: allFields.length },
        ].map(s => (
          <Card key={s.label} className="stat-card">
            <p className="stat-value">{s.value}</p>
            <p className="stat-label">{s.label}</p>
          </Card>
        ))}
      </div>

      {/* AI Analysis Results */}
      {analysis && (
        <Card className="content-card mb-6">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Bot size={14} className="text-primary" />AI Insights
              </CardTitle>
              <Button onClick={handleCreateFaq} disabled={creatingPost} size="sm" className="h-7 text-xs">
                {creatingPost ? <Loader2 size={12} className="animate-spin mr-1" /> : <FileText size={12} className="mr-1" />}
                Create FAQ Post
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {analysis.summary && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">SUMMARY</p>
                <p className="text-sm">{analysis.summary}</p>
              </div>
            )}
            {analysis.top_questions?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">TOP QUESTIONS</p>
                <ul className="space-y-1">
                  {analysis.top_questions.map((q, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="text-primary text-xs mt-0.5 flex-shrink-0">{i + 1}.</span>
                      <span className="text-sm">{q}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {analysis.suggested_faqs?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">SUGGESTED FAQ ITEMS</p>
                <div className="space-y-3">
                  {analysis.suggested_faqs.map((faq, i) => (
                    <div key={i} className="border border-border/50 rounded-md p-3">
                      <p className="font-medium text-sm mb-1">{faq.question}</p>
                      <p className="text-xs text-muted-foreground">{faq.answer}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Entries Table */}
      <Card className="content-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">
            Entries — {currentForm?.title || currentForm?.name || "Select a form"}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loadingEntries ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-primary" />
            </div>
          ) : entries.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              {selectedForm ? "No entries found for this form" : "Select a site and form"}
            </div>
          ) : (
            <ScrollArea className="max-h-[500px]">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/50">
                      <th className="text-left p-3 text-xs font-medium text-muted-foreground">#</th>
                      <th className="text-left p-3 text-xs font-medium text-muted-foreground">Date</th>
                      {allFields.slice(0, 4).map(f => (
                        <th key={f} className="text-left p-3 text-xs font-medium text-muted-foreground capitalize">{f}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry, idx) => {
                      const date = entry.date_created || entry.date_updated || "";
                      const fields = typeof entry.fields === "object" ? entry.fields : {};
                      return (
                        <tr key={entry.id || idx} className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                          <td className="p-3 text-xs text-muted-foreground">{entry.id || idx + 1}</td>
                          <td className="p-3 text-xs text-muted-foreground">{date ? new Date(date).toLocaleDateString() : "—"}</td>
                          {allFields.slice(0, 4).map(f => (
                            <td key={f} className="p-3 text-xs max-w-[150px] truncate">{String(fields[f] ?? "—")}</td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
