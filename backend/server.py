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


app = FastAPI(title="Site Autopilot — Next.js automation platform", lifespan=lifespan)

# Router with the /api prefix — shared singleton so routers/*.py modules can
# register onto the same object (see core/router.py for the baseline access policy).
from core.router import api_router  # noqa: E402

# Route modules register onto the shared api_router at import time and must be
# imported before app.include_router() below. (routers.autopilot, routers.ads and
# routers.monitoring_triggers are imported at the top for lifespan().)
import routers.core_routes  # noqa: E402,F401
import routers.sites  # noqa: E402,F401
import routers.site_resources  # noqa: E402,F401
import routers.changesets  # noqa: E402,F401
import routers.operations  # noqa: E402,F401
import routers.audit_log  # noqa: E402,F401
import routers.ai_agent  # noqa: E402,F401
import routers.ai_assist  # noqa: E402,F401
import routers.blog_generation  # noqa: E402,F401
import routers.auto_blog_generation  # noqa: E402,F401
import routers.seo_management  # noqa: E402,F401
import routers.content_refresh  # noqa: E402,F401
import routers.broken_links  # noqa: E402,F401
import routers.content_quality  # noqa: E402,F401
import routers.competitor  # noqa: E402,F401
import routers.pagespeed  # noqa: E402,F401
import routers.admin_misc  # noqa: E402,F401
import routers.content_tools  # noqa: E402,F401
import routers.onboarding_visibility  # noqa: E402,F401
import routers.keyword_link_builder  # noqa: E402,F401
import routers.reports_local  # noqa: E402,F401
import routers.misc_global  # noqa: E402,F401
import routers.programmatic_local  # noqa: E402,F401
import routers.indexing_revenue  # noqa: E402,F401
import routers.keywords_intel  # noqa: E402,F401
import routers.media_plan  # noqa: E402,F401
import routers.opportunities  # noqa: E402,F401
import routers.seo_technical_utils  # noqa: E402,F401
import routers.full_page_optimizer  # noqa: E402,F401
import routers.ai_content_detector  # noqa: E402,F401
import routers.keyword_intelligence  # noqa: E402,F401
import routers.content_seo_analytics  # noqa: E402,F401
import routers.company_profile  # noqa: E402,F401
import routers.outreach_gate  # noqa: E402,F401
import routers.platform_intelligence  # noqa: E402,F401
import routers.directories  # noqa: E402,F401
import routers.onpage_seo  # noqa: E402,F401
import routers.testing_social  # noqa: E402,F401
import routers.newsletter_health  # noqa: E402,F401

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
