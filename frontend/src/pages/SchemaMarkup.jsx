import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Code, Plus, CheckCircle2, Loader2, Sparkles, Copy, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { ScrollArea } from "../components/ui/scroll-area";
import { toast } from "sonner";
import { getSites, getPages, getPosts, generateSchema, listSchemaRecords, applySchemaRecord } from "../lib/api";
import ImpactBadge from "../components/ImpactBadge";
import ManualApplySheet from "../components/ManualApplySheet";
import { useApplyMode } from "../hooks/useApplyMode";

const SCHEMA_TYPES = [
  { value: "faq", label: "FAQ" },
  { value: "article", label: "Article" },
  { value: "product", label: "Product" },
  { value: "local_business", label: "Local Business" },
];

export default function SchemaMarkup() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [records, setRecords] = useState([]);
  const [pages, setPages] = useState([]);
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState({});
  const [previewRecord, setPreviewRecord] = useState(null);

  // Form state
  const [contentType, setContentType] = useState("post");
  const [wpId, setWpId] = useState("");
  const [schemaType, setSchemaType] = useState("article");

  // Apply Mode
  const { isManual } = useApplyMode();
  const [manualSheet, setManualSheet] = useState({ open: false, title: "", wpAdminUrl: "", fields: [], instructions: "" });
  const openManualSheet = (config) => setManualSheet({ open: true, ...config });
  const closeManualSheet = () => setManualSheet((prev) => ({ ...prev, open: false }));

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data || []);
      if (r.data?.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSite) {
      loadRecords();
      loadContent();
    }
  }, [selectedSite]); // eslint-disable-line

  const loadRecords = async () => {
    setLoading(true);
    try {
      const r = await listSchemaRecords(selectedSite);
      setRecords(r.data || []);
    } catch { setRecords([]); }
    finally { setLoading(false); }
  };

  const loadContent = async () => {
    try {
      const [pgs, pts] = await Promise.all([getPages(selectedSite), getPosts(selectedSite)]);
      setPages(pgs.data || []);
      setPosts(pts.data || []);
    } catch { /* ignore */ }
  };

  const contentItems = contentType === "page" ? pages : posts;

  const handleGenerate = async () => {
    if (!wpId) { toast.error("Select a page or post"); return; }
    setGenerating(true);
    try {
      const r = await generateSchema(selectedSite, {
        wp_id: parseInt(wpId),
        content_type: contentType,
        schema_type: schemaType,
      });
      setRecords(prev => [r.data, ...prev]);
      setGenOpen(false);
      setWpId("");
      toast.success(`${schemaType.toUpperCase()} schema generated!`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Generation failed");
    } finally { setGenerating(false); }
  };

  const handleApply = async (record) => {
    const siteData = sites.find((s) => s.id === selectedSite);
    const siteUrl = siteData?.url || "";
    if (isManual) {
      openManualSheet({
        title: "Apply Schema to WordPress",
        wpAdminUrl: `${siteUrl}/wp-admin/post.php?post=${record.wp_id}&action=edit`,
        fields: [
          { label: "JSON-LD Schema", value: record.schema_json, type: "json" },
          { label: "Post / Page ID", value: String(record.wp_id), type: "text" },
          { label: "Schema Type", value: record.schema_type, type: "text" },
        ],
        instructions: "In the WordPress editor for this post/page, add a Custom HTML block, paste the JSON-LD inside <script type='application/ld+json'> tags, and save.",
      });
      return;
    }
    setApplying(prev => ({ ...prev, [record.id]: true }));
    try {
      const r = await applySchemaRecord(selectedSite, record.id);
      setRecords(prev => prev.map(rec => rec.id === record.id ? { ...rec, status: "applied" } : rec));
      toast.success("Schema applied to WordPress!");
      if (r.data?.impact_estimate) {
        toast.info(`Expected impact: ${r.data.impact_estimate.traffic_change} traffic`);
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to apply schema");
    } finally { setApplying(prev => ({ ...prev, [record.id]: false })); }
  };

  const copyJSON = (json) => {
    navigator.clipboard.writeText(json);
    toast.success("JSON-LD copied to clipboard");
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Schema Markup Generator</h1>
          <p className="text-sm text-muted-foreground mt-1">Generate and apply JSON-LD structured data to your pages</p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Select site" /></SelectTrigger>
            <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button className="btn-primary" size="sm" onClick={() => setGenOpen(true)} disabled={!selectedSite}>
            <Plus size={14} className="mr-1" /> Generate Schema
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Code size={18} className="text-primary" />
            Schema Records
            <Badge variant="secondary" className="ml-auto">{records.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>
          ) : records.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              <Sparkles size={32} className="mx-auto mb-2 opacity-40" />
              <p className="text-sm">No schema records yet. Generate your first schema markup.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Page / Post</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map(rec => (
                  <TableRow key={rec.id}>
                    <TableCell className="font-medium max-w-[200px] truncate">
                      {rec.title || `${rec.content_type} #${rec.wp_id}`}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">{rec.schema_type?.replace("_", " ")}</Badge>
                    </TableCell>
                    <TableCell>
                      {rec.status === "applied" ? (
                        <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
                          <CheckCircle2 size={11} className="mr-1" /> Applied
                        </Badge>
                      ) : (
                        <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">Pending</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {rec.created_at ? new Date(rec.created_at).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex gap-1 justify-end">
                        <Button variant="ghost" size="sm" onClick={() => setPreviewRecord(rec)} title="Preview JSON-LD">
                          <ExternalLink size={13} />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => copyJSON(rec.schema_json)} title="Copy JSON">
                          <Copy size={13} />
                        </Button>
                        {rec.status !== "applied" && (
                          <Button size="sm" className="btn-primary" onClick={() => handleApply(rec)} disabled={applying[rec.id]}>
                            {applying[rec.id] ? <Loader2 size={13} className="animate-spin" /> : "Apply"}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Generate Dialog */}
      <Dialog open={genOpen} onOpenChange={setGenOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate Schema Markup</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Content Type</Label>
              <Select value={contentType} onValueChange={v => { setContentType(v); setWpId(""); }}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="post">Post</SelectItem>
                  <SelectItem value="page">Page</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Select {contentType === "page" ? "Page" : "Post"}</Label>
              <Select value={wpId} onValueChange={setWpId}>
                <SelectTrigger className="mt-1"><SelectValue placeholder={`Choose a ${contentType}…`} /></SelectTrigger>
                <SelectContent>
                  {contentItems.map(item => {
                    const title = typeof item.title === "object" ? item.title?.rendered : item.title;
                    const id = item.wp_id || item.id;
                    return <SelectItem key={id} value={String(id)}>{title || `#${id}`}</SelectItem>;
                  })}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Schema Type</Label>
              <Select value={schemaType} onValueChange={setSchemaType}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SCHEMA_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGenOpen(false)}>Cancel</Button>
            <Button className="btn-primary" onClick={handleGenerate} disabled={generating || !wpId}>
              {generating ? <><Loader2 size={14} className="mr-1 animate-spin" /> Generating…</> : <><Sparkles size={14} className="mr-1" /> Generate</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview Dialog */}
      <Dialog open={!!previewRecord} onOpenChange={v => !v && setPreviewRecord(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>JSON-LD Preview — {previewRecord?.title}</DialogTitle>
          </DialogHeader>
          <ScrollArea className="h-64 rounded border p-3 bg-muted/30">
            <pre className="text-xs font-mono whitespace-pre-wrap">
              {previewRecord?.schema_json ? JSON.stringify(JSON.parse(previewRecord.schema_json), null, 2) : ""}
            </pre>
          </ScrollArea>
          <ImpactBadge impact={{ traffic_change: "+15-35%", ranking_impact: "Enable rich snippets", ctr_change: "+1.0-3.5%", confidence: "high" }} />
          <DialogFooter>
            <Button variant="outline" onClick={() => copyJSON(previewRecord?.schema_json)}>
              <Copy size={13} className="mr-1" /> Copy JSON
            </Button>
            <Button className="btn-primary" onClick={() => { handleApply(previewRecord); setPreviewRecord(null); }} disabled={previewRecord?.status === "applied"}>
              {previewRecord?.status === "applied" ? "Already Applied" : "Apply to WordPress"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ManualApplySheet
        open={manualSheet.open}
        onClose={closeManualSheet}
        title={manualSheet.title}
        wpAdminUrl={manualSheet.wpAdminUrl}
        fields={manualSheet.fields}
        instructions={manualSheet.instructions}
      />
    </motion.div>
  );
}
