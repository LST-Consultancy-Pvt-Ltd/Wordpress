import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Settings as SettingsIcon, Save, Loader2, Globe, Key, Eye, EyeOff,
  BarChart3, Search, Clock, Trash2, Plus, RefreshCw, CheckCircle, Users, ShieldCheck,
  PenLine, Pencil
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { Separator } from "../components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "../components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from "../components/ui/dialog";
import { getSites, getSettings, updateSettings, getJobs, createJob, deleteJob, getUsers, updateUserRole, register,
  getWritingStyles, createWritingStyle, updateWritingStyle, deleteWritingStyle, testDataForSEO } from "../lib/api";
import { Textarea } from "../components/ui/textarea";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "../components/ui/alert-dialog";
import { toast } from "sonner";

const JOB_TYPE_LABELS = {
  content_freshness: "Content Freshness Scan",
  seo_health: "SEO Health Check",
  scheduled_publish: "Scheduled Publish",
};

export default function Settings() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [saving, setSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showClaudeKey, setShowClaudeKey] = useState(false);
  const [showAppPassword, setShowAppPassword] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [jobDialogOpen, setJobDialogOpen] = useState(false);
  const [creatingJob, setCreatingJob] = useState(false);
  const [newJob, setNewJob] = useState({ job_type: "content_freshness", cron_expression: "0 2 * * 1", post_id: "" });

  // Writing Styles state
  const [styles, setStyles] = useState([]);
  const [loadingStyles, setLoadingStyles] = useState(false);
  const [styleDialogOpen, setStyleDialogOpen] = useState(false);
  const [editingStyle, setEditingStyle] = useState(null);
  const [styleForm, setStyleForm] = useState({ name: "", tone: "professional", instructions: "", example_opening: "" });
  const [savingStyle, setSavingStyle] = useState(false);

  // Team Members state
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: "", full_name: "", role: "editor", password: "" });

  // Determine current user role from localStorage
  const currentUserRole = (() => { try { return JSON.parse(localStorage.getItem("wp_user") || "{}").role || "admin"; } catch { return "admin"; } })();
  const isAdmin = currentUserRole === "admin";

  const [formData, setFormData] = useState({
    openai_api_key: "",
    anthropic_api_key: "",
    pagespeed_api_key: "",
    ai_provider: "openai",
    default_language: "en",
    seo_auto_fix: false,
    content_refresh_days: 90,
    ga4_property_id: "",
    gsc_site_url: "",
    google_service_account_json: "",
    dataforseo_login: "",
    dataforseo_password: "",
    google_trends_enabled: true,
  });
  const [dfsTestResult, setDfsTestResult] = useState(null);
  const [dfsTesting, setDfsTesting] = useState(false);

  useEffect(() => { loadSites(); if (isAdmin) loadUsers(); loadStyles(); }, []);
  useEffect(() => { if (selectedSite) { loadSettings(); loadJobs(); } }, [selectedSite]);

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    } catch { toast.error("Failed to load sites"); }
  };

  const loadUsers = async () => {
    setLoadingUsers(true);
    try {
      const r = await getUsers();
      setUsers(r.data || []);
    } catch { /* viewer — silently ignore */ }
    finally { setLoadingUsers(false); }
  };

  const loadStyles = async () => {
    setLoadingStyles(true);
    try {
      const r = await getWritingStyles();
      setStyles(r.data || []);
    } catch { /* ignore */ }
    finally { setLoadingStyles(false); }
  };

  const openNewStyleDialog = () => {
    setEditingStyle(null);
    setStyleForm({ name: "", tone: "professional", instructions: "", example_opening: "" });
    setStyleDialogOpen(true);
  };

  const openEditStyleDialog = (style) => {
    setEditingStyle(style);
    setStyleForm({ name: style.name, tone: style.tone, instructions: style.instructions, example_opening: style.example_opening || "" });
    setStyleDialogOpen(true);
  };

  const handleSaveStyle = async () => {
    if (!styleForm.name.trim() || !styleForm.instructions.trim()) {
      toast.error("Name and instructions are required");
      return;
    }
    setSavingStyle(true);
    try {
      if (editingStyle) {
        await updateWritingStyle(editingStyle.id, styleForm);
        setStyles((prev) => prev.map((s) => s.id === editingStyle.id ? { ...s, ...styleForm } : s));
        toast.success("Style updated");
      } else {
        const r = await createWritingStyle(styleForm);
        setStyles((prev) => [...prev, r.data]);
        toast.success("Writing style created");
      }
      setStyleDialogOpen(false);
    } catch { toast.error("Failed to save style"); }
    finally { setSavingStyle(false); }
  };

  const handleDeleteStyle = async (styleId) => {
    try {
      await deleteWritingStyle(styleId);
      setStyles((prev) => prev.filter((s) => s.id !== styleId));
      toast.success("Style deleted");
    } catch { toast.error("Failed to delete style"); }
  };

  const handleRoleChange = async (userId, newRole) => {
    try {
      await updateUserRole(userId, newRole);
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, role: newRole } : u));
      toast.success("Role updated");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to update role");
    }
  };

  const handleInvite = async (e) => {
    e.preventDefault();
    setInviting(true);
    try {
      await register(inviteForm);
      toast.success(`Invited ${inviteForm.email}`);
      setInviteOpen(false);
      setInviteForm({ email: "", full_name: "", role: "editor", password: "" });
      loadUsers();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to invite user");
    } finally { setInviting(false); }
  };

  const loadSettings = async () => {
    try {
      const r = await getSettings();
      if (r.data) {
        setFormData({
          openai_api_key: r.data.openai_api_key || "",
          anthropic_api_key: r.data.anthropic_api_key || "",
          pagespeed_api_key: r.data.pagespeed_api_key || "",
          ai_provider: r.data.ai_provider || "openai",
          default_language: r.data.default_language || "en",
          seo_auto_fix: r.data.seo_auto_fix || false,
          content_refresh_days: r.data.content_refresh_days || 90,
          ga4_property_id: r.data.ga4_property_id || "",
          gsc_site_url: r.data.gsc_site_url || "",
          google_service_account_json: r.data.google_analytics_credentials || "",
        });
      }
    } catch { toast.error("Failed to load settings"); }
  };

  const loadJobs = async () => {
    setLoadingJobs(true);
    try {
      const r = await getJobs(selectedSite);
      setJobs(r.data || []);
    } catch { setJobs([]); }
    finally { setLoadingJobs(false); }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        openai_api_key: formData.openai_api_key || undefined,
        anthropic_api_key: formData.anthropic_api_key || undefined,
        pagespeed_api_key: formData.pagespeed_api_key || undefined,
        ai_provider: formData.ai_provider || undefined,
        ga4_property_id: formData.ga4_property_id || undefined,
        gsc_site_url: formData.gsc_site_url || undefined,
        google_analytics_credentials: formData.google_service_account_json || undefined,
      };
      await updateSettings(payload);
      toast.success("Settings saved!");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to save settings");
    } finally { setSaving(false); }
  };

  const handleCreateJob = async (e) => {
    e.preventDefault();
    setCreatingJob(true);
    try {
      await createJob({ site_id: selectedSite, ...newJob, post_id: newJob.post_id || undefined });
      toast.success("Scheduled job created!");
      setJobDialogOpen(false);
      setNewJob({ job_type: "content_freshness", cron_expression: "0 2 * * 1", post_id: "" });
      loadJobs();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to create job");
    } finally { setCreatingJob(false); }
  };

  const handleDeleteJob = async (jobId) => {
    if (!window.confirm("Delete this scheduled job?")) return;
    try {
      await deleteJob(jobId);
      toast.success("Job deleted");
      loadJobs();
    } catch { toast.error("Failed to delete job"); }
  };

  return (
    <div className="page-container" data-testid="settings-page">
      <div className="mb-8">
        <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          Settings
        </motion.h1>
        <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
          Configure API keys, Google integrations, and scheduled jobs
        </motion.p>
      </div>

      <div className="mb-6">
        <Label>Select Site</Label>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[240px] mt-2" data-testid="site-select">
            <SelectValue placeholder="Select a site" />
          </SelectTrigger>
          <SelectContent>
            {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {selectedSite && (
        <form onSubmit={handleSave} className="space-y-6">
          {/* Sticky save bar */}
          <div className="sticky top-0 z-10 flex justify-end py-2 px-0 bg-background/80 backdrop-blur border-b border-border mb-2 -mx-1 px-1">
            <Button type="submit" className="btn-primary" disabled={saving || !selectedSite} data-testid="save-settings-btn">
              {saving ? <Loader2 size={16} className="mr-2 animate-spin" /> : <Save size={16} className="mr-2" />}
              Save Settings
            </Button>
          </div>
          {/* API Configuration */}
          <Card className="content-card">
            <CardHeader>
              <CardTitle className="font-heading flex items-center gap-2">
                <Key size={18} className="text-primary" />API Configuration
              </CardTitle>
              <CardDescription>OpenAI and Claude AI credentials</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="openai-key">OpenAI API Key</Label>
                <div className="relative">
                  <Input
                    id="openai-key"
                    type={showApiKey ? "text" : "password"}
                    placeholder="sk-..."
                    value={formData.openai_api_key}
                    onChange={(e) => setFormData({ ...formData, openai_api_key: e.target.value })}
                    data-testid="openai-api-key-input"
                  />
                  <Button type="button" variant="ghost" size="sm"
                    className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                    onClick={() => setShowApiKey(!showApiKey)}>
                    {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Used for AI post generation, AI Agent, and DALL-E image generation</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="claude-key">Anthropic (Claude) API Key</Label>
                <div className="relative">
                  <Input
                    id="claude-key"
                    type={showClaudeKey ? "text" : "password"}
                    placeholder="sk-ant-..."
                    value={formData.anthropic_api_key}
                    onChange={(e) => setFormData({ ...formData, anthropic_api_key: e.target.value })}
                    data-testid="anthropic-api-key-input"
                  />
                  <Button type="button" variant="ghost" size="sm"
                    className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                    onClick={() => setShowClaudeKey(!showClaudeKey)}>
                    {showClaudeKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Required when using Claude as the AI provider</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="pagespeed-key">Google PageSpeed API Key <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <Input
                  id="pagespeed-key"
                  type="password"
                  placeholder="AIza..."
                  value={formData.pagespeed_api_key}
                  onChange={(e) => setFormData({ ...formData, pagespeed_api_key: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Free key from{" "}
                  <a href="https://developers.google.com/speed/docs/insights/v5/get-started" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Google Cloud Console</a>.
                  {" "}Removes rate limits on PageSpeed Insights analysis.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ai-provider">AI Provider</Label>
                <Select value={formData.ai_provider} onValueChange={(v) => setFormData({ ...formData, ai_provider: v })}>
                  <SelectTrigger id="ai-provider" className="w-[200px]" data-testid="ai-provider-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI (GPT-4o)</SelectItem>
                    <SelectItem value="claude">Anthropic (Claude)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Active provider for content generation and SEO analysis. Note: AI Agent always uses OpenAI (required for tool-calling).</p>
              </div>
            </CardContent>
          </Card>

          {/* Keyword API Integrations (DataForSEO) */}
          <Card className="content-card">
            <CardHeader>
              <CardTitle className="font-heading flex items-center gap-2">
                <Key size={18} className="text-emerald-500" /> Keyword API Integrations
              </CardTitle>
              <CardDescription>DataForSEO credentials for live keyword data, SERP analysis, and backlink metrics</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="dfs-login">DataForSEO Login (Email)</Label>
                <Input id="dfs-login" type="text" placeholder="your@email.com"
                  value={formData.dataforseo_login}
                  onChange={(e) => setFormData({ ...formData, dataforseo_login: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dfs-password">DataForSEO API Password</Label>
                <Input id="dfs-password" type="password" placeholder="API password"
                  value={formData.dataforseo_password}
                  onChange={(e) => setFormData({ ...formData, dataforseo_password: e.target.value })} />
                <p className="text-xs text-muted-foreground">
                  Get credentials from <a href="https://app.dataforseo.com/api-access" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">DataForSEO Dashboard</a>. Used for live keyword metrics, SERP data, and backlinks.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Button type="button" variant="outline" size="sm" disabled={dfsTesting || !formData.dataforseo_login || !formData.dataforseo_password}
                  onClick={async () => {
                    setDfsTesting(true); setDfsTestResult(null);
                    try {
                      const r = await testDataForSEO(formData.dataforseo_login, formData.dataforseo_password);
                      setDfsTestResult(r.data);
                      if (r.data?.connected) toast.success(`Connected! Credits: $${r.data.credits_usd}`);
                      else toast.error('Connection failed');
                    } catch (e) { toast.error(e.response?.data?.detail || 'Test failed'); setDfsTestResult({ connected: false }); }
                    finally { setDfsTesting(false); }
                  }}>
                  {dfsTesting ? <Loader2 size={14} className="mr-1 animate-spin" /> : null}
                  Test Connection
                </Button>
                {dfsTestResult && (
                  dfsTestResult.connected
                    ? <Badge className="bg-emerald-500/10 text-emerald-500">Connected — ${dfsTestResult.credits_usd} credits</Badge>
                    : <Badge className="bg-red-500/10 text-red-500">Not Connected</Badge>
                )}
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <Label>Google Trends Integration</Label>
                  <p className="text-xs text-muted-foreground">Enable trending keyword data via Google Trends (pytrends)</p>
                </div>
                <Button type="button" variant="outline" size="sm"
                  className={formData.google_trends_enabled ? 'border-emerald-500/40 text-emerald-500' : ''}
                  onClick={() => setFormData({ ...formData, google_trends_enabled: !formData.google_trends_enabled })}>
                  {formData.google_trends_enabled ? 'Enabled' : 'Disabled'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Integrations */}
          <Card className="content-card">
            <CardHeader>
              <CardTitle className="font-heading flex items-center gap-2">
                <Key size={18} className="text-primary" />Integrations
              </CardTitle>
              <CardDescription>Third-party services for social media, email and e-commerce</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="mailchimp-key">Mailchimp API Key</Label>
                <Input
                  id="mailchimp-key"
                  type="password"
                  placeholder="xxxxxxxxxxxxxxxxxxxxxxxx-us1"
                  value={formData.mailchimp_api_key || ""}
                  onChange={(e) => setFormData({ ...formData, mailchimp_api_key: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">Required for Newsletter — email list sync and campaign sending</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="twitter-token">Twitter/X Bearer Token</Label>
                <Input
                  id="twitter-token"
                  type="password"
                  placeholder="AAAA..."
                  value={formData.twitter_bearer_token || ""}
                  onChange={(e) => setFormData({ ...formData, twitter_bearer_token: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">Required for Social Media — Twitter/X auto-post</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="linkedin-token">LinkedIn Access Token</Label>
                <Input
                  id="linkedin-token"
                  type="password"
                  placeholder="AQV..."
                  value={formData.linkedin_access_token || ""}
                  onChange={(e) => setFormData({ ...formData, linkedin_access_token: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">Required for Social Media — LinkedIn auto-post</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="facebook-token">Facebook Page Access Token</Label>
                <Input
                  id="facebook-token"
                  type="password"
                  placeholder="EAA..."
                  value={formData.facebook_access_token || ""}
                  onChange={(e) => setFormData({ ...formData, facebook_access_token: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">Required for Social Media — Facebook/Instagram auto-post</p>
              </div>
              <p className="text-xs text-muted-foreground pt-2 border-t border-border/30">
                WooCommerce Consumer Key &amp; Secret are configured per-site in the Sites page.
              </p>
            </CardContent>
          </Card>

          {/* Google Analytics & Search Console */}
          <Card className="content-card">
            <CardHeader>
              <CardTitle className="font-heading flex items-center gap-2">
                <BarChart3 size={18} className="text-primary" />Google Analytics & Search Console
              </CardTitle>
              <CardDescription>Connect GA4 and GSC for live SEO metrics</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ga4-property">GA4 Property ID</Label>
                <Input
                  id="ga4-property"
                  placeholder="e.g., 123456789"
                  value={formData.ga4_property_id}
                  onChange={(e) => setFormData({ ...formData, ga4_property_id: e.target.value })}
                  data-testid="ga4-property-input"
                />
                <p className="text-xs text-muted-foreground">Found in GA4 Admin → Property Settings</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="gsc-url">Search Console Site URL</Label>
                <Input
                  id="gsc-url"
                  placeholder="https://example.com/"
                  value={formData.gsc_site_url}
                  onChange={(e) => setFormData({ ...formData, gsc_site_url: e.target.value })}
                  data-testid="gsc-url-input"
                />
                <p className="text-xs text-muted-foreground">Must match the exact URL registered in Search Console</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="service-account">Google Service Account JSON</Label>
                <textarea
                  id="service-account"
                  placeholder='{"type": "service_account", "project_id": "...", ...}'
                  value={formData.google_service_account_json}
                  onChange={(e) => setFormData({ ...formData, google_service_account_json: e.target.value })}
                  className="w-full min-h-[120px] px-3 py-2 rounded-md border border-input bg-background text-sm font-mono resize-y placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  data-testid="service-account-input"
                />
                <p className="text-xs text-muted-foreground">Service account must have Analytics Viewer and Search Console permissions</p>
              </div>
            </CardContent>
          </Card>

          {/* Content Settings */}
          <Card className="content-card">
            <CardHeader>
              <CardTitle className="font-heading flex items-center gap-2">
                <Globe size={18} className="text-primary" />Content & SEO Settings
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="language">Default Language</Label>
                <Select value={formData.default_language} onValueChange={(v) => setFormData({ ...formData, default_language: v })}>
                  <SelectTrigger id="language" className="w-[200px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">English</SelectItem>
                    <SelectItem value="es">Spanish</SelectItem>
                    <SelectItem value="fr">French</SelectItem>
                    <SelectItem value="de">German</SelectItem>
                    <SelectItem value="pt">Portuguese</SelectItem>
                    <SelectItem value="it">Italian</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="refresh-days">Content Refresh Threshold (days)</Label>
                <Input
                  id="refresh-days"
                  type="number"
                  min="7"
                  max="365"
                  value={formData.content_refresh_days}
                  onChange={(e) => setFormData({ ...formData, content_refresh_days: parseInt(e.target.value) || 90 })}
                  className="w-[120px]"
                  data-testid="refresh-days-input"
                />
                <p className="text-xs text-muted-foreground">Posts older than this will be flagged for refresh</p>
              </div>
            </CardContent>
          </Card>

        </form>
      )}

      {/* Scheduled Jobs Section */}
      {selectedSite && (
        <div className="mt-8">
          <Card className="content-card">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="font-heading flex items-center gap-2">
                    <Clock size={18} className="text-primary" />Scheduled Jobs
                  </CardTitle>
                  <CardDescription>Automated tasks that run on a schedule for this site</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={loadJobs} disabled={loadingJobs}>
                    <RefreshCw size={14} className={loadingJobs ? "animate-spin" : ""} />
                  </Button>
                  <Dialog open={jobDialogOpen} onOpenChange={setJobDialogOpen}>
                    <DialogTrigger asChild>
                      <Button size="sm" className="btn-primary" data-testid="create-job-btn">
                        <Plus size={14} className="mr-1" />Add Job
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-[500px]">
                      <DialogHeader>
                        <DialogTitle>Create Scheduled Job</DialogTitle>
                        <DialogDescription>Set up an automated task for this site</DialogDescription>
                      </DialogHeader>
                      <form onSubmit={handleCreateJob}>
                        <div className="space-y-4 py-4">
                          <div className="space-y-2">
                            <Label>Job Type</Label>
                            <Select value={newJob.job_type} onValueChange={(v) => setNewJob({ ...newJob, job_type: v })}>
                              <SelectTrigger data-testid="job-type-select">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="content_freshness">Content Freshness Scan</SelectItem>
                                <SelectItem value="seo_health">SEO Health Check</SelectItem>
                                <SelectItem value="scheduled_publish">Scheduled Publish</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label>Cron Expression</Label>
                            <Input
                              placeholder="0 2 * * 1"
                              value={newJob.cron_expression}
                              onChange={(e) => setNewJob({ ...newJob, cron_expression: e.target.value })}
                              required
                              data-testid="cron-input"
                            />
                            <p className="text-xs text-muted-foreground">
                              Examples: <code className="text-primary">0 2 * * 1</code> (Mon 2am) &nbsp;
                              <code className="text-primary">0 8 * * *</code> (Daily 8am) &nbsp;
                              <code className="text-primary">0 12 1 * *</code> (1st of month)
                            </p>
                          </div>
                          {newJob.job_type === "scheduled_publish" && (
                            <div className="space-y-2">
                              <Label>Post/Page ID (WordPress)</Label>
                              <Input
                                placeholder="e.g., 42"
                                value={newJob.post_id}
                                onChange={(e) => setNewJob({ ...newJob, post_id: e.target.value })}
                                data-testid="post-id-input"
                              />
                            </div>
                          )}
                        </div>
                        <DialogFooter>
                          <Button type="button" variant="outline" onClick={() => setJobDialogOpen(false)}>Cancel</Button>
                          <Button type="submit" className="btn-primary" disabled={creatingJob}>
                            {creatingJob ? <Loader2 size={14} className="mr-2 animate-spin" /> : null}
                            Create Job
                          </Button>
                        </DialogFooter>
                      </form>
                    </DialogContent>
                  </Dialog>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {loadingJobs ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 size={24} className="animate-spin text-primary" />
                </div>
              ) : jobs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <Clock size={40} className="text-muted-foreground/30 mb-3" />
                  <p className="text-muted-foreground text-sm">No scheduled jobs. Add one above.</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Job Type</TableHead>
                      <TableHead>Cron</TableHead>
                      <TableHead>Last Run</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobs.map((job) => (
                      <TableRow key={job.id}>
                        <TableCell className="font-medium">{JOB_TYPE_LABELS[job.job_type] || job.job_type}</TableCell>
                        <TableCell><code className="text-xs bg-muted px-1 py-0.5 rounded">{job.cron_expression}</code></TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {job.last_run ? new Date(job.last_run).toLocaleString() : "Never"}
                        </TableCell>
                        <TableCell>
                          {job.last_run_status === "success" ? (
                            <Badge className="bg-emerald-500/10 text-emerald-500 text-xs">
                              <CheckCircle size={10} className="mr-1" />Success
                            </Badge>
                          ) : job.last_run_status === "error" ? (
                            <Badge className="bg-red-500/10 text-red-500 text-xs">Error</Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs">Pending</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost" size="sm"
                            className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
                            onClick={() => handleDeleteJob(job.id)}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Team Members Section — admin only */}
      {isAdmin && (
        <div className="mt-8">
          <Card className="content-card">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="font-heading flex items-center gap-2">
                    <Users size={18} className="text-primary" />Team Members
                  </CardTitle>
                  <CardDescription>Manage user roles and invite new team members</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={loadUsers} disabled={loadingUsers}>
                    <RefreshCw size={14} className={loadingUsers ? "animate-spin" : ""} />
                  </Button>
                  <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
                    <DialogTrigger asChild>
                      <Button size="sm" className="btn-primary">
                        <Plus size={14} className="mr-1" />Invite User
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-[420px]">
                      <DialogHeader>
                        <DialogTitle>Invite Team Member</DialogTitle>
                        <DialogDescription>Create an account with a temporary password. Share credentials securely.</DialogDescription>
                      </DialogHeader>
                      <form onSubmit={handleInvite}>
                        <div className="space-y-4 py-4">
                          <div className="space-y-2">
                            <Label>Email</Label>
                            <Input type="email" required placeholder="jane@example.com"
                              value={inviteForm.email} onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })} />
                          </div>
                          <div className="space-y-2">
                            <Label>Full Name</Label>
                            <Input placeholder="Jane Doe"
                              value={inviteForm.full_name} onChange={(e) => setInviteForm({ ...inviteForm, full_name: e.target.value })} />
                          </div>
                          <div className="space-y-2">
                            <Label>Temporary Password</Label>
                            <Input type="password" required placeholder="At least 8 characters"
                              value={inviteForm.password} onChange={(e) => setInviteForm({ ...inviteForm, password: e.target.value })} />
                          </div>
                          <div className="space-y-2">
                            <Label>Role</Label>
                            <Select value={inviteForm.role} onValueChange={(v) => setInviteForm({ ...inviteForm, role: v })}>
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="admin">Admin</SelectItem>
                                <SelectItem value="editor">Editor</SelectItem>
                                <SelectItem value="viewer">Viewer</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                        <DialogFooter>
                          <Button type="button" variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button>
                          <Button type="submit" className="btn-primary" disabled={inviting}>
                            {inviting ? <Loader2 size={14} className="mr-2 animate-spin" /> : null}Invite
                          </Button>
                        </DialogFooter>
                      </form>
                    </DialogContent>
                  </Dialog>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {loadingUsers ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 size={24} className="animate-spin text-primary" />
                </div>
              ) : users.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <Users size={40} className="text-muted-foreground/30 mb-3" />
                  <p className="text-muted-foreground text-sm">No users found.</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Full Name</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Joined</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((user) => (
                      <TableRow key={user.id}>
                        <TableCell className="font-medium">{user.email}</TableCell>
                        <TableCell className="text-muted-foreground">{user.full_name || "—"}</TableCell>
                        <TableCell>
                          <Select value={user.role || "viewer"} onValueChange={(v) => handleRoleChange(user.id, v)}>
                            <SelectTrigger className="w-28 h-7 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">
                                <span className="flex items-center gap-1"><ShieldCheck size={12} className="text-primary" />Admin</span>
                              </SelectItem>
                              <SelectItem value="editor">Editor</SelectItem>
                              <SelectItem value="viewer">Viewer</SelectItem>
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {user.created_at ? new Date(user.created_at).toLocaleDateString() : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Writing Style Profiles — editor + admin */}
      {(isAdmin || currentUserRole === "editor") && (
        <div className="mt-6">
          <Card className="border border-border/50 shadow-card bg-card/80 backdrop-blur rounded-2xl">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <PenLine size={18} className="text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-lg font-semibold flex items-center gap-2">
                      Writing Style Profiles
                    </CardTitle>
                    <CardDescription>Define tone and style for AI-generated content</CardDescription>
                  </div>
                </div>
                <Button size="sm" onClick={openNewStyleDialog} className="gap-1.5">
                  <Plus size={14} />New Style
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {loadingStyles ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 size={24} className="animate-spin text-primary" />
                </div>
              ) : styles.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <PenLine size={40} className="text-muted-foreground/30 mb-3" />
                  <p className="text-muted-foreground text-sm">No writing styles yet. Create one to use in AI post generation.</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Tone</TableHead>
                      <TableHead className="hidden md:table-cell">Instructions preview</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {styles.map((style) => (
                      <TableRow key={style.id}>
                        <TableCell className="font-medium">{style.name}</TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="capitalize">{style.tone}</Badge>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-muted-foreground text-sm truncate max-w-xs">
                          {style.instructions.slice(0, 80)}{style.instructions.length > 80 ? "…" : ""}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEditStyleDialog(style)}>
                              <Pencil size={13} />
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive">
                                  <Trash2 size={13} />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Delete writing style?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    "{style.name}" will be permanently deleted. Posts generated with it will remain unchanged.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction onClick={() => handleDeleteStyle(style.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                                    Delete
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Writing Style dialog */}
      <Dialog open={styleDialogOpen} onOpenChange={setStyleDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingStyle ? "Edit Writing Style" : "New Writing Style"}</DialogTitle>
            <DialogDescription>Define how the AI should write when this style is selected.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label>Name *</Label>
              <Input placeholder="e.g. Casual Blog, Technical Deep-Dive" value={styleForm.name}
                onChange={(e) => setStyleForm((p) => ({ ...p, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Tone</Label>
              <Select value={styleForm.tone} onValueChange={(v) => setStyleForm((p) => ({ ...p, tone: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["professional", "casual", "authoritative", "friendly", "technical", "conversational", "formal"].map((t) => (
                    <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Writing Instructions *</Label>
              <Textarea placeholder="Describe how AI should write: sentence length, use of examples, formality level, etc." rows={4}
                value={styleForm.instructions}
                onChange={(e) => setStyleForm((p) => ({ ...p, instructions: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Example Opening <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Textarea placeholder="Paste an example opening paragraph to guide the AI's writing style." rows={3}
                value={styleForm.example_opening}
                onChange={(e) => setStyleForm((p) => ({ ...p, example_opening: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStyleDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveStyle} disabled={savingStyle}>
              {savingStyle && <Loader2 size={14} className="animate-spin mr-1.5" />}
              {editingStyle ? "Save Changes" : "Create Style"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
