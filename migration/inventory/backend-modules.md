# Backend module inventory (pre-migration, tag `pre-nextjs-migration`)

Classification: **wp_only** = exists only to drive WordPress · **mixed** = generic feature with WP calls · **generic** = no WP coupling.
Per-route data: [`routes.json`](routes.json). Per-line references: [`legacy-references.json`](legacy-references.json).

## Registration and infrastructure

| Module | Class | Notes | Action |
|---|---|---|---|
| server.py | generic (copy) | `FastAPI(title="AI WordPress Management Platform")`; routers register by import side effect onto the shared `api_router` (core/router.py); `lifespan()` starts the scheduler, restores jobs, registers daily crawl, autopilot schedules, rank-drop 02:00 and new-keyword 03:00 watchers, ads check every 6h | scrub copy; drop imports of deleted routers |
| main.py | generic | `print("Hello")` stub, not the entry point | delete |
| core/crypto.py | generic | Fernet from `ENCRYPTION_KEY`; **no-op when unset**; `decrypt_field` returns input on failure (masks wrong key). Site secrets are encrypted at call sites (sites.py), not centrally. `woo_consumer_key/secret` never encrypted | keep; make key mandatory and failure loud in phase 3 |
| core/scheduled_jobs.py | mixed | `run_scheduled_publish` → WP `PUT posts/{id}` (only site write). Freshness/SEO-health jobs are DB-only | **frozen in phase 1**; port to change sets |
| core/agent_tools.py | mixed | `create_post`/`update_post` tools call WP REST; WP wording in tool descriptions | port to bridge change sets |
| core/security.py, config.py | generic | App JWT auth (python-jose), roles `viewer/editor/admin` via `require_user/require_editor/require_admin` | keep; add `deployer` role in phase 3 |
| core/activity, ai, content_analysis, db, explain, http_headers, json_utils, prompts, rate_limit, router, scheduler, seo_impact, tasks | generic | | keep |

## Providers

| Module | Class | Notes | Action |
|---|---|---|---|
| providers/wordpress.py | wp_only | `get_wp_credentials` chokepoint, `wp_api_request` (`/wp-json/wp/v2`), `wp_upload_image`, `wp_xmlrpc_write/edit/delete` | delete after all callers are gone |
| providers/nextjs.py | generic | prototype bridge client; `get_bridge_credentials` refuses WP sites | replace with `providers/bridge_client.py` (phase 3) |
| providers/content.py | generic | `get_site_any`, `get_platform` (defaults `"wordpress"`), `nextjs_create/update/delete_post`, `wp_id` naming | fold into bridge client |
| providers/seo_audit.py, onpage.py | generic | `platform` default `"wordpress"` in one report | keep; scrub |
| citations, dataforseo, email, google_analytics, google_cse, hunter, semrush, signalhire | generic | | keep |

## Models

- `models/legacy.py` — `WordPressSite`, `WordPressSiteCreate`, `WordPressSiteResponse` with `platform="wordpress"`, `username`, `app_password`, `auth_type`, `jwt_token`, `wp_password`, `bridge_url`, `bridge_token`. Also WP-shaped: `NavigationMenu.wp_menu_id`, `BulkTaxonomyUpdate`, `BulkMetaUpdate`, `PluginAuditResult`, `PageCreate`/`PostCreate`, `AICommand`. → replace with `ManagedSite`/`SiteConnection`/… (phase 3).
- `models/discovery.py` — generic (`platform` = social platform).
- `routers/sites.py::UpdateCredentialsRequest` — WP credentials model.

## Routers (384 routes)

| Router | Class | Routes | WP-dependent routes / notes | Action |
|---|---|---|---|---|
| wp_admin | wp_only | 12 | all (`/wp-users/*`, `/plugins-themes/*`) | delete |
| media_comments | wp_only | 14 | all (`/media/*`, `/comments/*`) | delete (asset adapter replaces media) |
| forms_woo | wp_only | 11 | all (`/forms/*`, `/woo/*`) | delete |
| plugin_downloads | wp_only | 2 | PHP plugin ZIPs | delete |
| live_editor | wp_only* | 4 | 3 WP post routes; `/editor/ai-assist` generic | delete WP routes; keep ai-assist |
| backup_redirects | wp_only* | 10 | backups create/restore, redirect create/ai-suggest | delete backups; port redirects |
| sites | mixed (core) | 8 | JWT plugin discovery, credential update, test-connection, test-write, WP sync (dead: `/sync` decorates `_sync_bridge_site`) | replace (phase 3) |
| content_crud | mixed | 8 | WP page CRUD; posts branch on platform | port posts; delete WP pages |
| autopilot | mixed | 15 | crawl fix (Yoast meta), publish, interlink; publish/interlink bypass the platform guard | **cron frozen in phase 1**; port |
| monitoring_triggers | mixed | 3 | nightly watchers queue autopilot runs (which publish); unused WP import | **frozen in phase 1**; keep |
| auto_seo | mixed | 6 | apply-meta/og/schema/bulk via Yoast + XML-RPC | port to metadata change sets |
| auto_blog_generation | mixed | 1 | WP publish, media upload, taxonomies | port |
| blog_generation | mixed | 2 | generate (WP media), translate | port |
| admin_migration | mixed | 18 | migrate-encrypt, plugin audit, image alt (WP media), readability, guard-only calls | split |
| content_quality | mixed | 6 | duplicate fix, internal-link apply (XML-RPC) | port the two applies |
| bulk_links | mixed | 4 | bulk publish | port |
| calendar_competitor | mixed | 4 | calendar list/schedule | port |
| content_seo_analytics | mixed | 7 | anchor distribution, social signals, title tests (conclude already broken: bad kwarg) | port |
| full_page_optimizer | mixed | 1 | reads page from WP | read live URL / bridge |
| image_seo_extra | mixed | 3 | EXIF clean, WebP convert (both already broken: bad kwargs), image sitemap | delete or port |
| keyword_intelligence | mixed | 5 | cannibalization | port |
| keyword_link_builder | mixed | 7 | internal link insert | port |
| meta_pagespeed | mixed | 5 | bulk meta, taxonomies | port meta; delete taxonomies |
| misc_global | mixed | 15 | image-seo bulk alt/audit, global search | port |
| nav_refresh | mixed | 6 | WP menu sync | delete nav; keep content-refresh |
| newsletter_health | mixed | 10 | newsletter post source, `wp-site-health` checks | port / replace |
| opportunities | mixed | 27 | 1 bulk-redirect route | port |
| programmatic_local | mixed | 7 | push pages | port |
| seo_management | mixed | 5 | bulk-audit WP path (already dead: bad kwarg) | remove block |
| seo_technical_utils | mixed | 14 | schema apply, canonical get/put/bulk, robots put, mobile | port |
| testing_social | mixed | 16 | A/B title writes, social from WP post | port |
| ai_agent | mixed | 7 | agent turn tools, AI command prompt | port |
| core_routes | generic (copy) | 13 | root message; `/jobs` schedules WP publish | scrub; frozen |
| onpage_seo | generic | 16 | `platform=="wordpress"` refusals | scrub |
| nextjs_content | generic | 14 | prototype bridge routes | replace (phase 3/4) |
| admin_misc, platform_intelligence | generic | 5, 1 | projections exclude `app_password` | scrub |
| ads, ai_content_detector, company_profile, directories, indexing_revenue, keywords_intel, media_plan, onboarding_visibility, outreach_gate, reports_local | generic | — | | keep |

## Existing defects found during inventory (not fixed; they die with the WP code)

1. `routers/sites.py` — `@api_router.post("/sites/{site_id}/sync")` decorates `_sync_bridge_site`; the WP `sync_site` below it is unreachable.
2. `routers/image_seo_extra.py:63,183` — pass `extra_headers=`/`data=` to `wp_api_request`, which accepts neither → TypeError.
3. `routers/content_seo_analytics.py` conclude — passes `json_data=` → TypeError.
4. `routers/seo_management.py` bulk-audit — passes `params=` → TypeError, swallowed; WP path never runs.
5. `routers/autopilot.py` publish/interlink read `db.sites` directly and decrypt only `app_password`, bypassing the platform guard.
