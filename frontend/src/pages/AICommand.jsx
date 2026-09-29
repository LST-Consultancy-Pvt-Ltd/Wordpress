import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Sparkles, Send, Loader2, Bot, User, Copy, CheckCheck,
  Plus, Trash2, Wrench, GitPullRequest,
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
import GatedButton from "../components/sa/GatedButton";
import { useRole } from "../hooks/useRole";
import { openTaskStream } from "../lib/stream";
import {
  apiErrorMessage, listItems,
  getSites, createAgentSession, getAgentSessions, getAgentSession,
  deleteAgentSession, startAgentTurn,
} from "../lib/api";
import { toast } from "sonner";

const exampleCommands = [
  "Audit my site and propose fixes for the 3 weakest pages",
  "Draft a blog post about Next.js performance best practices",
  "Analyze SEO for the homepage and propose metadata improvements",
  "Draft a FAQ page about our services",
  "Review all articles and propose better meta descriptions",
];

/** Collect change-set ids from an agent event payload or tool result. */
function changesetIdsFrom(value, out = new Set(), depth = 0) {
  if (!value || depth > 4) return out;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { return changesetIdsFrom(JSON.parse(trimmed), out, depth + 1); } catch { /* not JSON */ }
    }
    const re = /"changeset_id"\s*:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(value))) out.add(m[1]);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v) => changesetIdsFrom(v, out, depth + 1));
    return out;
  }
  if (typeof value === "object") {
    if (typeof value.changeset_id === "string") out.add(value.changeset_id);
    if (value.changeset && typeof value.changeset.id === "string") out.add(value.changeset.id);
    if (Array.isArray(value.changeset_ids)) value.changeset_ids.forEach((id) => typeof id === "string" && out.add(id));
    ["data", "result", "content"].forEach((k) => {
      if (value[k] && typeof value[k] !== "string") changesetIdsFrom(value[k], out, depth + 1);
    });
  }
  return out;
}

function ChangeSetLinks({ ids }) {
  if (!ids.length) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-1">
      {ids.map((id) => (
        <Link
          key={id}
          to={`/changesets/${id}`}
          className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2"
        >
          <GitPullRequest size={12} aria-hidden="true" />
          Review proposed change set
        </Link>
      ))}
    </div>
  );
}

function MessageBubble({ message }) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";
  const isTool = message.role === "tool";
  const isAssistant = message.role === "assistant";

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isTool) {
    const ids = [...changesetIdsFrom(message.content)];
    return (
      <div className="text-xs text-muted-foreground py-1 px-2 bg-muted/30 rounded border border-border/20">
        <div className="flex gap-2 items-start">
          <Wrench size={12} className="mt-0.5 text-yellow-500 flex-shrink-0" aria-hidden="true" />
          <span className="font-mono truncate">Tool result: {(message.content || "").slice(0, 120)}</span>
        </div>
        <ChangeSetLinks ids={ids} />
      </div>
    );
  }

  if (isAssistant && message.tool_calls?.length) {
    return (
      <div className="flex gap-2 items-center text-xs text-muted-foreground py-1 px-2 bg-primary/5 rounded border border-primary/10">
        <Sparkles size={12} className="text-primary flex-shrink-0" aria-hidden="true" />
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
              <Button variant="ghost" size="sm" className="h-6 px-2" onClick={handleCopy} aria-label="Copy message">
                {copied ? <CheckCheck size={12} className="text-emerald-500" /> : <Copy size={12} />}
              </Button>
            </div>
          )}
          <p className="text-sm whitespace-pre-wrap leading-relaxed">{message.content}</p>
          {isAssistant && <ChangeSetLinks ids={[...changesetIdsFrom(message.content)]} />}
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
        <div className="bg-card border border-border/50 rounded-lg p-3" aria-live="polite">
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Loader2 size={12} className="animate-spin text-primary" aria-hidden="true" />
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
  const [proposedIds, setProposedIds] = useState([]);
  const [newSessionTitle, setNewSessionTitle] = useState("");
  const scrollRef = useRef(null);
  const esRef = useRef(null);
  const { can } = useRole();
  const canEdit = can("editor");

  useEffect(() => {
    (async () => {
      try {
        const res = await getSites();
        const list = listItems(res.data);
        setSites(list);
        if (list.length > 0) setSelectedSite(list[0].id);
      } catch { toast.error("Failed to load sites"); }
    })();
  }, []);

  const loadSessions = useCallback(async () => {
    if (!selectedSite) return;
    try {
      const res = await getAgentSessions(selectedSite);
      setSessions(listItems(res.data));
    } catch { /* ignore */ }
  }, [selectedSite]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, streamEvents]);

  // Close any open stream on unmount.
  useEffect(() => () => { esRef.current?.close(); }, []);

  const handleNewSession = async () => {
    if (!selectedSite || !canEdit) return;
    try {
      const res = await createAgentSession({ site_id: selectedSite, title: newSessionTitle || "New Session" });
      const session = res.data;
      setSessions((prev) => [session, ...prev]);
      setActiveSession(session);
      setMessages([]);
      setProposedIds([]);
      setNewSessionTitle("");
    } catch { toast.error("Failed to create session"); }
  };

  const handleSelectSession = async (session) => {
    setActiveSession(session);
    setProposedIds([]);
    try {
      const res = await getAgentSession(session.id);
      setMessages(res.data.messages || []);
    } catch { setMessages([]); }
  };

  const handleDeleteSession = async (sessionId) => {
    try {
      await deleteAgentSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (activeSession?.id === sessionId) { setActiveSession(null); setMessages([]); setProposedIds([]); }
    } catch { toast.error("Failed to delete session"); }
  };

  const finishTurn = (sessionId) => {
    getAgentSession(sessionId)
      .then((r) => setMessages(r.data.messages || []))
      .catch(() => {})
      .finally(() => {
        setStreamEvents([]);
        setLoading(false);
      });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!command.trim() || !activeSession || !canEdit) return;
    const userMsg = command;
    const sessionId = activeSession.id;
    setCommand("");
    setLoading(true);
    setStreamEvents([]);

    // Optimistic user message
    const tempMsg = { role: "user", content: userMsg, created_at: new Date().toISOString() };
    setMessages((prev) => [...prev, tempMsg]);

    try {
      const res = await startAgentTurn({ session_id: sessionId, message: userMsg });
      const taskId = res.data.task_id;

      esRef.current?.close();
      const es = await openTaskStream(taskId);
      esRef.current = es;

      es.onmessage = (ev) => {
        let event;
        try { event = JSON.parse(ev.data); } catch { return; }
        setStreamEvents((prev) => [...prev, event]);
        const ids = [...changesetIdsFrom(event.data)];
        if (ids.length) setProposedIds((prev) => [...new Set([...prev, ...ids])]);

        if (event.type === "complete" || event.type === "done") {
          es.close();
          esRef.current = null;
          finishTurn(sessionId);
        } else if (event.type === "error" || event.type === "timeout") {
          es.close();
          esRef.current = null;
          toast.error(event.data?.message || "Agent error");
          setStreamEvents([]);
          setLoading(false);
        }
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;
        toast.error("Stream connection lost");
        finishTurn(sessionId);
      };
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to send message"));
      setLoading(false);
      setStreamEvents([]);
    }
  };

  return (
    <div className="page-container" data-testid="ai-command-page">
      <div className="mb-6">
        <motion.h1 className="page-title flex items-center gap-3" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          <Sparkles className="text-primary" size={28} />
          AI Agent — Multi-turn
        </motion.h1>
        <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
          Chain multiple actions in one session. The agent researches with read-only tools and proposes change sets —
          it never applies anything. Review and approve its proposals in Change Sets.
        </motion.p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-[calc(100vh-220px)]">
        {/* Sessions Sidebar */}
        <div className="lg:col-span-1 flex flex-col gap-3">
          <Card className="content-card flex-1">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-heading">Sessions</CardTitle>
              <div className="flex gap-2 mt-2">
                <Select value={selectedSite} onValueChange={(v) => { setSelectedSite(v); setActiveSession(null); setMessages([]); setProposedIds([]); }}>
                  <SelectTrigger className="h-8 text-xs" aria-label="Site">
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
                  aria-label="New session title"
                  value={newSessionTitle}
                  onChange={(e) => setNewSessionTitle(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleNewSession()}
                />
                <GatedButton
                  minRole="editor"
                  size="sm"
                  className="h-7 px-2"
                  onClick={handleNewSession}
                  disabled={!selectedSite}
                  aria-label="Create session"
                >
                  <Plus size={12} />
                </GatedButton>
              </div>
              <ScrollArea className="h-[calc(100%-80px)]">
                <div className="space-y-1">
                  {sessions.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-4">No sessions yet</p>
                  )}
                  {sessions.map((session) => (
                    <div
                      key={session.id}
                      role="button"
                      tabIndex={0}
                      aria-current={activeSession?.id === session.id ? "true" : undefined}
                      onClick={() => handleSelectSession(session)}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSelectSession(session); }
                      }}
                      className={`flex items-center justify-between p-2 rounded cursor-pointer group text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                        activeSession?.id === session.id
                          ? "bg-primary/10 text-primary"
                          : "hover:bg-muted/50 text-muted-foreground"
                      }`}
                    >
                      <div className="flex-1 truncate">
                        <div className="font-medium truncate">{session.title}</div>
                        <div className="text-[10px] opacity-70">{(session.messages || []).length} messages</div>
                      </div>
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          aria-label={`Delete session ${session.title}`}
                          onClick={(e) => { e.stopPropagation(); handleDeleteSession(session.id); }}
                        >
                          <Trash2 size={10} />
                        </Button>
                      )}
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
                    type="button"
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
              {proposedIds.length > 0 && (
                <div className="mt-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2" role="status">
                  <p className="text-xs font-medium">
                    The agent proposed {proposedIds.length} change set{proposedIds.length === 1 ? "" : "s"} — review them in Change Sets.
                  </p>
                  <ChangeSetLinks ids={proposedIds} />
                </div>
              )}
            </CardHeader>

            <CardContent className="flex-1 flex flex-col p-0 overflow-hidden">
              <ScrollArea className="flex-1 p-4" ref={scrollRef}>
                {!activeSession ? (
                  <div className="flex flex-col items-center justify-center h-full text-center py-16">
                    <Bot size={48} className="text-primary/20 mb-4" />
                    <h3 className="font-heading font-medium text-lg mb-2">Multi-turn AI Agent</h3>
                    <p className="text-muted-foreground text-sm max-w-sm">
                      Create a session and give a complex goal — the agent chains tools and proposes change sets for your review.
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
                    aria-label="Agent goal"
                    placeholder={
                      !canEdit
                        ? "Your role can view sessions but not run the agent"
                        : activeSession
                        ? "Give the agent a goal, e.g. 'Audit my site and propose fixes for the 3 weakest pages'"
                        : "Select or create a session first..."
                    }
                    className="min-h-[80px] resize-none text-sm"
                    disabled={!activeSession || loading || !canEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSubmit(e);
                      }
                    }}
                  />
                  <GatedButton
                    minRole="editor"
                    type="submit"
                    className="self-end"
                    disabled={!command.trim() || !activeSession || loading}
                    aria-label="Send to agent"
                  >
                    {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  </GatedButton>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Press Enter to send · Shift+Enter for new line · Proposals appear as change sets awaiting approval
                </p>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
