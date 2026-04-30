import axios from "axios";

const configuredBackendUrl = (process.env.REACT_APP_BACKEND_URL || "").trim();
const fallbackBackendUrl = "http://localhost:8000";
const backendBase = (configuredBackendUrl || fallbackBackendUrl).replace(/\/+$/, "");
const API = `${backendBase}/api`;

const api = axios.create({
  baseURL: API,
  headers: {
    "Content-Type": "application/json",
  },
});

// JWT auth interceptor
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("wp_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auto-logout on 401 — only for actual auth failures, NOT for WordPress API errors
// WordPress API errors get mapped to 502 by the backend, so a true 401 here
// means our own JWT token is missing/expired.
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err.response?.status;
    const url = err.config?.url || "";
    // Only clear session when:
    //  - Status is 401 AND
    //  - It's hitting an auth-protected endpoint (not a content write that happens to fail)
    if (status === 401 && !url.includes("/auth/login") && !url.includes("/auth/register") && !url.includes("/sites")) {
      localStorage.removeItem("wp_token");
      localStorage.removeItem("wp_user");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

// Auth
export const login = (data) => api.post("/auth/login", data);
export const register = (data) => api.post("/auth/register", data);
export const getMe = () => api.get("/auth/me");
export const getUsers = () => api.get("/users");
export const updateUserRole = (userId, role) => api.patch(`/users/${userId}/role`, { role });

// Dashboard
export const getDashboardStats = () => api.get("/dashboard/stats");

// Settings (global, not per-site)
export const getSettings = () => api.get("/settings");
export const updateSettings = (data) => api.post("/settings", data);

// Sites
export const getSites = () => api.get("/sites");
export const createSite = (data) => api.post("/sites", data);
export const getSite = (id) => api.get(`/sites/${id}`);
export const deleteSite = (id) => api.delete(`/sites/${id}`);
export const syncSite = (id) => api.post(`/sites/${id}/sync`);
export const testSiteConnection = (id) => api.post(`/sites/${id}/test-connection`);
export const updateSiteCredentials = (id, data) => api.put(`/sites/${id}/credentials`, data);

// AI Commands (legacy)
export const executeAICommand = (data) => api.post("/ai/command", data);
export const getAICommands = (siteId) => api.get(`/ai/commands/${siteId}`);

// Agent Sessions
export const createAgentSession = (data) => api.post("/agent/sessions", data);
export const getAgentSessions = (siteId) => api.get(`/agent/sessions/${siteId}`);
export const getAgentSession = (id) => api.get(`/agent/session/${id}`);
export const deleteAgentSession = (id) => api.delete(`/agent/session/${id}`);
export const startAgentTurn = (data) => api.post("/agent/turn", data);

// Pages
export const getPages = (siteId) => api.get(`/pages/${siteId}`);
export const createPage = (data) => api.post("/pages", data);
export const updatePage = (siteId, wpId, data) => api.put(`/pages/${siteId}/${wpId}`, data);
export const deletePage = (siteId, wpId) => api.delete(`/pages/${siteId}/${wpId}`);

// Posts
export const getPosts = (siteId) => api.get(`/posts/${siteId}`);
export const createPost = (data) => api.post("/posts", data);
export const updatePost = (siteId, wpId, data) => api.put(`/posts/${siteId}/${wpId}`, data);
export const deletePost = (siteId, wpId) => api.delete(`/posts/${siteId}/${wpId}`);
export const generateBlogPost = (data) => api.post("/posts/generate", data);

// SEO
export const getSEOMetrics = (siteId) => api.get(`/seo/${siteId}`);
export const analyzeSEO = (siteId, pageUrl) =>
  api.post(`/seo/analyze/${siteId}?page_url=${encodeURIComponent(pageUrl)}`);
export const selfHealSEO = (siteId) => api.post(`/seo/self-heal/${siteId}`);
export const refreshSEOFromGoogle = (siteId) => api.post(`/seo/refresh-google/${siteId}`);
export const bulkSEOAudit = (siteIds) => api.post("/seo/bulk-audit", { site_ids: siteIds });

// Bulk Operations
export const bulkPublish = (data) => api.post("/bulk/publish", data);
export const bulkContentRefresh = (siteIds) => api.post("/content-refresh/bulk", { site_ids: siteIds });

// Scheduled Jobs
export const getJobs = (siteId) => api.get(`/jobs/${siteId}`);
export const createJob = (data) => api.post("/jobs", data);
export const updateJob = (id, data) => api.put(`/jobs/${id}`, data);
export const deleteJob = (id) => api.delete(`/jobs/${id}`);

// Navigation
export const getNavigation = (siteId) => api.get(`/navigation/${siteId}`);
export const syncNavigation = (siteId) => api.post(`/navigation/${siteId}/sync`);

// Content Refresh
export const getContentRefreshItems = (siteId) => api.get(`/content-refresh/${siteId}`);
export const scanForRefresh = (siteId) => api.post(`/content-refresh/${siteId}/scan`);
export const refreshContent = (siteId, itemId) => api.post(`/content-refresh/${siteId}/refresh/${itemId}`);
export const refreshContentDryRun = (siteId, itemId) => api.post(`/content-refresh/${siteId}/refresh/${itemId}?dry_run=true`);

// Activity
export const getActivityLogs = (siteId) => api.get(`/activity/${siteId}`);
export const getAllActivityLogs = () => api.get("/activity");

// Broken Links
export const scanBrokenLinks = (siteId) => api.post(`/broken-links/${siteId}/scan`);
export const getBrokenLinks = (siteId, status) =>
  api.get(`/broken-links/${siteId}${status ? `?status=${status}` : ""}`);
export const dismissBrokenLink = (siteId, linkId) => api.delete(`/broken-links/${siteId}/${linkId}`);

// Duplicate Content
export const scanDuplicateContent = (siteId) => api.post(`/duplicate-content/${siteId}/scan`);
export const getDuplicateContent = (siteId) => api.get(`/duplicate-content/${siteId}`);
export const fixDuplicateContent = (siteId, itemId) => api.post(`/duplicate-content/${siteId}/fix/${itemId}`);
export const fixDuplicateContentDryRun = (siteId, itemId) => api.post(`/duplicate-content/${siteId}/fix/${itemId}?dry_run=true`);

// Internal Links
export const suggestInternalLinks = (siteId) => api.post(`/internal-links/${siteId}/suggest`);
export const getInternalLinkSuggestions = (siteId) => api.get(`/internal-links/${siteId}`);
export const applyInternalLink = (siteId, suggestionId) => api.post(`/internal-links/${siteId}/apply/${suggestionId}`);

// Content Calendar
export const getCalendarEvents = (siteId) => api.get(`/calendar/${siteId}`);
export const scheduleCalendarPost = (siteId, data) => api.post(`/calendar/${siteId}/schedule`, data);

// Competitor Analysis
export const analyzeCompetitor = (siteId, data) => api.post(`/competitor/${siteId}/analyze`, data);
export const getCompetitorAnalyses = (siteId) => api.get(`/competitor/${siteId}`);

// Bulk Meta + Taxonomy
export const bulkMetaUpdate = (data) => api.post("/bulk/meta-update", data);
export const bulkTaxonomyUpdate = (data) => api.post("/bulk/taxonomy-update", data);
export const getTaxonomies = (siteId) => api.get(`/taxonomies/${siteId}`);

// Post Translation
export const translatePost = (siteId, wpId, data) => api.post(`/posts/translate/${siteId}/${wpId}`, data);

// PageSpeed Insights
export const analyzePageSpeed = (siteId, data) => api.post(`/pagespeed/${siteId}/analyze`, data);
export const getPageSpeedResults = (siteId) => api.get(`/pagespeed/${siteId}`);

// Writing Style Profiles
export const getWritingStyles = () => api.get('/writing-styles');
export const createWritingStyle = (data) => api.post('/writing-styles', data);
export const updateWritingStyle = (id, data) => api.put(`/writing-styles/${id}`, data);
export const deleteWritingStyle = (id) => api.delete(`/writing-styles/${id}`);

// Content Briefs
export const generateBrief = (siteId, data) => api.post(`/brief/${siteId}/generate`, data);
export const getBriefs = (siteId) => api.get(`/brief/${siteId}`);
export const generatePostFromBrief = (siteId, briefId) => api.post(`/brief/${siteId}/${briefId}/generate-post`);

// Plugin Health Audit
export const auditPlugins = (siteId) => api.post(`/plugins/${siteId}/audit`);
export const getPluginAudit = (siteId) => api.get(`/plugins/${siteId}`);

// Image Alt Text
export const getImageAudit = (siteId) => api.get(`/images/${siteId}/audit`);
export const auditImages = (siteId) => api.post(`/images/${siteId}/audit`);
export const generateAltText = (siteId, mediaId) => api.post(`/images/${siteId}/generate-alt/${mediaId}`);
export const generateAllAltTexts = (siteId) => api.post(`/images/${siteId}/generate-all-alts`);

// Rank Tracker
export const getRankTrackerData = (siteId, keywords) =>
  api.get(`/rank-tracker/${siteId}${keywords?.length ? `?keywords=${keywords.join(',')}` : ''}`);
export const saveTrackedKeywords = (siteId, data) => api.post(`/rank-tracker/${siteId}/track`, data);
export const getTrackedKeywords = (siteId) => api.get(`/rank-tracker/${siteId}/tracked`);

// Site Health Report PDF
export const generateSiteReport = (siteId) =>
  api.post(`/reports/${siteId}/generate`, { template: 'site_health' }, { responseType: 'blob' });

// Readability
export const analyzeReadability = (siteId, wpId, contentType = 'post') =>
  api.post(`/readability/${siteId}/${wpId}?content_type=${contentType}`);

// Task polling helper (SSE-compatible via polling for environments that block EventSource)
export const subscribeToTask = (taskId, callback) => {
  let active = true;
  const poll = async () => {
    while (active) {
      try {
        const res = await api.get(`/tasks/${taskId}`);
        const data = res.data;
        callback({ type: "status", data });
        if (data.status === "completed" || data.status === "failed") {
          if (data.status === "failed") callback({ type: "error", data: { message: data.error } });
          active = false;
          break;
        }
      } catch {
        callback({ type: "error", data: { message: "Failed to fetch task status" } });
        active = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  };
  poll();
  return () => { active = false; };
};

// Feature 1: Onboarding
export const scrapeSiteMeta = (data) => api.post('/sites/scrape-meta', data);
export const suggestTopics = (data) => api.post('/sites/suggest-topics', data);
export const saveOnboarding = (siteId, data) => api.put(`/sites/${siteId}/onboarding`, data);

// Feature 2: Search Visibility
export const getSearchVisibility = (siteId) => api.get(`/search-visibility/${siteId}`);
export const analyzeSearchVisibility = (siteId) => api.post(`/search-visibility/analyze/${siteId}`);

// Feature 3: Keyword Tracking v2
export const getTrackedKeywordsV2 = (siteId) => api.get(`/keywords/${siteId}`);
export const addTrackedKeyword = (siteId, data) => api.post(`/keywords/${siteId}`, data);
export const deleteTrackedKeyword = (siteId, kwId) => api.delete(`/keywords/${siteId}/${kwId}`);
export const suggestKeywords = (siteId, data) => api.post(`/keywords/${siteId}/suggest`, data);
export const refreshKeywordRankings = (siteId) => api.post(`/keywords/${siteId}/refresh`);

// Feature 5: Link Builder
export const linkBuilderInsert = (siteId, data) => api.post(`/links/internal/insert/${siteId}`, data);
export const generateOutreachAngles = (siteId) => api.post(`/links/outreach/generate/${siteId}`);

// Feature 6: Reports
export const listReports = (siteId) => api.get(`/reports/${siteId}`);
export const generateReport = (siteId, data) => api.post(`/reports/${siteId}/generate`, data, { responseType: 'blob' });
export const scheduleReport = (siteId, data) => api.post(`/reports/${siteId}/schedule`, data);

// Feature 7: Local Tracking
export const getLocalTracking = (siteId) => api.get(`/local/${siteId}`);
export const addLocalKeyword = (siteId, data) => api.post(`/local/track/${siteId}`, data);
export const deleteLocalKeyword = (siteId, kwId) => api.delete(`/local/${siteId}/${kwId}`);
export const getLocalRecommendations = (siteId) => api.post(`/local/recommendations/${siteId}`);

// Feature 8: Live Editor
export const editorListPosts = (siteId) => api.get(`/editor/${siteId}/posts`);
export const editorGetPost = (siteId, wpId, type = 'post') => api.get(`/editor/${siteId}/post/${wpId}?content_type=${type}`);
export const editorSavePost = (siteId, wpId, data) => api.put(`/editor/${siteId}/post/${wpId}`, data);
export const editorAIAssist = (data) => api.post('/editor/ai-assist', data);

// Feature 10: Crawl Report
export const triggerCrawl = (siteId) => api.post(`/crawl/${siteId}`);
export const getLatestCrawl = (siteId) => api.get(`/crawl/${siteId}/latest`);
export const fixCrawlIssue = (siteId, issueId) => api.post(`/crawl/${siteId}/fix/${issueId}`);
export const fixCrawlIssueDryRun = (siteId, issueId) => api.post(`/crawl/${siteId}/fix/${issueId}?dry_run=true`);

// Autopilot Engine
export const autopilotGetSettings  = (siteId) => api.get(`/autopilot/${siteId}/settings`);
export const autopilotSaveSettings = (siteId, data) => api.post(`/autopilot/${siteId}/settings`, data);
export const autopilotRunPipeline  = (siteId) => api.post(`/autopilot/${siteId}/run-pipeline`);
export const autopilotGetHistory   = (siteId, page = 1) => api.get(`/autopilot/${siteId}/history?page=${page}&per_page=10`);
export const autopilotGetJobs      = (siteId) => api.get(`/autopilot/${siteId}/jobs`);
export const autopilotPickKeyword  = (siteId) => api.post(`/autopilot/${siteId}/pick-keyword`);
export const autopilotWritePost    = (siteId, jobId) => api.post(`/autopilot/${siteId}/write-post/${jobId}`);
export const autopilotOptimizeSEO  = (siteId, jobId) => api.post(`/autopilot/${siteId}/optimize-seo/${jobId}`);
export const autopilotPublish      = (siteId, jobId) => api.post(`/autopilot/${siteId}/publish/${jobId}`);
export const autopilotInterlink    = (siteId, jobId) => api.post(`/autopilot/${siteId}/interlink/${jobId}`);
export const autopilotUpdateSchedule = (siteId) => api.post(`/autopilot/${siteId}/update-schedule`);

// Auto-SEO: Meta Tags, Open Graph, Schema Markup
export const triggerAutoSEOScan    = (siteId)              => api.post(`/seo/auto-scan/${siteId}`);
export const getAutoSEOSuggestions = (siteId)              => api.get(`/seo/auto-scan/${siteId}`);
export const applyMetaTags         = (siteId, wpId, data)  => api.post(`/seo/apply-meta/${siteId}/${wpId}`, data);
export const applyOGTags           = (siteId, wpId, data)  => api.post(`/seo/apply-og/${siteId}/${wpId}`, data);
export const applySchema           = (siteId, wpId, data)  => api.post(`/seo/apply-schema/${siteId}/${wpId}`, data);
export const applyBulkSEO          = (siteId, data)        => api.post(`/seo/apply-bulk/${siteId}`, data);
export const downloadMetaFixerPlugin = (siteId)            => api.get(`/seo/meta-fixer-plugin/${siteId}`, { responseType: "blob" });
export const downloadBridgePlugin    = (siteId)            => api.get(`/seo/bridge-plugin/${siteId}`, { responseType: "blob" });
export const fullPageSEOAudit        = (siteId, data)      => api.post(`/seo/full-page-audit/${siteId}`, data);

// Feature: Media Library
export const getMedia              = (siteId)                       => api.get(`/media/${siteId}`);
export const deleteMedia           = (siteId, mediaId)              => api.delete(`/media/${siteId}/${mediaId}`);
export const renameMedia           = (siteId, mediaId, data)        => api.post(`/media/${siteId}/rename/${mediaId}`, data);
export const compressMedia         = (siteId, mediaId)              => api.post(`/media/${siteId}/compress/${mediaId}`);
export const bulkCompressMedia     = (siteId)                       => api.post(`/media/${siteId}/bulk-compress`);
export const uploadMedia           = (siteId, file)                 => {
  const formData = new FormData(); formData.append("file", file);
  return api.post(`/media/${siteId}/upload`, file, {
    headers: { "Content-Type": file.type, "X-Filename": file.name },
  });
};

// Feature: Comments
export const getComments           = (siteId, status = "hold")      => api.get(`/comments/${siteId}?status=${status}`);
export const approveComment        = (siteId, commentId)            => api.post(`/comments/${siteId}/approve/${commentId}`);
export const spamComment           = (siteId, commentId)            => api.post(`/comments/${siteId}/spam/${commentId}`);
export const deleteComment         = (siteId, commentId)            => api.delete(`/comments/${siteId}/${commentId}`);
export const bulkCommentAction     = (siteId, data)                 => api.post(`/comments/${siteId}/bulk-action`, data);
export const aiReplyComment        = (siteId, commentId)            => api.post(`/comments/${siteId}/ai-reply/${commentId}`);
export const postCommentReply      = (siteId, commentId, data)      => api.post(`/comments/${siteId}/post-reply/${commentId}`, data);
export const autoModerateComments  = (siteId)                       => api.post(`/comments/${siteId}/auto-moderate`);

// Feature: WP Users
export const getWPUsers            = (siteId)                       => api.get(`/wp-users/${siteId}`);
export const createWPUser          = (siteId, data)                 => api.post(`/wp-users/${siteId}`, data);
export const updateWPUser          = (siteId, userId, data)         => api.put(`/wp-users/${siteId}/${userId}`, data);
export const deleteWPUser          = (siteId, userId, reassign = 1) => api.delete(`/wp-users/${siteId}/${userId}?reassign=${reassign}`);
export const resetWPUserPassword   = (siteId, userId)               => api.post(`/wp-users/${siteId}/reset-password/${userId}`);

// Feature: Plugins & Themes
export const getPluginsThemes      = (siteId)                       => api.get(`/plugins-themes/${siteId}/plugins`);
export const activatePlugin        = (siteId, slug)                 => api.post(`/plugins-themes/${siteId}/plugins/${encodeURIComponent(slug)}/activate`);
export const deactivatePlugin      = (siteId, slug)                 => api.post(`/plugins-themes/${siteId}/plugins/${encodeURIComponent(slug)}/deactivate`);
export const getThemes             = (siteId)                       => api.get(`/plugins-themes/${siteId}/themes`);
export const activateTheme         = (siteId, stylesheet)           => api.post(`/plugins-themes/${siteId}/themes/${encodeURIComponent(stylesheet)}/activate`);
export const pluginSecurityScan    = (siteId)                       => api.post(`/plugins-themes/${siteId}/security-scan`);

// Feature: Forms & Leads
export const getForms              = (siteId)                       => api.get(`/forms/${siteId}`);
export const getFormEntries        = (siteId, formId)               => api.get(`/forms/${siteId}/${formId}/entries`);
export const analyzeFormEntries    = (siteId, formId)               => api.post(`/forms/${siteId}/ai-analyze/${formId}`);
export const createFaqPostFromForm = (siteId, formId)               => api.post(`/forms/${siteId}/create-faq-post/${formId}`);

// Feature: WooCommerce
export const getWooProducts        = (siteId)                       => api.get(`/woo/${siteId}/products`);
export const getWooOrders          = (siteId)                       => api.get(`/woo/${siteId}/orders`);
export const getWooCustomers       = (siteId)                       => api.get(`/woo/${siteId}/customers`);
export const getWooStats           = (siteId)                       => api.get(`/woo/${siteId}/stats`);
export const wooAIDescription      = (siteId, prodId)               => api.post(`/woo/${siteId}/products/${prodId}/ai-description`);
export const wooBulkAIDescriptions = (siteId)                       => api.post(`/woo/${siteId}/bulk-ai-descriptions`);
export const wooLowStockAlert      = (siteId)                       => api.post(`/woo/${siteId}/low-stock-alert`);

// Feature: Backups
export const listBackups           = (siteId)                       => api.get(`/backups/${siteId}`);
export const createBackup          = (siteId)                       => api.post(`/backups/${siteId}/create`);
export const restoreBackup         = (siteId, backupId)             => api.post(`/backups/${siteId}/restore/${backupId}`);
export const deleteBackup          = (siteId, backupId)             => api.delete(`/backups/${siteId}/${backupId}`);
export const scheduleBackup        = (siteId, data)                 => api.post(`/backups/${siteId}/schedule`, data);

// Feature: Redirects
export const listRedirects         = (siteId)                       => api.get(`/redirects/${siteId}`);
export const createRedirect        = (siteId, data)                 => api.post(`/redirects/${siteId}`, data);
export const deleteRedirect        = (siteId, redirectId)           => api.delete(`/redirects/${siteId}/${redirectId}`);
export const aiSuggestRedirects    = (siteId)                       => api.post(`/redirects/${siteId}/ai-suggest`);
export const bulkCreateRedirects   = (siteId, data)                 => api.post(`/redirects/${siteId}/bulk-create`, data);

// Feature: A/B Testing
export const listABTests           = (siteId)                       => api.get(`/ab/${siteId}`);
export const createABTest          = (siteId, data)                 => api.post(`/ab/${siteId}/create`, data);
export const recordABImpression    = (siteId, testId, variant)      => api.post(`/ab/${siteId}/record-impression/${testId}?variant=${variant}`);
export const recordABClick         = (siteId, testId, variant)      => api.post(`/ab/${siteId}/record-click/${testId}?variant=${variant}`);
export const switchABVariant       = (siteId, testId)               => api.post(`/ab/${siteId}/switch-variant/${testId}`);
export const concludeABTest        = (siteId, testId)               => api.post(`/ab/${siteId}/conclude/${testId}`);
export const generateABVariants    = (siteId, postId)               => api.post(`/ab/${siteId}/ai-generate-variants/${postId}`);

// Feature: Social Media
export const getSocialAccounts     = (siteId)                       => api.get(`/social/${siteId}/accounts`);
export const connectSocialAccount  = (siteId, data)                 => api.post(`/social/${siteId}/connect`, data);
export const disconnectSocialAccount = (siteId, accountId)          => api.delete(`/social/${siteId}/accounts/${accountId}`);
export const generateSocialPost    = (siteId, data)                => api.post(`/social/${siteId}/generate-post`, data);
export const publishSocialPost     = (siteId, data)                => api.post(`/social/${siteId}/publish`, data);
export const getSocialQueue        = (siteId)                       => api.get(`/social/${siteId}/queue`);
export const saveSocialAutoSettings = (siteId, data)                => api.post(`/social/${siteId}/auto-post-settings`, data);
export const processSocialQueue    = (siteId)                       => api.post(`/social/${siteId}/process-queue`);

// Feature: Newsletter
export const getNewsletterLists    = (siteId)                       => api.get(`/newsletter/${siteId}/lists`);
export const generateNewsletter    = (siteId, data)                 => api.post(`/newsletter/${siteId}/generate`, data);
export const sendNewsletter        = (siteId, data)                 => api.post(`/newsletter/${siteId}/send`, data);
export const getNewsletterHistory  = (siteId)                       => api.get(`/newsletter/${siteId}/history`);
export const subscribeNewsletter   = (siteId, email)                => api.post(`/newsletter/${siteId}/subscribe`, { email });

// Feature: Site Health
export const getHealthData         = (siteId)                       => api.get(`/health/${siteId}`);
export const runHealthCheck        = (siteId)                       => api.post(`/health/${siteId}/check`);
export const getHealthHistory      = (siteId)                       => api.get(`/health/${siteId}/history`);
export const scheduleHealthMonitor = (siteId, data)                 => api.post(`/health/${siteId}/schedule-monitor`, data);
export const getHealthFix          = (siteId, issueKey)             => api.post(`/health/${siteId}/fix/${issueKey}`);

// Global: Notifications
export const getNotifications      = (siteId)                       => api.get(`/notifications/${siteId}`);
export const markNotificationRead  = (siteId, notifId)              => api.post(`/notifications/${siteId}/mark-read/${notifId}`);
export const markAllNotificationsRead = (siteId)                    => api.post(`/notifications/${siteId}/mark-all-read`);

// Global: Search
export const globalSearch          = (siteId, q)                    => api.get(`/search/${siteId}?q=${encodeURIComponent(q)}`);

// Feature: Programmatic SEO
export const generateProgrammaticPages  = (siteId, data)            => api.post(`/programmatic/${siteId}/generate`, data);
export const listProgrammaticPages      = (siteId)                  => api.get(`/programmatic/${siteId}`);
export const pushProgrammaticPages      = (siteId, data)            => api.post(`/programmatic/${siteId}/push`, data);
export const deleteProgrammaticPage     = (siteId, pageId)          => api.delete(`/programmatic/${siteId}/${pageId}`);

// Feature: Keyword Clusters
export const generateKeywordClusters    = (siteId, data)            => api.post(`/keyword-clusters/${siteId}/generate`, data);
export const listKeywordClusters        = (siteId)                  => api.get(`/keyword-clusters/${siteId}`);
export const deleteKeywordCluster       = (siteId, clusterId)       => api.delete(`/keyword-clusters/${siteId}/${clusterId}`);

// Feature: GBP Optimizer
export const analyzeGBP                 = (siteId, data)            => api.post(`/gbp/${siteId}/analyze`, data);
export const listGBPAnalyses            = (siteId)                  => api.get(`/gbp/${siteId}`);
export const toggleGBPChecklistItem     = (siteId, analysisId, idx) => api.patch(`/gbp/${siteId}/${analysisId}/checklist/${idx}`);

// Feature: Review Growth
export const generateReviewPlan         = (siteId, data)            => api.post(`/reviews/${siteId}/plan`, data);
export const listReviewPlans            = (siteId)                  => api.get(`/reviews/${siteId}`);
export const setReviewWebhook           = (siteId, planId, data)    => api.patch(`/reviews/${siteId}/${planId}/webhook`, data);
export const testReviewWebhook          = (siteId, planId)          => api.post(`/reviews/${siteId}/${planId}/test-webhook`);

// Feature: Indexing Tracker
export const checkIndexingStatus        = (siteId)                  => api.post(`/indexing/${siteId}/check`);
export const getIndexingReport          = (siteId)                  => api.get(`/indexing/${siteId}`);
export const submitSitemapToGSC         = (siteId, data)            => api.post(`/indexing/${siteId}/submit-sitemap`, data);

// Feature: Revenue Dashboard
export const getRevenueAttribution      = (siteId)                  => api.get(`/revenue/${siteId}/attribution`);
export const getMonthlySummary          = (siteId)                  => api.get(`/revenue/${siteId}/monthly-summary`);
export const updateRevenueSettings      = (siteId, data)            => api.post(`/revenue/${siteId}/settings`, data);
export const getRevenueSettings         = (siteId)                  => api.get(`/revenue/${siteId}/settings`);
export const exportRevenuePDF           = (siteId)                  => api.post(`/revenue/${siteId}/export-pdf`, {}, { responseType: 'blob' });

// Off-Page SEO: Backlink Outreach
export const findBacklinkOpportunities  = (siteId, data)            => api.post(`/backlink-outreach/${siteId}/find-opportunities`, data);
export const listBacklinkOpportunities  = (siteId)                  => api.get(`/backlink-outreach/${siteId}/opportunities`);
export const generateOutreachEmail      = (siteId, oppId)           => api.post(`/backlink-outreach/${siteId}/generate-email/${oppId}`);
export const updateBacklinkStatus       = (siteId, oppId, data)     => api.patch(`/backlink-outreach/${siteId}/opportunity/${oppId}/status`, data);
export const generateDisavow            = (siteId)                  => api.post(`/backlink-outreach/${siteId}/generate-disavow`);
export const getDisavow                 = (siteId)                  => api.get(`/backlink-outreach/${siteId}/disavow`);

// Off-Page SEO: Guest Posting
export const findGuestPostSites         = (siteId, data)            => api.post(`/guest-posts/${siteId}/find-sites`, data);
export const listGuestPostProspects     = (siteId)                  => api.get(`/guest-posts/${siteId}/prospects`);
export const generateGuestPitch         = (siteId, prospectId)      => api.post(`/guest-posts/${siteId}/generate-pitch/${prospectId}`);
export const generateGuestArticle       = (siteId, prospectId)      => api.post(`/guest-posts/${siteId}/generate-article/${prospectId}`);
export const updateGuestProspect        = (siteId, prospectId, data)=> api.patch(`/guest-posts/${siteId}/prospect/${prospectId}`, data);
export const checkGuestLiveLinks        = (siteId)                  => api.post(`/guest-posts/${siteId}/check-live-links`);

// Off-Page SEO: Brand Mentions
export const scanBrandMentions          = (siteId, data)            => api.post(`/brand-mentions/${siteId}/scan`, data);
export const listBrandMentions          = (siteId)                  => api.get(`/brand-mentions/${siteId}/mentions`);
export const generateMentionOutreach    = (siteId, mentionId)       => api.post(`/brand-mentions/${siteId}/generate-outreach/${mentionId}`);
export const getBrandMentionSummary     = (siteId)                  => api.get(`/brand-mentions/${siteId}/summary`);

// Off-Page SEO: Digital PR
export const generatePressRelease       = (siteId, data)            => api.post(`/digital-pr/${siteId}/generate-press-release`, data);
export const generatePRPitch            = (siteId, prId)            => api.post(`/digital-pr/${siteId}/generate-pitch/${prId}`);
export const generateHaroResponse       = (siteId, data)            => api.post(`/digital-pr/${siteId}/generate-haro-response`, data);
export const listPRCampaigns            = (siteId)                  => api.get(`/digital-pr/${siteId}/campaigns`);
export const addPRCoverage              = (siteId, campId, data)    => api.patch(`/digital-pr/${siteId}/campaign/${campId}/coverage`, data);

// Off-Page SEO: Local Citations
export const auditLocalCitations        = (siteId, data)            => api.post(`/local-citations/${siteId}/audit`, data);
export const listLocalCitations         = (siteId)                  => api.get(`/local-citations/${siteId}/citations`);
export const generateCitationDescription= (siteId, dir)             => api.post(`/local-citations/${siteId}/generate-description/${dir}`);
export const getCitationGaps            = (siteId)                  => api.get(`/local-citations/${siteId}/gaps`);
export const updateCanonicalNAP         = (siteId, data)            => api.post(`/local-citations/${siteId}/update-nap`, data);

// Off-Page SEO: Influencer Outreach
export const findInfluencers            = (siteId, data)            => api.post(`/influencer/${siteId}/find-influencers`, data);
export const listInfluencers            = (siteId)                  => api.get(`/influencer/${siteId}/influencers`);
export const generateInfluencerPitch    = (siteId, infId)           => api.post(`/influencer/${siteId}/generate-pitch/${infId}`);
export const generateCollabBrief        = (siteId, infId)           => api.post(`/influencer/${siteId}/generate-brief/${infId}`);
export const updateInfluencerStatus     = (siteId, infId, data)     => api.patch(`/influencer/${siteId}/influencer/${infId}/status`, data);

// Off-Page SEO: Community Engagement
export const findCommunities            = (siteId, data)            => api.post(`/community/${siteId}/find-communities`, data);
export const generateCommunityAnswer    = (siteId, threadId, data)  => api.post(`/community/${siteId}/generate-answer/${threadId}`, data);
export const listCommunityOpportunities = (siteId)                  => api.get(`/community/${siteId}/opportunities`);
export const updateCommunityOpp         = (siteId, oppId, data)     => api.patch(`/community/${siteId}/opportunity/${oppId}/status`, data);
export const getCommunityPerformance    = (siteId)                  => api.get(`/community/${siteId}/performance`);

// Off-Page SEO: Podcast Outreach
export const findPodcasts               = (siteId, data)            => api.post(`/podcast/${siteId}/find-podcasts`, data);
export const listPodcasts               = (siteId)                  => api.get(`/podcast/${siteId}/podcasts`);
export const generatePodcastPitch       = (siteId, podId)           => api.post(`/podcast/${siteId}/generate-pitch/${podId}`);
export const generateTalkingPoints      = (siteId, podId)           => api.post(`/podcast/${siteId}/generate-talking-points/${podId}`);
export const updatePodcastStatus        = (siteId, podId, data)     => api.patch(`/podcast/${siteId}/podcast/${podId}/status`, data);

// Off-Page SEO: Link Reclamation
export const scanInbound404s            = (siteId)                  => api.post(`/link-reclamation/${siteId}/scan-inbound-404s`);
export const getLinkReclamationReport   = (siteId)                  => api.get(`/link-reclamation/${siteId}/report`);
export const generateReclaimEmail       = (siteId, linkId)          => api.post(`/link-reclamation/${siteId}/generate-reclaim-email/${linkId}`);
export const bulkCreateLinkRedirects    = (siteId, data)            => api.post(`/link-reclamation/${siteId}/bulk-redirect`, data);

// Off-Page SEO: Autopilot Dashboard
export const getOffPageScore            = (siteId)                  => api.get(`/offpage-autopilot/${siteId}/score`);
export const getOffPagePriorityActions  = (siteId)                  => api.get(`/offpage-autopilot/${siteId}/priority-actions`);
export const generateOffPageStrategy   = (siteId)                  => api.post(`/offpage-autopilot/${siteId}/generate-strategy`);
export const getOffPageDigest           = (siteId)                  => api.get(`/offpage-autopilot/${siteId}/digest`);

// Feature: Schema Markup Generator
export const generateSchema             = (siteId, data)            => api.post(`/schema/${siteId}/generate`, data);
export const listSchemaRecords          = (siteId)                  => api.get(`/schema/${siteId}`);
export const applySchemaRecord          = (siteId, schemaId)        => api.post(`/schema/${siteId}/apply/${schemaId}`);

// Feature: Sitemap & Robots.txt Manager
export const getSitemap                 = (siteId)                  => api.get(`/sitemap/${siteId}`);
export const regenerateSitemap          = (siteId)                  => api.post(`/sitemap/${siteId}/regenerate`);
export const getRobotsTxt               = (siteId)                  => api.get(`/robots/${siteId}`);
export const updateRobotsTxt            = (siteId, data)            => api.put(`/robots/${siteId}`, data);

// Feature: Canonical Tag Manager
export const getCanonicals              = (siteId)                  => api.get(`/canonical/${siteId}`);
export const updateCanonical            = (siteId, wpId, data)      => api.put(`/canonical/${siteId}/${wpId}`, data);
export const bulkFixCanonicals          = (siteId)                  => api.post(`/canonical/${siteId}/bulk-fix`);

// Feature: Mobile Responsiveness Checker
export const checkMobileUsability       = (siteId)                  => api.post(`/mobile/${siteId}/check`);
export const getMobileCheckResults      = (siteId)                  => api.get(`/mobile/${siteId}`);

// Feature: Keyword Intent Categorisation
export const categorizeKeywords         = (siteId, data)            => api.post(`/keywords/${siteId}/categorize`, data);
export const getKeywordsByIntent        = (siteId)                  => api.get(`/keywords/${siteId}/by-intent`);

// Feature: AI Content Detector
export const analyzeAIContent           = (siteId, data)            => api.post(`/ai-content-detector/${siteId}/analyze`, data);
export const bulkScanAIContent          = (siteId, data)            => api.post(`/ai-content-detector/${siteId}/bulk-scan`, data);
export const fullScoreAIContent         = (siteId, data)            => api.post(`/ai-content-detector/${siteId}/full-score`, data);
export const humanizeContent            = (siteId, data)            => api.post(`/ai-content-detector/${siteId}/humanize`, data);

// Feature: Keyword Research
export const researchKeyword            = (siteId, data)            => api.post(`/keyword-research/${siteId}/analyze`, data);

// Feature: Auto Blog Generation
export const generateAutoBlogs          = (siteId, data)            => api.post(`/auto-blog-generation/${siteId}/generate`, data);

// Feature: Keyword Analysis
export const analyzeKeywordDensity      = (siteId, data)            => api.post(`/keyword-analysis/${siteId}/analyze`, data);

// Module 3: Uptime Monitoring
export const uptimeDeepCheck            = (siteId)                  => api.post(`/uptime/${siteId}/deep-check`);
export const getUptimeHistory           = (siteId, days = 7)        => api.get(`/uptime/${siteId}/history?days=${days}`);
export const getUptimeSummary           = (siteId)                  => api.get(`/uptime/${siteId}/summary`);

// Module 4: Image SEO
export const bulkGenerateAltText        = (siteId)                  => api.post(`/image-seo/${siteId}/bulk-generate-alt`);
export const runImageSEOAudit           = (siteId)                  => api.post(`/image-seo/${siteId}/audit`);
export const getImageSEOAudit           = (siteId)                  => api.get(`/image-seo/${siteId}/audit`);

// Module 12: Pipeline Logs
export const getPipelineLogs            = (siteId, limit = 20)      => api.get(`/autopilot/${siteId}/pipeline-logs?limit=${limit}`);
export const getPipelineStats           = (siteId)                  => api.get(`/autopilot/${siteId}/pipeline-stats`);

// Keyword Cannibalization Detector (Module 1)
export const detectCannibalization      = (siteId)                  => api.get(`/keywords/${siteId}/cannibalization`);

// EXIF Metadata Cleaning (Module 4)
export const cleanExifMetadata          = (siteId, data = {})       => api.post(`/images/${siteId}/clean-exif`, data);

// Image Sitemap with Images (Module 4)
export const regenerateSitemapWithImages = (siteId, data = {})      => api.post(`/sitemap/${siteId}/regenerate-with-images`, data);

// WebP Bulk Conversion (Module 4)
export const convertImagesToWebP        = (siteId, data = {})       => api.post(`/images/${siteId}/convert-webp`, data);

// Event-Based Autopilot Triggers (Module 12)
export const getAutopilotTriggers       = (siteId)                  => api.get(`/autopilot/${siteId}/trigger-settings`);
export const saveAutopilotTriggers      = (siteId, data)            => api.post(`/autopilot/${siteId}/trigger-settings`, data);

// Multi-Region Uptime (Module 3)
export const multiRegionUptimeCheck     = (siteId)                  => api.post(`/uptime/${siteId}/multi-region`);

// ROI per Keyword (Module 1)
export const getKeywordROI             = (siteId)                   => api.get(`/keywords/${siteId}/roi`);

// Google Trends (Module 1)
export const getKeywordTrends          = (siteId, data)             => api.post(`/keywords/${siteId}/trends`, data);

// Predictive Ranking (Module 5)
export const getRankPredictions        = (siteId)                   => api.get(`/rank-tracker/${siteId}/predictions`);

// Section-by-Section AI Detection (Module 10)
export const sectionAIDetection        = (siteId, data)             => api.post(`/ai-content-detector/${siteId}/section-score`, data);

// Google Helpful Content Score (Module 10)
export const helpfulContentScore       = (siteId, data)             => api.post(`/ai-content-detector/${siteId}/helpful-content-score`, data);

// Real Fact-Check API (Module 10)
export const factCheckContent          = (siteId, data)             => api.post(`/ai-content-detector/${siteId}/fact-check`, data);

// Competitor Content Comparison (Module 10)
export const compareCompetitorContent  = (siteId, data)             => api.post(`/ai-content-detector/${siteId}/compare-competitor`, data);

// Anchor Text Distribution (Module 9)
export const getAnchorDistribution     = (siteId)                   => api.get(`/link-builder/${siteId}/anchor-distribution`);

// Social Signal SEO Mapping (Module 9)
export const getSocialSignals          = (siteId)                   => api.get(`/link-builder/${siteId}/social-signals`);

// A/B Title SEO Testing (Module 5)
export const createTitleTest           = (siteId, data)             => api.post(`/ab-testing/${siteId}/title-test`, data);
export const listTitleTests            = (siteId)                   => api.get(`/ab-testing/${siteId}/title-tests`);
export const concludeTitleTest         = (siteId, testId)           => api.post(`/ab-testing/${siteId}/title-test/${testId}/conclude`);

// DataForSEO Integrations — Real Keyword & SERP Data
export const getKeywordMetrics         = (siteId, data)             => api.post(`/keywords/${siteId}/metrics`, data);
export const getKeywordIdeas           = (siteId, data)             => api.post(`/keywords/${siteId}/ideas`, data);
export const getSERPAnalysis           = (siteId, data)             => api.post(`/keywords/${siteId}/serp`, data);
export const checkLiveRankings         = (siteId, data)             => api.post(`/rank-tracker/${siteId}/check-live`, data);
export const getLiveBacklinks          = (siteId, data)             => api.post(`/link-builder/${siteId}/backlinks-live`, data);
export const getCompetitorGap          = (siteId, data)             => api.post(`/keywords/${siteId}/competitor-gap`, data);
export const testDataForSEO            = (login, password)          => api.get(`/integrations/dataforseo/test`, { params: { login, password } });

export default api;
