from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware
import os
import logging
import re
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from contextlib import asynccontextmanager

from core.db import mongo_client
from core.scheduled_jobs import restore_scheduled_jobs
from routers.autopilot import (  # noqa: E402 (also registers routers.autopilot routes onto api_router)
    _daily_crawl_all_sites, _restore_autopilot_schedules,
)
from core.scheduler import scheduler
from routers.ads import _ads_autopilot_check  # noqa: E402 (also registers routers.ads routes onto api_router)
from routers.monitoring_triggers import (  # noqa: E402 (also registers routers.monitoring_triggers routes onto api_router)
    _check_rank_drop_triggers, _check_new_keyword_triggers,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class _RedactSecretsFilter(logging.Filter):
    """Several providers (Hunter.io, Google CSE, SEMrush) authenticate via a
    query-string parameter rather than a header, so httpx's own request
    logger (`HTTP Request: GET https://...?api_key=...`) writes the raw
    secret to disk on every call. Redact those values wherever they show up
    in a log record, regardless of which logger emitted it."""
    _PATTERN = re.compile(r'(?i)\b((?:api[_-]?key|apikey|access[_-]?key|token|secret|password)=)([^&\s"\']+)')

    def _redact(self, value):
        text = str(value)
        return self._PATTERN.sub(r'\1***REDACTED***', text) if self._PATTERN.search(text) else value

    def filter(self, record):
        if isinstance(record.msg, str):
            record.msg = self._redact(record.msg)
        if record.args:
            if isinstance(record.args, dict):
                record.args = {k: self._redact(v) for k, v in record.args.items()}
            else:
                record.args = tuple(self._redact(a) for a in record.args)
        return True


# Must go on the root HANDLERS, not the root logger: a logger's own filters
# only run for records logged directly to it, and are skipped entirely for
# records propagated up from child loggers like `httpx` — which are exactly
# the ones carrying the leaked key. Handler filters do see propagated records.
for _handler in logging.getLogger().handlers:
    _handler.addFilter(_RedactSecretsFilter())

# Every symbol server.py used to define directly (Pydantic models, auth/crypto/AI
# helpers, WordPress/DataForSEO/GA clients, etc.) now lives in core/, providers/,
# or models/, and is imported directly by whichever routers/*.py module needs it —
# server.py itself only needs what lifespan() and the app/middleware setup below
# use directly (see REFACTOR_NOTES.md for the full module map).


# ========================
# Lifespan (startup/shutdown)
# ========================

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: load and start scheduled jobs from DB
    try:
        scheduler.start()
        await restore_scheduled_jobs()
        # Daily crawl for all connected sites (runs every 24h)
        scheduler.add_job(
            _daily_crawl_all_sites,
            trigger=IntervalTrigger(hours=24),
            id="global_daily_crawl",
            replace_existing=True,
            misfire_grace_time=3600,
        )
        # Restore autopilot schedules for all enabled sites
        await _restore_autopilot_schedules()
        # Event-based autopilot trigger watchers (nightly)
        scheduler.add_job(
            _check_rank_drop_triggers,
            trigger=CronTrigger(hour=2, minute=0),
            id="rank_drop_watcher",
            replace_existing=True,
            misfire_grace_time=3600,
        )
        scheduler.add_job(
            _check_new_keyword_triggers,
            trigger=CronTrigger(hour=3, minute=0),
            id="new_keyword_watcher",
            replace_existing=True,
            misfire_grace_time=3600,
        )
        # Ads Autopilot — every 6 hours
        scheduler.add_job(
            _ads_autopilot_check,
            trigger=IntervalTrigger(hours=6),
            id="ads_autopilot_check",
            replace_existing=True,
            misfire_grace_time=3600,
        )
        logger.info("APScheduler started")
    except Exception as e:
        logger.error(f"Scheduler startup error: {e}")
    yield
    # Shutdown
    try:
        if scheduler.running:
            scheduler.shutdown(wait=False)
    except Exception:
        pass
    mongo_client.close()


# Create the main app
app = FastAPI(title="AI WordPress Management Platform", lifespan=lifespan)

# Router with the /api prefix — shared singleton so routers/*.py modules can
# register onto the same object (see core/router.py).
from core.router import api_router  # noqa: E402

# DataForSEO client, cache, and spend-guard helpers now live in providers/dataforseo.py
# (imported at top of this file: DFS_TTL, dataforseo_post, dataforseo_get, _dfs_available,
#  _dfs_check_spend, _cache_key, _cache_get, _cache_set, _data_meta, DATAFORSEO_LOGIN,
#  DATAFORSEO_PASSWORD, DFS_DAILY_LIMIT)

# All Pydantic models (auth, sites, posts/pages, agent sessions, PageSpeed,
# competitor analysis, bulk ops, SEO metrics, settings, etc.) now live in
# models/legacy.py — imported explicitly below.

# Auth helpers (hash_password, verify_password, create_access_token, get_current_user,
# require_user, require_admin, require_editor) now live in core/security.py.
# Encryption helpers (encrypt_field, decrypt_field, get_decrypted_settings) now live in
# core/crypto.py. AI helpers (get_openai_client, get_ai_response) now live in core/ai.py.
# All are imported at the top of this file.

# WordPress client (get_wp_credentials, wp_error_to_http, wp_api_request, wp_upload_image,
# wp_xmlrpc_write/edit/delete) now lives in providers/wordpress.py. log_activity now lives in
# core/activity.py; SSE task helpers now live in core/tasks.py. compute_readability now lives
# in core/content_analysis.py. All are imported at the top of this file.

# ========================
# Google API Helpers
# ========================

# Google credentials / GA4 / GSC metric fetchers now live in providers/google_analytics.py
# (get_google_credentials, fetch_ga4_metrics, fetch_gsc_metrics — imported at top of this file).

# APScheduler job functions (run_content_freshness_scan, run_seo_health_check,
# run_scheduled_publish, restore_scheduled_jobs, _schedule_job) now live in
# core/scheduled_jobs.py. Agent tool definitions (AGENT_TOOLS, execute_agent_tool)
# now live in core/agent_tools.py. Both imported at the top of this file.


# Root, Authentication, Settings, SSE Streaming, and Scheduled Jobs routes now
# live in routers/core_routes.py.


# Sites Management routes now live in routers/sites.py.


# AI Agent (multi-turn/SSE + legacy single-turn) routes now live in routers/ai_agent.py.


# Pages Management + Posts Management routes now live in routers/content_crud.py.


# AI Blog Generation routes now live in routers/blog_generation.py.


# SEO Management routes now live in routers/seo_management.py.


# Navigation Management + Content Refresh routes now live in routers/nav_refresh.py.


# Bulk Publish/Unpublish + Broken Link Detection routes now live in routers/bulk_links.py.


# Duplicate Content Detection + Internal Link Suggestions routes now live in
# routers/content_quality.py.


# Content Calendar + Competitor Analysis routes now live in routers/calendar_competitor.py.


# Bulk Meta + Taxonomy + PageSpeed Insights routes now live in routers/meta_pagespeed.py.


# Activity Logs + Dashboard Stats + User Management routes now live in
# routers/admin_misc.py.


# Admin Migration + Writing Style Profiles + Content Brief Generator + Plugin
# Health Audit + Image Alt Text Bulk Generator + Rank Tracker + Readability
# routes now live in routers/admin_migration.py.


# FEATURE 1 (Smart Onboarding) + FEATURE 2 (AI Search Visibility Engine) routes
# now live in routers/onboarding_visibility.py.


# FEATURE 3 (Keyword Tracking) + FEATURE 5 (Link Builder) routes now live in
# routers/keyword_link_builder.py.


# FEATURE 6 (Standard Reports) + FEATURE 7 (Local Results Tracking) routes now
# live in routers/reports_local.py.


# FEATURE 8 (Live Editor) routes now live in routers/live_editor.py.


# FEATURE 10 (Daily Crawl) + the whole Autopilot Engine now live in routers/autopilot.py.


# Auto-SEO (meta/OG/schema apply, AI scan) routes now live in routers/auto_seo.py.


# Media Library Manager (FEATURE 1) and Comments Manager (FEATURE 2) now live in
# routers/media_comments.py.


# User & Role Manager (FEATURE 3) and Plugin & Theme Manager (FEATURE 4) now live in
# routers/wp_admin.py.


# Forms & Leads Manager (FEATURE 5) and WooCommerce Manager (FEATURE 6) now live in
# routers/forms_woo.py.


# Backup & Restore Manager (FEATURE 7) and Redirect Manager (FEATURE 8) now live in
# routers/backup_redirects.py.


# A/B Testing Engine (FEATURE 9) and Social Media Auto-Poster (FEATURE 10) now live in
# routers/testing_social.py.


# Email Newsletter Builder (FEATURE 11) and Site Health & Uptime Monitor (FEATURE 12)
# now live in routers/newsletter_health.py.


# GLOBAL Notifications, MODULE 3 (Extended Uptime), MODULE 4 (Extended Image SEO),
# MODULE 12 (Autopilot Pipeline Logs), and GLOBAL Search routes now live in
# routers/misc_global.py.


# ========================
# Local + Programmatic SEO Automation Engine
# ========================

# Programmatic Page Engine, Keyword Cluster Engine, GBP Optimizer, and Review
# Growth System routes now live in routers/programmatic_local.py. Indexing
# Tracker and Revenue Dashboard routes now live in routers/indexing_revenue.py.


# MODULE 1-10 (Backlink Outreach, Guest Posting Manager, Brand Mention Monitor,
# Digital PR, Local Citations, Influencer Outreach, Community Engagement,
# Podcast Outreach, Link Reclamation, Off-Page Autopilot Dashboard) now live in
# routers/opportunities.py. NOTE: this module still contains LLM-fabrication
# patterns moved verbatim -- see REFACTOR_NOTES.md.


# SEO Meta Fields REST API Fixer plugin download and WP Manager Bridge plugin
# download routes now live in routers/plugin_downloads.py.


# estimate_seo_impact now lives in core/seo_impact.py (imported at top of this file).

# The following features (formerly a single ~2950-line "Local + Programmatic
# SEO Automation Engine" mega-section) now live in dedicated router modules:
#   - Schema Markup Generator, Sitemap & Robots.txt Manager, Canonical Tag
#     Manager, Mobile Responsiveness Checker, Keyword Intent Categorisation
#     -> routers/seo_technical_utils.py
#   - Full Page SEO Optimizer -> routers/full_page_optimizer.py
#   - AI Content Detector (Module 10 full scoring suite), Section-by-Section
#     AI Detection, Google Helpful Content Score, Real Fact-Check API
#     -> routers/ai_content_detector.py
#   - Keyword Research, Keyword Analysis, Keyword Cannibalization Detector,
#     ROI/Revenue per Keyword, Google Trends/Seasonal Queries
#     -> routers/keyword_intelligence.py
#   - Auto Blog Generation -> routers/auto_blog_generation.py
#   - EXIF Metadata Cleaning, Image Sitemap Auto-Generation, WebP Bulk
#     Conversion -> routers/image_seo_extra.py
#   - Event-Based Autopilot Triggers, Multi-Region Uptime Checks
#     -> routers/monitoring_triggers.py (the two trigger-check functions are
#     imported back below for lifespan()'s cron scheduling)
#   - Predictive Ranking Model, Competitor Content Comparison, Anchor Text
#     Distribution, Social Signal SEO Mapping, A/B Title SEO Testing
#     -> routers/content_seo_analytics.py




# DataForSEO keyword intelligence (keyword metrics, ideas, SERP analysis, live rank
# tracking, live backlinks, competitor gap, connection test) now lives in
# routers/keywords_intel.py, registered onto the shared api_router via the
# `import routers.keywords_intel` below (see core/router.py for why this works).


# Ads Manager (Meta Ads + Google Ads connect/campaigns/generate/create/pause/resume,
# plus _ads_autopilot_check scheduled from lifespan() below) now lives in routers/ads.py.


# Media Plan Automation (parse/activate/execute/pause/resume media plan tasks,
# platform connections, YouTube/LinkedIn connect) now lives in routers/media_plan.py.


# Extra route modules that register directly onto the shared api_router
# (see core/router.py) — must be imported before app.include_router() below.
import routers.media_comments  # noqa: E402,F401
import routers.wp_admin  # noqa: E402,F401
import routers.forms_woo  # noqa: E402,F401
import routers.backup_redirects  # noqa: E402,F401
import routers.testing_social  # noqa: E402,F401
import routers.newsletter_health  # noqa: E402,F401
import routers.core_routes  # noqa: E402,F401
import routers.sites  # noqa: E402,F401
import routers.ai_agent  # noqa: E402,F401
import routers.content_crud  # noqa: E402,F401
import routers.blog_generation  # noqa: E402,F401
import routers.seo_management  # noqa: E402,F401
import routers.nav_refresh  # noqa: E402,F401
import routers.bulk_links  # noqa: E402,F401
import routers.content_quality  # noqa: E402,F401
import routers.calendar_competitor  # noqa: E402,F401
import routers.meta_pagespeed  # noqa: E402,F401
import routers.admin_misc  # noqa: E402,F401
import routers.admin_migration  # noqa: E402,F401
import routers.onboarding_visibility  # noqa: E402,F401
import routers.keyword_link_builder  # noqa: E402,F401
import routers.reports_local  # noqa: E402,F401
import routers.live_editor  # noqa: E402,F401
import routers.auto_seo  # noqa: E402,F401
import routers.misc_global  # noqa: E402,F401
import routers.programmatic_local  # noqa: E402,F401
import routers.indexing_revenue  # noqa: E402,F401
import routers.keywords_intel  # noqa: E402,F401
import routers.media_plan  # noqa: E402,F401
import routers.opportunities  # noqa: E402,F401
import routers.plugin_downloads  # noqa: E402,F401
import routers.seo_technical_utils  # noqa: E402,F401
import routers.full_page_optimizer  # noqa: E402,F401
import routers.ai_content_detector  # noqa: E402,F401
import routers.keyword_intelligence  # noqa: E402,F401
import routers.auto_blog_generation  # noqa: E402,F401
import routers.image_seo_extra  # noqa: E402,F401
import routers.content_seo_analytics  # noqa: E402,F401
import routers.company_profile  # noqa: E402,F401
import routers.outreach_gate  # noqa: E402,F401
import routers.platform_intelligence  # noqa: E402,F401
import routers.directories  # noqa: E402,F401

# Include the router in the main app
app.include_router(api_router)

# Added before CORSMiddleware so CORS stays the OUTERMOST middleware (Starlette
# wraps in reverse add-order) — a 429 from the rate limiter still gets CORS
# headers applied on its way back out, instead of the browser seeing an
# opaque failed-fetch with no CORS headers.
from core.rate_limit import RateLimitMiddleware  # noqa: E402
app.add_middleware(RateLimitMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
