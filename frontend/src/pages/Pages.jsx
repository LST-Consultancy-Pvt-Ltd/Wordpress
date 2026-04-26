import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import {
  FileText, Plus, Trash2, ExternalLink, Loader2,
  AlertCircle, Eye, Edit2, BarChart3, CheckSquare, Languages
} from "lucide-react";
import { Card, CardContent } from "../components/ui/card";
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
import { getSites, getPages, createPage, deletePage, bulkPublish,
  bulkMetaUpdate, bulkTaxonomyUpdate, getTaxonomies, translatePost } from "../lib/api";
import SSEProgressDrawer, { useSSETask } from "../components/SSEProgressDrawer";
import { toast } from "sonner";

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
    <iframe ref={iframeRef} title="preview" sandbox="allow-same-origin" className="w-full h-full border-0 rounded-r-lg" />
  );
}

export default function Pages() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [selectedPages, setSelectedPages] = useState([]);
  const [bulkAction, setBulkAction] = useState("publish");
  const [taxonomies, setTaxonomies] = useState({ categories: [], tags: [] });
  const [bulkCategoryId, setBulkCategoryId] = useState("");
  const [bulkTagInput, setBulkTagInput] = useState("");
  const [bulkActionRunning, setBulkActionRunning] = useState(false);
  // Translate
  const [translatingPage, setTranslatingPage] = useState(null);
  const [translateDialogOpen, setTranslateDialogOpen] = useState(false);
  const [translateLangs, setTranslateLangs] = useState([]);
  const [translatingLoading, setTranslatingLoading] = useState(false);
  const { tasks, startTask, dismissTask } = useSSETask();

  const [formData, setFormData] = useState({ title: "", content: "", status: "draft" });

  useEffect(() => { loadSites(); }, []);
  useEffect(() => { if (selectedSite) { loadPages(); loadTaxonomies(); } }, [selectedSite]);

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    } catch { toast.error("Failed to load sites"); }
  };

  const loadPages = async () => {
    setLoading(true);
    try {
      const r = await getPages(selectedSite);
      setPages(r.data);
    } catch { toast.error("Failed to load pages"); }
    finally { setLoading(false); }
  };

  const loadTaxonomies = async () => {
    try {
      const r = await getTaxonomies(selectedSite);
      setTaxonomies(r.data || { categories: [], tags: [] });
    } catch { /* ignore */ }
  };

  const handleTranslatePage = async () => {
    if (!translatingPage || !translateLangs.length) return;
    setTranslatingLoading(true);
    try {
      const r = await translatePost(selectedSite, translatingPage.wp_id, { target_languages: translateLangs });
      toast.success(`Translated into ${r.data.translations?.length || translateLangs.length} language(s)!`);
      setTranslateDialogOpen(false);
      setTranslatingPage(null);
      setTranslateLangs([]);
      loadPages();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Translation failed");
    } finally { setTranslatingLoading(false); }
  };

  const handleCreatePage = async (e) => {
    e.preventDefault();
    setCreating(true);
    try {
      await createPage({ site_id: selectedSite, ...formData });
      toast.success("Page created!");
      setDialogOpen(false);
      setFormData({ title: "", content: "", status: "draft" });
      loadPages();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to create page");
    } finally { setCreating(false); }
  };

  const handleDeletePage = async (wpId) => {
    if (!window.confirm("Delete this page?")) return;
    try {
      await deletePage(selectedSite, wpId);
      toast.success("Page deleted");
      loadPages();
    } catch { toast.error("Failed to delete page"); }
  };

  const handleBulkAction = async () => {
    if (selectedPages.length === 0) return;
    setBulkActionRunning(true);
    try {
      if (bulkAction === "publish" || bulkAction === "draft") {
        const r = await bulkPublish({ site_id: selectedSite, item_ids: selectedPages.map(String), content_type: "page", action: bulkAction });
        startTask(r.data.task_id, `Bulk ${bulkAction} ${selectedPages.length} pages`);
        toast.info(`Bulk ${bulkAction} started...`);
      } else if (bulkAction === "meta-ai") {
        const r = await bulkMetaUpdate({ site_id: selectedSite, item_ids: selectedPages, content_type: "page" });
        startTask(r.data.task_id, `AI meta update for ${selectedPages.length} pages`);
        toast.info("AI meta update started...");
      } else if (bulkAction === "set-category" && bulkCategoryId) {
        const r = await bulkTaxonomyUpdate({ site_id: selectedSite, item_ids: selectedPages, categories: [Number(bulkCategoryId)] });
        startTask(r.data.task_id, `Set category for ${selectedPages.length} pages`);
        toast.info("Category update started...");
      } else if (bulkAction === "add-tag" && bulkTagInput.trim()) {
        const tags = bulkTagInput.split(",").map((t) => t.trim()).filter(Boolean);
        const r = await bulkTaxonomyUpdate({ site_id: selectedSite, item_ids: selectedPages, tags });
        startTask(r.data.task_id, `Add tags for ${selectedPages.length} pages`);
        toast.info("Tag update started...");
      }
      setSelectedPages([]);
      setBulkCategoryId("");
      setBulkTagInput("");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Bulk action failed");
    } finally { setBulkActionRunning(false); }
  };

  const togglePage = (wpId) => {
    setSelectedPages((prev) => prev.includes(wpId) ? prev.filter((id) => id !== wpId) : [...prev, wpId]);
  };

  const stripHtml = (html) => {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || "";
  };

  return (
    <div className="page-container" data-testid="pages-page">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
            Pages
          </motion.h1>
          <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
            Manage WordPress pages with bulk operations and live preview
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
          <Dialog open={dialogOpen} onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) { setPreviewMode(false); setFormData({ title: "", content: "", status: "draft" }); }
          }}>
            <DialogTrigger asChild>
              <Button className="btn-primary" disabled={!selectedSite} data-testid="create-page-btn">
                <Plus size={16} className="mr-2" />New Page
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[900px] max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="font-heading">Create Page</DialogTitle>
                <DialogDescription>Create a new WordPress page with HTML content and live preview</DialogDescription>
              </DialogHeader>
              <div className="py-4">
                <div className="flex items-center justify-between mb-4">
                  <Label>Edit / Preview</Label>
                  <div className="flex items-center gap-2 text-sm">
                    <Edit2 size={14} className={!previewMode ? "text-primary" : "text-muted-foreground"} />
                    <Switch checked={previewMode} onCheckedChange={setPreviewMode} />
                    <Eye size={14} className={previewMode ? "text-primary" : "text-muted-foreground"} />
                  </div>
                </div>
                <form onSubmit={handleCreatePage}>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>Page Title</Label>
                      <Input
                        placeholder="Enter page title"
                        value={formData.title}
                        onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                        required
                        data-testid="page-title-input"
                      />
                    </div>
                    <div className={`grid gap-2 ${previewMode ? "grid-cols-2" : "grid-cols-1"}`} style={{ height: 300 }}>
                      <div className="flex flex-col">
                        <Label className="mb-1 text-xs text-muted-foreground">Content (HTML)</Label>
                        <Textarea
                          placeholder="Enter page content..."
                          value={formData.content}
                          onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                          className="flex-1 font-mono text-xs resize-none"
                          style={{ height: "100%" }}
                          data-testid="page-content-input"
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
                      Create Page
                    </Button>
                  </DialogFooter>
                </form>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {selectedPages.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 p-3 bg-primary/5 border border-primary/20 rounded-lg flex items-center gap-3 flex-wrap"
        >
          <CheckSquare size={16} className="text-primary" />
          <span className="text-sm font-medium">{selectedPages.length} selected</span>
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
          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setSelectedPages([])}>Clear</Button>
        </motion.div>
      )}

      <Card className="content-card">
        <CardContent className="p-0">
          {!selectedSite ? (
            <div className="flex flex-col items-center justify-center py-16">
              <AlertCircle size={48} className="text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground">Select a site to view pages</p>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={32} className="animate-spin text-primary" />
            </div>
          ) : pages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <FileText size={48} className="text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground mb-4">No pages found. Create one!</p>
              <Button className="btn-primary" onClick={() => setDialogOpen(true)} data-testid="create-first-page-btn">
                <Plus size={16} className="mr-2" />Create Page
              </Button>
            </div>
          ) : (
            <Table className="data-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      checked={selectedPages.length === pages.length && pages.length > 0}
                      onCheckedChange={(v) => setSelectedPages(v ? pages.map((p) => p.wp_id) : [])}
                    />
                  </TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Modified</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pages.map((page) => (
                  <TableRow key={page.wp_id}>
                    <TableCell>
                      <Checkbox
                        checked={selectedPages.includes(page.wp_id)}
                        onCheckedChange={() => togglePage(page.wp_id)}
                      />
                    </TableCell>
                    <TableCell>
                      <div>
                        <p className="font-medium">{stripHtml(page.title)}</p>
                        {page.link && (
                          <a href={page.link} target="_blank" rel="noopener noreferrer"
                            className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 mt-0.5">
                            View page <ExternalLink size={10} />
                          </a>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={page.status === "publish" ? "default" : "secondary"}>{page.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {page.modified ? new Date(page.modified).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost" size="sm"
                          className="text-muted-foreground hover:text-primary"
                          title="Translate page"
                          onClick={() => { setTranslatingPage(page); setTranslateLangs([]); setTranslateDialogOpen(true); }}
                        >
                          <Languages size={14} />
                        </Button>
                        <Button
                          variant="ghost" size="sm"
                          className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
                          onClick={() => handleDeletePage(page.wp_id)}
                          data-testid={`delete-page-${page.wp_id}`}
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

      {/* Translate Dialog */}
      <Dialog open={translateDialogOpen} onOpenChange={(open) => { setTranslateDialogOpen(open); if (!open) { setTranslatingPage(null); setTranslateLangs([]); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Translate Page</DialogTitle>
            <DialogDescription>Select languages to translate "{translatingPage?.title ? translatingPage.title.replace(/<[^>]+>/g, '') : ''}" into.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2 py-2">
            {[
              { code: "es", label: "Spanish" }, { code: "fr", label: "French" },
              { code: "de", label: "German" }, { code: "pt", label: "Portuguese" },
              { code: "hi", label: "Hindi" }, { code: "ar", label: "Arabic" },
              { code: "zh", label: "Chinese" }, { code: "ja", label: "Japanese" },
              { code: "it", label: "Italian" },
            ].map((lang) => (
              <label key={lang.code} className="flex items-center gap-2 cursor-pointer text-sm p-2 rounded-md border border-border/30 hover:bg-muted/30">
                <input
                  type="checkbox"
                  checked={translateLangs.includes(lang.code)}
                  onChange={(e) => setTranslateLangs((prev) => e.target.checked ? [...prev, lang.code] : prev.filter((l) => l !== lang.code))}
                />
                {lang.label}
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTranslateDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleTranslatePage} disabled={translatingLoading || !translateLangs.length}>
              {translatingLoading ? <Loader2 size={14} className="animate-spin mr-2" /> : <Languages size={14} className="mr-2" />}
              Translate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SSEProgressDrawer tasks={tasks} dismissTask={dismissTask} />
    </div>
  );
}
