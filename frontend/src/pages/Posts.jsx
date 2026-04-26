import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import {
  Newspaper, Plus, Trash2, ExternalLink, Sparkles, Loader2,
  AlertCircle, Wand2, Eye, Edit2, Image, BarChart3, CheckSquare,
  BookOpen, FileSearch, X, RefreshCw
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "../components/ui/card";
import { Separator } from "../components/ui/separator";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { Badge } from "../components/ui/badge";
import { Checkbox } from "../components/ui/checkbox";
import { Switch } from "../components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from "../components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { getSites, getPosts, createPost, deletePost, generateBlogPost, bulkPublish,
  bulkMetaUpdate, bulkTaxonomyUpdate, getTaxonomies, translatePost,
  getWritingStyles, generateBrief, getBriefs, generatePostFromBrief, analyzeReadability,
  executeAICommand } from "../lib/api";
import SSEProgressDrawer, { useSSETask } from "../components/SSEProgressDrawer";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "../components/ui/sheet";

function PreviewPane({ content, title }) {
  const iframeRef = useRef(null);
  useEffect(() => {
    if (iframeRef.current) {
      const doc = iframeRef.current.contentDocument;
      doc.open();
      doc.write(`<!DOCTYPE html><html><head>
        <style>body{font-family:sans-serif;padding:20px;color:#ccc;background:#0f172a;line-height:1.6;}
        h1,h2,h3{color:#e2e8f0;}a{color:#818cf8;}</style>
      </head><body><h1>${title || "Preview"}</h1>${content || "<p><em>Start typing to see preview...</em></p>"}</body></html>`);
      doc.close();
    }
  }, [content, title]);
  return (
    <iframe
      ref={iframeRef}
      title="preview"
      sandbox="allow-same-origin"
      className="w-full h-full border-0 rounded-r-lg"
    />
  );
}

export default function Posts() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [activeTab, setActiveTab] = useState("manual");
  const [previewMode, setPreviewMode] = useState(false);
  const [generateImage, setGenerateImage] = useState(false);
  const [selectedPosts, setSelectedPosts] = useState([]);
  const [bulkAction, setBulkAction] = useState("publish");
  const [taxonomies, setTaxonomies] = useState({ categories: [], tags: [] });
  const [bulkCategoryId, setBulkCategoryId] = useState("");
  const [bulkTagInput, setBulkTagInput] = useState("");
  const [bulkActionRunning, setBulkActionRunning] = useState(false);
  // Multi-language
  const [multiLang, setMultiLang] = useState(false);
  const [targetLanguages, setTargetLanguages] = useState([]);
  const [generatedTranslations, setGeneratedTranslations] = useState([]);
  // Writing styles
  const [writingStyles, setWritingStyles] = useState([]);
  const [selectedStyle, setSelectedStyle] = useState("");
  // Content briefs
  const [briefDialogOpen, setBriefDialogOpen] = useState(false);
  const [briefStep, setBriefStep] = useState(1); // 1=form, 2=view brief, 3=generating
  const [briefForm, setBriefForm] = useState({ topic: "", target_keyword: "" });
  const [generatingBrief, setGeneratingBrief] = useState(false);
  const [currentBrief, setCurrentBrief] = useState(null);
  const [generatingFromBrief, setGeneratingFromBrief] = useState(false);
  // Readability
  const [readabilityPost, setReadabilityPost] = useState(null);
  const [readabilityData, setReadabilityData] = useState(null);
  const [loadingReadability, setLoadingReadability] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  // Edit post (for rewrite flow)
  const [editPost, setEditPost] = useState(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  // Saved briefs tab
  const [savedBriefs, setSavedBriefs] = useState([]);
  const [loadingBriefs, setLoadingBriefs] = useState(false);
  const [postsPageTab, setPostsPageTab] = useState("posts"); // "posts" | "briefs"
  const { tasks, startTask, dismissTask } = useSSETask();

  const [formData, setFormData] = useState({ title: "", content: "", status: "draft" });
  const [generateData, setGenerateData] = useState({ topic: "", keywords: "" });
  const [generatedPost, setGeneratedPost] = useState(null);

  useEffect(() => { loadSites(); loadWritingStyles(); }, []);
  useEffect(() => { if (selectedSite) { loadPosts(); loadTaxonomies(); loadSavedBriefs(); } }, [selectedSite]); // eslint-disable-line

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    } catch { toast.error("Failed to load sites"); }
  };

  const loadPosts = async () => {
    setLoading(true);
    try {
      const r = await getPosts(selectedSite);
      setPosts(r.data);
    } catch { toast.error("Failed to load posts"); }
    finally { setLoading(false); }
  };

  const loadTaxonomies = async () => {
    try {
      const r = await getTaxonomies(selectedSite);
      setTaxonomies(r.data || { categories: [], tags: [] });
    } catch { /* ignore */ }
  };

  const loadWritingStyles = async () => {
    try {
      const r = await getWritingStyles();
      setWritingStyles(r.data || []);
    } catch { /* ignore */ }
  };

  const loadSavedBriefs = async () => {
    if (!selectedSite) return;
    setLoadingBriefs(true);
    try {
      const r = await getBriefs(selectedSite);
      setSavedBriefs(r.data || []);
    } catch { setSavedBriefs([]); }
    finally { setLoadingBriefs(false); }
  };

  const handleGenerateBrief = async () => {
    if (!briefForm.topic.trim() || !briefForm.target_keyword.trim()) {
      toast.error("Topic and keyword are required");
      return;
    }
    setGeneratingBrief(true);
    try {
      const r = await generateBrief(selectedSite, briefForm);
      setCurrentBrief(r.data);
      setBriefStep(2);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to generate brief");
    } finally { setGeneratingBrief(false); }
  };

  const handleGenerateFromBrief = async () => {
    if (!currentBrief) return;
    setGeneratingFromBrief(true);
    setBriefStep(3);
    try {
      const r = await generatePostFromBrief(selectedSite, currentBrief.id);
      setGeneratedPost(r.data);
      setBriefDialogOpen(false);
      setBriefStep(1);
      setCurrentBrief(null);
      setActiveTab("ai");
      setDialogOpen(true);
      toast.success("Post generated from brief!");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to generate post from brief");
      setBriefStep(2);
    } finally { setGeneratingFromBrief(false); }
  };

  const handleRewriteForReadability = async () => {
    if (!readabilityData || !readabilityPost) return;
    setRewriting(true);
    try {
      const suggestions = readabilityData.suggestions?.map((s) =>
        typeof s === "string" ? s : s.issue || s
      ).join("; ") || "";
      const r = await executeAICommand({
        site_id: selectedSite,
        command: `Rewrite this WordPress post to improve readability. Apply these improvements: ${suggestions}. Target grade level: Easy (Flesch score 60-70). Use short paragraphs (2-3 sentences max). Keep all the original facts, meaning, and SEO keywords intact. Post title: "${readabilityPost.title}" Return JSON with two fields only: {"title": "...", "content": "..."} Current content (HTML): ${readabilityPost.content || ""}`,
      });
      let parsed;
      try {
        const text = r.data?.result || r.data?.response || "";
        const clean = text.replace(/```json|```/g, "").trim();
        parsed = JSON.parse(clean);
      } catch {
        toast.error("Could not parse AI rewrite response");
        return;
      }
      setReadabilityPost(null);
      setReadabilityData(null);
      setEditPost({ ...readabilityPost, title: parsed.title || readabilityPost.title, content: parsed.content || readabilityPost.content });
      setEditDialogOpen(true);
      toast.success("Rewritten! Review and save the improved version.");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Rewrite failed");
    } finally { setRewriting(false); }
  };

  const handleReadability = async (post) => {
    setReadabilityPost(post);
    setReadabilityData(null);
    setLoadingReadability(true);
    try {
      const r = await analyzeReadability(selectedSite, post.wp_id, "post");
      setReadabilityData(r.data);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Readability analysis failed");
      setReadabilityPost(null);
    } finally { setLoadingReadability(false); }
  };

  const handleCreatePost = async (e) => {
    e.preventDefault();
    setCreating(true);
    try {
      await createPost({ site_id: selectedSite, ...formData });
      toast.success("Post created!");
      setDialogOpen(false);
      setFormData({ title: "", content: "", status: "draft" });
      loadPosts();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to create post");
    } finally { setCreating(false); }
  };

  const handleGeneratePost = async (e) => {
    e.preventDefault();
    setGenerating(true);
    setGeneratedPost(null);
    setGeneratedTranslations([]);
    try {
      const keywords = generateData.keywords.split(",").map((k) => k.trim()).filter(Boolean);
      const r = await generateBlogPost({
        site_id: selectedSite,
        topic: generateData.topic,
        keywords,
        generate_image: generateImage,
        target_languages: multiLang && targetLanguages.length ? targetLanguages : undefined,
        style_id: (selectedStyle && selectedStyle !== "__none__") ? selectedStyle : undefined,
      });
      setGeneratedPost(r.data);
      if (r.data.translations?.length) setGeneratedTranslations(r.data.translations);
      toast.success("Post generated!");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Generation failed. Check OpenAI API key.");
    } finally { setGenerating(false); }
  };

  const handlePublishGenerated = async () => {
    if (!generatedPost) return;
    setCreating(true);
    try {
      const postPayload = {
        site_id: selectedSite,
        title: generatedPost.title,
        content: generatedPost.content,
        status: "draft",
      };
      if (generatedPost.featured_media_id) postPayload.featured_media = generatedPost.featured_media_id;
      await createPost(postPayload);

      // Save translation drafts
      for (const t of generatedTranslations) {
        try {
          await createPost({ site_id: selectedSite, title: t.title, content: t.content, status: "draft" });
        } catch { /* best-effort */ }
      }
      toast.success(`Saved as draft${generatedTranslations.length ? ` + ${generatedTranslations.length} translations` : ""}!`);
      setDialogOpen(false);
      setGeneratedPost(null);
      setGeneratedTranslations([]);
      setGenerateData({ topic: "", keywords: "" });
      setMultiLang(false);
      setTargetLanguages([]);
      loadPosts();
    } catch { toast.error("Failed to save post"); }
    finally { setCreating(false); }
  };

  const handleDeletePost = async (wpId) => {
    if (!window.confirm("Delete this post?")) return;
    try {
      await deletePost(selectedSite, wpId);
      toast.success("Post deleted");
      loadPosts();
    } catch { toast.error("Failed to delete post"); }
  };

  const handleBulkAction = async () => {
    if (selectedPosts.length === 0) return;
    setBulkActionRunning(true);
    try {
      if (bulkAction === "publish" || bulkAction === "draft") {
        const r = await bulkPublish({ site_id: selectedSite, item_ids: selectedPosts.map(String), content_type: "post", action: bulkAction });
        startTask(r.data.task_id, `Bulk ${bulkAction} ${selectedPosts.length} posts`);
        toast.info(`Bulk ${bulkAction} started...`);
      } else if (bulkAction === "meta-ai") {
        const r = await bulkMetaUpdate({ site_id: selectedSite, item_ids: selectedPosts, content_type: "post" });
        startTask(r.data.task_id, `AI meta update for ${selectedPosts.length} posts`);
        toast.info("AI meta update started...");
      } else if (bulkAction === "set-category" && bulkCategoryId) {
        const r = await bulkTaxonomyUpdate({ site_id: selectedSite, item_ids: selectedPosts, categories: [Number(bulkCategoryId)] });
        startTask(r.data.task_id, `Set category for ${selectedPosts.length} posts`);
        toast.info("Category update started...");
      } else if (bulkAction === "add-tag" && bulkTagInput.trim()) {
        const tags = bulkTagInput.split(",").map((t) => t.trim()).filter(Boolean);
        const r = await bulkTaxonomyUpdate({ site_id: selectedSite, item_ids: selectedPosts, tags });
        startTask(r.data.task_id, `Add tags for ${selectedPosts.length} posts`);
        toast.info("Tag update started...");
      }
      setSelectedPosts([]);
      setBulkCategoryId("");
      setBulkTagInput("");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Bulk action failed");
    } finally { setBulkActionRunning(false); }
  };

  const togglePost = (wpId) => {
    setSelectedPosts((prev) => prev.includes(wpId) ? prev.filter((id) => id !== wpId) : [...prev, wpId]);
  };

  const stripHtml = (html) => {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || "";
  };

  return (
    <div className="page-container" data-testid="posts-page">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
            Blog Posts
          </motion.h1>
          <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
            Manage posts — AI generation, DALL-E images, bulk operations
          </motion.p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-[200px]" data-testid="site-select">
              <SelectValue placeholder="Select a site" />
            </SelectTrigger>
            <SelectContent>
              {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" className="gap-1.5" disabled={!selectedSite}
            onClick={() => { setBriefStep(1); setBriefForm({ topic: "", target_keyword: "" }); setCurrentBrief(null); setBriefDialogOpen(true); }}>
            <FileSearch size={15} />Brief
          </Button>
          <Dialog open={dialogOpen} onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) { setGeneratedPost(null); setActiveTab("manual"); setPreviewMode(false); }
          }}>
            <DialogTrigger asChild>
              <Button className="btn-primary" disabled={!selectedSite} data-testid="create-post-btn">
                <Plus size={16} className="mr-2" />New Post
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[900px] max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="font-heading">Create Blog Post</DialogTitle>
                <DialogDescription>Manual editor or AI generation with optional DALL-E featured image</DialogDescription>
              </DialogHeader>

              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="manual">Manual</TabsTrigger>
                  <TabsTrigger value="ai"><Sparkles size={14} className="mr-2" />AI Generate</TabsTrigger>
                </TabsList>

                <TabsContent value="manual">
                  <div className="py-4">
                    <div className="flex items-center justify-between mb-4">
                      <Label>Edit / Preview</Label>
                      <div className="flex items-center gap-2 text-sm">
                        <Edit2 size={14} className={!previewMode ? "text-primary" : "text-muted-foreground"} />
                        <Switch checked={previewMode} onCheckedChange={setPreviewMode} />
                        <Eye size={14} className={previewMode ? "text-primary" : "text-muted-foreground"} />
                      </div>
                    </div>
                    <form onSubmit={handleCreatePost}>
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label>Post Title</Label>
                          <Input
                            placeholder="Enter post title"
                            value={formData.title}
                            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                            required
                            data-testid="post-title-input"
                          />
                        </div>
                        <div className={`grid gap-2 ${previewMode ? "grid-cols-2" : "grid-cols-1"}`} style={{ height: 300 }}>
                          <div className="flex flex-col">
                            <Label className="mb-1 text-xs text-muted-foreground">Content (HTML)</Label>
                            <Textarea
                              placeholder="Enter post content..."
                              value={formData.content}
                              onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                              className="flex-1 font-mono text-xs resize-none"
                              style={{ height: "100%" }}
                              data-testid="post-content-input"
                            />
                          </div>
                          {previewMode && (
                            <div className="border border-border/30 rounded-lg overflow-hidden" style={{ height: "100%" }}>
                              <PreviewPane content={formData.content} title={formData.title} />
                            </div>
                          )}
                        </div>
                        <div className="space-y-2">
                          <Label>Status</Label>
                          <Select value={formData.status} onValueChange={(v) => setFormData({ ...formData, status: v })}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="draft">Draft</SelectItem>
                              <SelectItem value="publish">Publish</SelectItem>
                              <SelectItem value="pending">Pending Review</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <DialogFooter className="mt-4">
                        <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                        <Button type="submit" className="btn-primary" disabled={creating}>
                          {creating ? <Loader2 size={16} className="mr-2 animate-spin" /> : null}
                          Create Post
                        </Button>
                      </DialogFooter>
                    </form>
                  </div>
                </TabsContent>

                <TabsContent value="ai">
                  {!generatedPost ? (
                    <form onSubmit={handleGeneratePost}>
                      <div className="space-y-4 py-4">
                        <div className="space-y-2">
                          <Label>Topic</Label>
                          <Input
                            placeholder="e.g., 10 Best WordPress Security Plugins"
                            value={generateData.topic}
                            onChange={(e) => setGenerateData({ ...generateData, topic: e.target.value })}
                            required
                            data-testid="ai-topic-input"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Keywords (comma-separated)</Label>
                          <Input
                            placeholder="wordpress, security, plugins"
                            value={generateData.keywords}
                            onChange={(e) => setGenerateData({ ...generateData, keywords: e.target.value })}
                            data-testid="ai-keywords-input"
                          />
                        </div>
                        <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/5 border border-primary/20">
                          <Switch id="gen-image" checked={generateImage} onCheckedChange={setGenerateImage} />
                          <div>
                            <Label htmlFor="gen-image" className="cursor-pointer flex items-center gap-2">
                              <Image size={14} className="text-primary" />
                              Auto-generate featured image (DALL-E 3)
                            </Label>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              Generates and uploads a featured image to WordPress
                            </p>
                          </div>
                        </div>
                        {/* Multi-language toggle */}
                        <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/20 border border-border/30">
                          <Switch id="multi-lang" checked={multiLang} onCheckedChange={(v) => { setMultiLang(v); if (!v) setTargetLanguages([]); }} />
                          <div className="flex-1">
                            <Label htmlFor="multi-lang" className="cursor-pointer text-sm">Generate in multiple languages</Label>
                            <p className="text-xs text-muted-foreground mt-0.5">AI translates and localises the post</p>
                          </div>
                        </div>
                        {multiLang && (
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pl-2">
                            {[
                              { code: "es", label: "Spanish" },
                              { code: "fr", label: "French" },
                              { code: "de", label: "German" },
                              { code: "pt", label: "Portuguese" },
                              { code: "hi", label: "Hindi" },
                              { code: "ar", label: "Arabic" },
                            ].map(({ code, label }) => (
                              <label key={code} className="flex items-center gap-2 text-sm cursor-pointer">
                                <input
                                  type="checkbox"
                                  className="accent-primary"
                                  checked={targetLanguages.includes(code)}
                                  onChange={(e) =>
                                    setTargetLanguages((prev) =>
                                      e.target.checked ? [...prev, code] : prev.filter((l) => l !== code)
                                    )
                                  }
                                />
                                {label}
                              </label>
                            ))}
                          </div>
                        )}
                        {/* Writing Style Selector */}
                        {writingStyles.length > 0 && (
                          <div className="space-y-2">
                            <Label>Writing Style <span className="text-muted-foreground text-xs">(optional)</span></Label>
                            <Select value={selectedStyle || "__none__"} onValueChange={(v) => setSelectedStyle(v === "__none__" ? "" : v)}>
                              <SelectTrigger><SelectValue placeholder="Default (no style)" /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">Default (no style)</SelectItem>
                                {writingStyles.map((s) => (
                                  <SelectItem key={s.id} value={s.id}>{s.name} — <span className="capitalize text-muted-foreground">{s.tone}</span></SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                        <div className="bg-muted/30 rounded-lg p-3 text-xs text-muted-foreground">
                          <div className="flex items-center gap-2 mb-1">
                            <Wand2 size={12} className="text-primary" />
                            <span className="font-medium text-foreground">AI will generate:</span>
                          </div>
                          <ul className="space-y-0.5 ml-4 list-disc">
                            <li>SEO-optimized title and content</li>
                            <li>Meta description (max 160 chars)</li>
                            <li>Category and tag suggestions</li>
                            {generateImage && <li>DALL-E 3 featured image uploaded to WP media</li>}
                          </ul>
                        </div>
                      </div>
                      <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                        <Button type="submit" className="btn-primary" disabled={generating} data-testid="generate-post-btn">
                          {generating ? <Loader2 size={16} className="mr-2 animate-spin" /> : <Sparkles size={16} className="mr-2" />}
                          Generate Post
                        </Button>
                      </DialogFooter>
                    </form>
                  ) : (
                    <div className="space-y-4 py-4">
                      <div>
                        <Label className="text-xs text-muted-foreground">Generated Title</Label>
                        <p className="font-medium mt-1">{generatedPost.title}</p>
                      </div>
                      {generatedPost.meta_description && (
                        <div>
                          <Label className="text-xs text-muted-foreground">Meta Description</Label>
                          <p className="text-sm text-muted-foreground mt-1">{generatedPost.meta_description}</p>
                        </div>
                      )}
                      {generatedPost.featured_image_url && (
                        <div>
                          <Label className="text-xs text-muted-foreground flex items-center gap-1">
                            <Image size={10} />Featured Image (DALL-E 3)
                          </Label>
                          <img src={generatedPost.featured_image_url} alt="Featured" className="w-full h-40 object-cover rounded-lg mt-1" />
                          {generatedPost.featured_media_id && (
                            <Badge className="mt-1 text-xs bg-emerald-500/10 text-emerald-500">
                              Uploaded to WordPress (ID: {generatedPost.featured_media_id})
                            </Badge>
                          )}
                        </div>
                      )}
                      {generatedPost.featured_image_error && (
                        <div className="text-xs text-red-500">Image generation failed: {generatedPost.featured_image_error}</div>
                      )}
                      <div>
                        <Label className="text-xs text-muted-foreground">Content Preview</Label>
                        <div
                          className="p-3 rounded-lg bg-muted/30 max-h-[200px] overflow-y-auto prose prose-sm dark:prose-invert text-sm mt-1"
                          dangerouslySetInnerHTML={{ __html: generatedPost.content }}
                        />
                      </div>
                      {generatedTranslations.length > 0 && (
                        <div>
                          <Label className="text-xs text-muted-foreground">Translations Generated</Label>
                          <div className="space-y-1 mt-1">
                            {generatedTranslations.map((t) => (
                              <div key={t.language} className="flex items-center gap-2 p-2 rounded-md bg-muted/20 text-sm">
                                <Badge variant="outline" className="uppercase text-xs">{t.language}</Badge>
                                <span className="truncate font-medium">{t.title}</span>
                              </div>
                            ))}
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">Translations will be saved as separate draft posts.</p>
                        </div>
                      )}
                      {generatedPost.readability && (
                        <div className="flex flex-wrap items-center gap-2 p-2 rounded-lg bg-muted/20 border border-border/30 text-sm">
                          <BookOpen size={14} className="text-primary" />
                          <span className="font-medium">Readability:</span>
                          <Badge variant="outline">{generatedPost.readability.grade_label}</Badge>
                          <span className="text-muted-foreground">Flesch {generatedPost.readability.flesch_reading_ease} · {generatedPost.readability.word_count} words · ~{generatedPost.readability.reading_time_minutes} min read</span>
                        </div>
                      )}
                      <DialogFooter>
                        <Button variant="outline" onClick={() => { setGeneratedPost(null); setGeneratedTranslations([]); }}>Regenerate</Button>
                        <Button className="btn-primary" onClick={handlePublishGenerated} disabled={creating} data-testid="publish-generated-btn">
                          {creating ? <Loader2 size={16} className="mr-2 animate-spin" /> : null}
                          Save as Draft
                        </Button>
                      </DialogFooter>
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Tabs value={postsPageTab} onValueChange={setPostsPageTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="posts"><Newspaper size={14} className="mr-1.5" />Posts</TabsTrigger>
          <TabsTrigger value="briefs"><FileSearch size={14} className="mr-1.5" />Content Briefs</TabsTrigger>
        </TabsList>

        <TabsContent value="posts">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 p-3 bg-primary/5 border border-primary/20 rounded-lg flex items-center gap-3 flex-wrap"
        >
          <CheckSquare size={16} className="text-primary" />
          <span className="text-sm font-medium">{selectedPosts.length} selected</span>
          <Select value={bulkAction} onValueChange={(v) => { setBulkAction(v); setBulkCategoryId(""); setBulkTagInput(""); }}>
            <SelectTrigger className="w-44 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="publish">Publish</SelectItem>
              <SelectItem value="draft">Unpublish</SelectItem>
              <SelectItem value="meta-ai">Update Meta (AI)</SelectItem>
              <SelectItem value="set-category">Set Category</SelectItem>
              <SelectItem value="add-tag">Add Tag</SelectItem>
            </SelectContent>
          </Select>
          {bulkAction === "set-category" && (
            <Select value={bulkCategoryId} onValueChange={setBulkCategoryId}>
              <SelectTrigger className="w-40 h-8 text-xs"><SelectValue placeholder="Pick category" /></SelectTrigger>
              <SelectContent>
                {taxonomies.categories.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {bulkAction === "add-tag" && (
            <Input
              className="w-40 h-8 text-xs"
              placeholder="tag1, tag2"
              value={bulkTagInput}
              onChange={(e) => setBulkTagInput(e.target.value)}
            />
          )}
          <Button size="sm" className="h-8 text-xs" onClick={handleBulkAction} disabled={bulkActionRunning}>
            {bulkActionRunning ? <Loader2 size={12} className="mr-1 animate-spin" /> : <BarChart3 size={12} className="mr-1" />}Apply
          </Button>
          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setSelectedPosts([])}>Clear</Button>
        </motion.div>
      )}

      <Card className="content-card">
        <CardContent className="p-0">
          {!selectedSite ? (
            <div className="flex flex-col items-center justify-center py-16">
              <AlertCircle size={48} className="text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground">Select a site to view posts</p>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={32} className="animate-spin text-primary" />
            </div>
          ) : posts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Newspaper size={48} className="text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground mb-4">No posts found. Create one!</p>
              <Button className="btn-primary" onClick={() => setDialogOpen(true)} data-testid="create-first-post-btn">
                <Plus size={16} className="mr-2" />Create Post
              </Button>
            </div>
          ) : (
            <Table className="data-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      checked={selectedPosts.length === posts.length && posts.length > 0}
                      onCheckedChange={(v) => setSelectedPosts(v ? posts.map((p) => p.wp_id) : [])}
                    />
                  </TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Modified</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {posts.map((post) => (
                  <TableRow key={post.wp_id}>
                    <TableCell>
                      <Checkbox
                        checked={selectedPosts.includes(post.wp_id)}
                        onCheckedChange={() => togglePost(post.wp_id)}
                      />
                    </TableCell>
                    <TableCell>
                      <div>
                        <p className="font-medium">{stripHtml(post.title)}</p>
                        {post.link && (
                          <a href={post.link} target="_blank" rel="noopener noreferrer"
                            className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 mt-0.5">
                            View post <ExternalLink size={10} />
                          </a>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={post.status === "publish" ? "default" : "secondary"}>{post.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {post.modified ? new Date(post.modified).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost" size="sm"
                          className="text-muted-foreground hover:text-primary"
                          title="Readability analysis"
                          onClick={() => handleReadability(post)}
                        >
                          <BookOpen size={14} />
                        </Button>
                        <Button
                          variant="ghost" size="sm"
                          className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
                          onClick={() => handleDeletePost(post.wp_id)}
                          data-testid={`delete-post-${post.wp_id}`}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

        </TabsContent>

        <TabsContent value="briefs">
          <div className="flex justify-between items-center mb-3">
            <p className="text-sm text-muted-foreground">Saved content briefs for {sites.find((s) => s.id === selectedSite)?.name || "this site"}</p>
            <Button variant="outline" size="sm" onClick={loadSavedBriefs} disabled={loadingBriefs}>
              <RefreshCw size={13} className={loadingBriefs ? "animate-spin" : ""} />
            </Button>
          </div>
          {loadingBriefs ? (
            <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-primary" /></div>
          ) : savedBriefs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <FileSearch size={48} className="text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground mb-1">No briefs yet.</p>
              <p className="text-sm text-muted-foreground">Use the Brief button to generate your first content brief.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {savedBriefs.map((brief) => (
                <Card key={brief.id} className="content-card flex flex-col">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base line-clamp-1">{brief.topic}</CardTitle>
                    {brief.target_keyword && (
                      <Badge variant="secondary" className="w-fit text-xs">{brief.target_keyword}</Badge>
                    )}
                  </CardHeader>
                  <CardContent className="flex-1 space-y-1.5 text-sm">
                    {brief.target_audience && (
                      <p className="text-muted-foreground line-clamp-1"><span className="font-medium text-foreground">Audience:</span> {brief.target_audience}</p>
                    )}
                    {brief.recommended_word_count && (
                      <p className="text-muted-foreground"><span className="font-medium text-foreground">Words:</span> {brief.recommended_word_count}</p>
                    )}
                    {brief.tone_recommendation && (
                      <p className="text-muted-foreground capitalize"><span className="font-medium text-foreground">Tone:</span> {brief.tone_recommendation}</p>
                    )}
                    {brief.lsi_keywords?.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {brief.lsi_keywords.slice(0, 4).map((kw) => (
                          <Badge key={kw} variant="outline" className="text-xs">{kw}</Badge>
                        ))}
                        {brief.lsi_keywords.length > 4 && <Badge variant="outline" className="text-xs">+{brief.lsi_keywords.length - 4} more</Badge>}
                      </div>
                    )}
                  </CardContent>
                  <CardFooter className="gap-2 pt-3">
                    <Button size="sm" className="flex-1" onClick={() => { setCurrentBrief(brief); setBriefStep(2); setBriefDialogOpen(true); }}>
                      Use Brief
                    </Button>
                    <Button size="sm" variant="outline" className="flex-1" onClick={() => { setCurrentBrief(brief); handleGenerateFromBrief(); }}>
                      <Sparkles size={12} className="mr-1" />Write Post
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
      {/* Content Brief Dialog */}
      <Dialog open={briefDialogOpen} onOpenChange={(open) => { setBriefDialogOpen(open); if (!open) { setBriefStep(1); setCurrentBrief(null); } }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><FileSearch size={16} />AI Content Brief</DialogTitle>
            <DialogDescription>
              {briefStep === 1 ? "Generate a detailed SEO content brief before writing." : briefStep === 2 ? "Review your brief and generate the full post." : "Generating your post…"}
            </DialogDescription>
          </DialogHeader>
          {briefStep === 3 && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <Loader2 size={40} className="animate-spin text-primary" />
              <p className="text-muted-foreground text-sm">Generating post from your brief…</p>
              <p className="text-xs text-muted-foreground">This may take 15–30 seconds</p>
            </div>
          )}
          {briefStep === 1 ? (
            <div className="space-y-4 pt-2">
              <div className="space-y-1.5">
                <Label>Topic *</Label>
                <Input placeholder="e.g. Best WordPress caching plugins 2025" value={briefForm.topic}
                  onChange={(e) => setBriefForm((p) => ({ ...p, topic: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Primary Keyword *</Label>
                <Input placeholder="e.g. wordpress caching plugins" value={briefForm.target_keyword}
                  onChange={(e) => setBriefForm((p) => ({ ...p, target_keyword: e.target.value }))} />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setBriefDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleGenerateBrief} disabled={generatingBrief}>
                  {generatingBrief && <Loader2 size={14} className="animate-spin mr-1.5" />}
                  Generate Brief
                </Button>
              </DialogFooter>
            </div>
          ) : briefStep === 2 && currentBrief ? (
            <div className="space-y-4 pt-2 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div><span className="text-muted-foreground text-xs block">Audience</span><span>{currentBrief.target_audience || "—"}</span></div>
                <div><span className="text-muted-foreground text-xs block">Word count</span><span>{currentBrief.recommended_word_count}</span></div>
                <div><span className="text-muted-foreground text-xs block">Tone</span><span className="capitalize">{currentBrief.tone_recommendation || "—"}</span></div>
                <div><span className="text-muted-foreground text-xs block">CTA</span><span>{currentBrief.cta_suggestion || "—"}</span></div>
              </div>
              {currentBrief.competitor_angle && (
                <div><span className="text-muted-foreground text-xs block mb-0.5">Angle vs competitors</span><p className="text-sm">{currentBrief.competitor_angle}</p></div>
              )}
              {currentBrief.lsi_keywords?.length > 0 && (
                <div>
                  <span className="text-muted-foreground text-xs block mb-1">LSI Keywords</span>
                  <div className="flex flex-wrap gap-1">
                    {currentBrief.lsi_keywords.map((kw) => <Badge key={kw} variant="secondary" className="text-xs">{kw}</Badge>)}
                  </div>
                </div>
              )}
              {currentBrief.outline?.length > 0 && (
                <div>
                  <span className="text-muted-foreground text-xs block mb-1">Outline</span>
                  <div className="space-y-1">
                    {currentBrief.outline.map((h, i) => (
                      <div key={i} style={{ paddingLeft: `${(h.level - 1) * 16}px` }} className="text-sm">
                        <span className="text-muted-foreground text-xs mr-1">H{h.level}</span>{h.heading}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setBriefStep(1)}>Back</Button>
                <Button onClick={handleGenerateFromBrief} disabled={generatingFromBrief}>
                  {generatingFromBrief && <Loader2 size={14} className="animate-spin mr-1.5" />}
                  <Sparkles size={14} className="mr-1.5" />Generate Post from Brief
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Edit/Review Rewritten Post Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={(open) => { setEditDialogOpen(open); if (!open) setEditPost(null); }}>
        <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-heading">Review Rewritten Post</DialogTitle>
            <DialogDescription>Review the AI-rewritten version and save it as a draft.</DialogDescription>
          </DialogHeader>
          {editPost && (
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input value={editPost.title} onChange={(e) => setEditPost((p) => ({ ...p, title: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Content (HTML)</Label>
                <Textarea
                  value={editPost.content}
                  onChange={(e) => setEditPost((p) => ({ ...p, content: e.target.value }))}
                  className="font-mono text-xs resize-none"
                  style={{ height: 280 }}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setEditDialogOpen(false)}>Discard</Button>
                <Button className="btn-primary" disabled={creating} onClick={async () => {
                  setCreating(true);
                  try {
                    await createPost({ site_id: selectedSite, title: editPost.title, content: editPost.content, status: "draft" });
                    toast.success("Saved as draft!");
                    setEditDialogOpen(false);
                    setEditPost(null);
                    loadPosts();
                  } catch { toast.error("Failed to save"); }
                  finally { setCreating(false); }
                }}>
                  {creating ? <Loader2 size={14} className="animate-spin mr-2" /> : null}
                  Save as Draft
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Sheet open={!!readabilityPost} onOpenChange={(open) => { if (!open) { setReadabilityPost(null); setReadabilityData(null); } }}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><BookOpen size={16} />Readability Analysis</SheetTitle>
            <SheetDescription>{readabilityPost ? stripHtml(readabilityPost.title) : ""}</SheetDescription>
          </SheetHeader>
          <div className="mt-6">
            {loadingReadability ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <Loader2 size={28} className="animate-spin text-primary" />
                <p className="text-muted-foreground text-sm">Analysing content…</p>
              </div>
            ) : readabilityData ? (
              <div className="space-y-5">
                <div className="flex items-center justify-between p-4 rounded-xl bg-primary/8 border border-primary/20">
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">Grade</p>
                    <p className="text-xl font-bold">{readabilityData.grade_label}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground mb-0.5">Flesch Score</p>
                    <p className="text-xl font-bold">{readabilityData.flesch_reading_ease}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    ["FK Grade", readabilityData.flesch_kincaid_grade],
                    ["Gunning Fog", readabilityData.gunning_fog],
                    ["Avg Sentence", `${readabilityData.avg_sentence_length} wds`],
                    ["Word Count", readabilityData.word_count],
                    ["Read Time", `~${readabilityData.reading_time_minutes} min`],
                    ["Avg Syllables", readabilityData.avg_syllables_per_word],
                  ].map(([label, val]) => (
                    <div key={label} className="p-3 rounded-lg bg-muted/30 border border-border/30">
                      <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
                      <p className="font-semibold">{val}</p>
                    </div>
                  ))}
                </div>
                {readabilityData.suggestions?.length > 0 && (
                  <div>
                    <p className="text-sm font-medium mb-2">AI Suggestions</p>
                    <ul className="space-y-2">
                      {readabilityData.suggestions.map((s, i) => (
                        <li key={i} className="flex gap-2 text-sm text-muted-foreground">
                          <span className="text-primary font-bold mt-0.5">·</span>{typeof s === "string" ? s : s.issue || JSON.stringify(s)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <Separator className="my-4" />
                <Button
                  className="w-full"
                  onClick={handleRewriteForReadability}
                  disabled={rewriting}
                >
                  {rewriting
                    ? <><Loader2 size={14} className="animate-spin mr-2" />Rewriting...</>
                    : <><Sparkles size={14} className="mr-2" />Rewrite for Better Readability</>
                  }
                </Button>
              </div>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <SSEProgressDrawer tasks={tasks} dismissTask={dismissTask} />
    </div>
  );
}
