"""Global Notifications (+ dev-tool compatibility stubs), Extended Uptime
Monitoring (DNS/TTFB/SSL/CDN/nameserver deep-check), Extended Image SEO (bulk
alt-text generation, full image audit), Autopilot Pipeline Logs (per-job stage
timeline + success-rate stats), and Global Search across activity/keywords/
media/posts/pages.
"""
import logging
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import Depends, Request

from core.activity import log_activity
from core.db import db
from core.router import api_router
from core.safe_fetch import SSRF_GUARD
from core.security import require_editor
from providers.sites import get_site

logger = logging.getLogger(__name__)

# ============================================================
# GLOBAL — NOTIFICATIONS
# ============================================================

# ── Dev-tool compatibility stubs (used by @emergentbase/visual-edits) ──────────

@api_router.get("/notifications")
async def get_notifications_global(request: Request):
    """Global (site-agnostic) notification list — returns empty for dev-tool compatibility."""
    return []

# ── Site-scoped notification routes ───────────────────────────────────────────

@api_router.get("/notifications/{site_id}")
async def get_notifications(site_id: str, current_user: dict = Depends(require_editor)):
    notifs = await db.notifications.find({"site_id": site_id}, {"_id": 0}).sort("created_at", -1).to_list(50)
    return notifs

@api_router.post("/notifications/{site_id}/mark-read/{notification_id}")
async def mark_notification_read(site_id: str, notification_id: str, current_user: dict = Depends(require_editor)):
    await db.notifications.update_one({"id": notification_id, "site_id": site_id}, {"$set": {"read": True}})
    return {"success": True}

@api_router.post("/notifications/{site_id}/mark-all-read")
async def mark_all_notifications_read(site_id: str, current_user: dict = Depends(require_editor)):
    await db.notifications.update_many({"site_id": site_id}, {"$set": {"read": True}})
    return {"success": True}


# ============================================================
# MODULE 3 — EXTENDED UPTIME MONITORING (DNS, TTFB, CWV, CDN)
# ============================================================

@api_router.post("/uptime/{site_id}/deep-check")
async def uptime_deep_check(site_id: str, current_user: dict = Depends(require_editor)):
    """Comprehensive uptime check: HTTP status, DNS lookup, TTFB, SSL, CWV, CDN detection."""
    # Pure HTTP/DNS/SSL probe of the public URL — works on any platform,
    # so it only needs the site's public URL.
    site = await get_site(site_id)
    site_url = site["base_url"].rstrip("/")
    import time as _time
    from urllib.parse import urlparse
    parsed = urlparse(site_url)
    hostname = parsed.hostname or ""
    result = {
        "site_id": site_id,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "http_status": None, "online": False,
        "ttfb_ms": None, "total_response_ms": None,
        "dns_lookup_ms": None, "dns_resolved_ip": None,
        "ssl_valid": None, "ssl_expiry_days": None, "ssl_issuer": None,
        "cdn_detected": None, "cdn_provider": None,
        "server_header": None,
        "redirect_chain": [],
        "issues": [],
    }
    # 1. DNS resolution
    try:
        import socket
        t0 = _time.monotonic()
        ip = socket.gethostbyname(hostname)
        result["dns_lookup_ms"] = round((_time.monotonic() - t0) * 1000, 1)
        result["dns_resolved_ip"] = ip
        if result["dns_lookup_ms"] > 100:
            result["issues"].append({"key": "slow_dns", "status": "warning", "description": f"DNS lookup took {result['dns_lookup_ms']}ms (target < 100ms)"})
    except Exception as e:
        result["issues"].append({"key": "dns_failure", "status": "critical", "description": f"DNS resolution failed: {e}"})
    # 2. HTTP request + TTFB + redirect chain
    try:
        async with httpx.AsyncClient(event_hooks=SSRF_GUARD, timeout=20.0, follow_redirects=False) as hc:
            url = site_url
            chain = []
            for _ in range(5):
                t0 = _time.monotonic()
                resp = await hc.get(url)
                elapsed = round((_time.monotonic() - t0) * 1000)
                chain.append({"url": url, "status": resp.status_code, "time_ms": elapsed})
                if resp.status_code in (301, 302, 307, 308):
                    url = str(resp.headers.get("location", ""))
                    if not url.startswith("http"):
                        break
                    continue
                break
            result["redirect_chain"] = chain
            result["http_status"] = resp.status_code
            result["online"] = resp.status_code < 500
            result["ttfb_ms"] = chain[0]["time_ms"] if chain else elapsed
            result["total_response_ms"] = sum(c["time_ms"] for c in chain)
            result["server_header"] = resp.headers.get("server", "unknown")
            # CDN detection
            cdn_headers = {
                "cloudflare": "cf-ray", "cloudfront": "x-amz-cf-id",
                "fastly": "x-served-by", "akamai": "x-akamai-transformed",
                "sucuri": "x-sucuri-id", "stackpath": "x-sp-url",
            }
            for provider, header in cdn_headers.items():
                if header in resp.headers:
                    result["cdn_detected"] = True
                    result["cdn_provider"] = provider
                    break
            if result["cdn_detected"] is None:
                result["cdn_detected"] = False
            # TTFB warnings
            if result["ttfb_ms"] and result["ttfb_ms"] > 500:
                result["issues"].append({"key": "slow_ttfb", "status": "warning", "description": f"TTFB is {result['ttfb_ms']}ms (target < 200ms)"})
            elif result["ttfb_ms"] and result["ttfb_ms"] > 1000:
                result["issues"].append({"key": "slow_ttfb", "status": "critical", "description": f"TTFB is {result['ttfb_ms']}ms (critically slow)"})
            # Redirect chain warnings
            if len(chain) > 2:
                result["issues"].append({"key": "redirect_chain", "status": "warning", "description": f"Redirect chain has {len(chain)} hops (target ≤ 1)"})
    except Exception as e:
        result["issues"].append({"key": "unreachable", "status": "critical", "description": f"Site unreachable: {e}"})
    # 3. SSL certificate check
    try:
        import socket as _socket
        import ssl
        if parsed.scheme == "https" and hostname:
            ctx = ssl.create_default_context()
            with ctx.wrap_socket(_socket.socket(), server_hostname=hostname) as s:
                s.settimeout(10)
                s.connect((hostname, 443))
                cert = s.getpeercert()
            result["ssl_valid"] = True
            issuer = dict(x[0] for x in cert.get("issuer", []))
            result["ssl_issuer"] = issuer.get("organizationName", issuer.get("commonName", "unknown"))
            not_after = cert.get("notAfter", "")
            if not_after:
                from datetime import datetime as dt
                expiry = dt.strptime(not_after, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
                days_left = (expiry - dt.now(timezone.utc)).days
                result["ssl_expiry_days"] = days_left
                if days_left < 30:
                    result["issues"].append({"key": "ssl_expiry", "status": "warning" if days_left > 7 else "critical",
                                             "description": f"SSL expires in {days_left} days"})
    except Exception:
        result["ssl_valid"] = False
        result["issues"].append({"key": "ssl_error", "status": "critical", "description": "SSL certificate check failed"})
    # 4. HTTPS enforcement check
    if parsed.scheme == "http":
        result["issues"].append({"key": "no_https", "status": "critical", "description": "Site is not using HTTPS"})
    # 5. Nameserver redundancy check
    try:
        import dns.resolver
        ns_answers = dns.resolver.resolve(hostname, 'NS')
        nameservers = [str(ns.target).rstrip('.') for ns in ns_answers]
        result["nameservers"] = nameservers
        result["nameserver_count"] = len(nameservers)
        if len(nameservers) < 2:
            result["issues"].append({"key": "ns_redundancy", "status": "warning", "description": f"Only {len(nameservers)} nameserver(s) found — at least 2 recommended for redundancy"})
    except Exception:
        try:
            import subprocess
            ns_out = subprocess.check_output(["nslookup", "-type=ns", hostname], timeout=10, text=True)
            ns_lines = [l.strip() for l in ns_out.split("\n") if "nameserver" in l.lower() and "=" in l]
            nameservers = [l.split("=")[-1].strip().rstrip('.') for l in ns_lines]
            result["nameservers"] = nameservers if nameservers else ["unknown"]
            result["nameserver_count"] = len(nameservers)
            if len(nameservers) < 2:
                result["issues"].append({"key": "ns_redundancy", "status": "warning", "description": f"Only {len(nameservers)} nameserver(s) detected"})
        except Exception:
            result["nameservers"] = []
            result["nameserver_count"] = 0
    # Store
    await db.uptime_checks.insert_one({**result, "id": str(uuid.uuid4())})
    await log_activity(site_id, "uptime_deep_check", f"Deep uptime check: TTFB={result['ttfb_ms']}ms, online={result['online']}")
    return result


@api_router.get("/uptime/{site_id}/history")
async def get_uptime_history(site_id: str, days: int = 7, current_user: dict = Depends(require_editor)):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    history = await db.uptime_checks.find(
        {"site_id": site_id, "checked_at": {"$gte": cutoff}}, {"_id": 0}
    ).sort("checked_at", -1).to_list(500)
    # Compute uptime percentage
    total = len(history)
    online_count = sum(1 for h in history if h.get("online"))
    uptime_pct = round((online_count / max(total, 1)) * 100, 2)
    avg_ttfb = round(sum(h.get("ttfb_ms", 0) or 0 for h in history) / max(total, 1), 1) if total else 0
    return {
        "site_id": site_id,
        "period_days": days,
        "total_checks": total,
        "uptime_percentage": uptime_pct,
        "avg_ttfb_ms": avg_ttfb,
        "checks": history[:50],
    }


@api_router.get("/uptime/{site_id}/summary")
async def get_uptime_summary(site_id: str, current_user: dict = Depends(require_editor)):
    """Get a summary of uptime stats for the dashboard."""
    latest = await db.uptime_checks.find_one({"site_id": site_id}, {"_id": 0}, sort=[("checked_at", -1)])
    # 24h history
    cutoff_24h = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    checks_24h = await db.uptime_checks.find(
        {"site_id": site_id, "checked_at": {"$gte": cutoff_24h}}, {"_id": 0, "online": 1, "ttfb_ms": 1}
    ).to_list(500)
    total_24h = len(checks_24h)
    online_24h = sum(1 for c in checks_24h if c.get("online"))
    return {
        "site_id": site_id,
        "latest_check": latest,
        "uptime_24h": round((online_24h / max(total_24h, 1)) * 100, 2),
        "total_checks_24h": total_24h,
    }


# ============================================================
# MODULE 12 — AUTOPILOT PIPELINE LOGS
# ============================================================

@api_router.get("/autopilot/{site_id}/pipeline-logs")
async def get_pipeline_logs(site_id: str, limit: int = 20, _=Depends(require_editor)):
    """Get detailed pipeline execution logs for autopilot jobs."""
    jobs = await db.autopilot_jobs.find(
        {"site_id": site_id}, {"_id": 0}
    ).sort("created_at", -1).to_list(limit)
    logs = []
    for job in jobs:
        steps = []
        for stage in ["keyword_picked", "post_written", "seo_optimized", "proposed"]:
            ts_key = f"{stage}_at"
            if job.get(ts_key) or job.get("status") == stage:
                steps.append({
                    "stage": stage,
                    "status": "completed" if job.get(ts_key) else ("in_progress" if job.get("status") == stage else "pending"),
                    "completed_at": job.get(ts_key),
                })
            elif job.get("status") in ("failed", "error") and not job.get(ts_key):
                steps.append({"stage": stage, "status": "skipped"})
            else:
                steps.append({"stage": stage, "status": "pending"})
        logs.append({
            "job_id": job.get("id"),
            "keyword": job.get("keyword", ""),
            "title": job.get("title", ""),
            "status": job.get("status", "unknown"),
            "created_at": job.get("created_at"),
            "completed_at": job.get("completed_at") or job.get("proposed_at"),
            "changeset_id": job.get("changeset_id"),
            "seo_score": job.get("seo_score"),
            "steps": steps,
            "error": job.get("error"),
        })
    return {"site_id": site_id, "total": len(logs), "logs": logs}


@api_router.get("/autopilot/{site_id}/pipeline-stats")
async def get_pipeline_stats(site_id: str, _=Depends(require_editor)):
    """Pipeline statistics: success rate, average time, total jobs."""
    all_jobs = await db.autopilot_jobs.find({"site_id": site_id}, {"_id": 0, "status": 1, "created_at": 1, "completed_at": 1, "published_at": 1}).to_list(500)
    total = len(all_jobs)
    published = sum(1 for j in all_jobs if j.get("status") == "published")
    failed = sum(1 for j in all_jobs if j.get("status") in ("failed", "error"))
    in_progress = sum(1 for j in all_jobs if j.get("status") not in ("published", "failed", "error"))
    return {
        "site_id": site_id,
        "total_jobs": total,
        "published": published,
        "failed": failed,
        "in_progress": in_progress,
        "success_rate": round((published / max(total, 1)) * 100, 1),
    }


# ============================================================
# GLOBAL — SEARCH
# ============================================================

