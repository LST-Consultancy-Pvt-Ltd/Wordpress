import { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Bot, Loader2, Play, Eye, Trash2, Settings2, FileText, GitPullRequest,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { Badge } from "../components/ui/badge";
import { Slider } from "../components/ui/slider";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "../components/ui/dialog";
import { ScrollArea } from "../components/ui/scroll-area";
import { Separator } from "../components/ui/separator";
import GatedButton from "../components/sa/GatedButton";
import {
  apiErrorMessage, listItems, getSites, getContentCollections, generateAutoBlogs,
} from "../lib/api";
import { extractChangeSet, notifyChangeSetCreated } from "../lib/changesets";
import { hasCapability, writeBlockedReason } from "../lib/capabilities";
import SSEProgressDrawer, { useSSETask } from "../components/SSEProgressDrawer";
import { toast } from "sonner";

const WRITING_STYLES = ["Professional", "Casual", "Academic", "Conversational", "Persuasive", "Storytelling"];
const TONES = ["Professional", "Conversational", "Technical"];
const AUDIENCES = ["SMB", "Enterprise", "Tech", "Non-tech", "Consumer", "Startup Founders", "Marketers", "Developers"];
const COUNTRIES = ["Global", "United States", "United Kingdom", "Canada", "Australia", "India", "Germany", "France", "UAE", "Singapore", "Japan"];
const DEFAULT_COLLECTION = "__default__";

export default function AutoBlogGeneration() {
  const navigate = useNavigate();
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [collections, setCollections] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [generatedPosts, setGeneratedPosts] = useState([]);
  const [changesetId, setChangesetId] = useState(null);
  const [previewPost, setPreviewPost] = useState(null);
  const { tasks, startTask, dismissTask } = useSSETask();
  const handledTasks = useRef(new Set());

  // Config
  const [config, setConfig] = useState({
    topic: "",
    keywords: "",
    num_posts: 3,
    writing_style: "Professional",
    collection: DEFAULT_COLLECTION,
    target_country: "Global",
    target_audience: "SMB",
    primary_color: "#0A66C2",
    secondary_color: "",
    brand_name: "",
    tone: "Professional",
    word_count_min: 1200,
    word_count_max: 2000,
  });

  const site = sites.find((s) => s.id === selectedSite) || null;
  const generateBlocked = writeBlockedReason(site, "content.write");
  const canReadContent = hasCapability(site, "content.read");

  useEffect(() => {
    getSites().then((r) => {
      const list = listItems(r.data);
      setSites(list);
      if (list.length > 0) setSelectedSite(list[0].id);
    }).catch(() => {});
  }, []);

  // Content collections for the target picker (optional; backend picks a default otherwise).
  useEffect(() => {
    setCollections([]);
    setConfig((c) => ({ ...c, collection: DEFAULT_COLLECTION }));
    if (!selectedSite || !canReadContent) return undefined;
    let cancelled = false;
    getContentCollections(selectedSite)
      .then((r) => { if (!cancelled) setCollections(listItems(r.data)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedSite, canReadContent]);

  // When a generation task finishes, pick up its change set and proposed posts.
  useEffect(() => {
    tasks.forEach((t) => {
      if (t.status !== "complete" || handledTasks.current.has(t.id)) return;
      handledTasks.current.add(t.id);
      const final = [...t.events].reverse().find((e) => e.type === "complete" || e.type === "done");
      const data = final?.data || {};
      if (Array.isArray(data.posts) && data.posts.length) {
        setGeneratedPosts((prev) => [...data.posts, ...prev]);
      }
      const cs = extractChangeSet(data);
      if (cs?.id) setChangesetId(cs.id);
      notifyChangeSetCreated(cs, navigate, {
        title: cs ? `Change set created with ${data.posts?.length || 0} draft post(s)` : undefined,
      });
    });
  }, [tasks, navigate]);

  const handleGenerate = async () => {
    if (!config.topic.trim()) { toast.error("Enter a topic"); return; }
    if (!selectedSite) { toast.error("Select a site"); return; }
    setGenerating(true);
    try {
      const { collection, ...rest } = config;
      const payload = {
        ...rest,
        keywords: config.keywords.split(",").map((k) => k.trim()).filter(Boolean),
      };
      if (collection && collection !== DEFAULT_COLLECTION) payload.collection = collection;
      const r = await generateAutoBlogs(selectedSite, payload);
      if (r.data?.task_id) {
        startTask(r.data.task_id, `Drafting ${config.num_posts} blog posts`);
        toast.success("Generation started — a draft change set will be created when it finishes.");
      }
      const cs = extractChangeSet(r.data);
      if (cs) {
        setChangesetId(cs.id);
        notifyChangeSetCreated(cs, navigate);
      }
      if (Array.isArray(r.data?.posts)) {
        setGeneratedPosts((prev) => [...r.data.posts, ...prev]);
      }
    } catch (e) {
      toast.error(apiErrorMessage(e, "Generation failed"));
    } finally { setGenerating(false); }
  };

  const handleDelete = (idx) => {
    setGeneratedPosts((prev) => prev.filter((_, i) => i !== idx));
    toast.info("Removed from this list (the change set is unchanged)");
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-heading font-bold flex items-center gap-3">
            <Bot className="text-primary" /> Auto Blog Generation
          </h1>
          <p className="text-muted-foreground mt-1">
            Draft SEO-optimized blog posts with AI. Drafts are proposed as one change set for review — nothing is published automatically.
          </p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[220px]" aria-label="Site"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>
            {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name || s.base_url}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Config Panel */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Settings2 size={16} /> Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="abg-topic">Topic / Niche</Label>
              <Textarea
                id="abg-topic"
                placeholder="e.g., Best practices for remote work productivity"
                value={config.topic}
                onChange={(e) => setConfig((c) => ({ ...c, topic: e.target.value }))}
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="abg-keywords">Target Keywords (comma-separated)</Label>
              <Input
                id="abg-keywords"
                placeholder="e.g., remote work, productivity tips, home office"
                value={config.keywords}
                onChange={(e) => setConfig((c) => ({ ...c, keywords: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label>Number of Posts: {config.num_posts}</Label>
              <Slider
                value={[config.num_posts]}
                onValueChange={([v]) => setConfig((c) => ({ ...c, num_posts: v }))}
                min={1}
                max={10}
                step={1}
                aria-label="Number of posts"
              />
            </div>

            {canReadContent && collections.length > 0 && (
              <div className="space-y-2">
                <Label>Target Collection</Label>
                <Select value={config.collection} onValueChange={(v) => setConfig((c) => ({ ...c, collection: v }))}>
                  <SelectTrigger aria-label="Target collection"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_COLLECTION}>Default collection</SelectItem>
                    {collections.map((col) => (
                      <SelectItem key={col.id} value={col.id}>{col.label || col.id}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label>Writing Style</Label>
              <Select value={config.writing_style} onValueChange={(v) => setConfig((c) => ({ ...c, writing_style: v }))}>
                <SelectTrigger aria-label="Writing style"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WRITING_STYLES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Tone</Label>
              <Select value={config.tone} onValueChange={(v) => setConfig((c) => ({ ...c, tone: v }))}>
                <SelectTrigger aria-label="Tone"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TONES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Target Country</Label>
                <Select value={config.target_country} onValueChange={(v) => setConfig((c) => ({ ...c, target_country: v }))}>
                  <SelectTrigger aria-label="Target country"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {COUNTRIES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Target Audience</Label>
                <Select value={config.target_audience} onValueChange={(v) => setConfig((c) => ({ ...c, target_audience: v }))}>
                  <SelectTrigger aria-label="Target audience"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {AUDIENCES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="abg-brand">Brand / Company Name</Label>
              <Input
                id="abg-brand"
                placeholder="e.g., Acme Inc."
                value={config.brand_name}
                onChange={(e) => setConfig((c) => ({ ...c, brand_name: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="abg-primary">Primary Color</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="Primary color picker"
                    value={config.primary_color}
                    onChange={(e) => setConfig((c) => ({ ...c, primary_color: e.target.value }))}
                    className="w-10 h-9 rounded border cursor-pointer flex-shrink-0"
                  />
                  <Input
                    id="abg-primary"
                    value={config.primary_color}
                    onChange={(e) => setConfig((c) => ({ ...c, primary_color: e.target.value }))}
                    placeholder="#0A66C2"
                    className="font-mono text-xs"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="abg-secondary">Secondary <span className="text-xs text-muted-foreground">(optional)</span></Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="Secondary color picker"
                    value={config.secondary_color || "#ffffff"}
                    onChange={(e) => setConfig((c) => ({ ...c, secondary_color: e.target.value }))}
                    className="w-10 h-9 rounded border cursor-pointer flex-shrink-0"
                  />
                  <Input
                    id="abg-secondary"
                    value={config.secondary_color}
                    onChange={(e) => setConfig((c) => ({ ...c, secondary_color: e.target.value }))}
                    placeholder="(optional)"
                    className="font-mono text-xs"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Word Count: {config.word_count_min}–{config.word_count_max}</Label>
              <Slider
                value={[config.word_count_min, config.word_count_max]}
                onValueChange={([min, max]) => setConfig((c) => ({ ...c, word_count_min: min, word_count_max: max }))}
                min={500}
                max={4000}
                step={100}
                minStepsBetweenThumbs={2}
                aria-label="Word count range"
              />
            </div>

            <Separator />

            <p className="text-xs text-muted-foreground">
              Posts are saved as drafts in a change set. Review, validate and submit it for approval in Change Sets.
            </p>

            <GatedButton
              minRole="editor"
              blocked={generateBlocked}
              className="w-full"
              onClick={handleGenerate}
              disabled={generating || !config.topic.trim()}
            >
              {generating
                ? <><Loader2 size={14} className="animate-spin mr-2" /> Generating...</>
                : <><Play size={14} className="mr-2" /> Create change set</>}
            </GatedButton>
          </CardContent>
        </Card>

        {/* Generated Posts */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText size={16} /> Proposed Posts
                {generatedPosts.length > 0 && (
                  <Badge variant="outline" className="ml-auto">{generatedPosts.length} posts</Badge>
                )}
              </CardTitle>
              {changesetId && (
                <Button asChild variant="outline" size="sm" className="w-fit mt-2">
                  <Link to={`/changesets/${changesetId}`}>
                    <GitPullRequest size={14} className="mr-2" aria-hidden="true" /> Review change set
                  </Link>
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {generatedPosts.length > 0 ? (
                <ScrollArea className="h-[500px]">
                  <div className="space-y-3">
                    {generatedPosts.map((post, i) => (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="flex items-start gap-3 p-4 rounded-lg bg-muted/30 border border-border/30"
                      >
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-sm truncate">{post.title}</h4>
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                            {post.excerpt || `${(post.content || post.body || "").replace(/<[^>]+>/g, "").slice(0, 120)}...`}
                          </p>
                          <div className="flex gap-2 mt-2">
                            <Badge variant="outline" className="text-xs capitalize">{post.status || "proposed"}</Badge>
                            {post.slug && <Badge variant="outline" className="text-xs font-mono">{post.slug}</Badge>}
                            {post.word_count && <Badge variant="outline" className="text-xs">{post.word_count} words</Badge>}
                            {post.seo_score && (
                              <Badge variant="outline" className={`text-xs ${post.seo_score >= 80 ? "text-emerald-500" : post.seo_score >= 60 ? "text-yellow-500" : "text-red-500"}`}>
                                SEO: {post.seo_score}
                              </Badge>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setPreviewPost(post)} title="Preview" aria-label={`Preview ${post.title || "post"}`}>
                            <Eye size={14} />
                          </Button>
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-red-500" onClick={() => handleDelete(i)} title="Remove from list" aria-label={`Remove ${post.title || "post"} from list`}>
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                <div className="text-center text-muted-foreground py-16">
                  <Bot size={32} className="mx-auto mb-3 opacity-40" />
                  <p>Configure your settings and create a change set of draft posts</p>
                  <p className="text-xs mt-1">Proposed posts will appear here once generated</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Preview Dialog */}
      <Dialog open={!!previewPost} onOpenChange={() => setPreviewPost(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>{previewPost?.title}</DialogTitle>
          </DialogHeader>
          <ScrollArea className="h-[60vh]">
            {previewPost?.content ? (
              <div
                className="prose prose-invert max-w-none p-4"
                dangerouslySetInnerHTML={{ __html: previewPost.content }}
              />
            ) : (
              <pre className="whitespace-pre-wrap text-sm p-4 font-sans">{previewPost?.body || ""}</pre>
            )}
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewPost(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SSEProgressDrawer tasks={tasks} dismissTask={dismissTask} />
    </motion.div>
  );
}
