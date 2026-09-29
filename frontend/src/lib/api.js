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


// Posts
export const getPosts = (siteId) => api.get(`/posts/${siteId}`);

// SEO
export const getSEOMetrics = (siteId) => api.get(`/seo/${siteId}`);
export const analyzeSEO = (siteId, pageUrl) =>
  api.post(`/seo/analyze/${siteId}?page_url=${encodeURIComponent(pageUrl)}`);
export const selfHealSEO = (siteId) => api.post(`/seo/self-heal/${siteId}`);
export const refreshSEOFromGoogle = (siteId) => api.post(`/seo/refresh-google/${siteId}`);
export const bulkSEOAudit = (siteIds) => api.post("/seo/bulk-audit", { site_ids: siteIds });

// Bulk Operations
export const bulkContentRefresh = (siteIds) => api.post("/content-refresh/bulk", { site_ids: siteIds });

// Scheduled Jobs
export const getJobs = (siteId) => api.get(`/jobs/${siteId}`);
export const createJob = (data) => api.post("/jobs", data);
export const updateJob = (id, data) => api.put(`/jobs/${id}`, data);
export const deleteJob = (id) => api.delete(`/jobs/${id}`);


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


// Competitor Analysis
export const analyzeCompetitor = (siteId, data) => api.post(`/competitor/${siteId}/analyze`, data);
export const getCompetitorAnalyses = (siteId) => api.get(`/competitor/${siteId}`);



// PageSpeed Insights
export const analyzePageSpeed = (siteId, data) => api.post(`/pagespeed/${siteId}/analyze`, data);
export const getPageSpeedResults = (siteId) => api.get(`/pagespeed/${siteId}`);

// Writing Style Profiles
export const getWritingStyles = () => api.get('/writing-styles');
export const createWritingStyle = (data) => api.post('/writing-styles', data);
export const updateWritingStyle = (id, data) => api.put(`/writing-styles/${id}`, data);
export const deleteWritingStyle = (id) => api.delete(`/writing-styles/${id}`);


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


// Feature: Comments
export const getComments           = (siteId, status = "hold")      => api.get(`/comments/${siteId}?status=${status}`);





// Feature: Backups
export const listBackups           = (siteId)                       => api.get(`/backups/${siteId}`);



// Feature: Social Media
export const getSocialAccounts     = (siteId)                       => api.get(`/social/${siteId}/accounts`);
export const connectSocialAccount  = (siteId, data)                 => api.post(`/social/${siteId}/connect`, data);
export const disconnectSocialAccount = (siteId, accountId)          => api.delete(`/social/${siteId}/accounts/${accountId}`);
export const generateSocialPost    = (siteId, data)                => api.post(`/social/${siteId}/generate-post`, data);
export const publishSocialPost     = (siteId, postId, data)        => api.post(`/social/${siteId}/publish/${postId}`, data);
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


// Feature: Programmatic SEO
export const generateProgrammaticPages  = (siteId, data)            => api.post(`/programmatic/${siteId}/generate`, data);
export const listProgrammaticPages      = (siteId)                  => api.get(`/programmatic/${siteId}`);
export const pushProgrammaticPages      = (siteId, data)            => api.post(`/programmatic/${siteId}/push`, data);
export const deleteProgrammaticPage     = (siteId, pageId)          => api.delete(`/programmatic/${siteId}/${pageId}`);

// Feature: Keyword Clusters
export const generateKeywordClusters    = (siteId, data)            => api.post(`/keyword-clusters/${siteId}/generate`, data);
export const listKeywordClusters        = (siteId)                  => api.get(`/keyword-clusters/${siteId}`);
export const deleteKeywordCluster       = (siteId, clusterId)       => api.delete(`/keyword-clusters/${siteId}/${clusterId}`);

// Feature: Indexing Tracker
export const checkIndexingStatus        = (siteId)                  => api.post(`/indexing/${siteId}/check`);
export const getIndexingReport          = (siteId)                  => api.get(`/indexing/${siteId}`);
export const submitSitemapToGSC         = (siteId, data)            => api.post(`/indexing/${siteId}/submit-sitemap`, data);

// Off-Page SEO: Backlink Outreach
export const findBacklinkOpportunities  = (siteId, data)            => api.post(`/backlink-outreach/${siteId}/find-opportunities`, data);
export const listBacklinkOpportunities  = (siteId, params = {})     => api.get(`/backlink-outreach/${siteId}/opportunities`, { params });
export const listBacklinkSearches       = (siteId)                  => api.get(`/backlink-outreach/${siteId}/searches`);
export const generateOutreachEmail      = (siteId, oppId)           => api.post(`/backlink-outreach/${siteId}/generate-email/${oppId}`);
export const updateBacklinkStatus       = (siteId, oppId, data)     => api.patch(`/backlink-outreach/${siteId}/opportunity/${oppId}/status`, data);
export const generateDisavow            = (siteId)                  => api.post(`/backlink-outreach/${siteId}/generate-disavow`);
export const getDisavow                 = (siteId)                  => api.get(`/backlink-outreach/${siteId}/disavow`);
export const exportBacklinkOutreachExcel = (siteId)                 => api.post(`/backlink-outreach/${siteId}/export-excel`, {}, { responseType: 'blob' });

// On-page SEO audit (platform-neutral — reads rendered HTML of live URLs)
export const scanOnPageSEO           = (siteId, data = {})       => api.post(`/onpage/${siteId}/scan`, data);
export const getOnPageAudit          = (siteId)                  => api.get(`/onpage/${siteId}`);
export const getOnPageHistory        = (siteId)                  => api.get(`/onpage/${siteId}/history`);
export const auditSinglePage         = (siteId, url)             => api.post(`/onpage/${siteId}/page`, { urls: [url] });
export const listOnPagePages         = (siteId)                  => api.get(`/onpage/${siteId}/pages`);
export const setPageMeta             = (siteId, data)            => api.put(`/onpage/${siteId}/meta`, data);
export const clearPageMeta           = (siteId, path)            => api.delete(`/onpage/${siteId}/meta`, { params: { path } });
export const movePage                = (siteId, fromPath, toPath) =>
  api.post(`/onpage/${siteId}/move-page`, { from_path: fromPath, to_path: toPath });
export const getOnPageSummary        = (siteId)                  => api.get(`/onpage/${siteId}/summary`);
export const getOnPageCategory       = (siteId, key)             => api.get(`/onpage/${siteId}/category/${key}`);
export const getMetaCapabilities     = (siteId)                  => api.get(`/onpage/${siteId}/meta-capabilities`);
export const listFocusKeywords       = (siteId)                  => api.get(`/onpage/${siteId}/keywords`);
export const setFocusKeyword         = (siteId, data)            => api.put(`/onpage/${siteId}/keyword`, data);
export const clearFocusKeyword       = (siteId, path)            => api.delete(`/onpage/${siteId}/keyword`, { params: { path } });
export const getNextjsSnippets       = (siteId)                  => api.get(`/onpage/${siteId}/snippets`);
export const exportOnPageAudit       = (siteId, kind = "actions") =>
  api.get(`/onpage/${siteId}/export`, { params: { kind }, responseType: "blob" });

// Next.js sites: content publishing via the SEO Bridge endpoint in their app
export const nextjsBridgeHealth      = (siteId)                  => api.get(`/nextjs/${siteId}/health`);

// Next.js sites: editable body-copy blocks on static pages (not blog posts)
export const nextjsGetPageContent    = (siteId, path)             => api.get(`/nextjs/${siteId}/pages/content`, { params: { path } });
export const nextjsSetPageContent    = (siteId, path, key, value) => api.put(`/nextjs/${siteId}/pages/content`, { path, key, value });

// Next.js sites: editable image alt text on static pages
export const nextjsGetPageImages     = (siteId, path)             => api.get(`/nextjs/${siteId}/images/content`, { params: { path } });
export const nextjsSetImageAlt       = (siteId, path, key, alt)   => api.put(`/nextjs/${siteId}/images/content`, { path, key, alt });
export const nextjsGenerateImageAlt  = (siteId, path, key, src)   => api.post(`/nextjs/${siteId}/images/generate-alt`, { path, key, src });

// Direct-posting directories (sign in & get listed — no outreach email)
export const getDirectories             = (siteId)                  => api.get(`/directories/${siteId}`);
export const prepareDirectoryListing    = (siteId, dirId)           => api.post(`/directories/${siteId}/prepare/${dirId}`);
export const updateDirectorySubmission  = (siteId, dirId, data)     => api.patch(`/directories/${siteId}/submission/${dirId}`, data);
export const verifyDirectoryListing     = (siteId, dirId)           => api.post(`/directories/${siteId}/verify/${dirId}`);
export const verifyAllDirectoryListings = (siteId)                  => api.post(`/directories/${siteId}/verify-all`);

// Off-Page SEO: Guest Posting
export const findGuestPostSites         = (siteId, data)            => api.post(`/guest-posts/${siteId}/find-sites`, data);
export const listGuestPostProspects     = (siteId)                  => api.get(`/guest-posts/${siteId}/prospects`);
export const generateGuestPitch         = (siteId, prospectId)      => api.post(`/guest-posts/${siteId}/generate-pitch/${prospectId}`);
export const generateGuestArticle       = (siteId, prospectId)      => api.post(`/guest-posts/${siteId}/generate-article/${prospectId}`);
export const updateGuestProspect        = (siteId, prospectId, data)=> api.patch(`/guest-posts/${siteId}/prospect/${prospectId}`, data);
export const checkGuestLiveLinks        = (siteId)                  => api.post(`/guest-posts/${siteId}/check-live-links`);

// Off-Page SEO: Local Citations
export const auditLocalCitations        = (siteId, data)            => api.post(`/local-citations/${siteId}/audit`, data);
export const listLocalCitations         = (siteId)                  => api.get(`/local-citations/${siteId}/citations`);
export const generateCitationDescription= (siteId, dir)             => api.post(`/local-citations/${siteId}/generate-description/${dir}`);
export const getCitationGaps            = (siteId)                  => api.get(`/local-citations/${siteId}/gaps`);
export const updateCanonicalNAP         = (siteId, data)            => api.post(`/local-citations/${siteId}/update-nap`, data);

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


// Feature: Sitemap & Robots.txt Manager
export const getSitemap                 = (siteId)                  => api.get(`/sitemap/${siteId}`);
export const regenerateSitemap          = (siteId)                  => api.post(`/sitemap/${siteId}/regenerate`);
export const getRobotsTxt               = (siteId)                  => api.get(`/robots/${siteId}`);
export const updateRobotsTxt            = (siteId, data)            => api.put(`/robots/${siteId}`, data);


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


// Module 12: Pipeline Logs
export const getPipelineLogs            = (siteId, limit = 20)      => api.get(`/autopilot/${siteId}/pipeline-logs?limit=${limit}`);
export const getPipelineStats           = (siteId)                  => api.get(`/autopilot/${siteId}/pipeline-stats`);

// Keyword Cannibalization Detector (Module 1)
export const detectCannibalization      = (siteId)                  => api.get(`/keywords/${siteId}/cannibalization`);


// Image Sitemap with Images (Module 4)
export const regenerateSitemapWithImages = (siteId, data = {})      => api.post(`/sitemap/${siteId}/regenerate-with-images`, data);


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


// DataForSEO Integrations — Real Keyword & SERP Data
export const getKeywordMetrics         = (siteId, data)             => api.post(`/keywords/${siteId}/metrics`, data);
export const getKeywordIdeas           = (siteId, data)             => api.post(`/keywords/${siteId}/ideas`, data);
export const getSERPAnalysis           = (siteId, data)             => api.post(`/keywords/${siteId}/serp`, data);
export const checkLiveRankings         = (siteId, data)             => api.post(`/rank-tracker/${siteId}/check-live`, data);
export const getLiveBacklinks          = (siteId, data)             => api.post(`/link-builder/${siteId}/backlinks-live`, data);
export const getCompetitorGap          = (siteId, data)             => api.post(`/keywords/${siteId}/competitor-gap`, data);
export const testDataForSEO            = (login, password)          => api.get(`/integrations/dataforseo/test`, { params: { login, password } });

// Platform Intelligence (§7) — cross-site portfolio view
export const getPortfolioIntelligence  = ()                         => api.get(`/platform/portfolio`);

// Verified Company Knowledge Base (§12)
export const getCompanyProfile         = (siteId)                   => api.get(`/company-profile/${siteId}`);
export const updateCompanyProfile      = (siteId, data)             => api.post(`/company-profile/${siteId}`, data);
export const deleteCompanyProfile      = (siteId)                   => api.delete(`/company-profile/${siteId}`);

// Trust & Safety Gate + Outreach Sending (§10/§11)
export const setOutreachRecipient      = (collection, itemId, email) => api.patch(`/outreach/${collection}/${itemId}/recipient`, { recipient_email: email });
export const approveOutreach           = (collection, itemId)        => api.post(`/outreach/${collection}/${itemId}/approve`);
export const rejectOutreach            = (collection, itemId)        => api.post(`/outreach/${collection}/${itemId}/reject`);
export const sendOutreach              = (collection, itemId)        => api.post(`/outreach/${collection}/${itemId}/send`);

export default api;
