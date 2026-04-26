import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import {
  Image, Upload, Trash2, Edit2, Loader2, CheckCircle2, AlertCircle,
  Filter, Minimize2, Download, RefreshCw
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Checkbox } from "../components/ui/checkbox";
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
import { getSites, getMedia, deleteMedia, renameMedia, compressMedia, bulkCompressMedia, cleanExifMetadata, convertImagesToWebP } from "../lib/api";
import SSEProgressDrawer, { useSSETask } from "../components/SSEProgressDrawer";
import { toast } from "sonner";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;

export default function MediaLibrary() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [media, setMedia] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState([]);
  const [editItem, setEditItem] = useState(null);
  const [editForm, setEditForm] = useState({ title: "", alt_text: "" });
  const [saving, setSaving] = useState(false);
  const [compressing, setCompressing] = useState({});
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const { tasks, startTask, dismissTask } = useSSETask();
  const [cleaningExif, setCleaningExif] = useState(false);
  const [exifResults, setExifResults] = useState(null);
  const [convertingWebP, setConvertingWebP] = useState(false);
  const [webpResults, setWebpResults] = useState(null);
  const [showExifModal, setShowExifModal] = useState(false);
  const [showWebpModal, setShowWebpModal] = useState(false);

  useEffect(() => { loadSites(); }, []);
  useEffect(() => { if (selectedSite) loadMedia(); }, [selectedSite]);

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data || []);
      if (r.data?.length) setSelectedSite(r.data[0].id);
    } catch { toast.error("Failed to load sites"); }
  };

  const loadMedia = async () => {
    setLoading(true);
    try {
      const r = await getMedia(selectedSite);
      setMedia(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to load media");
    } finally { setLoading(false); }
  };

  const filteredMedia = media.filter(m => {
    if (filter === "images") return m.mime_type?.startsWith("image/");
    if (filter === "videos") return m.mime_type?.startsWith("video/");
    if (filter === "documents") return m.mime_type?.includes("pdf") || m.mime_type?.includes("document");
    return true;
  });

  const getFileSize = (item) => {
    return item.media_details?.filesize || 0;
  };

  const handleDelete = async (mediaId) => {
    if (!window.confirm("Delete this media item from WordPress?")) return;
    try {
      await deleteMedia(selectedSite, mediaId);
      setMedia(prev => prev.filter(m => m.id !== mediaId));
      toast.success("Media deleted");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Delete failed");
    }
  };

  const openEdit = (item) => {
    setEditItem(item);
    setEditForm({
      title: item.title?.rendered || "",
      alt_text: item.alt_text || "",
    });
  };

  const handleSaveEdit = async () => {
    setSaving(true);
    try {
      await renameMedia(selectedSite, editItem.id, editForm);
      setMedia(prev => prev.map(m => m.id === editItem.id ? {
        ...m, title: { rendered: editForm.title }, alt_text: editForm.alt_text
      } : m));
      toast.success("Media updated");
      setEditItem(null);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Update failed");
    } finally { setSaving(false); }
  };

  const handleCompress = async (mediaId) => {
    setCompressing(prev => ({ ...prev, [mediaId]: true }));
    try {
      const r = await compressMedia(selectedSite, mediaId);
      toast.success(`Compressed: saved ${Math.round(r.data.saved_bytes / 1024)}KB`);
      loadMedia();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Compression failed");
    } finally { setCompressing(prev => ({ ...prev, [mediaId]: false })); }
  };

  const handleBulkCompress = async () => {
    try {
      const r = await bulkCompressMedia(selectedSite);
      startTask(r.data.task_id, "Bulk Compressing Images");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Bulk compress failed");
    }
  };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const token = localStorage.getItem("wp_token");
      const resp = await fetch(`${BACKEND_URL}/api/media/${selectedSite}/upload`, {
        method: "POST",
        headers: {
          "Content-Type": file.type,
          "X-Filename": file.name,
          "Authorization": `Bearer ${token}`,
        },
        body: file,
      });
      if (!resp.ok) throw new Error("Upload failed");
      toast.success(`Uploaded ${file.name}`);
      loadMedia();
    } catch (err) {
      toast.error("Upload failed");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleCleanExif = async () => {
    setCleaningExif(true);
    try {
      const r = await cleanExifMetadata(selectedSite, { media_ids: selectedIds.length > 0 ? selectedIds : [] });
      setExifResults(r.data?.results || r.data || []);
      setShowExifModal(true);
      const cleaned = (r.data?.results || r.data || []).filter(x => x.status === "cleaned").length;
      toast.success(`Cleaned EXIF from ${cleaned} images`);
    } catch (e) { toast.error(e.response?.data?.detail || "EXIF cleaning failed"); }
    finally { setCleaningExif(false); }
  };

  const handleConvertWebP = async () => {
    setConvertingWebP(true);
    try {
      const r = await convertImagesToWebP(selectedSite, { media_ids: selectedIds.length > 0 ? selectedIds : [] });
      setWebpResults(r.data?.results || r.data || []);
      setShowWebpModal(true);
      const converted = (r.data?.results || r.data || []).filter(x => x.status === "converted" || x.status === "success").length;
      const savedKB = (r.data?.results || r.data || []).reduce((s, x) => s + (x.savings || x.saved_bytes || 0), 0);
      toast.success(`Converted ${converted} images, saved ${Math.round(savedKB / 1024)}KB`);
    } catch (e) { toast.error(e.response?.data?.detail || "WebP conversion failed"); }
    finally { setConvertingWebP(false); }
  };

  return (
    <div className="page-container">
      <div className="mb-8">
        <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          Media Library
        </motion.h1>
        <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
          Manage, compress, and organize your WordPress media files
        </motion.p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>

        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Files</SelectItem>
            <SelectItem value="images">Images</SelectItem>
            <SelectItem value="videos">Videos</SelectItem>
            <SelectItem value="documents">Documents</SelectItem>
          </SelectContent>
        </Select>

        <Button onClick={loadMedia} variant="outline" size="sm" disabled={!selectedSite}>
          <RefreshCw size={14} className="mr-2" />Refresh
        </Button>

        <Button onClick={() => fileInputRef.current?.click()} disabled={!selectedSite || uploading} size="sm">
          {uploading ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Upload size={14} className="mr-2" />}
          Upload
        </Button>
        <input ref={fileInputRef} type="file" className="hidden" accept="image/*,video/*,.pdf" onChange={handleUpload} />

        <Button onClick={handleBulkCompress} disabled={!selectedSite} variant="outline" size="sm">
          <Minimize2 size={14} className="mr-2" />Compress All Oversized
        </Button>

        <Button onClick={handleCleanExif} disabled={!selectedSite || cleaningExif} variant="outline" size="sm">
          {cleaningExif ? <Loader2 size={14} className="mr-2 animate-spin" /> : <RefreshCw size={14} className="mr-2" />}
          Clean EXIF
        </Button>

        <Button onClick={handleConvertWebP} disabled={!selectedSite || convertingWebP} variant="outline" size="sm">
          {convertingWebP ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Image size={14} className="mr-2" />}
          Convert to WebP
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[
          { label: "Total Files", value: media.length },
          { label: "Images", value: media.filter(m => m.mime_type?.startsWith("image/")).length },
          { label: "Oversized (>200KB)", value: media.filter(m => getFileSize(m) > 200 * 1024).length, danger: true },
          { label: "Videos", value: media.filter(m => m.mime_type?.startsWith("video/")).length },
        ].map(stat => (
          <Card key={stat.label} className="stat-card">
            <p className="stat-value" style={stat.danger && stat.value > 0 ? { color: "#ef4444" } : {}}>{stat.value}</p>
            <p className="stat-label">{stat.label}</p>
          </Card>
        ))}
      </div>

      {/* Media Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin text-primary" />
        </div>
      ) : (
        <Card className="content-card">
          <CardContent className="p-0">
            <ScrollArea className="h-[600px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8"></TableHead>
                    <TableHead>Preview</TableHead>
                    <TableHead>Filename</TableHead>
                    <TableHead>Alt Text</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Dimensions</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredMedia.map(item => {
                    const fileSize = getFileSize(item);
                    const isOversized = fileSize > 200 * 1024;
                    const isImage = item.mime_type?.startsWith("image/");
                    const dims = item.media_details?.width && item.media_details?.height
                      ? `${item.media_details.width}×${item.media_details.height}`
                      : "—";
                    return (
                      <TableRow key={item.id}>
                        <TableCell>
                          <Checkbox
                            checked={selectedIds.includes(item.id)}
                            onCheckedChange={() => toggleSelect(item.id)}
                          />
                        </TableCell>
                        <TableCell>
                          {isImage ? (
                            <img src={item.source_url} alt={item.alt_text || ""} className="w-12 h-12 object-cover rounded border border-border" />
                          ) : (
                            <div className="w-12 h-12 rounded border border-border bg-muted flex items-center justify-center">
                              <Image size={16} className="text-muted-foreground" />
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-sm font-medium max-w-[180px] truncate">
                          {item.title?.rendered || item.source_url?.split("/").pop() || "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground max-w-[150px] truncate">
                          {item.alt_text || <span className="text-orange-400 text-xs">No alt text</span>}
                        </TableCell>
                        <TableCell>
                          <Badge variant={isOversized ? "destructive" : "secondary"} className="text-xs">
                            {fileSize > 0 ? `${Math.round(fileSize / 1024)}KB` : "—"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{dims}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => openEdit(item)} title="Edit">
                              <Edit2 size={13} />
                            </Button>
                            {isImage && (
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={compressing[item.id]}
                                onClick={() => handleCompress(item.id)} title="Compress">
                                {compressing[item.id] ? <Loader2 size={13} className="animate-spin" /> : <Minimize2 size={13} />}
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500 hover:text-red-600"
                              onClick={() => handleDelete(item.id)} title="Delete">
                              <Trash2 size={13} />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {filteredMedia.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                        {selectedSite ? "No media found" : "Select a site to view media"}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {/* Edit Dialog */}
      <Dialog open={!!editItem} onOpenChange={() => setEditItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Media</DialogTitle>
            <DialogDescription>Update the title and alt text for this media item.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">Title</label>
              <Input value={editForm.title} onChange={e => setEditForm(p => ({ ...p, title: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Alt Text</label>
              <Input value={editForm.alt_text} onChange={e => setEditForm(p => ({ ...p, alt_text: e.target.value }))}
                placeholder="Describe the image for accessibility" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditItem(null)}>Cancel</Button>
            <Button onClick={handleSaveEdit} disabled={saving}>
              {saving ? <Loader2 size={14} className="mr-2 animate-spin" /> : null}Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SSEProgressDrawer tasks={tasks} dismissTask={dismissTask} />

      {/* EXIF Results Modal */}
      <Dialog open={showExifModal} onOpenChange={setShowExifModal}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>EXIF Cleaning Results</DialogTitle></DialogHeader>
          <ScrollArea className="max-h-[400px]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Filename</TableHead>
                  <TableHead className="w-[100px]">Status</TableHead>
                  <TableHead className="text-right w-[120px]">Bytes Removed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(exifResults || []).map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm truncate max-w-[180px]">{r.filename || r.file || `Image ${i + 1}`}</TableCell>
                    <TableCell>
                      <Badge className={`text-xs ${r.status === "cleaned" ? "bg-emerald-500/10 text-emerald-500" : r.status === "error" ? "bg-red-500/10 text-red-500" : "bg-muted text-muted-foreground"}`}>
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs font-mono">{r.exif_bytes_removed || r.bytes_removed || 0}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* WebP Results Modal */}
      <Dialog open={showWebpModal} onOpenChange={setShowWebpModal}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>WebP Conversion Results</DialogTitle></DialogHeader>
          <ScrollArea className="max-h-[400px]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Filename</TableHead>
                  <TableHead className="text-right w-[90px]">Original</TableHead>
                  <TableHead className="text-right w-[90px]">WebP</TableHead>
                  <TableHead className="text-right w-[80px]">Savings</TableHead>
                  <TableHead className="w-[80px]">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(webpResults || []).map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm truncate max-w-[150px]">{r.filename || r.file || `Image ${i + 1}`}</TableCell>
                    <TableCell className="text-right text-xs font-mono">{r.original_size ? `${Math.round(r.original_size / 1024)}KB` : "—"}</TableCell>
                    <TableCell className="text-right text-xs font-mono">{r.webp_size ? `${Math.round(r.webp_size / 1024)}KB` : "—"}</TableCell>
                    <TableCell className="text-right text-xs font-mono text-emerald-500">{r.savings ? `${Math.round(r.savings / 1024)}KB` : "—"}</TableCell>
                    <TableCell>
                      <Badge className={`text-xs ${r.status === "converted" || r.status === "success" ? "bg-emerald-500/10 text-emerald-500" : r.status === "error" ? "bg-red-500/10 text-red-500" : "bg-muted text-muted-foreground"}`}>
                        {r.status}
                      </Badge>
                      {r.status === "error" && r.error && <p className="text-xs text-red-400 mt-1">{r.error}</p>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
