import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  MessageSquare, CheckCircle2, AlertTriangle, Trash2, Loader2,
  Bot, Send, RefreshCw, ChevronDown
} from "lucide-react";
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Checkbox } from "../components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Textarea } from "../components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "../components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "../components/ui/table";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  getSites, getComments, approveComment, spamComment, deleteComment,
  bulkCommentAction, aiReplyComment, postCommentReply, autoModerateComments,
} from "../lib/api";
import { toast } from "sonner";

const STATUS_TABS = [
  { key: "hold", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "spam", label: "Spam" },
  { key: "any", label: "All" },
];

export default function Comments() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [activeTab, setActiveTab] = useState("hold");
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkAction, setBulkAction] = useState("approve");
  const [applyingBulk, setApplyingBulk] = useState(false);
  const [moderating, setModerating] = useState(false);
  const [replyDialog, setReplyDialog] = useState(null);
  const [replyText, setReplyText] = useState("");
  const [loadingReply, setLoadingReply] = useState(false);
  const [postingReply, setPostingReply] = useState(false);
  const [actionLoading, setActionLoading] = useState({});

  useEffect(() => { loadSites(); }, []);
  useEffect(() => { if (selectedSite) loadComments(); }, [selectedSite, activeTab]);

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data || []);
      if (r.data?.length) setSelectedSite(r.data[0].id);
    } catch { }
  };

  const loadComments = async () => {
    setLoading(true);
    setSelectedIds([]);
    try {
      const r = await getComments(selectedSite, activeTab);
      setComments(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to load comments");
    } finally { setLoading(false); }
  };

  const stripHtml = (html) => {
    const tmp = document.createElement("div");
    tmp.innerHTML = html || "";
    return tmp.textContent || tmp.innerText || "";
  };

  const doAction = async (action, commentId) => {
    setActionLoading(prev => ({ ...prev, [commentId]: action }));
    try {
      if (action === "approve") await approveComment(selectedSite, commentId);
      else if (action === "spam") await spamComment(selectedSite, commentId);
      else if (action === "delete") await deleteComment(selectedSite, commentId);
      setComments(prev => prev.filter(c => c.id !== commentId));
      toast.success(`Comment ${action}d`);
    } catch (err) {
      toast.error(err.response?.data?.detail || `Failed to ${action}`);
    } finally { setActionLoading(prev => ({ ...prev, [commentId]: null })); }
  };

  const handleBulk = async () => {
    if (!selectedIds.length) return;
    setApplyingBulk(true);
    try {
      const r = await bulkCommentAction(selectedSite, { ids: selectedIds, action: bulkAction });
      setComments(prev => prev.filter(c => !selectedIds.includes(c.id)));
      setSelectedIds([]);
      toast.success(`Bulk ${bulkAction}: ${r.data.results.filter(x => x.success).length} succeeded`);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Bulk action failed");
    } finally { setApplyingBulk(false); }
  };

  const openAIReply = async (comment) => {
    setReplyDialog(comment);
    setReplyText("");
    setLoadingReply(true);
    try {
      const r = await aiReplyComment(selectedSite, comment.id);
      setReplyText(r.data.suggested_reply);
    } catch { setReplyText(""); }
    finally { setLoadingReply(false); }
  };

  const handlePostReply = async () => {
    if (!replyText.trim()) return;
    setPostingReply(true);
    try {
      await postCommentReply(selectedSite, replyDialog.id, {
        content: replyText,
        parent_id: replyDialog.post,
      });
      toast.success("Reply posted to WordPress");
      setReplyDialog(null);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to post reply");
    } finally { setPostingReply(false); }
  };

  const handleAutoModerate = async () => {
    setModerating(true);
    try {
      const r = await autoModerateComments(selectedSite);
      toast.success(`Auto-moderated: ${r.data.approved} approved, ${r.data.spammed} spammed, ${r.data.deleted} deleted`);
      loadComments();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Auto-moderate failed");
    } finally { setModerating(false); }
  };

  const toggleSelect = (id) => setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleAll = () => setSelectedIds(selectedIds.length === comments.length ? [] : comments.map(c => c.id));

  return (
    <div className="page-container">
      <div className="mb-8">
        <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          Comments Manager
        </motion.h1>
        <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
          Moderate, reply to, and manage WordPress comments with AI assistance
        </motion.p>
      </div>

      {/* Site + Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
        <Button onClick={loadComments} variant="outline" size="sm" disabled={!selectedSite}>
          <RefreshCw size={14} className="mr-2" />Refresh
        </Button>
        <Button onClick={handleAutoModerate} disabled={!selectedSite || moderating} variant="outline" size="sm"
          className="border-primary/30 text-primary hover:bg-primary/10">
          {moderating ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Bot size={14} className="mr-2" />}
          Auto-moderate All Pending
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          {STATUS_TABS.map(t => <TabsTrigger key={t.key} value={t.key}>{t.label}</TabsTrigger>)}
        </TabsList>

        {STATUS_TABS.map(t => (
          <TabsContent key={t.key} value={t.key}>
            {/* Bulk actions bar */}
            {selectedIds.length > 0 && (
              <div className="flex items-center gap-3 mb-4 p-3 rounded-lg border border-border/50 bg-muted/30">
                <span className="text-sm font-medium">{selectedIds.length} selected</span>
                <Select value={bulkAction} onValueChange={setBulkAction}>
                  <SelectTrigger className="w-[140px] h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="approve">Approve</SelectItem>
                    <SelectItem value="spam">Mark Spam</SelectItem>
                    <SelectItem value="delete">Delete</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={handleBulk} disabled={applyingBulk}>
                  {applyingBulk ? <Loader2 size={13} className="mr-1 animate-spin" /> : null}Apply
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])}>Clear</Button>
              </div>
            )}

            {loading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 size={32} className="animate-spin text-primary" />
              </div>
            ) : (
              <Card className="content-card">
                <CardContent className="p-0">
                  <ScrollArea className="h-[560px]">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-8">
                            <Checkbox checked={selectedIds.length === comments.length && comments.length > 0}
                              onCheckedChange={toggleAll} />
                          </TableHead>
                          <TableHead>Author</TableHead>
                          <TableHead>Comment</TableHead>
                          <TableHead>Post ID</TableHead>
                          <TableHead>Date</TableHead>
                          <TableHead>Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {comments.map(c => (
                          <TableRow key={c.id}>
                            <TableCell>
                              <Checkbox checked={selectedIds.includes(c.id)} onCheckedChange={() => toggleSelect(c.id)} />
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                                  {(c.author_name || "?")[0].toUpperCase()}
                                </div>
                                <div>
                                  <p className="text-sm font-medium">{c.author_name}</p>
                                  <p className="text-xs text-muted-foreground">{c.author_email}</p>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="max-w-[280px]">
                              <p className="text-sm truncate">{stripHtml(c.content?.rendered)}</p>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">{c.post}</TableCell>
                            <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                              {new Date(c.date).toLocaleDateString()}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1 flex-wrap">
                                {t.key !== "approved" && (
                                  <Button variant="outline" size="sm" className="h-7 text-xs text-emerald-500 border-emerald-500/30"
                                    disabled={actionLoading[c.id] === "approve"} onClick={() => doAction("approve", c.id)}>
                                    {actionLoading[c.id] === "approve" ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} className="mr-1" />}Approve
                                  </Button>
                                )}
                                <Button variant="outline" size="sm" className="h-7 text-xs text-yellow-500 border-yellow-500/30"
                                  disabled={actionLoading[c.id] === "spam"} onClick={() => doAction("spam", c.id)}>
                                  {actionLoading[c.id] === "spam" ? <Loader2 size={11} className="animate-spin" /> : <AlertTriangle size={11} className="mr-1" />}Spam
                                </Button>
                                <Button variant="ghost" size="sm" className="h-7 text-xs"
                                  onClick={() => openAIReply(c)}>
                                  <Bot size={11} className="mr-1 text-primary" />AI Reply
                                </Button>
                                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500"
                                  disabled={actionLoading[c.id] === "delete"} onClick={() => doAction("delete", c.id)}>
                                  {actionLoading[c.id] === "delete" ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                        {comments.length === 0 && (
                          <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                            {selectedSite ? `No ${t.label.toLowerCase()} comments` : "Select a site"}
                          </TableCell></TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        ))}
      </Tabs>

      {/* AI Reply Dialog */}
      <Dialog open={!!replyDialog} onOpenChange={() => setReplyDialog(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Bot size={16} className="text-primary" />AI-Generated Reply</DialogTitle>
            <DialogDescription>
              Reply to: <span className="font-medium">{replyDialog?.author_name}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <p className="text-xs text-muted-foreground mb-1">Original:</p>
            <p className="text-sm text-muted-foreground bg-muted/30 rounded p-2 mb-4">
              {stripHtml(replyDialog?.content?.rendered)}
            </p>
            <p className="text-xs text-muted-foreground mb-1">AI Reply (editable):</p>
            {loadingReply ? (
              <div className="flex items-center gap-2 p-4 text-muted-foreground">
                <Loader2 size={14} className="animate-spin" /> Generating reply...
              </div>
            ) : (
              <Textarea value={replyText} onChange={e => setReplyText(e.target.value)} rows={5} />
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReplyDialog(null)}>Cancel</Button>
            <Button onClick={handlePostReply} disabled={postingReply || !replyText.trim()}>
              {postingReply ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Send size={14} className="mr-2" />}
              Post Reply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
