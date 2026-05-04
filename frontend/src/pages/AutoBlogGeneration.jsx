import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Bot, Loader2, Play, Eye, Edit2, Trash2, CheckCircle2,
  Settings2, Image, Search, Sparkles, FileText, ExternalLink
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { Badge } from "../components/ui/badge";
import { Switch } from "../components/ui/switch";
import { Slider } from "../components/ui/slider";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "../components/ui/dialog";
import { ScrollArea } from "../components/ui/scroll-area";
import { Separator } from "../components/ui/separator";
import { getSites, generateAutoBlogs } from "../lib/api";
import SSEProgressDrawer, { useSSETask } from "../components/SSEProgressDrawer";
import { toast } from "sonner";

const WRITING_STYLES = ["Professional", "Casual", "Academic", "Conversational", "Persuasive", "Storytelling"];
const POST_STATUSES = ["draft", "publish"];
const TONES = ["Professional", "Conversational", "Technical"];
const AUDIENCES = ["SMB", "Enterprise", "Tech", "Non-tech", "Consumer", "Startup Founders", "Marketers", "Developers"];
const COUNTRIES = ["Global", "United States", "United Kingdom", "Canada", "Australia", "India", "Germany", "France", "UAE", "Singapore", "Japan"];

export default function AutoBlogGeneration() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generatedPosts, setGeneratedPosts] = useState([]);
  const [previewPost, setPreviewPost] = useState(null);
  const { tasks, startTask, dismissTask } = useSSETask();

  // Config
  const [config, setConfig] = useState({
    topic: "",
    keywords: "",
    num_posts: 3,
    writing_style: "Professional",
    post_status: "draft",
    auto_image: true,
    auto_seo: true,
    // Blog Generation Engine inputs
    target_country: "Global",
    target_audience: "SMB",
    primary_color: "#0A66C2",
    secondary_color: "",
    brand_name: "",
    tone: "Professional",
    word_count_min: 1200,
    word_count_max: 2000,
  });

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  const handleGenerate = async () => {
    if (!config.topic.trim()) { toast.error("Enter a topic"); return; }
    if (!selectedSite) { toast.error("Select a site"); return; }
    setGenerating(true);
    try {
      const r = await generateAutoBlogs(selectedSite, {
        ...config,
        keywords: config.keywords.split(",").map(k => k.trim()).filter(Boolean),
      });
      if (r.data?.task_id) {
        startTask(r.data.task_id, `Generating ${config.num_posts} blog posts`);
        toast.success("Blog generation started! Check progress below.");
      }
      if (r.data?.posts) {
        setGeneratedPosts(prev => [...r.data.posts, ...prev]);
        toast.success(`Generated ${r.data.posts.length} posts`);
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || "Generation failed");
    } finally { setGenerating(false); }
  };

  const handleDelete = (idx) => {
    setGeneratedPosts(prev => prev.filter((_, i) => i !== idx));
    toast.info("Post removed");
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-heading font-bold flex items-center gap-3">
            <Bot className="text-primary" /> Auto Blog Generation
          </h1>
          <p className="text-muted-foreground mt-1">Generate SEO-optimized blog posts with AI</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[220px]"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>
            {sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name || s.url}</SelectItem>)}
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
              <Label>Topic / Niche</Label>
              <Textarea
                placeholder="e.g., Best practices for remote work productivity in 2024"
                value={config.topic}
                onChange={(e) => setConfig(c => ({ ...c, topic: e.target.value }))}
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label>Target Keywords (comma-separated)</Label>
              <Input
                placeholder="e.g., remote work, productivity tips, home office"
                value={config.keywords}
                onChange={(e) => setConfig(c => ({ ...c, keywords: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label>Number of Posts: {config.num_posts}</Label>
              <Slider
                value={[config.num_posts]}
                onValueChange={([v]) => setConfig(c => ({ ...c, num_posts: v }))}
                min={1}
                max={10}
                step={1}
              />
            </div>

            <div className="space-y-2">
              <Label>Writing Style</Label>
              <Select value={config.writing_style} onValueChange={(v) => setConfig(c => ({ ...c, writing_style: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WRITING_STYLES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Tone</Label>
              <Select value={config.tone} onValueChange={(v) => setConfig(c => ({ ...c, tone: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TONES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Target Country</Label>
                <Select value={config.target_country} onValueChange={(v) => setConfig(c => ({ ...c, target_country: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {COUNTRIES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Target Audience</Label>
                <Select value={config.target_audience} onValueChange={(v) => setConfig(c => ({ ...c, target_audience: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {AUDIENCES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Brand / Company Name</Label>
              <Input
                placeholder="e.g., Acme Inc."
                value={config.brand_name}
                onChange={(e) => setConfig(c => ({ ...c, brand_name: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Primary Color</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={config.primary_color}
                    onChange={(e) => setConfig(c => ({ ...c, primary_color: e.target.value }))}
                    className="w-10 h-9 rounded border cursor-pointer flex-shrink-0"
                  />
                  <Input
                    value={config.primary_color}
                    onChange={(e) => setConfig(c => ({ ...c, primary_color: e.target.value }))}
                    placeholder="#0A66C2"
                    className="font-mono text-xs"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Secondary <span className="text-xs text-muted-foreground">(optional)</span></Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={config.secondary_color || "#ffffff"}
                    onChange={(e) => setConfig(c => ({ ...c, secondary_color: e.target.value }))}
                    className="w-10 h-9 rounded border cursor-pointer flex-shrink-0"
                  />
                  <Input
                    value={config.secondary_color}
                    onChange={(e) => setConfig(c => ({ ...c, secondary_color: e.target.value }))}
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
                onValueChange={([min, max]) => setConfig(c => ({ ...c, word_count_min: min, word_count_max: max }))}
                min={500}
                max={4000}
                step={100}
                minStepsBetweenThumbs={2}
              />
            </div>

            <div className="space-y-2">
              <Label>Post Status</Label>
              <Select value={config.post_status} onValueChange={(v) => setConfig(c => ({ ...c, post_status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {POST_STATUSES.map(s => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <Label htmlFor="auto-image" className="text-sm">Auto-generate images</Label>
              <Switch
                id="auto-image"
                checked={config.auto_image}
                onCheckedChange={(v) => setConfig(c => ({ ...c, auto_image: v }))}
              />
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="auto-seo" className="text-sm">Auto-optimize SEO</Label>
              <Switch
                id="auto-seo"
                checked={config.auto_seo}
                onCheckedChange={(v) => setConfig(c => ({ ...c, auto_seo: v }))}
              />
            </div>

            <Button className="w-full" onClick={handleGenerate} disabled={generating || !config.topic.trim()}>
              {generating ? <><Loader2 size={14} className="animate-spin mr-2" /> Generating...</> : <><Play size={14} className="mr-2" /> Generate Posts</>}
            </Button>
          </CardContent>
        </Card>

        {/* Generated Posts */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText size={16} /> Generated Posts
                {generatedPosts.length > 0 && (
                  <Badge variant="outline" className="ml-auto">{generatedPosts.length} posts</Badge>
                )}
              </CardTitle>
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
                            {post.excerpt || post.content?.replace(/<[^>]+>/g, "").slice(0, 120) + "..."}
                          </p>
                          <div className="flex gap-2 mt-2">
                            <Badge variant="outline" className="text-xs capitalize">{post.status || "draft"}</Badge>
                            {post.word_count && <Badge variant="outline" className="text-xs">{post.word_count} words</Badge>}
                            {post.seo_score && (
                              <Badge variant="outline" className={`text-xs ${post.seo_score >= 80 ? "text-emerald-500" : post.seo_score >= 60 ? "text-yellow-500" : "text-red-500"}`}>
                                SEO: {post.seo_score}
                              </Badge>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setPreviewPost(post)} title="Preview">
                            <Eye size={14} />
                          </Button>
                          {post.url && (
                            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" asChild title="Open in WordPress">
                              <a href={post.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /></a>
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-red-500" onClick={() => handleDelete(i)} title="Remove">
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
                  <p>Configure your settings and generate blog posts</p>
                  <p className="text-xs mt-1">Posts will appear here once generated</p>
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
            <div
              className="prose prose-invert max-w-none p-4"
              dangerouslySetInnerHTML={{ __html: previewPost?.content || "" }}
            />
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
