import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Globe,
  Plus,
  RefreshCw,
  Trash2,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Loader2,
  FileDown,
  Sparkles,
  ChevronRight,
  ChevronLeft,
  Tag,
  Pencil,
  KeyRound
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { Textarea } from "../components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { getSites, createSite, deleteSite, syncSite, testSiteConnection, generateSiteReport, scrapeSiteMeta, suggestTopics, saveOnboarding, updateSiteCredentials } from "../lib/api";
import { toast } from "sonner";

export default function Sites() {
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [siteToDelete, setSiteToDelete] = useState(null);
  const [syncing, setSyncing] = useState({});
  const [testing, setTesting] = useState({});
  const [creating, setCreating] = useState(false);
  const [downloadingReport, setDownloadingReport] = useState({});

  // Update credentials state
  const [credDialogOpen, setCredDialogOpen] = useState(false);
  const [credSite, setCredSite] = useState(null);
  const [credForm, setCredForm] = useState({ username: "", app_password: "", auth_type: "app_password", jwt_token: "" });
  const [savingCreds, setSavingCreds] = useState(false);

  // Edit site details state
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingSite, setEditingSite] = useState(null);
  const [editMeta, setEditMeta] = useState({ description: "", target_audience: "" });
  const [editTopics, setEditTopics] = useState(["", "", "", ""]);
  const [editTopicInput, setEditTopicInput] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Onboarding wizard state
  const [wizardStep, setWizardStep] = useState(1);
  const [createdSiteId, setCreatedSiteId] = useState(null);
  const [scraping, setScraping] = useState(false);
  const [savingOnboarding, setSavingOnboarding] = useState(false);
  const [suggestingTopics, setSuggestingTopics] = useState(false);
  const [formData, setFormData] = useState({ name: "", url: "", username: "", app_password: "", auth_type: "app_password", jwt_token: "", wp_password: "" });
  const [metaData, setMetaData] = useState({ description: "", target_audience: "" });
  const [topics, setTopics] = useState(["", "", "", ""]);
  const [topicInput, setTopicInput] = useState("");
  const [topicSuggestions, setTopicSuggestions] = useState([]);

  const resetWizard = () => {
    setWizardStep(1);
    setCreatedSiteId(null);
    setFormData({ name: "", url: "", username: "", app_password: "", auth_type: "app_password", jwt_token: "", wp_password: "" });
    setMetaData({ description: "", target_audience: "" });
    setTopics(["", "", "", ""]);
    setTopicInput("");
    setTopicSuggestions([]);
  };

  const handleDialogClose = (open) => {
    if (!open) resetWizard();
    setDialogOpen(open);
  };

  useEffect(() => {
    loadSites();
  }, []);

  const loadSites = async () => {
    try {
      const response = await getSites();
      setSites(response.data);
    } catch (error) {
      toast.error("Failed to load sites");
    } finally {
      setLoading(false);
    }
  };

  // Step 1: Create site & auto-scrape, advance to step 2
  const handleCreateSite = async (e) => {
    e.preventDefault();
    setCreating(true);
    try {
      const response = await createSite(formData);
      const newSite = response.data;
      setSites(prev => [...prev, newSite]);
      setCreatedSiteId(newSite.id);
      // Auto-scrape meta in background
      setScraping(true);
      try {
        const scrapeRes = await scrapeSiteMeta({ url: formData.url });
        const d = scrapeRes.data;
        setMetaData({
          description: d.description || "",
          target_audience: d.target_audience || "",
        });
      } catch {/* silent — user can fill manually */} finally { setScraping(false); }
      setWizardStep(2);
    } catch (error) {
      toast.error(error.response?.data?.detail || "Failed to add site");
    } finally { setCreating(false); }
  };

  // Step 2: Save meta & advance to step 3
  const handleMetaNext = async () => {
    setSuggestingTopics(true);
    try {
      const res = await suggestTopics({ description: metaData.description, target_audience: metaData.target_audience });
      setTopicSuggestions(res.data.suggestions || []);
    } catch {/* silent */} finally { setSuggestingTopics(false); }
    setWizardStep(3);
  };

  // Step 3: Save all onboarding data and close
  const handleFinishOnboarding = async () => {
    setSavingOnboarding(true);
    const filledTopics = topics.filter(t => t.trim());
    try {
      await saveOnboarding(createdSiteId, {
        description: metaData.description,
        target_audience: metaData.target_audience,
        content_topics: filledTopics,
      });
      toast.success("Site set up successfully!");
    } catch { toast.error("Failed to save onboarding data"); }
    finally { setSavingOnboarding(false); }
    handleDialogClose(false);
  };

  const addTopicFromInput = () => {
    if (!topicInput.trim()) return;
    const empty = topics.findIndex(t => !t.trim());
    if (empty !== -1) {
      const updated = [...topics]; updated[empty] = topicInput.trim();
      setTopics(updated);
    } else {
      setTopics([...topics, topicInput.trim()]);
    }
    setTopicInput("");
  };

  const addTopicFromSuggestion = (t) => {
    const empty = topics.findIndex(tt => !tt.trim());
    if (empty !== -1) {
      const updated = [...topics]; updated[empty] = t;
      setTopics(updated);
    } else {
      setTopics([...topics, t]);
    }
    setTopicSuggestions(prev => prev.filter(s => s !== t));
  };

  const handleRefreshTopicSuggestions = async () => {
    setSuggestingTopics(true);
    try {
      const res = await suggestTopics({ description: metaData.description, target_audience: metaData.target_audience });
      setTopicSuggestions(res.data.suggestions || []);
    } catch { toast.error("Suggestion failed"); }
    finally { setSuggestingTopics(false); }
  };

  const handleSyncSite = async (siteId) => {
    setSyncing({ ...syncing, [siteId]: true });
    
    try {
      await syncSite(siteId);
      await loadSites();
      toast.success("Site synced successfully!");
    } catch (error) {
      toast.error(error.response?.data?.detail || "Failed to sync site");
    } finally {
      setSyncing({ ...syncing, [siteId]: false });
    }
  };

  const handleOpenCredDialog = (site) => {
    setCredSite(site);
    setCredForm({ username: site.username || "", app_password: "", auth_type: site.auth_type || "app_password", jwt_token: "" });
    setCredDialogOpen(true);
  };

  const handleSaveCredentials = async () => {
    if (!credSite) return;
    setSavingCreds(true);
    try {
      await updateSiteCredentials(credSite.id, credForm);
      toast.success("Credentials updated and verified!");
      setCredDialogOpen(false);
      setSites(prev => prev.map(s => s.id === credSite.id ? { ...s, status: "connected", username: credForm.username || s.username } : s));
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to update credentials");
    } finally {
      setSavingCreds(false);
    }
  };

  const handleTestConnection = async (siteId) => {
    setTesting({ ...testing, [siteId]: true });
    try {
      const res = await testSiteConnection(siteId);
      const d = res.data;
      if (d.status === "connected") {
        toast.success(`Connected! Logged in as "${d.wp_user}" (${(d.roles || []).join(", ")})`);
      } else if (d.status === "auth_error") {
        toast.error(d.message);
      } else {
        toast.error(d.message || "Connection failed");
      }
      await loadSites();
    } catch (error) {
      toast.error(error.response?.data?.detail || "Test failed");
    } finally {
      setTesting({ ...testing, [siteId]: false });
    }
  };

  const handleDeleteSite = async () => {
    if (!siteToDelete) return;
    
    try {
      await deleteSite(siteToDelete.id);
      setSites(sites.filter(s => s.id !== siteToDelete.id));
      toast.success("Site removed successfully");
    } catch (error) {
      toast.error("Failed to remove site");
    } finally {
      setDeleteDialogOpen(false);
      setSiteToDelete(null);
    }
  };

  const handleOpenEditDialog = (site) => {
    const onb = site.onboarding || {};
    setEditingSite(site);
    setEditMeta({
      description: onb.description || site.description || "",
      target_audience: onb.target_audience || site.target_audience || "",
    });
    const existingTopics = onb.content_topics || site.content_topics || [];
    // Pad to at least 4 slots
    const padded = [...existingTopics];
    while (padded.length < 4) padded.push("");
    setEditTopics(padded);
    setEditTopicInput("");
    setEditDialogOpen(true);
  };

  const handleSaveEdit = async () => {
    setSavingEdit(true);
    const filledTopics = editTopics.filter(t => t.trim());
    try {
      await saveOnboarding(editingSite.id, {
        description: editMeta.description,
        target_audience: editMeta.target_audience,
        content_topics: filledTopics,
      });
      toast.success("Site details updated! Future autopilot posts will use these topics.");
      setEditDialogOpen(false);
    } catch {
      toast.error("Failed to save site details");
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDownloadReport = async (site) => {
    setDownloadingReport((prev) => ({ ...prev, [site.id]: true }));
    try {
      const r = await generateSiteReport(site.id);
      const url = URL.createObjectURL(new Blob([r.data], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `site-report-${site.name || site.id}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Report downloaded");
    } catch { toast.error("Failed to generate report"); }
    finally { setDownloadingReport((prev) => ({ ...prev, [site.id]: false })); }
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case "connected":
        return (
          <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
            <CheckCircle2 size={12} className="mr-1" />
            Connected
          </Badge>
        );
      case "auth_error":
        return (
          <Badge className="bg-orange-500/10 text-orange-500 border-orange-500/20">
            <XCircle size={12} className="mr-1" />
            Auth Error
          </Badge>
        );
      case "error":
        return (
          <Badge variant="destructive" className="bg-red-500/10 text-red-500 border-red-500/20">
            <XCircle size={12} className="mr-1" />
            Error
          </Badge>
        );
      default:
        return (
          <Badge variant="secondary">
            {status}
          </Badge>
        );
    }
  };

  return (
    <div className="page-container" data-testid="sites-page">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <motion.h1
            className="page-title"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
          >
            WordPress Sites
          </motion.h1>
          <motion.p
            className="page-description"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1 }}
          >
            Manage your connected WordPress websites
          </motion.p>
        </div>
        
        <Dialog open={dialogOpen} onOpenChange={handleDialogClose}>
          <DialogTrigger asChild>
            <Button className="btn-primary" data-testid="add-site-btn">
              <Plus size={16} className="mr-2" />
              Add Site
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[520px]">
            <DialogHeader>
              <DialogTitle className="font-heading flex items-center gap-2">
                {wizardStep === 1 && <><Globe size={16} className="text-primary" /> Connect Your Site</>}
                {wizardStep === 2 && <><Sparkles size={16} className="text-primary" /> Describe Your Business</>}
                {wizardStep === 3 && <><Tag size={16} className="text-primary" /> Plan Your Content</>}
              </DialogTitle>
              {/* Step indicator */}
              <div className="flex items-center gap-2 pt-1">
                {[1,2,3].map(s => (
                  <div key={s} className={`h-1.5 flex-1 rounded-full transition-colors ${s <= wizardStep ? "bg-primary" : "bg-muted"}`} />
                ))}
              </div>
            </DialogHeader>

            <AnimatePresence mode="wait">
              {/* Step 1 */}
              {wizardStep === 1 && (
                <motion.form key="step1" onSubmit={handleCreateSite}
                  initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label htmlFor="name">Site Name</Label>
                      <Input id="name" placeholder="My WordPress Site" value={formData.name}
                        onChange={e => setFormData({ ...formData, name: e.target.value })} required data-testid="site-name-input" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="url">Site URL</Label>
                      <Input id="url" placeholder="https://example.com" value={formData.url}
                        onChange={e => setFormData({ ...formData, url: e.target.value })} required data-testid="site-url-input" />
                    </div>

                    {/* Auth type toggle */}
                    <div className="space-y-2">
                      <Label>Authentication Method</Label>
                      <div className="grid grid-cols-2 gap-2">
                        <button type="button"
                          onClick={() => setFormData({ ...formData, auth_type: "app_password" })}
                          className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${formData.auth_type === "app_password" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/50"}`}>
                          <span className="font-medium">Application Password</span>
                          <span className="text-xs opacity-70">WordPress built-in (recommended)</span>
                        </button>
                        <button type="button"
                          onClick={() => setFormData({ ...formData, auth_type: "jwt" })}
                          className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${formData.auth_type === "jwt" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/50"}`}>
                          <span className="font-medium">JWT Token</span>
                          <span className="text-xs opacity-70">For sites with App Passwords disabled</span>
                        </button>
                      </div>
                    </div>

                    {formData.auth_type === "app_password" ? (
                      <>
                        <div className="space-y-2">
                          <Label htmlFor="username">WordPress Username</Label>
                          <Input id="username" placeholder="admin" value={formData.username}
                            onChange={e => setFormData({ ...formData, username: e.target.value })} required data-testid="site-username-input" />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="app_password">Application Password</Label>
                          <Input id="app_password" type="password" placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
                            value={formData.app_password}
                            onChange={e => setFormData({ ...formData, app_password: e.target.value })} required data-testid="site-password-input" />
                          <p className="text-xs text-muted-foreground">Generate in WordPress: Users → Profile → Application Passwords</p>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="space-y-2">
                          <Label htmlFor="jwt_username">WordPress Admin Username</Label>
                          <Input id="jwt_username" placeholder="admin" value={formData.username}
                            onChange={e => setFormData({ ...formData, username: e.target.value })} required data-testid="site-username-input" />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="wp_password">WordPress Admin Password</Label>
                          <Input id="wp_password" type="password" placeholder="Your WordPress login password"
                            value={formData.wp_password || ""}
                            onChange={e => setFormData({ ...formData, wp_password: e.target.value })} required data-testid="site-password-input" />
                          <p className="text-xs text-muted-foreground">
                            Your password is used once to generate a JWT token and is never stored.
                            Requires the "JWT Authentication for WP REST APIs" plugin to be active.
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <Button type="button" variant="outline" onClick={() => handleDialogClose(false)}>Cancel</Button>
                    <Button type="submit" className="btn-primary" disabled={creating} data-testid="submit-site-btn">
                      {creating ? <><Loader2 size={14} className="mr-2 animate-spin" />Connecting…</> : <>Continue <ChevronRight size={14} className="ml-1" /></>}
                    </Button>
                  </div>
                </motion.form>
              )}

              {/* Step 2 */}
              {wizardStep === 2 && (
                <motion.div key="step2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                  {scraping && (
                    <div className="flex items-center gap-2 text-xs text-primary mb-3 p-2 rounded bg-primary/5 border border-primary/20">
                      <Loader2 size={12} className="animate-spin" /> Auto-scanning your site…
                    </div>
                  )}
                  <div className="space-y-4 py-2">
                    <div className="space-y-2">
                      <Label>Product / Service Description <span className="text-muted-foreground text-xs">({(metaData.description || "").length}/4500)</span></Label>
                      <Textarea rows={5} maxLength={4500} placeholder="Describe what your business offers…"
                        value={metaData.description}
                        onChange={e => setMetaData({ ...metaData, description: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label>Target Audience <span className="text-muted-foreground text-xs">({(metaData.target_audience || "").length}/4500)</span></Label>
                      <Textarea rows={3} maxLength={4500} placeholder="Who are you writing for?"
                        value={metaData.target_audience}
                        onChange={e => setMetaData({ ...metaData, target_audience: e.target.value })} />
                    </div>
                  </div>
                  <div className="flex justify-between pt-2">
                    <Button variant="outline" onClick={() => setWizardStep(1)}><ChevronLeft size={14} className="mr-1" /> Back</Button>
                    <Button className="btn-primary" onClick={handleMetaNext} disabled={suggestingTopics}>
                      {suggestingTopics ? <><Loader2 size={14} className="mr-2 animate-spin" />Getting ideas…</> : <>Continue <ChevronRight size={14} className="ml-1" /></>}
                    </Button>
                  </div>
                </motion.div>
              )}

              {/* Step 3 */}
              {wizardStep === 3 && (
                <motion.div key="step3" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                  <p className="text-sm text-muted-foreground mb-3">Add up to content topic areas — we'll suggest posts for each one.</p>
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    {topics.map((t, i) => (
                      <div key={i} className="flex gap-1">
                        <Input placeholder={`Topic ${i + 1}`} value={t} className="text-sm h-8"
                          onChange={e => { const u = [...topics]; u[i] = e.target.value; setTopics(u); }} />
                        {t && <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-red-500"
                          onClick={() => { const u = [...topics]; u[i] = ""; setTopics(u); }}>×</Button>}
                      </div>
                    ))}
                  </div>
                  {/* Suggestions */}
                  {topicSuggestions.length > 0 && (
                    <div className="mb-3">
                      <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                        <Sparkles size={11} className="text-primary" /> AI suggestions — click to add:
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {topicSuggestions.map((s, i) => (
                          <button key={i} onClick={() => addTopicFromSuggestion(s)}
                            className="text-xs px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors">
                            + {s}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex gap-2 mb-3">
                    <Input placeholder="Type a topic…" value={topicInput} className="h-8 text-sm"
                      onChange={e => setTopicInput(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && (e.preventDefault(), addTopicFromInput())} />
                    <Button size="sm" variant="outline" className="h-8" onClick={addTopicFromInput}>Add</Button>
                    <Button size="sm" variant="ghost" className="h-8 text-xs text-primary" onClick={handleRefreshTopicSuggestions} disabled={suggestingTopics}>
                      {suggestingTopics ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                    </Button>
                  </div>
                  <div className="flex justify-between pt-2">
                    <Button variant="outline" onClick={() => setWizardStep(2)}><ChevronLeft size={14} className="mr-1" /> Back</Button>
                    <Button className="btn-primary" onClick={handleFinishOnboarding} disabled={savingOnboarding}>
                      {savingOnboarding ? <><Loader2 size={14} className="mr-2 animate-spin" />Saving…</> : "Finish Setup"}
                    </Button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </DialogContent>
        </Dialog>
      </div>

      {/* Sites Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={32} className="animate-spin text-primary" />
        </div>
      ) : sites.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {sites.map((site, index) => (
            <motion.div
              key={site.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
            >
              <Card className="content-card h-full">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                        <Globe size={20} className="text-primary" />
                      </div>
                      <div>
                        <CardTitle className="text-base font-heading">{site.name}</CardTitle>
                        <a
                          href={site.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1"
                        >
                          {new URL(site.url).hostname}
                          <ExternalLink size={10} />
                        </a>
                      </div>
                    </div>
                    {getStatusBadge(site.status)}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium">Username:</span> {site.username}
                    </div>
                    {site.last_sync && (
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium">Last Sync:</span>{" "}
                        {new Date(site.last_sync).toLocaleString()}
                      </div>
                    )}
                    <div className="flex gap-2 pt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => handleTestConnection(site.id)}
                        disabled={testing[site.id]}
                        title="Test WordPress credentials"
                      >
                        {testing[site.id] ? (
                          <Loader2 size={14} className="mr-1 animate-spin" />
                        ) : (
                          <CheckCircle2 size={14} className="mr-1" />
                        )}
                        Test
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => handleSyncSite(site.id)}
                        disabled={syncing[site.id]}
                        data-testid={`sync-site-${site.id}`}
                      >
                        {syncing[site.id] ? (
                          <Loader2 size={14} className="mr-1 animate-spin" />
                        ) : (
                          <RefreshCw size={14} className="mr-1" />
                        )}
                        Sync
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        title="Download site health PDF report"
                        disabled={downloadingReport[site.id]}
                        onClick={() => handleDownloadReport(site)}
                      >
                        {downloadingReport[site.id] ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <FileDown size={14} />
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        title="Update WordPress credentials"
                        onClick={() => handleOpenCredDialog(site)}
                      >
                        <KeyRound size={14} />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        title="Edit site description & content topics"
                        onClick={() => handleOpenEditDialog(site)}
                      >
                        <Pencil size={14} />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
                        onClick={() => {
                          setSiteToDelete(site);
                          setDeleteDialogOpen(true);
                        }}
                        data-testid={`delete-site-${site.id}`}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      ) : (
        <Card className="content-card">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Globe size={48} className="text-muted-foreground/30 mb-4" />
            <h3 className="font-heading font-medium text-lg mb-1">No sites connected</h3>
            <p className="text-muted-foreground text-sm text-center max-w-md mb-6">
              Connect your WordPress sites to start managing them with AI.
              You'll need your site URL, username, and an Application Password.
            </p>
            <Button className="btn-primary" onClick={() => setDialogOpen(true)} data-testid="add-first-site-btn">
              <Plus size={16} className="mr-2" />
              Add Your First Site
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Site</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove "{siteToDelete?.name}"? This will not affect your
              actual WordPress site, just remove it from this management platform.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteSite}
              className="bg-red-500 hover:bg-red-600"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Update Credentials Dialog */}
      <Dialog open={credDialogOpen} onOpenChange={setCredDialogOpen}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle className="font-heading flex items-center gap-2">
              <KeyRound size={16} className="text-primary" /> Update Credentials — {credSite?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-400">
              Generate a fresh Application Password from <strong>WP Admin → Users → Profile → Application Passwords</strong>, then paste it below. Leave blank fields to keep existing values.
            </div>
            <div className="space-y-2">
              <Label>WordPress Username</Label>
              <Input
                placeholder="your-wp-login-username"
                value={credForm.username}
                onChange={e => setCredForm({ ...credForm, username: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">Must be the login username — not email or display name.</p>
            </div>
            <div className="space-y-2">
              <Label>New Application Password</Label>
              <Input
                type="password"
                placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
                value={credForm.app_password}
                onChange={e => setCredForm({ ...credForm, app_password: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">Spaces are OK — will be stripped automatically.</p>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setCredDialogOpen(false)}>Cancel</Button>
            <Button className="btn-primary" onClick={handleSaveCredentials} disabled={savingCreds}>
              {savingCreds ? <><Loader2 size={14} className="mr-2 animate-spin" />Verifying…</> : "Save & Verify"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Site Details Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="font-heading flex items-center gap-2">
              <Pencil size={16} className="text-primary" /> Edit Site Details — {editingSite?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Product / Service Description</Label>
              <Textarea
                rows={5}
                maxLength={4500}
                placeholder="Describe what your business offers — the AI uses this to pick keywords…"
                value={editMeta.description}
                onChange={e => setEditMeta({ ...editMeta, description: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                This is what the Autopilot Engine reads to generate relevant keywords. Make it specific to your niche.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Target Audience</Label>
              <Textarea
                rows={2}
                maxLength={4500}
                placeholder="e.g. Job seekers using AI tools, tech-savvy professionals…"
                value={editMeta.target_audience}
                onChange={e => setEditMeta({ ...editMeta, target_audience: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Content Topics</Label>
              <p className="text-xs text-muted-foreground">The autopilot picks keywords from these topics only.</p>
              <div className="grid grid-cols-2 gap-2">
                {editTopics.map((t, i) => (
                  <div key={i} className="flex gap-1">
                    <Input
                      placeholder={`Topic ${i + 1}`}
                      value={t}
                      className="text-sm h-8"
                      onChange={e => { const u = [...editTopics]; u[i] = e.target.value; setEditTopics(u); }}
                    />
                    {t && (
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-red-500"
                        onClick={() => { const u = [...editTopics]; u[i] = ""; setEditTopics(u); }}>×</Button>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex gap-2 mt-1">
                <Input
                  placeholder="Add a topic…"
                  value={editTopicInput}
                  className="h-8 text-sm"
                  onChange={e => setEditTopicInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (!editTopicInput.trim()) return;
                      setEditTopics(prev => [...prev, editTopicInput.trim()]);
                      setEditTopicInput("");
                    }
                  }}
                />
                <Button size="sm" variant="outline" className="h-8" onClick={() => {
                  if (!editTopicInput.trim()) return;
                  setEditTopics(prev => [...prev, editTopicInput.trim()]);
                  setEditTopicInput("");
                }}>Add</Button>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>Cancel</Button>
            <Button className="btn-primary" onClick={handleSaveEdit} disabled={savingEdit}>
              {savingEdit ? <><Loader2 size={14} className="mr-2 animate-spin" />Saving…</> : "Save Details"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
