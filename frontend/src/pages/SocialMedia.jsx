import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Share2, Twitter, Linkedin, Facebook, Instagram, Plus, Bot, Send, Loader2, RefreshCw, Clock, CheckCircle, Unlink } from "lucide-react";
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
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "../components/ui/dialog";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  getSites, getSocialAccounts, connectSocialAccount, disconnectSocialAccount,
  generateSocialPost, publishSocialPost, getSocialQueue,
} from "../lib/api";
import { toast } from "sonner";

const PLATFORM_ICONS = {
  twitter: Twitter,
  linkedin: Linkedin,
  facebook: Facebook,
  instagram: Instagram,
};

const PLATFORM_COLORS = {
  twitter: "border-sky-500/30 text-sky-400",
  linkedin: "border-blue-500/30 text-blue-400",
  facebook: "border-indigo-500/30 text-indigo-400",
  instagram: "border-pink-500/30 text-pink-400",
};

const PLATFORMS = ["twitter", "linkedin", "facebook", "instagram"];

export default function SocialMedia() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [accounts, setAccounts] = useState([]);
  const [queue, setQueue] = useState([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [activeTab, setActiveTab] = useState("accounts");
  const [generateOpen, setGenerateOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [genForm, setGenForm] = useState({ platform: "twitter", topic: "", post_id: "" });
  const [connectForm, setConnectForm] = useState({ platform: "twitter", access_token: "", page_id: "", account_name: "" });
  const [generating, setGenerating] = useState(false);
  const [generatedPost, setGeneratedPost] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => { loadSites(); }, []);
  useEffect(() => { if (selectedSite) { loadAccounts(); loadQueue(); } }, [selectedSite]);

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data || []);
      if (r.data?.length) setSelectedSite(r.data[0].id);
    } catch { }
  };

  const loadAccounts = async () => {
    setLoadingAccounts(true);
    try {
      const r = await getSocialAccounts(selectedSite);
      setAccounts(Array.isArray(r.data) ? r.data : []);
    } catch { } finally { setLoadingAccounts(false); }
  };

  const loadQueue = async () => {
    try {
      const r = await getSocialQueue(selectedSite);
      setQueue(Array.isArray(r.data) ? r.data : []);
    } catch { }
  };

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await connectSocialAccount(selectedSite, connectForm);
      toast.success(`${connectForm.platform} account connected`);
      setConnectOpen(false);
      setConnectForm({ platform: "twitter", access_token: "", page_id: "", account_name: "" });
      loadAccounts();
    } catch (err) {
      const detail = err.response?.data?.detail;
      const msg = Array.isArray(detail)
        ? detail.map(e => e.msg || JSON.stringify(e)).join("; ")
        : typeof detail === "string"
        ? detail
        : "Failed to connect account";
      toast.error(msg);
    } finally { setConnecting(false); }
  };

  const handleDisconnect = async (platform) => {
    try {
      await disconnectSocialAccount(selectedSite, platform);
      setAccounts(prev => prev.filter(a => a.platform !== platform));
      toast.success(`${platform} disconnected`);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to disconnect");
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setGeneratedPost(null);
    try {
      const r = await generateSocialPost(selectedSite, { topic: genForm.topic, platform: genForm.platform });
      const variants = r.data || {};
      const text = variants[genForm.platform] || variants.twitter || Object.values(variants)[0] || "";
      setGeneratedPost({ content: text, platform: genForm.platform, all: variants });
      toast.success("Post generated!");
    } catch (err) {
      const detail = err.response?.data?.detail;
      toast.error(Array.isArray(detail) ? detail.map(e => e.msg).join("; ") : detail || "Generation failed");
    } finally { setGenerating(false); }
  };

  const handlePublish = async (scheduleAt = null) => {
    if (!generatedPost) return;
    setPublishing(true);
    try {
      const r = await publishSocialPost(selectedSite, genForm.post_id || "0", {
        platforms: [generatedPost.platform],
        content: generatedPost.all || { [generatedPost.platform]: generatedPost.content },
        scheduled_at: scheduleAt,
      });
      const data = r.data || {};
      if (scheduleAt) {
        toast.success("Post scheduled");
      } else {
        const results = data.results || {};
        const platformResult = results[generatedPost.platform];
        if (platformResult?.success) {
          toast.success(`Posted to ${generatedPost.platform} successfully!`);
        } else {
          const errMsg = platformResult?.error || "Unknown error";
          toast.error(`Failed to post to ${generatedPost.platform}: ${errMsg}`);
          return; // keep dialog open so user can see the error
        }
      }
      setGenerateOpen(false);
      setGeneratedPost(null);
      loadQueue();
    } catch (err) {
      const detail = err.response?.data?.detail;
      toast.error(Array.isArray(detail) ? detail.map(e => e.msg).join("; ") : detail || "Publish failed");
    } finally { setPublishing(false); }
  };

  const connectedPlatforms = new Set(accounts.map(a => a.platform));

  return (
    <div className="page-container">
      <div className="mb-8">
        <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          Social Media
        </motion.h1>
        <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
          Manage social accounts, generate AI posts and schedule publishing
        </motion.p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
        <Button onClick={() => { loadAccounts(); loadQueue(); }} variant="outline" size="sm" disabled={!selectedSite}>
          <RefreshCw size={14} className="mr-2" />Refresh
        </Button>
        <Button onClick={() => setConnectOpen(true)} disabled={!selectedSite} variant="outline" size="sm"
          className="border-primary/30 text-primary">
          <Plus size={14} className="mr-2" />Connect Account
        </Button>
        <Button onClick={() => setGenerateOpen(true)} disabled={!selectedSite} size="sm">
          <Bot size={14} className="mr-2" />Generate Post
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {PLATFORMS.map(p => {
          const PIcon = PLATFORM_ICONS[p];
          const isConnected = connectedPlatforms.has(p);
          return (
            <Card key={p} className={`stat-card ${isConnected ? "ring-1 ring-primary/30" : ""}`}>
              <PIcon size={18} className={`mb-1 ${isConnected ? "text-primary" : "text-muted-foreground/40"}`} />
              <p className="stat-value capitalize">{p}</p>
              <p className={`stat-label ${isConnected ? "text-emerald-500" : ""}`}>{isConnected ? "Connected" : "Not connected"}</p>
            </Card>
          );
        })}
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="accounts">Accounts ({accounts.length})</TabsTrigger>
          <TabsTrigger value="queue">Queue ({queue.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="accounts">
          {loadingAccounts ? (
            <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-primary" /></div>
          ) : (
            <div className="space-y-3">
              {accounts.map(a => {
                const PIcon = PLATFORM_ICONS[a.platform] || Share2;
                return (
                  <Card key={a.platform} className="content-card">
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`w-9 h-9 rounded-full border flex items-center justify-center flex-shrink-0 ${PLATFORM_COLORS[a.platform] || "border-gray-500/30 text-gray-400"}`}>
                            <PIcon size={16} />
                          </div>
                          <div>
                            <p className="font-medium text-sm capitalize">{a.platform}</p>
                            <p className="text-xs text-muted-foreground">{a.account_name || a.username || "Connected"}</p>
                          </div>
                        </div>
                        <Button variant="outline" size="sm" className="h-7 text-xs text-red-400 border-red-500/30"
                          onClick={() => handleDisconnect(a.platform)}>
                          <Unlink size={12} className="mr-1" />Disconnect
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
              {accounts.length === 0 && (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  {selectedSite ? "No social accounts connected" : "Select a site"}
                </div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="queue">
          <div className="space-y-3">
            {queue.map((q, i) => {
              const platforms = Array.isArray(q.platforms) ? q.platforms : [q.platform].filter(Boolean);
              const firstPlatform = platforms[0] || "twitter";
              const PIcon = PLATFORM_ICONS[firstPlatform] || Share2;
              const isPending = q.status === "pending";
              const contentObj = q.content || {};
              const previewText = typeof contentObj === "string"
                ? contentObj
                : (contentObj[firstPlatform] || Object.values(contentObj).find(v => typeof v === "string") || "");
              return (
                <Card key={q.id || i} className="content-card">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className={`w-8 h-8 rounded-full border flex items-center justify-center flex-shrink-0 mt-0.5 ${PLATFORM_COLORS[firstPlatform] || "border-gray-500/30 text-gray-400"}`}>
                        <PIcon size={14} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium text-xs capitalize">{platforms.join(", ")}</span>
                          <Badge variant="outline" className={`text-xs ${isPending ? "border-yellow-500/30 text-yellow-500" : "border-emerald-500/30 text-emerald-500"}`}>
                            {isPending ? <Clock size={8} className="mr-1" /> : <CheckCircle size={8} className="mr-1" />}
                            {q.status}
                          </Badge>
                          {q.schedule_at && (
                            <span className="text-xs text-muted-foreground">{new Date(q.schedule_at).toLocaleString()}</span>
                          )}
                        </div>
                        <p className="text-sm line-clamp-2">{previewText}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            {queue.length === 0 && (
              <div className="text-center py-12 text-muted-foreground text-sm">No posts in queue</div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Connect Dialog */}
      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Connect Social Account</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-xs mb-1 block">Platform</Label>
              <Select value={connectForm.platform} onValueChange={v => setConnectForm(p => ({ ...p, platform: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map(p => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs mb-1 block">Account Name</Label>
              <Input value={connectForm.account_name}
                onChange={e => setConnectForm(p => ({ ...p, account_name: e.target.value }))}
                placeholder="e.g. My Business Page" />
            </div>
            <div>
              <Label className="text-xs mb-1 block">Access Token</Label>
              <Input type="password" value={connectForm.access_token}
                onChange={e => setConnectForm(p => ({ ...p, access_token: e.target.value }))}
                placeholder="Bearer token or access token" />
            </div>
            {(connectForm.platform === "facebook" || connectForm.platform === "instagram") && (
              <div>
                <Label className="text-xs mb-1 block">Page ID</Label>
                <Input value={connectForm.page_id}
                  onChange={e => setConnectForm(p => ({ ...p, page_id: e.target.value }))}
                  placeholder="Facebook Page ID" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConnectOpen(false)}>Cancel</Button>
            <Button onClick={handleConnect} disabled={connecting || !connectForm.access_token || !connectForm.account_name}>
              {connecting ? <Loader2 size={14} className="animate-spin mr-2" /> : null}
              Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Generate Dialog */}
      <Dialog open={generateOpen} onOpenChange={(v) => { setGenerateOpen(v); if (!v) setGeneratedPost(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Generate Social Post</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-xs mb-1 block">Platform</Label>
              <Select value={genForm.platform} onValueChange={v => setGenForm(p => ({ ...p, platform: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map(p => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs mb-1 block">Topic or Post ID</Label>
              <Input value={genForm.topic} onChange={e => setGenForm(p => ({ ...p, topic: e.target.value }))}
                placeholder="Write about our new product launch..." />
            </div>
            <Button onClick={handleGenerate} disabled={generating || (!genForm.topic)} variant="outline" className="w-full">
              {generating ? <Loader2 size={14} className="animate-spin mr-2" /> : <Bot size={14} className="mr-2" />}
              Generate
            </Button>
            {generatedPost && (
              <div>
                <Label className="text-xs mb-1 block">Generated Post</Label>
                <Textarea value={generatedPost.content}
                  onChange={e => setGeneratedPost(p => ({ ...p, content: e.target.value }))}
                  className="min-h-[120px]" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGenerateOpen(false)}>Cancel</Button>
            <Button variant="outline" onClick={() => handlePublish("scheduled")} disabled={!generatedPost || publishing}>
              <Clock size={14} className="mr-2" />Schedule
            </Button>
            <Button onClick={() => handlePublish(null)} disabled={!generatedPost || publishing}>
              {publishing ? <Loader2 size={14} className="animate-spin mr-2" /> : <Send size={14} className="mr-2" />}
              Publish Now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
