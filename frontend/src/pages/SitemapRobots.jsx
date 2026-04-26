import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Map, RefreshCw, Save, Loader2, ExternalLink, CheckCircle2, ImageIcon, Download } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { ScrollArea } from "../components/ui/scroll-area";
import { toast } from "sonner";
import { getSites, getSitemap, regenerateSitemap, getRobotsTxt, updateRobotsTxt, regenerateSitemapWithImages } from "../lib/api";
import ManualApplySheet from "../components/ManualApplySheet";
import { useApplyMode } from "../hooks/useApplyMode";
import { Switch } from "../components/ui/switch";
import { Label } from "../components/ui/label";

export default function SitemapRobots() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");

  // Sitemap state
  const [sitemap, setSitemap] = useState(null);
  const [loadingSitemap, setLoadingSitemap] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  // Robots.txt state
  const [robotsContent, setRobotsContent] = useState("");
  const [robotsUrl, setRobotsUrl] = useState("");
  const [loadingRobots, setLoadingRobots] = useState(false);
  const [saving, setSaving] = useState(false);

  // Image Sitemap state
  const [imgSitemapLoading, setImgSitemapLoading] = useState(false);
  const [imgSitemapResult, setImgSitemapResult] = useState(null);
  const [includeTitles, setIncludeTitles] = useState(true);
  const [xmlExpanded, setXmlExpanded] = useState(false);

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
      loadSitemap();
      loadRobots();
    }
  }, [selectedSite]); // eslint-disable-line

  const loadSitemap = async () => {
    setLoadingSitemap(true);
    try {
      const r = await getSitemap(selectedSite);
      setSitemap(r.data);
    } catch { setSitemap(null); }
    finally { setLoadingSitemap(false); }
  };

  const loadRobots = async () => {
    setLoadingRobots(true);
    try {
      const r = await getRobotsTxt(selectedSite);
      setRobotsContent(r.data.content || "");
      setRobotsUrl(r.data.url || "");
    } catch { setRobotsContent(""); }
    finally { setLoadingRobots(false); }
  };

  const handleRegenerate = async () => {
    const siteData = sites.find((s) => s.id === selectedSite);
    const siteUrl = siteData?.url || "";
    if (isManual) {
      openManualSheet({
        title: "Regenerate & Ping Sitemap",
        wpAdminUrl: "https://search.google.com/search-console",
        fields: [
          { label: "Sitemap URL", value: `${siteUrl}/sitemap.xml`, type: "url" },
        ],
        instructions: `Visit Google Search Console and submit your sitemap URL manually: ${siteUrl}/sitemap.xml`,
      });
      return;
    }
    setRegenerating(true);
    try {
      const r = await regenerateSitemap(selectedSite);
      toast.success("Sitemap pinged to Google & Bing!");
      if (r.data.results) {
        const google = r.data.results.find(x => x.target === "google_ping");
        const bing = r.data.results.find(x => x.target === "bing_ping");
        if (google) toast.info(`Google ping: ${google.status || google.error}`);
        if (bing) toast.info(`Bing ping: ${bing.status || bing.error}`);
      }
      loadSitemap();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Regeneration failed");
    } finally { setRegenerating(false); }
  };

  const handleSaveRobots = async () => {
    const siteData = sites.find((s) => s.id === selectedSite);
    const siteUrl = siteData?.url || "";
    if (isManual) {
      openManualSheet({
        title: "Save robots.txt",
        wpAdminUrl: `${siteUrl}/wp-admin/admin.php?page=wpseo_tools`,
        fields: [
          { label: "robots.txt Content", value: robotsContent, type: "text" },
        ],
        instructions: "In WordPress, go to your SEO plugin settings (Yoast / RankMath) and paste this into the robots.txt editor, or use a plugin like 'Virtual Robots.txt'.",
      });
      return;
    }
    setSaving(true);
    try {
      await updateRobotsTxt(selectedSite, { content: robotsContent });
      toast.success("robots.txt saved!");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setSaving(false); }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Sitemap & Robots.txt</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage your site's sitemap and robots.txt file</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <Tabs defaultValue="sitemap">
        <TabsList>
          <TabsTrigger value="sitemap">Sitemap</TabsTrigger>
          <TabsTrigger value="robots">robots.txt</TabsTrigger>
        </TabsList>

        <TabsContent value="sitemap" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Map size={18} className="text-primary" />
                  Sitemap URLs
                  {sitemap?.total != null && (
                    <Badge variant="secondary">{sitemap.total} URLs</Badge>
                  )}
                </CardTitle>
                <div className="flex gap-2">
                  {sitemap?.sitemap_url && (
                    <Button variant="outline" size="sm" asChild>
                      <a href={sitemap.sitemap_url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink size={13} className="mr-1" /> View
                      </a>
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={loadSitemap} disabled={loadingSitemap}>
                    {loadingSitemap ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} className="mr-1" />}
                    Reload
                  </Button>
                  <Button className="btn-primary" size="sm" onClick={handleRegenerate} disabled={regenerating || !selectedSite}>
                    {regenerating ? <Loader2 size={13} className="mr-1 animate-spin" /> : <RefreshCw size={13} className="mr-1" />}
                    Ping Search Engines
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {loadingSitemap ? (
                <div className="flex justify-center py-8"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>
              ) : sitemap?.message ? (
                <div className="text-center py-8 text-muted-foreground text-sm">{sitemap.message}</div>
              ) : (
                <>
                  {sitemap?.sitemap_url && (
                    <div className="mb-3 flex items-center gap-2 text-sm">
                      <CheckCircle2 size={14} className="text-emerald-500" />
                      <span className="text-muted-foreground">Sitemap found at:</span>
                      <a href={sitemap.sitemap_url} target="_blank" rel="noopener noreferrer"
                        className="text-primary hover:underline truncate">{sitemap.sitemap_url}</a>
                    </div>
                  )}
                  <ScrollArea className="h-64">
                    <ul className="space-y-1">
                      {(sitemap?.urls || []).map((url, i) => (
                        <li key={i}>
                          <a href={url} target="_blank" rel="noopener noreferrer"
                            className="text-xs text-muted-foreground hover:text-primary hover:underline flex items-center gap-1">
                            <ExternalLink size={10} />{url}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </ScrollArea>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="robots" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">robots.txt Editor</CardTitle>
                <div className="flex gap-2">
                  {robotsUrl && (
                    <Button variant="outline" size="sm" asChild>
                      <a href={robotsUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink size={13} className="mr-1" /> View live
                      </a>
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={loadRobots} disabled={loadingRobots}>
                    <RefreshCw size={13} className={loadingRobots ? "animate-spin" : ""} />
                  </Button>
                  <Button className="btn-primary" size="sm" onClick={handleSaveRobots} disabled={saving}>
                    {saving ? <Loader2 size={13} className="mr-1 animate-spin" /> : <Save size={13} className="mr-1" />}
                    Save
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {loadingRobots ? (
                <div className="flex justify-center py-8"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground mb-2">
                    Edit your robots.txt directives. Changes are saved to the platform and can be deployed via your WordPress configuration.
                  </p>
                  <Textarea
                    value={robotsContent}
                    onChange={e => setRobotsContent(e.target.value)}
                    className="font-mono text-xs min-h-[300px] resize-y"
                    placeholder={"User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml"}
                  />
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Image Sitemap Card */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ImageIcon size={18} className="text-primary" />
            Image Sitemap Generator
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Generate an XML sitemap with &lt;image:image&gt; entries for all posts and pages that have featured images. Improves image indexing in Google.
          </p>
          <div className="flex items-center gap-3">
            <Switch checked={includeTitles} onCheckedChange={setIncludeTitles} />
            <Label className="text-sm">Include image titles in sitemap</Label>
          </div>
          <Button
            onClick={async () => {
              setImgSitemapLoading(true);
              setImgSitemapResult(null);
              try {
                const r = await regenerateSitemapWithImages(selectedSite, { include_images: true, include_titles: includeTitles });
                setImgSitemapResult(r.data);
                toast.success("Image sitemap generated!");
              } catch (e) {
                toast.error(e.response?.data?.detail || "Image sitemap generation failed");
              } finally { setImgSitemapLoading(false); }
            }}
            disabled={imgSitemapLoading || !selectedSite}
          >
            {imgSitemapLoading ? <><Loader2 size={14} className="mr-2 animate-spin" /> Generating...</> : <><RefreshCw size={14} className="mr-2" /> Generate Image Sitemap</>}
          </Button>

          {imgSitemapResult && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
              <Card className="border-emerald-500/30 bg-emerald-500/5">
                <CardContent className="pt-4 space-y-3">
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <p className="text-2xl font-bold text-primary">{imgSitemapResult.url_count || imgSitemapResult.urls_included || 0}</p>
                      <p className="text-xs text-muted-foreground">URLs included</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-primary">{imgSitemapResult.image_count || imgSitemapResult.images_mapped || 0}</p>
                      <p className="text-xs text-muted-foreground">Images mapped</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Generated at</p>
                      <p className="text-xs font-mono">{imgSitemapResult.generated_at ? new Date(imgSitemapResult.generated_at).toLocaleString() : new Date().toLocaleString()}</p>
                    </div>
                  </div>

                  {imgSitemapResult.xml && (
                    <>
                      <button
                        onClick={() => setXmlExpanded(!xmlExpanded)}
                        className="text-xs text-primary hover:underline"
                      >
                        {xmlExpanded ? "Hide XML Preview" : "Show XML Preview"}
                      </button>
                      {xmlExpanded && (
                        <pre className="bg-black/40 border border-border/20 rounded-lg p-3 text-xs font-mono overflow-x-auto max-h-[200px] overflow-y-auto">
                          {imgSitemapResult.xml.substring(0, 500)}{imgSitemapResult.xml.length > 500 ? "\n..." : ""}
                        </pre>
                      )}
                      <Button
                        variant="outline" size="sm"
                        onClick={() => {
                          const blob = new Blob([imgSitemapResult.xml], { type: "application/xml" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = "image-sitemap.xml";
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                      >
                        <Download size={14} className="mr-2" /> Download Sitemap
                      </Button>
                    </>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          )}
        </CardContent>
      </Card>

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
