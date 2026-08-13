import json
import logging
from datetime import datetime, timedelta, timezone
from typing import List

logger = logging.getLogger(__name__)


async def get_google_credentials(settings: dict):
    """Return a google.oauth2.credentials.Credentials object from stored JSON."""
    from google.oauth2 import service_account
    creds_json = settings.get("google_analytics_credentials") or settings.get("google_search_console_credentials")
    if not creds_json:
        return None
    try:
        creds_data = json.loads(creds_json)
        scopes = [
            "https://www.googleapis.com/auth/analytics.readonly",
            "https://www.googleapis.com/auth/webmasters",          # full access — needed to submit sitemaps
            "https://www.googleapis.com/auth/webmasters.readonly",  # kept for read compat
        ]
        if creds_data.get("type") == "service_account":
            return service_account.Credentials.from_service_account_info(creds_data, scopes=scopes)
    except Exception as e:
        logger.error(f"Failed to parse Google credentials: {e}")
    return None


async def fetch_ga4_metrics(settings: dict, property_id: str, site_url: str) -> List[dict]:
    """Fetch real GA4 impressions/clicks via Google Analytics Data API."""
    try:
        from google.analytics.data_v1beta import BetaAnalyticsDataClient
        from google.analytics.data_v1beta.types import (
            RunReportRequest, Dimension, Metric, DateRange
        )
        creds = await get_google_credentials(settings)
        if not creds:
            return []
        ga_client = BetaAnalyticsDataClient(credentials=creds)
        request = RunReportRequest(
            property=f"properties/{property_id}",
            dimensions=[Dimension(name="pagePath")],
            metrics=[
                Metric(name="screenPageViews"),
                Metric(name="sessions"),
                Metric(name="bounceRate"),
                Metric(name="averageSessionDuration"),
                Metric(name="engagedSessions"),
            ],
            date_ranges=[DateRange(start_date="30daysAgo", end_date="today")],
            limit=50,
        )
        response = ga_client.run_report(request)
        rows = []
        for row in response.rows:
            rows.append({
                "page_url": site_url.rstrip("/") + row.dimension_values[0].value,
                "page_views": int(row.metric_values[0].value),
                "sessions": int(row.metric_values[1].value),
                "bounce_rate": round(float(row.metric_values[2].value or 0), 2),
                "avg_session_duration": round(float(row.metric_values[3].value or 0), 1),
                "engaged_sessions": int(row.metric_values[4].value),
            })
        return rows
    except Exception as e:
        logger.error(f"GA4 fetch failed: {e}")
        return []


async def fetch_gsc_metrics(settings: dict, site_url: str) -> List[dict]:
    """Fetch real GSC impressions/clicks/CTR/rankings."""
    try:
        from googleapiclient.discovery import build
        creds = await get_google_credentials(settings)
        if not creds:
            return []
        service = build("searchconsole", "v1", credentials=creds, cache_discovery=False)
        end_date = datetime.now(timezone.utc).date().isoformat()
        start_date = (datetime.now(timezone.utc) - timedelta(days=28)).date().isoformat()
        body = {
            "startDate": start_date,
            "endDate": end_date,
            "dimensions": ["page", "query"],
            "rowLimit": 100,
        }
        response = (
            service.searchanalytics()
            .query(siteUrl=site_url, body=body)
            .execute()
        )
        rows = []
        for row in response.get("rows", []):
            keys = row.get("keys", [])
            rows.append({
                "page_url": keys[0] if keys else "",
                "keyword": keys[1] if len(keys) > 1 else "",
                "impressions": int(row.get("impressions", 0)),
                "clicks": int(row.get("clicks", 0)),
                "ctr": round(row.get("ctr", 0.0) * 100, 2),
                "ranking": round(row.get("position", 0), 1),
            })
        return rows
    except Exception as e:
        logger.error(f"GSC fetch failed: {e}")
        return []
