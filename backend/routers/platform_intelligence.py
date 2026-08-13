"""Platform Intelligence (§7): a cross-site portfolio view. Everything
elsewhere in this app (dashboard/stats, health, off-page score) is scoped to
ONE site at a time — this aggregates real per-site signals (uptime/health,
off-page authority score, backlinks acquired, revenue-tracking configured,
last activity) across every site an agency operator manages, so they can see
which client sites need attention without opening each one individually.
"""
from datetime import datetime, timezone

from fastapi import Depends

from core.db import db
from core.explain import with_reason
from core.router import api_router
from core.security import get_current_user
from routers.opportunities import offpage_score


@api_router.get("/platform/portfolio")
async def get_portfolio_intelligence(current_user: dict = Depends(get_current_user)):
    query = {}
    if current_user:
        query["user_id"] = current_user["id"]
    sites = await db.sites.find(query, {"_id": 0, "app_password": 0, "jwt_token": 0}).to_list(500)

    portfolio = []
    for site in sites:
        site_id = site["id"]
        health = await db.site_health.find_one({"site_id": site_id}, {"_id": 0})
        last_activity = await db.activity_logs.find_one(
            {"site_id": site_id}, {"_id": 0}, sort=[("created_at", -1)]
        )
        revenue_settings = await db.revenue_settings.find_one({"site_id": site_id}, {"_id": 0})
        try:
            offpage = await offpage_score(site_id, current_user or {})
        except Exception:
            offpage = None

        issues_count = len((health or {}).get("issues", []))
        online = (health or {}).get("online")
        needs_attention = bool((online is False) or issues_count > 0)
        if online is False:
            attention_reason = "Last health check found the site offline."
        elif issues_count > 0:
            attention_reason = f"Last health check found {issues_count} open issue(s) (SSL, WP version, etc.)."
        else:
            attention_reason = None

        entry = {
            "site_id": site_id, "name": site.get("name"), "url": site.get("url"), "status": site.get("status"),
            "uptime": {"online": online, "issues_count": issues_count, "checked_at": (health or {}).get("checked_at")},
            "offpage_score": (offpage or {}).get("score"),
            "backlinks_acquired": (offpage or {}).get("breakdown", {}).get("backlinks_acquired"),
            "revenue_tracking_configured": bool(revenue_settings),
            "last_activity_at": (last_activity or {}).get("created_at"),
            "needs_attention": needs_attention,
        }
        portfolio.append(with_reason(entry, attention_reason))

    portfolio.sort(key=lambda p: (not p["needs_attention"], (p["name"] or "").lower()))

    return {
        "total_sites": len(portfolio),
        "sites_needing_attention": sum(1 for p in portfolio if p["needs_attention"]),
        "sites_never_health_checked": sum(1 for p in portfolio if p["uptime"]["online"] is None),
        "portfolio": portfolio,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
