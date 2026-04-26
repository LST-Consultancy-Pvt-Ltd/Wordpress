import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Mail, Bot, Send, RefreshCw, Loader2, Users, Clock, CheckCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import { ScrollArea } from "../components/ui/scroll-area";
import { getSites, getNewsletterLists, generateNewsletter, sendNewsletter, getNewsletterHistory } from "../lib/api";
import { toast } from "sonner";

export default function Newsletter() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [lists, setLists] = useState([]);
  const [history, setHistory] = useState([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [activeTab, setActiveTab] = useState("compose");
  const [draft, setDraft] = useState({ subject: "", content: "", selectedList: "" });
  const [generatedHtml, setGeneratedHtml] = useState("");
  const [topic, setTopic] = useState("");

  useEffect(() => { loadSites(); }, []);
  useEffect(() => { if (selectedSite) { loadLists(); loadHistory(); } }, [selectedSite]);

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data || []);
      if (r.data?.length) setSelectedSite(r.data[0].id);
    } catch { }
  };

  const loadLists = async () => {
    setLoadingLists(true);
    try {
      const r = await getNewsletterLists(selectedSite);
      const arr = Array.isArray(r.data) ? r.data : (r.data?.lists || []);
      setLists(arr);
      if (arr.length && !draft.selectedList) setDraft(p => ({ ...p, selectedList: String(arr[0].id) }));
    } catch { } finally { setLoadingLists(false); }
  };

  const loadHistory = async () => {
    try {
      const r = await getNewsletterHistory(selectedSite);
      setHistory(Array.isArray(r.data) ? r.data : []);
    } catch { }
  };

  const handleGenerate = async () => {
    if (!topic) return toast.error("Enter a topic first");
    setGenerating(true);
    try {
      const r = await generateNewsletter(selectedSite, { topic, list_id: draft.selectedList });
      setGeneratedHtml(r.data.html || r.data.content || "");
      setDraft(p => ({ ...p, subject: r.data.subject || p.subject, content: r.data.html || r.data.content || "" }));
      toast.success("Newsletter generated!");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Generation failed");
    } finally { setGenerating(false); }
  };

  const handleSend = async () => {
    if (!draft.subject || !draft.content || !draft.selectedList) return toast.error("Fill in subject, content and list");
    setSending(true);
    try {
      const r = await sendNewsletter(selectedSite, {
        subject: draft.subject,
        content: draft.content,
        list_id: draft.selectedList,
      });
      toast.success(`Newsletter sent to ${r.data.sent_to || "list"}`);
      setDraft({ subject: "", content: "", selectedList: draft.selectedList });
      setGeneratedHtml("");
      loadHistory();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to send newsletter");
    } finally { setSending(false); }
  };

  const totalSubscribers = lists.reduce((acc, l) => acc + (l.subscriber_count || l.stats?.member_count || 0), 0);

  return (
    <div className="page-container">
      <div className="mb-8">
        <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          Newsletter
        </motion.h1>
        <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
          Generate AI-powered newsletters and send to your email lists
        </motion.p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
        <Button onClick={() => { loadLists(); loadHistory(); }} variant="outline" size="sm" disabled={!selectedSite}>
          <RefreshCw size={14} className="mr-2" />Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: "Total Lists", value: lists.length, icon: Mail },
          { label: "Subscribers", value: totalSubscribers.toLocaleString(), icon: Users },
          { label: "Newsletters Sent", value: history.length, icon: CheckCircle },
        ].map(s => (
          <Card key={s.label} className="stat-card">
            <s.icon size={16} className="text-primary mb-1" />
            <p className="stat-value">{s.value}</p>
            <p className="stat-label">{s.label}</p>
          </Card>
        ))}
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="compose">Compose</TabsTrigger>
          <TabsTrigger value="lists">Lists ({lists.length})</TabsTrigger>
          <TabsTrigger value="history">History ({history.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="compose">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* left: form */}
            <div className="space-y-4">
              <Card className="content-card">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">AI Generation</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <Label className="text-xs mb-1 block">Send to list</Label>
                    {loadingLists ? (
                      <div className="h-9 flex items-center"><Loader2 size={14} className="animate-spin text-muted-foreground" /></div>
                    ) : (
                      <Select value={draft.selectedList} onValueChange={v => setDraft(p => ({ ...p, selectedList: v }))}>
                        <SelectTrigger><SelectValue placeholder="Select email list" /></SelectTrigger>
                        <SelectContent>
                          {lists.map(l => (
                            <SelectItem key={l.id} value={String(l.id)}>
                              {l.name || l.title} ({(l.subscriber_count || l.stats?.member_count || 0).toLocaleString()} subs)
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  <div>
                    <Label className="text-xs mb-1 block">Topic / Prompt</Label>
                    <Textarea value={topic} onChange={e => setTopic(e.target.value)}
                      placeholder="e.g., Monthly product update for October, highlighting new features..."
                      className="min-h-[80px]" />
                  </div>
                  <Button onClick={handleGenerate} disabled={generating || !topic || !selectedSite} className="w-full">
                    {generating ? <Loader2 size={14} className="animate-spin mr-2" /> : <Bot size={14} className="mr-2" />}
                    Generate Newsletter
                  </Button>
                </CardContent>
              </Card>

              <Card className="content-card">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Subject Line</CardTitle>
                </CardHeader>
                <CardContent>
                  <Input value={draft.subject} onChange={e => setDraft(p => ({ ...p, subject: e.target.value }))}
                    placeholder="Newsletter subject..." />
                </CardContent>
              </Card>

              <Button onClick={handleSend} disabled={sending || !draft.subject || !draft.content || !draft.selectedList}
                className="w-full">
                {sending ? <Loader2 size={14} className="animate-spin mr-2" /> : <Send size={14} className="mr-2" />}
                Send Newsletter
              </Button>
            </div>

            {/* right: preview */}
            <Card className="content-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Preview</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {generatedHtml ? (
                  <iframe
                    srcDoc={`<html><body style="font-family:sans-serif;padding:16px;color:#111">${generatedHtml}</body></html>`}
                    className="w-full rounded-b-lg border-0"
                    style={{ height: 500 }}
                    title="Newsletter preview"
                    sandbox="allow-same-origin"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center h-[300px] text-muted-foreground text-sm gap-2 p-4">
                    <Mail size={32} className="opacity-20" />
                    <span>Preview will appear here after generation</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="lists">
          <div className="space-y-3">
            {lists.map(l => (
              <Card key={l.id} className="content-card">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm">{l.name || l.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {(l.subscriber_count || l.stats?.member_count || 0).toLocaleString()} subscribers
                        {l.created_at && ` · Created ${new Date(l.created_at).toLocaleDateString()}`}
                      </p>
                    </div>
                    <Badge variant="outline" className="text-xs border-emerald-500/30 text-emerald-500">Active</Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
            {lists.length === 0 && (
              <div className="text-center py-12 text-muted-foreground text-sm">
                {selectedSite ? "No email lists found. Connect Mailchimp in Settings." : "Select a site"}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="history">
          <div className="space-y-3">
            {history.map((h, i) => (
              <Card key={h.id || i} className="content-card">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-sm">{h.subject || "Newsletter"}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Sent: {h.sent_at ? new Date(h.sent_at).toLocaleString() : "—"}
                        {h.sent_to && ` · To: ${h.sent_to}`}
                      </p>
                    </div>
                    <Badge variant="outline" className="text-xs border-emerald-500/30 text-emerald-500 flex-shrink-0">
                      <CheckCircle size={10} className="mr-1" />Sent
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
            {history.length === 0 && (
              <div className="text-center py-12 text-muted-foreground text-sm">No newsletters sent yet</div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
