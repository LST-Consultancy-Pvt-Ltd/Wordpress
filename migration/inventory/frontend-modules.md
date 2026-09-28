# Frontend module inventory (pre-migration, tag `pre-nextjs-migration`)

React 19 / CRACO SPA. API client `src/lib/api.js` (base `REACT_APP_BACKEND_URL` + `/api`).

## Cross-cutting

- **Auth storage:** `localStorage.wp_token` / `wp_user` (the app's own JWT, misleadingly named). Written: Login.jsx:34-35, Register.jsx:37-38. Read: App.js:68 (AuthGuard), lib/api.js:17, MediaLibrary.jsx:140, Autopilot.jsx:165 (token in EventSource query string), Layout.jsx:241, Settings.jsx:65. Removed: api.js:34-35, Layout.jsx:246-247.
- **Unauthenticated/bypassing calls:** SSEProgressDrawer.jsx (EventSource `/api/stream`, fetch `/api/tasks` with no auth header), AICommand.jsx EventSource, Autopilot.jsx EventSource (token in URL — leaks into logs), MediaLibrary.jsx raw fetch upload.
- **Branding "WP Autopilot":** public/index.html:7,11; Layout.jsx:260-261,428; Login.jsx:59-60; Register.jsx:39,62-63; LandingPage.jsx:58,157; ReportBuilder.jsx:108; SEO.jsx plugin dialog (2548-2596).
- **Navigation:** Layout.jsx `navGroups` has a "WordPress" group (Media Library, Comments, Users, Plugins & Themes, Forms, Navigation, Backups, Redirects, WooCommerce). Test IDs derive from labels (`nav-{label}`).
- **Existing defect:** Layout.jsx:445 uses undeclared `location` (falls back to `window.location`).

## Per-page classification

### wp_only → delete
WPUsers, PluginsThemes, WooCommerce, Forms, Comments, MediaLibrary, Navigation, Backups (WP backups), Pages (WP page CRUD).
Posts.jsx is WP-shaped but its AI writing features are worth rebuilding on the content-adapter API.

### mixed → rebuild or scrub

| Page | WP coupling | Action |
|---|---|---|
| Sites | platform picker, WP credential forms (App Password / JWT), test/sync/credential dialogs | rebuild as connection wizard |
| SEO | Yoast/RankMath instructions, `wpAdminUrl`, "Apply to WordPress", plugin ZIP dialog | fold into On-Page SEO / change sets |
| Dashboard | plugin audit card, comments/backup stats, WP copy | scrub |
| CanonicalManager, SchemaMarkup | `wp_id` pickers, wp-admin links, apply-to-WP | rebuild on metadata change sets (by route) |
| SitemapRobots, Redirects, DuplicateContent, ContentRefresh, CrawlReport, BrokenLinks | wp-admin links / plugin instructions via ManualApplySheet | scrub; route writes through change sets |
| Calendar, AutoBlogGeneration, ProgrammaticSEO, Autopilot, AICommand | publish/push to WP | rebuild on change sets |
| LiveEditor, OnPageSEO, PagesEditor, SnippetsPanel | platform branches (`=== "nextjs"`) | make Next.js unconditional |
| SiteHealth | WP/PHP version checks | scrub |
| Settings | `wp_user`, WooCommerce note, "Scheduled Publish" WP post ID | scrub |
| ManualApplySheet | `wpAdminUrl` prop, "Open in WordPress" | rename to `externalUrl` |
| LandingPage, Login, Register, ReportBuilder | branding / session keys | scrub |
| Newsletter, ABTesting, KeywordTracking, AIContentDetector, LinkBuilder, LinkReclamation, MobileChecker | UI generic; backend endpoint WP-bound | keep UI; fix backend |

### generic → keep
Activity, CompanyProfile, PlatformPortfolio, OutreachApprovals, BacklinkOutreach, GuestPosting, LocalCitations, OffPageAutopilot, IndexingTracker, KeywordAnalysis, KeywordClusters, KeywordResearch, LocalTracking, Reports, SiteSpeed, SocialMedia, AdsManager, MediaPlanAutomation, ImpactBadge, SSEProgressDrawer (needs auth fix), onpage/CategoryPanel, onpage/OverviewPanel, onpage/shared, hooks, `components/ui/*`.

## api.js exports removable with the wp_only pages
`/wp-users`, `/plugins-themes`, `/woo`, `/forms`, `/comments`, `/media`, `/backups`, `/navigation`, `/plugins`, `/taxonomies`, `/editor` (except ai-assist), bulk meta/taxonomy, `downloadMetaFixerPlugin`, `downloadBridgePlugin`; `updateSiteCredentials`, `syncSite`, `testSiteConnection` once Sites is rebuilt.
