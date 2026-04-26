import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Link2, Sparkles, Send, ExternalLink, CheckCircle2, Loader2, RefreshCw, Mail, Copy,
  PieChart as PieChartIcon, AlertTriangle, Share2, ThumbsUp, MessageCircle
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "../components/ui/table";
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { toast } from "sonner";
import {
  getSites, suggestInternalLinks, getInternalLinkSuggestions, linkBuilderInsert,
  generateOutreachAngles, subscribeToTask, getAnchorDistribution,
  getLiveBacklinks, getCompetitorGap,
} from "../lib/api";

const TypeBadge = ({ type }) => {
  const variants = {
    guest_post: "bg-blue-500/10 text-blue-400",
    resource_page: "bg-purple-500/10 text-purple-400",
    expert_roundup: "bg-teal-500/10 text-teal-400",
  };
  const labels = { guest_post: "Guest Post", resource_page: "Resource Page", expert_roundup: "Expert Roundup" };
  return <Badge className={`text-xs ${variants[type] || "bg-muted/30 text-muted-foreground"}`}>{labels[type] || type}</Badge>;
};

export default function LinkBuilder() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [tab, setTab] = useState("internal");
  const [internalSuggestions, setInternalSuggestions] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState({});
  const [outreachAngles, setOutreachAngles] = useState([]);
  const [generatingOutreach, setGeneratingOutreach] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(null);
  const [loadingInternal, setLoadingInternal] = useState(false);
  // Anchor Distribution
  const [anchorLoading, setAnchorLoading] = useState(false);
  const [anchorData, setAnchorData] = useState(null);
  // Social Signals
  const [socialLoading, setSocialLoading] = useState(false);
  const [socialData, setSocialData] = useState(null);
  // Live Backlinks (DataForSEO)
  const [backlinkLoading, setBacklinkLoading] = useState(false);
  const [backlinkData, setBacklinkData] = useState(null);
  // Competitor Gap
  const [gapLoading, setGapLoading] = useState(false);
  const [gapData, setGapData] = useState(null);
  const [competitorDomains, setCompetitorDomains] = useState("");

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSite) loadInternalSuggestions();
  }, [selectedSite]);

  useEffect(() => {
    if (selectedSite && tab === "anchor") loadAnchorDistribution();
    if (selectedSite && tab === "social") loadSocialSignals();
  }, [tab, selectedSite]); // eslint-disable-line

  const loadAnchorDistribution = async () => {
    setAnchorLoading(true);
    try {
      const r = await getAnchorDistribution(selectedSite);
      setAnchorData(r.data);
    } catch (e) { toast.error(e.response?.data?.detail || "Failed to load anchor distribution"); }
    finally { setAnchorLoading(false); }
  };

  const loadSocialSignals = async () => {
    setSocialLoading(true);
    try {
      const { getSocialSignals } = await import("../lib/api");
      const r = await getSocialSignals(selectedSite);
      setSocialData(r.data?.posts || r.data || []);
    } catch (e) { toast.error(e.response?.data?.detail || "Failed to load social signals"); }
    finally { setSocialLoading(false); }
  };

  const handleFetchBacklinks = async () => {
    const site = sites.find(s => s.id === selectedSite);
    if (!site) return;
    setBacklinkLoading(true);
    try {
      const domain = new URL(site.url.startsWith('http') ? site.url : `https://${site.url}`).hostname;
      const r = await getLiveBacklinks(selectedSite, { domain, limit: 100 });
      setBacklinkData(r.data);
    } catch (e) { toast.error(e.response?.data?.detail || 'Failed to fetch backlinks'); }
    finally { setBacklinkLoading(false); }
  };

  const handleCompetitorGap = async () => {
    const site = sites.find(s => s.id === selectedSite);
    if (!site || !competitorDomains.trim()) return;
    setGapLoading(true);
    try {
      const domain = new URL(site.url.startsWith('http') ? site.url : `https://${site.url}`).hostname;
      const r = await getCompetitorGap(selectedSite, {
        your_domain: domain,
        competitor_domains: competitorDomains.split(',').map(d => d.trim()).filter(Boolean),
      });
      setGapData(r.data);
    } catch (e) { toast.error(e.response?.data?.detail || 'Competitor gap failed'); }
    finally { setGapLoading(false); }
  };

  const loadInternalSuggestions = async () => {
    setLoadingInternal(true);
    try {
      const r = await getInternalLinkSuggestions(selectedSite);
      setInternalSuggestions(r.data || []);
    } catch { setInternalSuggestions([]); }
    finally { setLoadingInternal(false); }
  };

  const handleScan = async () => {
    setScanning(true);
    toast.info("Scanning posts for internal link opportunities…");
    try {
      const r = await suggestInternalLinks(selectedSite);
      const taskId = r.data.task_id;
      const unsub = subscribeToTask(taskId, (ev) => {
        if (ev.type === "status" && ev.data?.step === ev.data?.total && ev.data?.total > 0) {
          unsub(); setScanning(false); loadInternalSuggestions();
          toast.success("Scan complete!");
        }
        if (ev.type === "error") { unsub(); setScanning(false); toast.error(ev.data?.message || "Scan failed"); }
      });
    } catch (e) { toast.error(e.response?.data?.detail || "Scan failed"); setScanning(false); }
  };

  const handleInsert = async (s) => {
    setApplying(prev => ({ ...prev, [s.id]: true }));
    try {
      await linkBuilderInsert(selectedSite, {
        post_id: s.source_post_id,
        target_post_id: s.target_post_id,
        anchor_text: s.anchor_text,
        target_url: s.target_url || `/?p=${s.target_post_id}`,
      });
      setInternalSuggestions(prev => prev.map(x => x.id === s.id ? { ...x, applied: true } : x));
      toast.success("Link inserted successfully!");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to insert link");
    } finally { setApplying(prev => ({ ...prev, [s.id]: false })); }
  };

  const handleGenerateOutreach = async () => {
    setGeneratingOutreach(true);
    try {
      const r = await generateOutreachAngles(selectedSite);
      setOutreachAngles(r.data.angles || []);
      toast.success("Outreach angles generated!");
    } catch (e) { toast.error(e.response?.data?.detail || "Failed"); }
    finally { setGeneratingOutreach(false); }
  };

  const copyEmail = (angle) => {
    const text = `Subject: ${angle.email_subject}\n\n${angle.email_opening}`;
    navigator.clipboard.writeText(text).then(() => {
      setCopiedEmail(angle.title);
      setTimeout(() => setCopiedEmail(null), 2000);
    });
    toast.success("Email draft copied to clipboard");
  };

  return (
    <div className="page-container">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
            Link Builder
          </motion.h1>
          <p className="page-description">Internal linking opportunities + outreach angle generator</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="internal">Internal Links</TabsTrigger>
          <TabsTrigger value="outreach">Outreach Opportunities</TabsTrigger>
          <TabsTrigger value="anchor"><PieChartIcon size={14} className="mr-1" /> Anchor Distribution</TabsTrigger>
          <TabsTrigger value="social"><Share2 size={14} className="mr-1" /> Social Signals</TabsTrigger>
          <TabsTrigger value="backlinks"><ExternalLink size={14} className="mr-1" /> Live Backlinks</TabsTrigger>
          <TabsTrigger value="competitor-gap"><AlertTriangle size={14} className="mr-1" /> Competitor Gap</TabsTrigger>
        </TabsList>

        <TabsContent value="internal">
          <div className="flex justify-between items-center mb-4">
            <p className="text-sm text-muted-foreground">{internalSuggestions.length} suggestions</p>
            <Button className="btn-primary" size="sm" onClick={handleScan} disabled={scanning || !selectedSite}>
              {scanning ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Sparkles size={14} className="mr-2" />}
              Scan for Opportunities
            </Button>
          </div>
          {loadingInternal ? (
            <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-primary" /></div>
          ) : internalSuggestions.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Link2 size={40} className="mx-auto mb-3 opacity-30" />
              <p>No suggestions yet. Click "Scan for Opportunities" to let AI find internal link opportunities.</p>
            </div>
          ) : (
            <Card className="content-card">
              <CardContent className="pt-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/40 text-muted-foreground text-xs">
                        <th className="text-left py-2 pr-4">Source Post</th>
                        <th className="text-left py-2 px-4">Anchor Text</th>
                        <th className="text-left py-2 px-4">Target Post</th>
                        <th className="py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {internalSuggestions.map(s => (
                        <tr key={s.id} className="border-b border-border/20 hover:bg-muted/20">
                          <td className="py-2.5 pr-4 text-sm max-w-[180px]">
                            <p className="truncate">{s.source_post_title}</p>
                            <span className="text-xs text-muted-foreground">#{s.source_post_id}</span>
                          </td>
                          <td className="py-2.5 px-4">
                            <code className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded">{s.anchor_text}</code>
                          </td>
                          <td className="py-2.5 px-4 text-sm max-w-[180px]">
                            <p className="truncate">{s.target_post_title}</p>
                            <span className="text-xs text-muted-foreground">#{s.target_post_id}</span>
                          </td>
                          <td className="py-2.5 pl-2">
                            {s.applied ? (
                              <Badge className="bg-emerald-500/10 text-emerald-500 text-xs">
                                <CheckCircle2 size={10} className="mr-1" /> Applied
                              </Badge>
                            ) : (
                              <Button size="sm" variant="outline" className="text-xs h-7"
                                onClick={() => handleInsert(s)} disabled={applying[s.id]}>
                                {applying[s.id] ? <Loader2 size={11} className="animate-spin mr-1" /> : null}
                                Insert
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="outreach">
          <div className="flex justify-end mb-4">
            <Button className="btn-primary" size="sm" onClick={handleGenerateOutreach}
              disabled={generatingOutreach || !selectedSite}>
              {generatingOutreach ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Sparkles size={14} className="mr-2" />}
              Generate Outreach Angles
            </Button>
          </div>
          {outreachAngles.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Mail size={40} className="mx-auto mb-3 opacity-30" />
              <p>Click "Generate Outreach Angles" for AI-crafted link-building opportunities.</p>
            </div>
          ) : (
            <div className="grid gap-4">
              {outreachAngles.map((angle, i) => (
                <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.07 }}>
                  <Card className="content-card">
                    <CardContent className="pt-4">
                      <div className="flex items-start justify-between gap-3 mb-3">
                        <div>
                          <h3 className="font-medium">{angle.title}</h3>
                          <p className="text-sm text-muted-foreground mt-1">{angle.description}</p>
                        </div>
                        <TypeBadge type={angle.type} />
                      </div>
                      <div className="bg-muted/30 rounded-lg p-3 text-sm space-y-1 border border-border/30">
                        <p className="text-xs font-medium text-muted-foreground">EMAIL DRAFT</p>
                        <p className="font-medium">{angle.email_subject}</p>
                        <p className="text-muted-foreground">{angle.email_opening}</p>
                      </div>
                      <div className="mt-3 flex justify-end">
                        <Button variant="outline" size="sm" className="text-xs"
                          onClick={() => copyEmail(angle)}>
                          {copiedEmail === angle.title
                            ? <><CheckCircle2 size={11} className="mr-1 text-emerald-500" /> Copied!</>
                            : <><Copy size={11} className="mr-1" /> Copy Email Draft</>}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Anchor Distribution Tab */}
        <TabsContent value="anchor">
          {anchorLoading ? (
            <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-primary" /></div>
          ) : !anchorData || !anchorData.categories?.length ? (
            <div className="text-center py-16 text-muted-foreground">
              <PieChartIcon size={40} className="mx-auto mb-3 opacity-30" />
              <p>No anchor text data available yet. Build some links first!</p>
            </div>
          ) : (() => {
            const COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#f97316", "#ec4899"];
            const chartData = anchorData.categories.map(c => ({ name: c.type, value: c.percentage }));
            return (
              <div className="grid gap-6 lg:grid-cols-2">
                {/* Donut Chart */}
                <Card className="content-card">
                  <CardHeader><CardTitle className="text-base">Anchor Text Distribution</CardTitle></CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie data={chartData} cx="50%" cy="50%" innerRadius={60} outerRadius={100}
                          dataKey="value" nameKey="name" paddingAngle={3} label={({ name, value }) => `${name} ${value}%`}>
                          {chartData.map((_, idx) => <Cell key={idx} fill={COLORS[idx % COLORS.length]} />)}
                        </Pie>
                        <Tooltip formatter={(v) => `${v}%`} />
                        <Legend />
                      </PieChart>
                    </ResponsiveContainer>
                    <p className="text-xs text-muted-foreground text-center mt-2">Total backlinks: {anchorData.total_backlinks || "N/A"}</p>
                  </CardContent>
                </Card>
                {/* Category Table + Warnings */}
                <div className="space-y-4">
                  <Card className="content-card">
                    <CardHeader><CardTitle className="text-base">Category Breakdown</CardTitle></CardHeader>
                    <CardContent className="pt-0">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Type</TableHead>
                            <TableHead className="text-right">Count</TableHead>
                            <TableHead className="text-right">%</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {anchorData.categories.map((c, i) => (
                            <TableRow key={i}>
                              <TableCell className="flex items-center gap-2">
                                <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                                {c.type}
                              </TableCell>
                              <TableCell className="text-right">{c.count}</TableCell>
                              <TableCell className="text-right font-medium">{c.percentage}%</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                  {/* Warnings */}
                  {anchorData.categories.some(c => c.type?.toLowerCase() === "exact match" && c.percentage > 30) && (
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm">
                      <AlertTriangle size={16} className="text-red-400 mt-0.5 shrink-0" />
                      <div><span className="font-medium text-red-400">Over-optimization risk:</span> Exact match anchors exceed 30%. Diversify your anchor text to avoid penalties.</div>
                    </div>
                  )}
                  {anchorData.categories.some(c => c.type?.toLowerCase() === "branded" && c.percentage < 20) && (
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-sm">
                      <AlertTriangle size={16} className="text-yellow-400 mt-0.5 shrink-0" />
                      <div><span className="font-medium text-yellow-400">Low branded anchors:</span> Branded anchors below 20%. Consider building more branded links for a natural profile.</div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        </TabsContent>

        {/* Social Signals Tab */}
        <TabsContent value="social">
          {socialLoading ? (
            <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-primary" /></div>
          ) : !socialData || socialData.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Share2 size={40} className="mx-auto mb-3 opacity-30" />
              <p>No social signal data available yet.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <Card className="content-card">
                <CardHeader><CardTitle className="text-base">Social Signals & SEO Correlation</CardTitle></CardHeader>
                <CardContent className="pt-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Post Title</TableHead>
                          <TableHead className="text-center">Shares</TableHead>
                          <TableHead className="text-center">Likes</TableHead>
                          <TableHead className="text-center">Comments</TableHead>
                          <TableHead className="text-center">Signal Score</TableHead>
                          <TableHead className="text-center">SEO Position</TableHead>
                          <TableHead>Platforms</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {socialData.map((post, i) => {
                          const score = post.signal_score ?? 0;
                          const scoreCls = score >= 80 ? "bg-emerald-500/10 text-emerald-500"
                            : score >= 50 ? "bg-yellow-500/10 text-yellow-500"
                            : "bg-red-500/10 text-red-400";
                          return (
                            <TableRow key={i}>
                              <TableCell className="max-w-[200px]">
                                <p className="truncate font-medium text-sm">{post.title}</p>
                                {post.url && <a href={post.url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1"><ExternalLink size={10} /> View</a>}
                              </TableCell>
                              <TableCell className="text-center">{post.shares ?? 0}</TableCell>
                              <TableCell className="text-center"><span className="inline-flex items-center gap-1"><ThumbsUp size={12} /> {post.likes ?? 0}</span></TableCell>
                              <TableCell className="text-center"><span className="inline-flex items-center gap-1"><MessageCircle size={12} /> {post.comments ?? 0}</span></TableCell>
                              <TableCell className="text-center"><Badge className={`text-xs ${scoreCls}`}>{score}</Badge></TableCell>
                              <TableCell className="text-center">{post.seo_position ?? "–"}</TableCell>
                              <TableCell>
                                <div className="flex gap-1 flex-wrap">
                                  {(post.platforms || []).map((p, j) => <Badge key={j} variant="outline" className="text-xs">{p}</Badge>)}
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
              {/* Summary Card */}
              <Card className="content-card">
                <CardContent className="pt-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
                    <div>
                      <p className="text-2xl font-bold">{socialData.reduce((a, p) => a + (p.shares || 0), 0)}</p>
                      <p className="text-xs text-muted-foreground">Total Shares</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold">{socialData.reduce((a, p) => a + (p.likes || 0), 0)}</p>
                      <p className="text-xs text-muted-foreground">Total Likes</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold">{socialData.reduce((a, p) => a + (p.comments || 0), 0)}</p>
                      <p className="text-xs text-muted-foreground">Total Comments</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold">
                        {socialData.length > 0 ? Math.round(socialData.reduce((a, p) => a + (p.signal_score || 0), 0) / socialData.length) : 0}
                      </p>
                      <p className="text-xs text-muted-foreground">Avg Signal Score</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>

        {/* Live Backlinks Tab */}
        <TabsContent value="backlinks">
          <div className="flex justify-end mb-4">
            <Button className="btn-primary" size="sm" onClick={handleFetchBacklinks}
              disabled={backlinkLoading || !selectedSite}>
              {backlinkLoading ? <Loader2 size={14} className="mr-2 animate-spin" /> : <ExternalLink size={14} className="mr-2" />}
              Fetch Live Backlinks
            </Button>
          </div>
          {backlinkLoading ? (
            <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-primary" /></div>
          ) : !backlinkData ? (
            <div className="text-center py-16 text-muted-foreground">
              <ExternalLink size={40} className="mx-auto mb-3 opacity-30" />
              <p>Click "Fetch Live Backlinks" to get real-time backlink data from DataForSEO.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Summary Stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "Total Backlinks", value: backlinkData.summary?.total_backlinks?.toLocaleString() || "0" },
                  { label: "Referring Domains", value: backlinkData.summary?.referring_domains?.toLocaleString() || "0" },
                  { label: "Domain Rank", value: backlinkData.summary?.rank?.toString() || "—" },
                  { label: "Toxic Links", value: backlinkData.toxic_count?.toString() || "0", cls: backlinkData.toxic_count > 0 ? "text-red-500" : "text-emerald-500" },
                ].map((s, i) => (
                  <Card key={i} className="content-card">
                    <CardContent className="pt-4 text-center">
                      <p className="text-xs text-muted-foreground">{s.label}</p>
                      <p className={`text-2xl font-bold mt-1 ${s.cls || "text-primary"}`}>{s.value}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
              {/* Backlinks Table */}
              {backlinkData.backlinks?.length > 0 && (
                <Card className="content-card">
                  <CardHeader><CardTitle className="text-base">Backlink List</CardTitle></CardHeader>
                  <CardContent className="pt-0">
                    <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Source URL</TableHead>
                            <TableHead className="w-20">Type</TableHead>
                            <TableHead className="w-24">Anchor</TableHead>
                            <TableHead className="w-20 text-center">Spam</TableHead>
                            <TableHead className="w-20 text-center">Rank</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {backlinkData.backlinks.map((bl, i) => {
                            const spamCls = (bl.spam_score || 0) > 40 ? "text-red-500 font-bold" : (bl.spam_score || 0) > 20 ? "text-yellow-500" : "text-emerald-500";
                            return (
                              <TableRow key={i} className={(bl.spam_score || 0) > 40 ? "bg-red-500/5" : ""}>
                                <TableCell className="max-w-[250px]">
                                  <p className="truncate text-xs">{bl.source_url || bl.url_from}</p>
                                </TableCell>
                                <TableCell><Badge variant="outline" className="text-[10px]">{bl.type || bl.dofollow ? "dofollow" : "nofollow"}</Badge></TableCell>
                                <TableCell className="text-xs truncate max-w-[120px]">{bl.anchor || "—"}</TableCell>
                                <TableCell className={`text-center text-xs ${spamCls}`}>{bl.spam_score ?? "—"}</TableCell>
                                <TableCell className="text-center text-xs">{bl.domain_from_rank || bl.rank || "—"}</TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              )}
              {backlinkData.data_source && (
                <p className="text-xs text-muted-foreground text-right">Source: {backlinkData.data_source}</p>
              )}
            </div>
          )}
        </TabsContent>

        {/* Competitor Gap Tab */}
        <TabsContent value="competitor-gap">
          <Card className="content-card mb-4">
            <CardContent className="pt-4">
              <div className="flex flex-col sm:flex-row gap-3 items-end">
                <div className="flex-1 space-y-1">
                  <label className="text-xs text-muted-foreground">Competitor Domains (comma-separated)</label>
                  <input className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    placeholder="competitor1.com, competitor2.com"
                    value={competitorDomains} onChange={e => setCompetitorDomains(e.target.value)} />
                </div>
                <Button className="btn-primary" size="sm" onClick={handleCompetitorGap}
                  disabled={gapLoading || !selectedSite || !competitorDomains.trim()}>
                  {gapLoading ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Sparkles size={14} className="mr-2" />}
                  Find Gap Keywords
                </Button>
              </div>
            </CardContent>
          </Card>
          {gapLoading ? (
            <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-primary" /></div>
          ) : !gapData ? (
            <div className="text-center py-16 text-muted-foreground">
              <AlertTriangle size={40} className="mx-auto mb-3 opacity-30" />
              <p>Enter competitor domains and click "Find Gap Keywords" to discover keyword opportunities.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {gapData.easy_wins?.length > 0 && (
                <Card className="content-card border-emerald-500/30">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <CheckCircle2 size={15} className="text-emerald-500" /> Easy Wins ({gapData.easy_wins.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {gapData.easy_wins.map((kw, i) => (
                        <Badge key={i} className="bg-emerald-500/10 text-emerald-500 text-xs">
                          {kw.keyword} — Vol: {kw.search_volume?.toLocaleString() || "?"} | KD: {kw.keyword_difficulty || "?"}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
              {gapData.gap_keywords?.length > 0 && (
                <Card className="content-card">
                  <CardHeader><CardTitle className="text-base">All Gap Keywords ({gapData.gap_keywords.length})</CardTitle></CardHeader>
                  <CardContent className="pt-0">
                    <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Keyword</TableHead>
                            <TableHead className="text-center w-24">Volume</TableHead>
                            <TableHead className="text-center w-16">KD</TableHead>
                            <TableHead className="text-center w-20">CPC</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {gapData.gap_keywords.map((kw, i) => (
                            <TableRow key={i}>
                              <TableCell className="font-medium text-sm">{kw.keyword}</TableCell>
                              <TableCell className="text-center text-xs">{kw.search_volume?.toLocaleString() || "—"}</TableCell>
                              <TableCell className="text-center text-xs">{kw.keyword_difficulty || "—"}</TableCell>
                              <TableCell className="text-center text-xs">${kw.cpc?.toFixed(2) || "—"}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              )}
              {gapData.data_source && (
                <p className="text-xs text-muted-foreground text-right">Source: {gapData.data_source}</p>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
