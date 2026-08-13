# server.py refactor — Phase 0 complete

Context: this was the prerequisite refactor described in the "AI Authority &
Organic Growth Engine" implementation brief, §3 ("PREREQUISITE REFACTOR — SPLIT
server.py"). Goal: zero behavior change, one shared `@api_router` route table,
verified byte-identical before/after by a route-parity check run after every
single extraction step.

## Result

`server.py` went from **16,701 lines / one file** to **339 lines** — just
`app = FastAPI(...)`, `lifespan()` (scheduler startup/shutdown + cron job
registration), CORS middleware, the `uvicorn.run(...)` entrypoint, and the
import wiring that pulls every router module in. Everything else moved into:

- **`core/`** (15 files) — shared primitives nearly every route depends on
  (db, security, crypto, activity log, AI client, task/SSE queues, JSON
  repair, content analysis, SEO-impact estimator, prompts, the shared
  `api_router`/`scheduler` singletons, scheduled-jobs, agent tools).
- **`providers/`** (3 files) — external API clients: `dataforseo.py`,
  `google_analytics.py` (GA4/GSC), `wordpress.py` (WP REST + XML-RPC — the
  single highest-leverage extraction, used at 100+ call sites).
- **`models/legacy.py`** — all 43 shared Pydantic models moved verbatim,
  imported explicitly (not `*`) wherever needed.
- **`routers/`** (40 files) — every route, grouped by feature area. Full list
  below.

**Route parity: 381/381 routes match the pre-refactor baseline exactly**
(377 `@api_router` routes + FastAPI's 4 built-in docs/OpenAPI routes),
verified by `tests/test_route_parity.py` after every one of the ~45
extraction steps in this refactor, with zero regressions surviving past the
immediately-following verification.

## §1 EVIDENCE RULE fix — status

**`routers/opportunities.py`** originally asked an LLM to *fabricate*
real-world entities (backlink domains, DA scores, brand mentions, NAP
listing checks, influencer/podcast/community contacts) instead of sourcing
them from a real provider — see git history for the verbatim-moved version
if you need to compare. That's now fixed for every endpoint, using two real
providers plus a new honesty convention for when neither is configured:

- **`providers/google_cse.py`** (new) — real Google Custom Search results.
  Credentials come from `Settings.google_search_api_key` /
  `google_search_cx` (same fields `routers/calendar_competitor.py` already
  used) or `GOOGLE_SEARCH_API_KEY` / `GOOGLE_SEARCH_CX` env vars.
- **`providers/dataforseo.py`** (already existed) — real backlink data via
  `/v3/backlinks/backlinks/live`, same endpoint/payload shape already
  proven in `routers/keywords_intel.py::get_live_backlinks`.
- **Every discovery endpoint now follows a real-first, labelled-estimate-
  fallback pattern** (the same `_data_meta(source, is_estimated)` convention
  `keywords_intel.py` already used elsewhere in this codebase): try the real
  provider; if it's not configured or returns nothing, fall back to an LLM
  guess that is explicitly reworded ("No web-search provider is configured,
  so ESTIMATE...") and stored with `is_estimated: True` — never silently
  presented as fact. Every stored document and every response now carries
  `data_source` / `is_estimated`.

| Endpoint | Real path | What's still estimated (no provider) |
|---|---|---|
| `find_backlink_opportunities` | DataForSEO: real backlinks-of-competitor lookup, real `domain_from_rank` as `estimated_da` | Falls back to AI estimate only if DataForSEO isn't configured |
| `generate_disavow` | Only disavows domains marked `is_estimated: False` | Returns **409** if the only low-authority domains found are AI-estimated — refuses to disavow unverified domains |
| `find_guest_post_sites` | Google CSE: real "write for us" / guidelines search results | `domain_authority`, `contact_email`, `audience_size_estimate` (no real signal available) — left `null`, not guessed |
| `scan_brand_mentions` | Google CSE: real search results for the brand name; a *second*, narrower AI call classifies sentiment/link-status from the real snippet text (analyzing real content ≠ inventing it) | `estimated_da`, `published_date` — left `null` |
| `audit_local_citations` | Google CSE: real `site:<directory>` presence check per directory; if a listing is found, fetches the real page and checks whether the phone/address text actually appears | **No dedicated NAP/citations API is configured** (BrightLocal/Whitespark/Moz Local etc.) — `nap_consistent` is `None` (unknown) when the page can't be parsed, and the whole route runs as an AI estimate if CSE isn't configured either. Treat as needing manual verification. |
| `find_influencers` / `find_communities` / `find_podcasts` | Google CSE: real search results, platform inferred from the real URL | `estimated_monthly_reach`, `engagement_rate_estimate`, `relevance_score`, `member_count_estimate`, etc. — no paid influencer/community/podcast database is configured, so these are left `null` rather than invented |
| `scan_inbound_404s` (link reclamation) | DataForSEO real backlinks-to-our-own-domain, **plus a real HTTP request to our own site** confirming the linked page actually 404s | `suggested_redirect_url` defaults to the homepage (not a fabricated "best match") with a note to review manually |
| Digital PR (`generate_press_release`, pitch, HARO response) | N/A — was never a violation | These generate the user's *own* PR copy; no external entity is invented |
| Off-Page Autopilot Dashboard (score/priority/strategy/digest) | N/A — was never a violation | Aggregates/analyzes counts from the (now largely real) data above |

**What you need to do to get real data instead of estimates:** add DataForSEO
credentials (already had a Settings UI hook) and a Google Custom Search API
key + Search Engine ID (Settings → `google_search_api_key` /
`google_search_cx`) via the Settings endpoint. Without either, every route
above still works — it just returns clearly-labelled estimates instead of
erroring out.

**Still open, not part of this pass:** a dedicated local-citations/NAP API
(BrightLocal, Whitespark, Moz Local, or similar) — `audit_local_citations`
cannot be made fully real without one. Everything else originally flagged in
this section is fixed.

## Full `routers/` map

| File | Contents |
|---|---|
| `core_routes.py` | Root, Auth, Settings, SSE Streaming, Scheduled Jobs |
| `sites.py` | Sites Management |
| `ai_agent.py` | AI Agent (multi-turn/SSE + legacy single-turn) |
| `content_crud.py` | Pages + Posts Management |
| `blog_generation.py` | AI Blog Generation (original feature, pre-existing) |
| `seo_management.py` | SEO Management (stored metrics, GSC/GA4 refresh, audits) |
| `nav_refresh.py` | Navigation Management + Content Refresh |
| `bulk_links.py` | Bulk Publish/Unpublish + Broken Link Detection |
| `content_quality.py` | Duplicate Content Detection + Internal Link Suggestions |
| `calendar_competitor.py` | Content Calendar + Competitor Analysis |
| `meta_pagespeed.py` | Bulk Meta + Taxonomy + PageSpeed Insights |
| `admin_misc.py` | Activity Logs + Dashboard Stats + User Management |
| `admin_migration.py` | Admin Migration, Writing Style Profiles, Content Brief Generator, Plugin Health Audit, Image Alt Text Bulk Gen, Rank Tracker, Readability |
| `onboarding_visibility.py` | Smart Onboarding + AI Search Visibility Engine |
| `keyword_link_builder.py` | Keyword Tracking + Link Builder |
| `reports_local.py` | Standard Reports + Local Results Tracking |
| `live_editor.py` | Live Editor |
| `autopilot.py` | Daily Crawl + Recommendations + the 5-stage Autopilot Engine |
| `auto_seo.py` | Auto-SEO meta/OG/schema apply + AI scan |
| `media_comments.py` | Media Library Manager + Comments Manager |
| `wp_admin.py` | User & Role Manager + Plugin & Theme Manager |
| `forms_woo.py` | Forms & Leads Manager + WooCommerce Manager |
| `backup_redirects.py` | Backup & Restore Manager + Redirect Manager |
| `testing_social.py` | A/B Testing Engine + Social Media Auto-Poster |
| `newsletter_health.py` | Email Newsletter Builder + Site Health & Uptime Monitor |
| `misc_global.py` | Global Notifications, Extended Uptime, Extended Image SEO, Autopilot Pipeline Logs, Global Search |
| `programmatic_local.py` | Programmatic Page Engine, Keyword Cluster Engine, GBP Optimizer, Review Growth System |
| `indexing_revenue.py` | Indexing Tracker + Revenue Dashboard |
| `keywords_intel.py` | DataForSEO keyword metrics/ideas/SERP/rank-tracking/backlinks/competitor-gap |
| `ads.py` | Meta Ads + Google Ads connect/campaigns/generate/create/pause/resume |
| `media_plan.py` | Media Plan Automation (parse/activate/execute/pause/resume, platform connect) |
| **`opportunities.py`** | MODULE 1–10 off-page/authority outreach — real DataForSEO/Google CSE data with labelled-estimate fallback, see "§1 EVIDENCE RULE fix" above |
| `plugin_downloads.py` | SEO Meta Fields REST API Fixer + WP Manager Bridge plugin ZIP downloads |
| `seo_technical_utils.py` | Schema Markup Generator, Sitemap & Robots.txt Manager, Canonical Tag Manager, Mobile Responsiveness Checker, Keyword Intent Categorisation |
| `full_page_optimizer.py` | Full Page SEO Optimizer |
| `ai_content_detector.py` | AI Content Detector (Module 10 full scoring suite), Section-by-Section AI Detection, Google Helpful Content Score, Real Fact-Check API |
| `keyword_intelligence.py` | Keyword Research, Keyword Analysis, Keyword Cannibalization Detector, ROI/Revenue per Keyword, Google Trends/Seasonal Queries |
| `auto_blog_generation.py` | Auto Blog Generation (the "MODULE: Auto Blog Generation" mega-feature, distinct from `blog_generation.py`) |
| `image_seo_extra.py` | EXIF Metadata Cleaning, Image Sitemap Auto-Generation, WebP Bulk Conversion |
| `monitoring_triggers.py` | Event-Based Autopilot Triggers, Multi-Region Uptime Checks |
| `content_seo_analytics.py` | Predictive Ranking Model, Competitor Content Comparison, Anchor Text Distribution, Social Signal SEO Mapping, A/B Title SEO Testing |

Four files combine content from two-or-more non-adjacent locations in the
original monolith (route registration order never mattered — every module
registers onto the same shared `api_router` singleton): `ai_content_detector.py`,
`keyword_intelligence.py`, `content_seo_analytics.py` each pull from 2–3
separate original line ranges; `monitoring_triggers.py`'s two functions are
also imported back into `server.py`'s `lifespan()` for cron scheduling.

## Verification pattern (reuse for any future extraction from this codebase)

1. **Route parity**: `cd backend && .venv/bin/python -m pytest
   tests/test_route_parity.py -v` — diffs live `app.routes` against
   `tests/route_baseline.json` (frozen pre-refactor snapshot). This is the
   merge blocker; it caught zero regressions across ~45 extraction steps
   because it ran after every single one.
2. **Static analysis**: `.venv/bin/python -m pyflakes server.py routers/*.py
   core/*.py providers/*.py models/*.py`, filtering `imported but unused`
   (mostly intentional `# noqa: E402,F401` side-effect route-registration
   imports, plus a few pre-existing dead locals verified against the
   original source) and `unable to detect undefined names`. **Not
   optional** — route-parity only checks that routes are *registered*, not
   that their bodies still resolve every name. This caught several real
   bugs during this refactor (missing re-imports of `_get_dfs_credentials`/
   `_dfs_auth_header`, `_SENSITIVE_SETTINGS_FIELDS`, a missing `import json`)
   that would have been silent `NameError`s at request time.
3. **pytest catches what pyflakes can't**: a wrong cross-module import
   (`from models.legacy import ActivityLog` when `ActivityLog` actually
   lives in `core.activity`) passed pyflakes (it doesn't verify a name is
   actually exported by the module you import it from) but failed pytest
   with an `ImportError` when `server.app` was actually imported. Always run
   both.

Local venv: Python **3.12** (`brew install python@3.12` if the system python
is older — several deps require 3.12), a `backend/.env` with dummy
`MONGO_URL`/`DB_NAME`/`JWT_SECRET_KEY`/a generated Fernet `ENCRYPTION_KEY`
(never a real one — Motor's Mongo client is lazy, so no live database is
needed just to import `server.py` and introspect its route table).

### The extraction pattern used throughout

1. Read the exact target block(s). Grep it for calls to anything not already
   in `core`/`providers`/`models` — every hidden dependency needs its own
   extraction first.
2. Check whether anything *outside* the block references a name defined
   *inside* it (e.g. `lifespan()` calling a trigger-check function) — add a
   matching cross-reference import at the top of `server.py`, not just
   inside the new router file.
3. Move the block verbatim into `routers/<name>.py`: same code, same
   prompts, same logic — only the import statements change. Never
   "simplify while moving," even when a simplification looks behaviorally
   equivalent (a Pydantic model constructor has validation side effects a
   plain dict/list literal doesn't replicate).
4. Replace the removed block in `server.py` with a short comment pointer,
   add `import routers.<name>  # noqa: E402,F401` before
   `app.include_router(api_router)`.
5. Run **both** verification steps (§ above). Don't skip pyflakes.

For a task at this scale, the read+write step for independent, non-conflicting
router files was parallelized across subagents (each given the exact source
line range(s), the current core/providers/models import map, and the same
"pure move" discipline) — the removal-from-server.py, cross-reference wiring,
and verification stayed sequential in one place, run after each merge.

## Two things to reconcile before an app-factory phase (still open)

1. **Two `main.py`s.** `backend/main.py` is currently an unrelated `uv init`
   hello-world stub (not used by the Dockerfile, which runs `uvicorn
   server:app` directly). If a future phase wants a `main.py` app-factory
   entrypoint, repurpose this stub deliberately or delete it first — don't
   let the two meanings collide silently.
2. **`app` is still defined directly in `server.py`.** `api_router` and
   `scheduler` are shared singletons in `core/`, but `app = FastAPI(...)`
   itself and `lifespan()` are still in `server.py`. Given `server.py` is
   now only 339 lines, this is arguably fine as the permanent home for both
   — moving them to `main.py` is optional polish, not required cleanup.

## Also created (unrelated to server.py itself, gitignored)

- `backend/.env` — dummy local values (fake Mongo URL, a generated but
  unused Fernet key, a throwaway JWT secret) so `server.py` can be imported
  and its route table introspected without a live Mongo instance or real
  secrets. **Never** point this at a real database. Already covered by
  `backend/.gitignore` (`*.env`).

## Second pass: §9, §12, §13, §15, §16, §18, §7

Beyond §1, this pass also shipped:

- **§9 durable jobs** — `core/tasks.py`'s `create_task_queue`/`push_event`/
  `finish_task` now mirror every status update into `db.task_runs`, in
  addition to the existing in-memory store. `GET /api/tasks/{task_id}`
  (`routers/core_routes.py`) falls back to that durable record via the new
  `get_durable_task_status()` helper, so polling a task survives a process
  restart instead of 404ing. Still in-memory-first (fresher for a live
  stream); Mongo is the fallback, not the primary path.
- **§18 cost control** — `core/ai.py::get_ai_response` now enforces
  `AI_DAILY_BUDGET_USD` (default $20) the same way
  `providers/dataforseo.py::_dfs_check_spend` enforces `DFS_DAILY_LIMIT`: a
  conservative upper-bound estimate gates the call *before* it's made
  (`_ai_spend_precheck`), and the real cost (from actual token usage) is
  recorded after (`_ai_spend_record`) into `db.ai_daily_spend`, regardless of
  whether the caller passes `track_usage=True` — that flag previously did
  nothing globally useful because no caller in the whole codebase ever set
  it. Visible at `GET /api/health`.
- **§13 rate limiting** — `core/rate_limit.py::RateLimitMiddleware`, a
  dependency-free in-memory sliding-window limiter (300 req/min per client
  IP), added to `server.py` **before** `CORSMiddleware` so CORS stays
  outermost and a 429 still carries CORS headers (verified with a
  `TestClient` test during this session — see git history if you need to
  re-run it). `/api/health`, `/api/tasks/*`, and the autopilot SSE stream are
  exempt. In-memory only — not shared across processes if this ever runs
  multiple workers.
- **§15 monitoring** — `GET /api/health` (no auth) pings MongoDB, reports
  APScheduler state, whether DataForSEO/Google CSE are configured, and
  today's AI spend vs budget. Didn't exist at all before this pass.
- **§16 security** — found and fixed two real issues while reviewing:
  `GET /api/settings` had **no auth dependency at all** (any unauthenticated
  HTTP client could read it) and returned `pagespeed_api_key` /
  `google_search_api_key` in full plaintext (every other credential field
  was masked). Both fixed: added `Depends(require_user)`, added masking for
  those two fields, and added `google_search_api_key` to
  `core/crypto._SENSITIVE_SETTINGS_FIELDS` so it's encrypted at rest going
  forward (backward-compatible — `decrypt_field` already tolerates
  pre-migration plaintext).
- **§12 verified company knowledge base** — new `CompanyProfile` /
  `CompanyProfileUpdate` models (`models/legacy.py`) + CRUD in
  `routers/company_profile.py`. `audit_local_citations` (§1-fixed earlier
  this session) now falls back to the verified profile via
  `get_verified_nap()` when `business_name`/`address`/`phone` aren't passed
  directly, instead of requiring them on every call — and 400s with a clear
  message if neither is available.
- **§7 platform intelligence** — `GET /api/platform/portfolio`
  (`routers/platform_intelligence.py`): the first cross-site view in this
  codebase. Rolls up real per-site signals (uptime from `db.site_health`,
  off-page score via the same `offpage_score()` function `opportunities.py`
  already uses, revenue-tracking configured, last activity) and flags which
  sites need attention. Everything else in this app operates one site at a
  time; this is genuinely new, not a refactor of something existing.
- **Frontend** — `frontend/src/pages/Settings.jsx` gained a "Web Search
  Integration" card exposing the `google_search_api_key`/`google_search_cx`
  fields the backend Settings model already had (added when a different
  feature needed them) but the UI never surfaced. While in there, also fixed
  a pre-existing bug: `handleSave`'s payload never included
  `dataforseo_login`/`dataforseo_password`/`google_trends_enabled` even
  though the form fields were fully wired up to edit them — those three
  silently did nothing on Save before this fix.

Every change in both passes was verified with `pyflakes` (zero undefined-
name/import errors) and `pytest tests/` after each step; `tests/
route_baseline.json` was regenerated once, at the end, after confirming via
`pytest -v` that the only diff from the pre-existing baseline was the 5
intentionally-added routes (`/api/health`, `/api/platform/portfolio`, and
the 3 `/api/company-profile/{site_id}` methods) with zero routes lost.

## Third pass: §10, §11, §4, §5, §6, §17, §21, plus frontend

- **§11 outreach sending** — `providers/email.py`: a generic SMTP sender
  (works with Gmail/SendGrid/Mailgun/SES/self-hosted — vendor-neutral by
  design, since no specific provider was chosen). Settings gained
  `smtp_host/port/username/password/from_email/use_tls` (`smtp_username`/
  `smtp_password` encrypted at rest, same as the other credential fields).
- **§10 trust & safety gate** — `routers/outreach_gate.py`: a generic
  approve/reject/send workflow over every collection that stores a drafted
  outreach email (`backlink_outreach`, `guest_posts`, `digital_pr`,
  `influencer_outreach`, `podcast_outreach`, `link_reclamation`,
  `brand_mentions`). Sending requires, in order: (1) a `recipient_email` set
  by a human — nothing here invents one, consistent with the §1 fix; (2) an
  admin approval (`require_admin`), logged via `log_activity`; (3) SMTP
  configured. Every transition is audit-logged. Both `/api/company-profile/*`
  (built in the second pass) and `/api/outreach/*` (this pass) were given
  `require_user`/`require_editor`/`require_admin` from the start — applying
  the lesson from the `GET /api/settings` auth gap found earlier.
- **NAP/citations API decision** — deliberately NOT implemented.
  `providers/citations.py` is an extension point (`check_listing()` raises
  `NotImplementedError` with a checklist) rather than a guess at BrightLocal/
  Whitespark/Moz Local's actual (non-trivial, signed-request) API shape —
  guessing wrong would silently ship broken code that looks like a real fix.
  Needs a vendor choice + their API docs to finish.
- **§4 domain model** — `models/discovery.py`: typed Pydantic models for
  every discovery entity (`BacklinkOpportunity`, `GuestPostProspect`,
  `BrandMention`, `InfluencerProfile`, `PodcastProspect`,
  `CommunityOpportunity`, `ReclaimedLink`), all carrying the
  `data_source`/`is_estimated` provenance pair. Deliberately **not**
  attached as `response_model=` on any route — FastAPI would silently drop
  any field not listed, which is exactly the kind of regression risk not
  worth taking on the just-verified §1 fixes. Documentation/typed-contract
  use only for now (e.g. by agent tools or a future TS client).
- **§6 agents** — confirmed NOT greenfield (a research pass found a real
  multi-turn tool-calling loop already in `routers/ai_agent.py` +
  `core/agent_tools.py`, session-persisted, 5 tools). Extended it with 3
  more: `get_company_profile`, `get_offpage_score`, `get_backlink_opportunities`
  — each manually invoked and confirmed working against the real DB.
- **§17 explainability** — `core/explain.py::with_reason()`: a one-line
  helper, not a framework (a heavyweight system across ~40 already-verified
  routers wasn't worth the risk). Applied it concretely to
  `platform_intelligence.py`'s `needs_attention` flag, which now carries a
  specific `why` ("Last health check found the site offline.") instead of
  just a boolean, surfaced in the Portfolio page.
- **§21 testing** — `tests/test_evidence_rule.py`: 6 new tests, mocking
  DataForSEO/Google CSE/AI calls (no real credentials needed to run them),
  that actually exercise the §1 fix's behavior rather than just checking it
  imports: real-vs-estimate labeling on `find_backlink_opportunities`, the
  `generate_disavow` 409-refusal on unverified domains (and that it excludes
  them from the disavow file even when real domains are present in the same
  batch), and `audit_local_citations`'s company-profile fallback + 400 when
  nothing's available. Uses a single shared event loop across the module
  (`asyncio.new_event_loop()` + `run_until_complete`, not repeated
  `asyncio.run()` calls) — Motor's client binds to the first loop it sees,
  and this project has no `pytest-asyncio` dependency to handle that for you.
- **Frontend** — three new pages wired into `App.js`/`Layout.jsx`'s nav:
  `PlatformPortfolio.jsx`, `CompanyProfile.jsx`, `OutreachApprovals.jsx`
  (the only UI for the new approve/send workflow), plus an SMTP settings
  card. **Also fixed real bugs the §1 backend fix had introduced**: several
  existing pages (`GuestPosting.jsx`, `BrandMentions.jsx`,
  `CommunityEngagement.jsx`, `PodcastOutreach.jsx`) rendered literal `"DA
  ~null"` / `"Host: null"` text once those fields legitimately became `null`
  instead of fabricated numbers — each now conditionally hides the field
  instead. Also fixed two long-standing, unrelated bugs found along the way:
  `Settings.jsx`'s save handler silently dropped
  `dataforseo_login`/`dataforseo_password`/`google_trends_enabled` (fields
  the form could edit but never actually saved), and
  `InfluencerOutreach.jsx`/`CommunityEngagement.jsx` referenced field names
  (`engagement_rate`, `member_count`) that never matched what the backend
  actually returns (`engagement_rate_estimate`, `member_count_estimate`).
  Full `craco build` production build verified clean after every change.

**What's genuinely still open**, in priority order:

1. **§11/§10 decisions** — the infrastructure (SMTP sender, approval gate)
   is built and safe (nothing can send without real credentials, which don't
   exist in this dev environment), but you still need to decide: which SMTP
   provider to actually use, and whether the current approval model (any
   admin approves, separate step from sending) matches what you want.
2. **A NAP/citations API vendor choice** (see above) — needed before
   `audit_local_citations` can be fully real.
3. **§5/§8** — further provider abstraction and deterministic scoring
   beyond what §1 already added.
4. **§19** — deeper frontend work than the 3 new pages + bug fixes above
   (e.g. surfacing `is_estimated` badges throughout the existing 8
   opportunities pages, not just Brand Mentions).
5. §14 (multi-tenancy) and §20 (demo mode) remain low priority per this
   platform's current use case (single internal agency tool, not a
   multi-tenant SaaS).
