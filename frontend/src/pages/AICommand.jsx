import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles, Send, Loader2, Bot, User, Copy, CheckCheck,
  AlertCircle, Plus, Trash2, Wrench, ChevronDown, ChevronUp, Zap
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Input } from "../components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import { ScrollArea } from "../components/ui/scroll-area";
import { Badge } from "../components/ui/badge";
import { Separator } from "../components/ui/separator";
import {
  getSites, createAgentSession, getAgentSessions, getAgentSession,
  deleteAgentSession, startAgentTurn,
} from "../lib/api";
import { toast } from "sonner";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;

const exampleCommands = [
  "Audit my site and rewrite the 3 weakest pages",
  "Write a blog post about WordPress security best practices",
  "Analyze SEO for the homepage and suggest improvements",
  "Generate a FAQ page about our services",
  "Check all posts and improve meta descriptions",
];

function MessageBubble({ message }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const isUser = message.role === "user";
  const isTool = message.role === "tool";
  const isAssistant = message.role === "assistant";

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isTool) {
    return (
      <div className="flex gap-2 items-start text-xs text-muted-foreground py-1 px-2 bg-muted/30 rounded border border-border/20">
        <Wrench size={12} className="mt-0.5 text-yellow-500 flex-shrink-0" />
        <span className="font-mono truncate">Tool result: {(message.content || "").slice(0, 120)}</span>
      </div>
    );
  }

  if (isAssistant && message.tool_calls?.length) {
    return (
      <div className="flex gap-2 items-center text-xs text-muted-foreground py-1 px-2 bg-primary/5 rounded border border-primary/10">
        <Sparkles size={12} className="text-primary flex-shrink-0" />
        <span>Calling tools: {message.tool_calls.map((tc) => tc.function?.name).join(", ")}</span>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}
    >
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
          isAssistant ? "bg-primary/10" : "bg-muted"
        }`}
      >
        {isAssistant ? <Bot size={16} className="text-primary" /> : <User size={16} className="text-muted-foreground" />}
      </div>
      <div className={`flex-1 max-w-[80%] ${isUser ? "items-end" : ""}`}>
        <div
          className={`rounded-lg p-3 ${
            isAssistant ? "bg-card border border-border/50" : "bg-primary/10 border border-primary/20"
          }`}
        >
          {isAssistant && (
            <div className="flex justify-between items-center mb-2">
              <Badge variant="outline" className="text-xs">AI Agent</Badge>
              <Button variant="ghost" size="sm" className="h-6 px-2" onClick={handleCopy}>
                {copied ? <CheckCheck size={12} className="text-emerald-500" /> : <Copy size={12} />}
              </Button>
            </div>
          )}
          <p className="text-sm whitespace-pre-wrap leading-relaxed">{message.content}</p>
        </div>
        <p className="text-xs text-muted-foreground mt-1 px-1">
          {message.created_at ? new Date(message.created_at).toLocaleTimeString() : ""}
        </p>
      </div>
    </motion.div>
  );
}

function StreamingBubble({ events }) {
  const lastMsg = [...events].reverse().find((e) => e.type === "assistant_message" || e.type === "thinking" || e.type === "tool_call");
  return (
    <div className="flex gap-3">
      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
        <Bot size={16} className="text-primary" />
      </div>
      <div className="flex-1">
        <div className="bg-card border border-border/50 rounded-lg p-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Loader2 size={12} className="animate-spin text-primary" />
            <span>
              {lastMsg?.type === "tool_call"
                ? `Calling tool: ${lastMsg.data?.tool}`
                : lastMsg?.data?.message || "Thinking..."}
            </span>
          </div>
          {events.filter((e) => e.type === "assistant_message").map((e, i) => (
            <p key={i} className="text-sm leading-relaxed mt-1">{e.data?.content}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function AICommand() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [sessions, setSessions] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [command, setCommand] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamEvents, setStreamEvents] = useState([]);
  const [newSessionTitle, setNewSessionTitle] = useState("");
  const scrollRef = useRef(null);
  const esRef = useRef(null);

  useEffect(() => { loadSites(); }, []);
  useEffect(() => { if (selectedSite) loadSessions(); }, [selectedSite]);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, streamEvents]);

  const loadSites = async () => {
    try {
      const res = await getSites();
      setSites(res.data);
      if (res.data.length > 0) setSelectedSite(res.data[0].id);
    } catch { toast.error("Failed to load sites"); }
  };

  const loadSessions = async () => {
    try {
      const res = await getAgentSessions(selectedSite);
      setSessions(res.data);
    } catch { /* ignore */ }
  };

  const handleNewSession = async () => {
    if (!selectedSite) return;
    try {
      const res = await createAgentSession({ site_id: selectedSite, title: newSessionTitle || "New Session" });
      const session = res.data;
      setSessions((prev) => [session, ...prev]);
      setActiveSession(session);
      setMessages([]);
      setNewSessionTitle("");
    } catch { toast.error("Failed to create session"); }
  };

  const handleSelectSession = async (session) => {
    setActiveSession(session);
    try {
      const res = await getAgentSession(session.id);
      setMessages(res.data.messages || []);
    } catch { setMessages([]); }
  };

  const handleDeleteSession = async (sessionId) => {
    try {
      await deleteAgentSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (activeSession?.id === sessionId) { setActiveSession(null); setMessages([]); }
    } catch { toast.error("Failed to delete session"); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!command.trim() || !activeSession) return;
    const userMsg = command;
    setCommand("");
    setLoading(true);
    setStreamEvents([]);

    // Optimistic user message
    const tempMsg = { role: "user", content: userMsg, created_at: new Date().toISOString() };
    setMessages((prev) => [...prev, tempMsg]);

    try {
      const res = await startAgentTurn({ session_id: activeSession.id, message: userMsg });
      const taskId = res.data.task_id;

      // Open SSE
      const es = new EventSource(`${BACKEND_URL}/api/stream/${taskId}`);
      esRef.current = es;

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          setStreamEvents((prev) => [...prev, event]);

          if (event.type === "complete" || event.type === "done") {
            es.close();
            // Reload session messages
            getAgentSession(activeSession.id).then((r) => {
              setMessages(r.data.messages || []);
              setStreamEvents([]);
              setLoading(false);
            });
          } else if (event.type === "error") {
            es.close();
            toast.error(event.data?.message || "Agent error");
            setStreamEvents([]);
            setLoading(false);
          }
        } catch { /* ignore */ }
      };

      es.onerror = () => {
        es.close();
        setLoading(false);
        setStreamEvents([]);
        toast.error("Stream connection lost");
      };
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to send message");
      setLoading(false);
      setStreamEvents([]);
    }
  };

  return (
    <div className="page-container" data-testid="ai-command-page">
      <div className="mb-6">
        <motion.h1 className="page-title flex items-center gap-3" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          <Sparkles className="text-primary" size={28} />
          AI Agent â€” Multi-turn
        </motion.h1>
        <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
          Chain multiple actions in one session â€” the agent executes tools autonomously and streams progress live
        </motion.p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-[calc(100vh-220px)]">
        {/* Sessions Sidebar */}
        <div className="lg:col-span-1 flex flex-col gap-3">
          <Card className="content-card flex-1">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-heading">Sessions</CardTitle>
              <div className="flex gap-2 mt-2">
                <Select value={selectedSite} onValueChange={(v) => { setSelectedSite(v); setActiveSession(null); setMessages([]); }}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Select site" />
                  </SelectTrigger>
                  <SelectContent>
                    {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent className="p-2">
              <div className="flex gap-1 mb-2">
                <Input
                  className="h-7 text-xs"
                  placeholder="Session title..."
                  value={newSessionTitle}
                  onChange={(e) => setNewSessionTitle(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleNewSession()}
                />
                <Button size="sm" className="h-7 px-2" onClick={handleNewSession} disabled={!selectedSite}>
                  <Plus size={12} />
                </Button>
              </div>
              <ScrollArea className="h-[calc(100%-80px)]">
                <div className="space-y-1">
                  {sessions.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-4">No sessions yet</p>
                  )}
                  {sessions.map((session) => (
                    <div
                      key={session.id}
                      onClick={() => handleSelectSession(session)}
                      className={`flex items-center justify-between p-2 rounded cursor-pointer group text-xs transition-colors ${
                        activeSession?.id === session.id
                          ? "bg-primary/10 text-primary"
                          : "hover:bg-muted/50 text-muted-foreground"
                      }`}
                    >
                      <div className="flex-1 truncate">
                        <div className="font-medium truncate">{session.title}</div>
                        <div className="text-[10px] opacity-70">{(session.messages || []).length} messages</div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100"
                        onClick={(e) => { e.stopPropagation(); handleDeleteSession(session.id); }}
                      >
                        <Trash2 size={10} />
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Example prompts */}
          <Card className="content-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-heading text-muted-foreground">Example Commands</CardTitle>
            </CardHeader>
            <CardContent className="p-2">
              <div className="space-y-1">
                {exampleCommands.map((ex, i) => (
                  <button
                    key={i}
                    className="w-full text-left text-xs p-1.5 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setCommand(ex)}
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Chat Area */}
        <div className="lg:col-span-3">
          <Card className="content-card h-full flex flex-col">
            <CardHeader className="border-b border-border/30 pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg font-heading">
                  {activeSession ? activeSession.title : "Select or create a session"}
                </CardTitle>
                {activeSession && (
                  <Badge variant="outline" className="text-xs">
                    {messages.filter((m) => m.role !== "system").length} messages
                  </Badge>
                )}
              </div>
            </CardHeader>

            <CardContent className="flex-1 flex flex-col p-0 overflow-hidden">
              <ScrollArea className="flex-1 p-4" ref={scrollRef}>
                {!activeSession ? (
                  <div className="flex flex-col items-center justify-center h-full text-center py-16">
                    <Bot size={48} className="text-primary/20 mb-4" />
                    <h3 className="font-heading font-medium text-lg mb-2">Multi-turn AI Agent</h3>
                    <p className="text-muted-foreground text-sm max-w-sm">
                      Create a session and give a complex goal â€” the agent chains multiple tools to complete it.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {messages
                      .filter((m) => m.role !== "system")
                      .map((msg, idx) => (
                        <MessageBubble key={idx} message={msg} />
                      ))}
                    {loading && streamEvents.length > 0 && <StreamingBubble events={streamEvents} />}
                    {loading && streamEvents.length === 0 && (
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                          <Loader2 size={16} className="animate-spin text-primary" />
                        </div>
                        <span className="text-sm text-muted-foreground">Agent is starting...</span>
                      </div>
                    )}
                  </div>
                )}
              </ScrollArea>

              <form onSubmit={handleSubmit} className="p-4 border-t border-border/30">
                <div className="flex gap-3">
                  <Textarea
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder={activeSession ? "Give the agent a goal, e.g. 'Audit my site and rewrite the 3 weakest pages'" : "Select or create a session first..."}
                    className="min-h-[80px] resize-none text-sm"
                    disabled={!activeSession || loading}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSubmit(e);
                      }
                    }}
                  />
                  <Button
                    type="submit"
                    className="self-end"
                    disabled={!command.trim() || !activeSession || loading}
                  >
                    {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Press Enter to send Â· Shift+Enter for new line Â· SSE streams progress live
                </p>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

