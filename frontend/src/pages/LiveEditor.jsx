import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import {
  Edit3, Eye, Loader2, Save, Globe, Sparkles, AlignLeft,
  TrendingUp, Link2, FileSearch, Expand, ChevronDown
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger
} from "../components/ui/dropdown-menu";
import { toast } from "sonner";
import { getSites, editorListPosts, editorGetPost, editorSavePost, editorAIAssist } from "../lib/api";

const readingTime = (text) => {
  const words = (text || "").replace(/<[^>]+>/g, "").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
};

const wordCount = (html) => (html || "").replace(/<[^>]+>/g, "").split(/\s+/).filter(Boolean).length;

export default function LiveEditor() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [postList, setPostList] = useState({ posts: [], pages: [] });
  const [selectedPostId, setSelectedPostId] = useState("");
  const [selectedType, setSelectedType] = useState("post");
  const [post, setPost] = useState(null);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiAction, setAiAction] = useState(null);
  const [selectedRange, setSelectedRange] = useState("");
  const editorRef = useRef(null);
  const iframeRef = useRef(null);

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSite) {
      editorListPosts(selectedSite)
        .then(r => setPostList(r.data))
        .catch(() => setPostList({ posts: [], pages: [] }));
    }
  }, [selectedSite]);

  useEffect(() => {
    if (iframeRef.current && content) {
      iframeRef.current.contentWindow.document.open();
      iframeRef.current.contentWindow.document.write(`<!doctype html><html><head><style>body{font-family:sans-serif;padding:16px;color:#e2e8f0;background:#0f172a;line-height:1.7;}a{color:#6366f1;}img{max-width:100%;}</style></head><body>${content}</body></html>`);
      iframeRef.current.contentWindow.document.close();
    }
  }, [content]);

  const loadPost = async (id, type) => {
    setLoading(true);
    try {
      const r = await editorGetPost(selectedSite, parseInt(id), type);
      setPost(r.data);
      setContent(r.data.content || "");
      setTitle(r.data.title || "");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to load post");
    } finally { setLoading(false); }
  };

  const handleSave = async (status) => {
    if (!post) return;
    setSaving(true);
    try {
      await editorSavePost(selectedSite, post.id, { content, title, status });
      toast.success(status === "publish" ? "Published!" : "Saved as draft");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setSaving(false); }
  };

  const getSelectedText = () => {
    if (editorRef.current) {
      const start = editorRef.current.selectionStart;
      const end = editorRef.current.selectionEnd;
      const raw = editorRef.current.value;
      return raw.slice(start, end) || raw.slice(0, 500);
    }
    return content.replace(/<[^>]+>/g, "").slice(0, 500);
  };

  const handleAIAction = async (action) => {
    const text = getSelectedText();
    if (!text.trim()) { toast.error("Select some text first, or load a post"); return; }
    setAiAction(action);
    try {
      const r = await editorAIAssist({ text, action, site_id: selectedSite });
      const result = r.data.result;
      // Replace selected text in editor or append
      if (editorRef.current) {
        const start = editorRef.current.selectionStart;
        const end = editorRef.current.selectionEnd;
        const raw = editorRef.current.value;
        if (start !== end) {
          const newContent = raw.slice(0, start) + result + raw.slice(end);
          setContent(newContent);
        } else {
          setContent(raw + "\n" + result);
        }
      } else {
        setContent(prev => prev + "\n" + result);
      }
      toast.success("AI edit applied!");
    } catch (e) {
      toast.error(e.response?.data?.detail || "AI assist failed");
    } finally { setAiAction(null); }
  };

  const allPosts = [
    ...postList.posts.map(p => ({ ...p, type: "post" })),
    ...postList.pages.map(p => ({ ...p, type: "page" })),
  ];

  const words = wordCount(content);
  const readTime = readingTime(content);

  return (
    <div className="page-container">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
            Live Editor
          </motion.h1>
          <p className="page-description">Edit WordPress posts with AI assistance and live preview</p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-40"><SelectValue placeholder="Site" /></SelectTrigger>
            <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={selectedPostId} onValueChange={(v) => {
            const item = allPosts.find(p => String(p.id) === v);
            setSelectedPostId(v);
            if (item) { setSelectedType(item.type); loadPost(v, item.type); }
          }}>
            <SelectTrigger className="w-52">
              <SelectValue placeholder="Select post / page" />
            </SelectTrigger>
            <SelectContent>
              {postList.posts.length > 0 && (
                <>
                  <div className="px-2 py-1 text-xs text-muted-foreground font-medium">Posts</div>
                  {postList.posts.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.title}</SelectItem>)}
                </>
              )}
              {postList.pages.length > 0 && (
                <>
                  <div className="px-2 py-1 text-xs text-muted-foreground font-medium">Pages</div>
                  {postList.pages.map(p => <SelectItem key={`page-${p.id}`} value={String(p.id)}>{p.title}</SelectItem>)}
                </>
              )}
            </SelectContent>
          </Select>
        </div>
      </div>

      {post && (
        <>
          {/* AI Toolbar */}
          <Card className="content-card mb-4">
            <CardContent className="pt-3 pb-3">
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-xs text-muted-foreground mr-1">AI Assist:</span>
                {[
                  { action: "improve_writing", icon: Edit3, label: "Improve Writing" },
                  { action: "seo_friendly", icon: TrendingUp, label: "Make SEO-Friendly" },
                  { action: "add_internal_links", icon: Link2, label: "Add Internal Links" },
                  { action: "summarize", icon: FileSearch, label: "Summarize" },
                  { action: "expand", icon: Expand, label: "Expand Section" },
                ].map(({ action, icon: Icon, label }) => (
                  <Button key={action} variant="outline" size="sm" className="text-xs h-7"
                    onClick={() => handleAIAction(action)}
                    disabled={aiAction !== null}>
                    {aiAction === action
                      ? <Loader2 size={11} className="mr-1 animate-spin" />
                      : <Icon size={11} className="mr-1" />}
                    {label}
                  </Button>
                ))}
                <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{words.toLocaleString()} words</span>
                  <span>{readTime} min read</span>
                  <Badge variant="secondary" className="capitalize">{post?.status}</Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Title */}
          <input
            className="w-full bg-transparent text-xl font-bold text-foreground border-b border-border/40 pb-2 mb-4 focus:outline-none focus:border-primary"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Post title…"
          />

          {/* Split Pane */}
          <div className="h-[500px] rounded-xl overflow-hidden border border-border/40">
            <PanelGroup direction="horizontal">
              <Panel defaultSize={50} minSize={30}>
                {loading ? (
                  <div className="flex items-center justify-center h-full">
                    <Loader2 size={28} className="animate-spin text-primary" />
                  </div>
                ) : (
                  <div className="h-full flex flex-col bg-muted/10">
                    <div className="px-3 py-1.5 border-b border-border/30 flex items-center gap-1.5 bg-muted/30">
                      <Edit3 size={12} className="text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">Editor</span>
                    </div>
                    <textarea
                      ref={editorRef}
                      className="flex-1 w-full p-4 bg-transparent text-sm text-foreground resize-none focus:outline-none font-mono leading-relaxed"
                      value={content}
                      onChange={e => setContent(e.target.value)}
                      placeholder="Start writing HTML or paste content here…"
                    />
                  </div>
                )}
              </Panel>
              <PanelResizeHandle className="w-1 bg-border/40 hover:bg-primary/40 transition-colors" />
              <Panel defaultSize={50} minSize={30}>
                <div className="h-full flex flex-col bg-background">
                  <div className="px-3 py-1.5 border-b border-border/30 flex items-center gap-1.5 bg-muted/30">
                    <Eye size={12} className="text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Preview</span>
                  </div>
                  <iframe
                    ref={iframeRef}
                    title="Live Preview"
                    sandbox="allow-same-origin"
                    className="flex-1 w-full border-0"
                  />
                </div>
              </Panel>
            </PanelGroup>
          </div>

          {/* Save Actions */}
          <div className="flex gap-3 mt-4 justify-end">
            <Button variant="outline" onClick={() => handleSave("draft")} disabled={saving}>
              {saving ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Save size={14} className="mr-1" />}
              Save Draft
            </Button>
            <Button className="btn-primary" onClick={() => handleSave("publish")} disabled={saving}>
              {saving ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Globe size={14} className="mr-1" />}
              Publish
            </Button>
          </div>
        </>
      )}

      {!post && !loading && (
        <div className="flex flex-col items-center justify-center py-24 text-muted-foreground text-center">
          <Edit3 size={48} className="mb-4 opacity-30" />
          <p>Select a site and post above to start editing.</p>
        </div>
      )}
    </div>
  );
}
