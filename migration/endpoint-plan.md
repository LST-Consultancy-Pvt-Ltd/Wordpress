# Endpoint plan (phases 3–6)

Decisions taken with the recommended defaults (user asked to run all phases
without pausing; each can be revisited):

- Bridge install mode: **sidecar agent** is the primary, documented and tested mode; the in-app App Router mode shares the same core and is also supported.
- Frontend: **refactor the existing React/CRACO app in place** (keep `components/ui`, accessibility, sonner, SSE drawer).
- Roles: add **`deployer`** between editor and admin.
- Drop, don't port: user/plugin/theme/commerce/forms/comments/media-library/menus/CMS backups/taxonomies, A/B title tests, calendar scheduling, translate, interlink auto-editing, bulk publish, EXIF/WebP rewriting, crawl auto-fix, plugin downloads.
- Content read cache: `db.posts`/`db.pages` → **`db.content_items`** `{site_id, collection, slug, content_id, title, body, status, url, updated_at, synced_at}`, filled by `POST /sites/{id}/content/sync` from the bridge content API. `wp_id` → `content_id` everywhere.

## Router-by-router

| Router | Decision |
|---|---|
| wp_admin, media_comments, forms_woo, plugin_downloads | **delete** file + registration + frontend pages/api fns |
| live_editor | **delete**; `POST /editor/ai-assist` moves to `POST /ai/assist` (routers/ai_agent.py) |
| backup_redirects | **delete**; redirects become `redirect.*` change-set ops (`GET /sites/{id}/inventory/redirects`, create via change sets); backups become bridge backups |
| sites | **replace** with routers/sites.py per control-plane-api.md |
| nextjs_content | **delete**; replaced by routers/content.py, changesets.py |
| content_crud | **delete** (content CRUD = content.upsert/delete change sets) |
| auto_seo | **delete** (superseded by `/onpage/*`, which now creates change sets) |
| onpage_seo | **port**: meta set/clear, blocks, image alt, move-page → create change sets (`{changeset}` response) |
| autopilot | **port**: publish stage → `content.upsert` draft change set pending approval (never applies); crawl reads the public site (sitemap/links) not the CMS; **delete** interlink stage, crawl fix, publish/interlink step routes |
| monitoring_triggers | keep; queued runs obey the freeze/policy and only ever create change sets |
| auto_blog_generation, blog_generation | **port** generate → content.upsert (status draft) change set; **delete** translate |
| programmatic_local | **port** push → content.upsert change sets |
| opportunities | **port** bulk-redirect → redirect.upsert change set |
| seo_technical_utils | **port** schema apply → metadata.set jsonLd change set; canonical GET from inventory/metadata, PUT/bulk-fix → metadata change sets; mobile check uses public URL; **delete** robots PUT |
| ai_agent | **port** agent tools → propose change sets (never apply); scrub prompts |
| admin_migration | **delete** migrate-encrypt, plugin audit, image audit/alt routes; readability/brief/rank-tracker use `get_site` + content_items |
| content_quality | keep scans (content_items); **delete** the two apply routes |
| bulk_links | keep broken-link scan (content_items); **delete** bulk publish |
| calendar_competitor | **delete** calendar; keep competitor (public URL) |
| content_seo_analytics | **delete** title tests + social-signals; anchor-distribution from content_items |
| full_page_optimizer | port: fetch the public URL |
| image_seo_extra | **delete** |
| keyword_intelligence | cannibalization from content_items |
| keyword_link_builder | **delete** insert route |
| meta_pagespeed | **delete** bulk meta + taxonomies; keep pagespeed |
| misc_global | **delete** image-seo bulk/audit and search |
| nav_refresh | **delete** navigation routes; content-refresh keeps scan (content_items) and "refresh" produces a content.upsert change set |
| newsletter_health | newsletter source = content_items; health check = bridge health + HTTP checks (no CMS/PHP) |
| testing_social | **delete** `/ab/*`; social generate-post reads content_items |
| core_routes | `/jobs`: drop `scheduled_publish`; scrub root message |
| core/scheduled_jobs | drop scheduled publish |
| core/agent_tools | propose change sets |
| providers/wordpress.py | **delete** |
| providers/nextjs.py, providers/content.py | **replace** with providers/bridge_client.py + providers/sites.py |
| models/legacy.py | CMS site models + WP request models removed; `ManagedSite` etc. in models/sites.py |
