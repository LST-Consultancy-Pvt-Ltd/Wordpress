/**
 * Control-plane API client (protocol/control-plane-api.md).
 *
 * - Every request carries the session JWT in the Authorization header. The
 *   JWT never goes into a URL: server-sent-event streams use a short-lived
 *   stream token instead (see lib/stream.js and `createStreamToken`).
 * - 401 from the control plane itself clears the session and returns to the
 *   login page. Bridge-originated failures come back as
 *   `{detail: {code, message, correlation_id}}` and never log the user out.
 * - 403 shows one "not permitted" toast; the rejection still reaches callers.
 */
import axios from "axios";
import { toast } from "sonner";
import { clearSession, getToken } from "./session";

const configuredBackendUrl = (process.env.REACT_APP_BACKEND_URL || "").trim();
const fallbackBackendUrl = "http://localhost:8000";
export const BACKEND_BASE = (configuredBackendUrl || fallbackBackendUrl).replace(/\/+$/, "");
export const API_BASE = `${BACKEND_BASE}/api`;

const api = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
});

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

const AUTH_ROUTES = ["/auth/login", "/auth/register"];

/** True when an error detail was produced by a site bridge, not by our own auth. */
export function isBridgeError(err) {
  const d = err?.response?.data?.detail;
  return !!(d && typeof d === "object" && d.code);
}

/** Human-readable message for any API error (FastAPI or bridge envelope). */
export function apiErrorMessage(err, fallback = "Request failed") {
  const data = err?.response?.data;
  const d = data?.detail;
  if (typeof d === "string") return d;
  if (d && typeof d === "object") {
    if (d.message) return d.code ? `${d.message} (${d.code})` : d.message;
    if (d.code) return d.code;
  }
  if (Array.isArray(d)) return d.map((x) => x.msg || JSON.stringify(x)).join("; ");
  if (typeof data?.message === "string") return data.message;
  return err?.message || fallback;
}

/** Structured error details: code, message, correlation id, capability. */
export function apiErrorDetails(err) {
  const d = err?.response?.data?.detail;
  const status = err?.response?.status ?? null;
  if (d && typeof d === "object" && !Array.isArray(d)) {
    return {
      status,
      code: d.code || null,
      message: d.message || apiErrorMessage(err),
      correlationId: d.correlation_id || null,
      capability: d.capability || null,
    };
  }
  return { status, code: null, message: apiErrorMessage(err), correlationId: null, capability: null };
}

export function isCapabilityUnsupported(err) {
  return err?.response?.status === 422 && apiErrorDetails(err).code === "CAPABILITY_UNSUPPORTED";
}

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err.response?.status;
    const url = err.config?.url || "";
    const isAuthRoute = AUTH_ROUTES.some((r) => url.includes(r));
    if (status === 401 && !isAuthRoute && !isBridgeError(err)) {
      clearSession();
      if (window.location.pathname !== "/login") window.location.assign("/login");
    } else if (status === 403 && !isBridgeError(err)) {
      toast.error("Not permitted", {
        id: "sa-forbidden",
        description: apiErrorMessage(err, "Your role does not allow this action."),
      });
    }
    return Promise.reject(err);
  }
);

/** Accepts `{items, next_cursor}` or a bare array; always returns an array. */
export function listItems(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

// ── Auth & users ─────────────────────────────────────────────────────────
export const login = (data) => api.post("/auth/login", data);
export const register = (data) => api.post("/auth/register", data);
export const getMe = () => api.get("/auth/me");
export const getUsers = () => api.get("/users");
export const updateUserRole = (userId, role) => api.patch(`/users/${userId}/role`, { role });

/** Short-lived token for SSE URLs: `{task_id}` → `{token, expires_in}`. */
export const createStreamToken = (data = {}) => api.post("/stream-token", data);

// ── Sites & connections ──────────────────────────────────────────────────
export const getSites = () => api.get("/sites");
export const getSite = (id) => api.get(`/sites/${id}`);
export const createSite = (data) => api.post("/sites", data);
export const updateSite = (id, data) => api.patch(`/sites/${id}`, data);
export const deleteSite = (id, confirm) => api.delete(`/sites/${id}`, { data: { confirm } });
export const handshakeSite = (id) => api.post(`/sites/${id}/handshake`);
export const getSiteHealth = (id) => api.get(`/sites/${id}/health`);
export const verifySiteWrite = (id) => api.post(`/sites/${id}/verify-write`);
export const setSiteWrites = (id, enabled, confirm) => api.post(`/sites/${id}/writes`, { enabled, confirm });
export const rotateSiteCredential = (id) => api.post(`/sites/${id}/credential/rotate`);
export const replaceSiteCredential = (id, data) => api.post(`/sites/${id}/credential/replace`, data);
export const revokeSiteCredential = (id, confirm) => api.post(`/sites/${id}/credential/revoke`, { confirm });
export const getSitePolicy = (id) => api.get(`/sites/${id}/policy`);
export const updateSitePolicy = (id, policy) => api.put(`/sites/${id}/policy`, policy);
/** → `{synced, failed, removed}` */
export const syncSiteContent = (id) => api.post(`/sites/${id}/content/sync`);

// ── Inventory & reads (bridge-backed) ────────────────────────────────────
export const getInventory = (id, kind, params) => api.get(`/sites/${id}/inventory/${kind}`, { params });
export const getContentCollections = (id) => api.get(`/sites/${id}/content/collections`);
export const getContentItems = (id, collection, params) =>
  api.get(`/sites/${id}/content/${encodeURIComponent(collection)}/items`, { params });
export const getContentItem = (id, collection, slug) =>
  api.get(`/sites/${id}/content/${encodeURIComponent(collection)}/items/${encodeURIComponent(slug)}`);
/** File read (capability `files.read`). Response: `{root, path, content, sha256}`. */
export const getSiteFile = (id, root, path) => api.get(`/sites/${id}/files`, { params: { root, path } });
export const getRevisions = (id, params) => api.get(`/sites/${id}/revisions`, { params });
export const getRevision = (id, rid) => api.get(`/sites/${id}/revisions/${rid}`);
export const getOpsStatus = (id) => api.get(`/sites/${id}/ops/status`);
export const getOpsLogs = (id, service, tail = 200) => api.get(`/sites/${id}/ops/logs`, { params: { service, tail } });
export const getBridgeAudit = (id, params) => api.get(`/sites/${id}/bridge/audit`, { params });

// ── Change sets ──────────────────────────────────────────────────────────
export const createChangeSet = (siteId, data) => api.post(`/sites/${siteId}/changesets`, data);
export const listChangeSets = (siteId, params) => api.get(`/sites/${siteId}/changesets`, { params });
/** All sites: `?status=&site_id=&cursor=` → `{items, next_cursor}` */
export const listAllChangeSets = (params) => api.get("/changesets", { params });
export const getChangeSet = (cid) => api.get(`/changesets/${cid}`);
export const updateChangeSet = (cid, data) => api.put(`/changesets/${cid}`, data);
export const planChangeSet = (cid) => api.post(`/changesets/${cid}/plan`);
export const validateChangeSet = (cid, steps) => api.post(`/changesets/${cid}/validate`, steps ? { steps } : {});
export const previewChangeSet = (cid) => api.post(`/changesets/${cid}/preview`);
export const submitChangeSet = (cid) => api.post(`/changesets/${cid}/submit`);
export const approveChangeSet = (cid, comment) => api.post(`/changesets/${cid}/approve`, { comment });
export const rejectChangeSet = (cid, comment) => api.post(`/changesets/${cid}/reject`, { comment });
export const applyChangeSet = (cid, confirm) => api.post(`/changesets/${cid}/apply`, confirm ? { confirm } : {});
export const rollbackChangeSet = (cid, confirm, reason) => api.post(`/changesets/${cid}/rollback`, { confirm, reason });
export const cancelChangeSet = (cid) => api.post(`/changesets/${cid}/cancel`);

// ── Deployments & backups ────────────────────────────────────────────────
export const getDeploymentProfiles = (id) => api.get(`/sites/${id}/deployments/profiles`);
export const listDeployments = (id) => api.get(`/sites/${id}/deployments`);
export const createDeployment = (id, data) => api.post(`/sites/${id}/deployments`, data);
export const getDeployment = (did) => api.get(`/deployments/${did}`);
export const rollbackDeployment = (did, confirm, reason) => api.post(`/deployments/${did}/rollback`, { confirm, reason });
export const listBackups = (id) => api.get(`/sites/${id}/backups`);
export const createBackup = (id, kind) => api.post(`/sites/${id}/backups`, { kind });
export const restoreBackup = (id, bid, data) => api.post(`/sites/${id}/backups/${bid}/restore`, data);

// ── Audit ────────────────────────────────────────────────────────────────
export const listAudit = (params) => api.get("/audit", { params });

// ── Tasks ────────────────────────────────────────────────────────────────
export const getTask = (taskId) => api.get(`/tasks/${taskId}`);

/** Poll a task until it completes (fallback for environments without SSE). */
export const subscribeToTask = (taskId, callback) => {
  let active = true;
  const poll = async () => {
    while (active) {
      try {
        const { data } = await getTask(taskId);
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
  return () => {
    active = false;
  };
};

// ── Dashboard, settings, activity, jobs ──────────────────────────────────
export const getDashboardStats = () => api.get("/dashboard/stats");
export const getSettings = () => api.get("/settings");
export const updateSettings = (data) => api.post("/settings", data);
export const getActivityLogs = (siteId) => api.get(`/activity/${siteId}`);
export const getAllActivityLogs = () => api.get("/activity");
export const getJobs = (siteId) => api.get(`/jobs/${siteId}`);
export const createJob = (data) => api.post("/jobs", data);
export const updateJob = (id, data) => api.put(`/jobs/${id}`, data);
export const deleteJob = (id) => api.delete(`/jobs/${id}`);
export const getNotifications = (siteId) => api.get(`/notifications/${siteId}`);
export const markNotificationRead = (siteId, notifId) => api.post(`/notifications/${siteId}/mark-read/${notifId}`);
export const markAllNotificationsRead = (siteId) => api.post(`/notifications/${siteId}/mark-all-read`);

// ── AI agent (proposes change sets, never applies) ───────────────────────
export const createAgentSession = (data) => api.post("/agent/sessions", data);
export const getAgentSessions = (siteId) => api.get(`/agent/sessions/${siteId}`);
export const getAgentSession = (id) => api.get(`/agent/session/${id}`);
export const deleteAgentSession = (id) => api.delete(`/agent/session/${id}`);
export const startAgentTurn = (data) => api.post("/agent/turn", data);
/** `{text, action, site_id?}` → `{result}` */
export const aiAssist = (data) => api.post("/ai/assist", data);

// ── Writing styles ───────────────────────────────────────────────────────
export const getWritingStyles = () => api.get("/writing-styles");
export const createWritingStyle = (data) => api.post("/writing-styles", data);
export const updateWritingStyle = (id, data) => api.put(`/writing-styles/${id}`, data);
export const deleteWritingStyle = (id) => api.delete(`/writing-styles/${id}`);

// ── SEO metrics, competitors, PageSpeed, rankings ────────────────────────
export const getSEOMetrics = (siteId) => api.get(`/seo/${siteId}`);
export const analyzeSEO = (siteId, pageUrl) => api.post(`/seo/analyze/${siteId}`, null, { params: { page_url: pageUrl } });
export const selfHealSEO = (siteId) => api.post(`/seo/self-heal/${siteId}`);
export const refreshSEOFromGoogle = (siteId) => api.post(`/seo/refresh-google/${siteId}`);
export const bulkSEOAudit = (siteIds) => api.post("/seo/bulk-audit", { site_ids: siteIds });
export const fullPageSEOAudit = (siteId, data) => api.post(`/seo/full-page-audit/${siteId}`, data);
export const analyzeCompetitor = (siteId, data) => api.post(`/competitor/${siteId}/analyze`, data);
export const getCompetitorAnalyses = (siteId) => api.get(`/competitor/${siteId}`);
export const analyzePageSpeed = (siteId, data) => api.post(`/pagespeed/${siteId}/analyze`, data);
export const getPageSpeedResults = (siteId) => api.get(`/pagespeed/${siteId}`);
export const getRankTrackerData = (siteId, keywords) =>
  api.get(`/rank-tracker/${siteId}`, { params: keywords?.length ? { keywords: keywords.join(",") } : undefined });
export const saveTrackedKeywords = (siteId, data) => api.post(`/rank-tracker/${siteId}/track`, data);
export const getTrackedKeywords = (siteId) => api.get(`/rank-tracker/${siteId}/tracked`);
export const getRankPredictions = (siteId) => api.get(`/rank-tracker/${siteId}/predictions`);
export const checkLiveRankings = (siteId, data) => api.post(`/rank-tracker/${siteId}/check-live`, data);

// ── On-page SEO audit (reads rendered HTML; writes create change sets) ───
export const scanOnPageSEO = (siteId, data = {}) => api.post(`/onpage/${siteId}/scan`, data);
export const getOnPageAudit = (siteId) => api.get(`/onpage/${siteId}`);
export const getOnPageHistory = (siteId) => api.get(`/onpage/${siteId}/history`);
export const auditSinglePage = (siteId, url) => api.post(`/onpage/${siteId}/page`, { urls: [url] });
export const listOnPagePages = (siteId) => api.get(`/onpage/${siteId}/pages`);
export const getMetaCapabilities = (siteId) => api.get(`/onpage/${siteId}/meta-capabilities`);
/** → `{changeset, route, opted_in}` */
export const setPageMeta = (siteId, data) => api.put(`/onpage/${siteId}/meta`, data);
/** → `{changeset, route}` */
export const clearPageMeta = (siteId, path) => api.delete(`/onpage/${siteId}/meta`, { params: { path } });
/** → `{from_path, to_path, changeset|null, focus_keyword_moved, instructions[], redirect_snippet|null}` */
export const movePage = (siteId, fromPath, toPath) =>
  api.post(`/onpage/${siteId}/move-page`, { from_path: fromPath, to_path: toPath });
export const getOnPageSummary = (siteId) => api.get(`/onpage/${siteId}/summary`);
export const getOnPageCategory = (siteId, key) => api.get(`/onpage/${siteId}/category/${key}`);
export const listFocusKeywords = (siteId) => api.get(`/onpage/${siteId}/keywords`);
export const setFocusKeyword = (siteId, data) => api.put(`/onpage/${siteId}/keyword`, data);
export const clearFocusKeyword = (siteId, path) => api.delete(`/onpage/${siteId}/keyword`, { params: { path } });
export const getOnPageSnippets = (siteId) => api.get(`/onpage/${siteId}/snippets`);
export const exportOnPageAudit = (siteId, kind = "actions") =>
  api.get(`/onpage/${siteId}/export`, { params: { kind }, responseType: "blob" });

// ── Site quality scans (read-only; fixes go through change sets) ─────────
export const triggerCrawl = (siteId) => api.post(`/crawl/${siteId}`);
export const getLatestCrawl = (siteId) => api.get(`/crawl/${siteId}/latest`);
export const scanBrokenLinks = (siteId) => api.post(`/broken-links/${siteId}/scan`);
export const getBrokenLinks = (siteId, status) => api.get(`/broken-links/${siteId}`, { params: status ? { status } : undefined });
export const dismissBrokenLink = (siteId, linkId) => api.delete(`/broken-links/${siteId}/${linkId}`);
export const scanDuplicateContent = (siteId) => api.post(`/duplicate-content/${siteId}/scan`);
export const getDuplicateContent = (siteId) => api.get(`/duplicate-content/${siteId}`);
export const suggestInternalLinks = (siteId) => api.post(`/internal-links/${siteId}/suggest`);
export const getInternalLinkSuggestions = (siteId) => api.get(`/internal-links/${siteId}`);
export const getContentRefreshItems = (siteId) => api.get(`/content-refresh/${siteId}`);
export const scanForRefresh = (siteId) => api.post(`/content-refresh/${siteId}/scan`);
/** → `{changeset}` (content.upsert, draft) */
export const refreshContent = (siteId, itemId) => api.post(`/content-refresh/${siteId}/refresh/${itemId}`);
export const refreshContentDryRun = (siteId, itemId) =>
  api.post(`/content-refresh/${siteId}/refresh/${itemId}`, null, { params: { dry_run: true } });
export const getSitemap = (siteId) => api.get(`/sitemap/${siteId}`);
export const getRobotsTxt = (siteId) => api.get(`/robots/${siteId}`);
export const checkMobileUsability = (siteId) => api.post(`/mobile/${siteId}/check`);
export const getMobileCheckResults = (siteId) => api.get(`/mobile/${siteId}`);
export const checkIndexingStatus = (siteId) => api.post(`/indexing/${siteId}/check`);
export const getIndexingReport = (siteId) => api.get(`/indexing/${siteId}`);
export const submitSitemapToGSC = (siteId, data) => api.post(`/indexing/${siteId}/submit-sitemap`, data);

// ── Site health & uptime ─────────────────────────────────────────────────
export const getHealthData = (siteId) => api.get(`/health/${siteId}`);
export const runHealthCheck = (siteId) => api.post(`/health/${siteId}/check`);
export const getHealthHistory = (siteId) => api.get(`/health/${siteId}/history`);
export const getHealthFix = (siteId, issueKey) => api.post(`/health/${siteId}/fix/${issueKey}`);
export const multiRegionUptimeCheck = (siteId) => api.post(`/uptime/${siteId}/multi-region`);
export const uptimeDeepCheck = (siteId) => api.post(`/uptime/${siteId}/deep-check`);
export const getUptimeHistory = (siteId, days = 7) => api.get(`/uptime/${siteId}/history`, { params: { days } });
export const getUptimeSummary = (siteId) => api.get(`/uptime/${siteId}/summary`);

// ── Autopilot & monitoring triggers ──────────────────────────────────────
export const autopilotGetSettings = (siteId) => api.get(`/autopilot/${siteId}/settings`);
export const autopilotSaveSettings = (siteId, data) => api.post(`/autopilot/${siteId}/settings`, data);
export const autopilotRunPipeline = (siteId) => api.post(`/autopilot/${siteId}/run-pipeline`);
export const autopilotGetHistory = (siteId, page = 1) =>
  api.get(`/autopilot/${siteId}/history`, { params: { page, per_page: 10 } });
export const autopilotGetJobs = (siteId) => api.get(`/autopilot/${siteId}/jobs`);
export const getAutopilotTriggers = (siteId) => api.get(`/autopilot/${siteId}/trigger-settings`);
export const saveAutopilotTriggers = (siteId, data) => api.post(`/autopilot/${siteId}/trigger-settings`, data);
export const getPipelineLogs = (siteId, limit = 20) => api.get(`/autopilot/${siteId}/pipeline-logs`, { params: { limit } });
export const getPipelineStats = (siteId) => api.get(`/autopilot/${siteId}/pipeline-stats`);

// ── Content generation (every write returns `{changeset}`) ───────────────
export const generateAutoBlogs = (siteId, data) => api.post(`/auto-blog-generation/${siteId}/generate`, data);
export const generateProgrammaticPages = (siteId, data) => api.post(`/programmatic/${siteId}/generate`, data);
export const listProgrammaticPages = (siteId) => api.get(`/programmatic/${siteId}`);
/** → `{changeset}` */
export const pushProgrammaticPages = (siteId, data) => api.post(`/programmatic/${siteId}/push`, data);
export const deleteProgrammaticPage = (siteId, pageId) => api.delete(`/programmatic/${siteId}/${pageId}`);
export const analyzeAIContent = (siteId, data) => api.post(`/ai-content-detector/${siteId}/analyze`, data);
export const bulkScanAIContent = (siteId, data) => api.post(`/ai-content-detector/${siteId}/bulk-scan`, data);
export const fullScoreAIContent = (siteId, data) => api.post(`/ai-content-detector/${siteId}/full-score`, data);
export const humanizeContent = (siteId, data) => api.post(`/ai-content-detector/${siteId}/humanize`, data);
export const sectionAIDetection = (siteId, data) => api.post(`/ai-content-detector/${siteId}/section-score`, data);
export const helpfulContentScore = (siteId, data) => api.post(`/ai-content-detector/${siteId}/helpful-content-score`, data);
export const factCheckContent = (siteId, data) => api.post(`/ai-content-detector/${siteId}/fact-check`, data);
export const compareCompetitorContent = (siteId, data) => api.post(`/ai-content-detector/${siteId}/compare-competitor`, data);

// ── Keywords ─────────────────────────────────────────────────────────────
export const getTrackedKeywordsV2 = (siteId) => api.get(`/keywords/${siteId}`);
export const addTrackedKeyword = (siteId, data) => api.post(`/keywords/${siteId}`, data);
export const deleteTrackedKeyword = (siteId, kwId) => api.delete(`/keywords/${siteId}/${kwId}`);
export const suggestKeywords = (siteId, data) => api.post(`/keywords/${siteId}/suggest`, data);
export const refreshKeywordRankings = (siteId) => api.post(`/keywords/${siteId}/refresh`);
export const categorizeKeywords = (siteId, data) => api.post(`/keywords/${siteId}/categorize`, data);
export const getKeywordsByIntent = (siteId) => api.get(`/keywords/${siteId}/by-intent`);
export const detectCannibalization = (siteId) => api.get(`/keywords/${siteId}/cannibalization`);
export const getKeywordROI = (siteId) => api.get(`/keywords/${siteId}/roi`);
export const getKeywordTrends = (siteId, data) => api.post(`/keywords/${siteId}/trends`, data);
export const getKeywordMetrics = (siteId, data) => api.post(`/keywords/${siteId}/metrics`, data);
export const getKeywordIdeas = (siteId, data) => api.post(`/keywords/${siteId}/ideas`, data);
export const getSERPAnalysis = (siteId, data) => api.post(`/keywords/${siteId}/serp`, data);
export const getCompetitorGap = (siteId, data) => api.post(`/keywords/${siteId}/competitor-gap`, data);
export const researchKeyword = (siteId, data) => api.post(`/keyword-research/${siteId}/analyze`, data);
export const analyzeKeywordDensity = (siteId, data) => api.post(`/keyword-analysis/${siteId}/analyze`, data);
export const generateKeywordClusters = (siteId, data) => api.post(`/keyword-clusters/${siteId}/generate`, data);
export const listKeywordClusters = (siteId) => api.get(`/keyword-clusters/${siteId}`);
export const deleteKeywordCluster = (siteId, clusterId) => api.delete(`/keyword-clusters/${siteId}/${clusterId}`);
export const testDataForSEO = (login, password) => api.get(`/integrations/dataforseo/test`, { params: { login, password } });

// ── Links ────────────────────────────────────────────────────────────────
export const generateOutreachAngles = (siteId) => api.post(`/links/outreach/generate/${siteId}`);
export const getAnchorDistribution = (siteId) => api.get(`/link-builder/${siteId}/anchor-distribution`);
export const getLiveBacklinks = (siteId, data) => api.post(`/link-builder/${siteId}/backlinks-live`, data);

// ── Reports & local ──────────────────────────────────────────────────────
export const listReports = (siteId) => api.get(`/reports/${siteId}`);
export const generateReport = (siteId, data) => api.post(`/reports/${siteId}/generate`, data, { responseType: "blob" });
export const generateSiteReport = (siteId) =>
  api.post(`/reports/${siteId}/generate`, { template: "site_health" }, { responseType: "blob" });
export const scheduleReport = (siteId, data) => api.post(`/reports/${siteId}/schedule`, data);
export const getLocalTracking = (siteId) => api.get(`/local/${siteId}`);
export const addLocalKeyword = (siteId, data) => api.post(`/local/track/${siteId}`, data);
export const deleteLocalKeyword = (siteId, kwId) => api.delete(`/local/${siteId}/${kwId}`);
export const getLocalRecommendations = (siteId) => api.post(`/local/recommendations/${siteId}`);

// ── Social & newsletter ──────────────────────────────────────────────────
export const getSocialAccounts = (siteId) => api.get(`/social/${siteId}/accounts`);
export const connectSocialAccount = (siteId, data) => api.post(`/social/${siteId}/connect`, data);
export const disconnectSocialAccount = (siteId, accountId) => api.delete(`/social/${siteId}/accounts/${accountId}`);
export const generateSocialPost = (siteId, data) => api.post(`/social/${siteId}/generate-post`, data);
export const publishSocialPost = (siteId, postId, data) => api.post(`/social/${siteId}/publish/${postId}`, data);
export const getSocialQueue = (siteId) => api.get(`/social/${siteId}/queue`);
export const getNewsletterLists = (siteId) => api.get(`/newsletter/${siteId}/lists`);
export const generateNewsletter = (siteId, data) => api.post(`/newsletter/${siteId}/generate`, data);
export const sendNewsletter = (siteId, data) => api.post(`/newsletter/${siteId}/send`, data);
export const getNewsletterHistory = (siteId) => api.get(`/newsletter/${siteId}/history`);

// ── Off-page SEO ─────────────────────────────────────────────────────────
export const findBacklinkOpportunities = (siteId, data) => api.post(`/backlink-outreach/${siteId}/find-opportunities`, data);
export const listBacklinkOpportunities = (siteId, params = {}) => api.get(`/backlink-outreach/${siteId}/opportunities`, { params });
export const listBacklinkSearches = (siteId) => api.get(`/backlink-outreach/${siteId}/searches`);
export const generateOutreachEmail = (siteId, oppId) => api.post(`/backlink-outreach/${siteId}/generate-email/${oppId}`);
export const updateBacklinkStatus = (siteId, oppId, data) => api.patch(`/backlink-outreach/${siteId}/opportunity/${oppId}/status`, data);
export const generateDisavow = (siteId) => api.post(`/backlink-outreach/${siteId}/generate-disavow`);
export const getDisavow = (siteId) => api.get(`/backlink-outreach/${siteId}/disavow`);
export const exportBacklinkOutreachExcel = (siteId) =>
  api.post(`/backlink-outreach/${siteId}/export-excel`, {}, { responseType: "blob" });
export const getDirectories = (siteId) => api.get(`/directories/${siteId}`);
export const prepareDirectoryListing = (siteId, dirId) => api.post(`/directories/${siteId}/prepare/${dirId}`);
export const updateDirectorySubmission = (siteId, dirId, data) => api.patch(`/directories/${siteId}/submission/${dirId}`, data);
export const verifyDirectoryListing = (siteId, dirId) => api.post(`/directories/${siteId}/verify/${dirId}`);
export const verifyAllDirectoryListings = (siteId) => api.post(`/directories/${siteId}/verify-all`);
export const findGuestPostSites = (siteId, data) => api.post(`/guest-posts/${siteId}/find-sites`, data);
export const listGuestPostProspects = (siteId) => api.get(`/guest-posts/${siteId}/prospects`);
export const generateGuestPitch = (siteId, prospectId) => api.post(`/guest-posts/${siteId}/generate-pitch/${prospectId}`);
export const generateGuestArticle = (siteId, prospectId) => api.post(`/guest-posts/${siteId}/generate-article/${prospectId}`);
export const updateGuestProspect = (siteId, prospectId, data) => api.patch(`/guest-posts/${siteId}/prospect/${prospectId}`, data);
export const checkGuestLiveLinks = (siteId) => api.post(`/guest-posts/${siteId}/check-live-links`);
export const auditLocalCitations = (siteId, data) => api.post(`/local-citations/${siteId}/audit`, data);
export const listLocalCitations = (siteId) => api.get(`/local-citations/${siteId}/citations`);
export const generateCitationDescription = (siteId, dir) => api.post(`/local-citations/${siteId}/generate-description/${dir}`);
export const getCitationGaps = (siteId) => api.get(`/local-citations/${siteId}/gaps`);
export const updateCanonicalNAP = (siteId, data) => api.post(`/local-citations/${siteId}/update-nap`, data);
export const scanInbound404s = (siteId) => api.post(`/link-reclamation/${siteId}/scan-inbound-404s`);
export const getLinkReclamationReport = (siteId) => api.get(`/link-reclamation/${siteId}/report`);
export const generateReclaimEmail = (siteId, linkId) => api.post(`/link-reclamation/${siteId}/generate-reclaim-email/${linkId}`);
/** → `{changeset}` (redirect.upsert) */
export const bulkCreateLinkRedirects = (siteId, data) => api.post(`/link-reclamation/${siteId}/bulk-redirect`, data);
export const getOffPageScore = (siteId) => api.get(`/offpage-autopilot/${siteId}/score`);
export const getOffPagePriorityActions = (siteId) => api.get(`/offpage-autopilot/${siteId}/priority-actions`);
export const generateOffPageStrategy = (siteId) => api.post(`/offpage-autopilot/${siteId}/generate-strategy`);
export const getOffPageDigest = (siteId) => api.get(`/offpage-autopilot/${siteId}/digest`);
export const setOutreachRecipient = (collection, itemId, email) =>
  api.patch(`/outreach/${collection}/${itemId}/recipient`, { recipient_email: email });
export const approveOutreach = (collection, itemId) => api.post(`/outreach/${collection}/${itemId}/approve`);
export const rejectOutreach = (collection, itemId) => api.post(`/outreach/${collection}/${itemId}/reject`);
export const sendOutreach = (collection, itemId) => api.post(`/outreach/${collection}/${itemId}/send`);

// ── Portfolio & company profile ──────────────────────────────────────────
export const getPortfolioIntelligence = () => api.get(`/platform/portfolio`);
export const getCompanyProfile = (siteId) => api.get(`/company-profile/${siteId}`);
export const updateCompanyProfile = (siteId, data) => api.post(`/company-profile/${siteId}`, data);
export const deleteCompanyProfile = (siteId) => api.delete(`/company-profile/${siteId}`);

export default api;
