"""Ads Manager: Meta Ads + Google Ads connect/campaigns/generate/create/pause/resume,
plus the ads-autopilot check (`_ads_autopilot_check`) that server.py's lifespan
schedules every 6 hours to auto-boost top-performing posts with paused draft campaigns.
"""
import json
import logging
import os
from datetime import datetime, timezone
from typing import List, Optional

import httpx
from fastapi import Body, Depends, HTTPException
from pydantic import BaseModel

from core.activity import log_activity
from core.ai import get_ai_response
from core.crypto import decrypt_field, encrypt_field
from core.db import db
from core.json_utils import _repair_and_parse_json
from core.router import api_router
from core.security import require_editor
from core.tasks import autopilot_sse_queues

logger = logging.getLogger(__name__)

# ── Pydantic models ──────────────────────────────────────────────

class MetaAdsConnectRequest(BaseModel):
    business_manager_id: str
    ad_account_id: str = ""
    access_token: str

class GoogleAdsConnectRequest(BaseModel):
    code: str
    customer_id: str

class AdCampaignRequest(BaseModel):
    site_id: Optional[str] = None
    platform: Optional[str] = None
    description: Optional[str] = None
    audience: Optional[str] = None
    goal: str = "OUTCOME_TRAFFIC"
    budget_daily: float = 10.0
    duration_days: int = 7
    landing_url: Optional[str] = None
    keywords: Optional[str] = None
    location: str = "IN"

class AutopilotAdsSettings(BaseModel):
    site_id: Optional[str] = None
    platform: str = "meta"
    enabled: bool = False
    pageview_threshold: int = 500
    max_daily_budget: float = 20.0

class AdsNegativeKeywordRequest(BaseModel):
    keyword: str
    campaign_id: str

class AdsBidSuggestionsRequest(BaseModel):
    campaigns: Optional[List[dict]] = None

# ── Helpers ──────────────────────────────────────────────────────

async def _get_ads_credentials(platform: str) -> dict:
    """Fetch and decrypt ads credentials for the given platform."""
    creds = await db.ads_credentials.find_one({"platform": platform}, {"_id": 0})
    if not creds:
        raise HTTPException(status_code=400, detail=f"{platform.title()} Ads account not connected. Please connect it in Ads Manager settings.")
    if creds.get("access_token_encrypted"):
        creds["access_token"] = decrypt_field(creds["access_token_encrypted"])
    if creds.get("refresh_token_encrypted"):
        creds["refresh_token"] = decrypt_field(creds["refresh_token_encrypted"])
    return creds

async def _ads_ai_generate(prompt: str, system: str = "You are an expert digital advertising strategist. Respond with valid JSON only — no markdown, no preamble.") -> dict:
    """Call AI for ads generation and parse JSON response."""
    raw = await get_ai_response(
        [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        max_tokens=2000,
        temperature=0.7,
    )
    # Strip any accidental code fences
    import re as _re
    raw = _re.sub(r'^```[a-z]*\s*', '', raw.strip(), flags=_re.IGNORECASE)
    raw = _re.sub(r'\s*```\s*$', '', raw.strip())
    try:
        return json.loads(raw)
    except Exception:
        return _repair_and_parse_json(raw)

# ── META ADS ROUTES ───────────────────────────────────────────────

@api_router.post("/ads/meta/connect")
async def meta_ads_connect(data: MetaAdsConnectRequest, current_user: dict = Depends(require_editor)):
    """Encrypt and store Meta Ads credentials."""
    doc = {
        "platform": "meta",
        "business_manager_id": data.business_manager_id,
        "ad_account_id": data.ad_account_id or f"act_{data.business_manager_id}",
        "access_token_encrypted": encrypt_field(data.access_token),
        "connected_at": datetime.now(timezone.utc).isoformat(),
        "connected_by": current_user.get("email", ""),
    }
    await db.ads_credentials.update_one({"platform": "meta"}, {"$set": doc}, upsert=True)
    logger.info(f"Meta Ads connected by {current_user.get('email')}")
    return {"success": True, "message": "Meta Ads account connected"}

@api_router.delete("/ads/meta/disconnect")
async def meta_ads_disconnect(current_user: dict = Depends(require_editor)):
    await db.ads_credentials.delete_one({"platform": "meta"})
    return {"success": True}

@api_router.get("/ads/meta/campaigns")
async def meta_ads_campaigns(current_user: dict = Depends(require_editor)):
    """Fetch campaigns from Meta Marketing API."""
    creds = await _get_ads_credentials("meta")
    ad_account_id = creds.get("ad_account_id", "")
    access_token = creds["access_token"]
    fields = "id,name,status,objective,daily_budget,spend_cap,start_time,stop_time"
    insights_fields = "spend,impressions,clicks,ctr,actions"
    url = f"https://graph.facebook.com/v19.0/{ad_account_id}/campaigns"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, params={
                "fields": f"{fields},insights.date_preset(last_30d){{{insights_fields}}}",
                "access_token": access_token,
                "limit": 50,
            })
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as e:
        logger.error(f"Meta campaigns API error: {e.response.text}")
        raise HTTPException(status_code=502, detail=f"Meta API error: {e.response.status_code}")
    except Exception as e:
        logger.error(f"Meta campaigns fetch error: {e}")
        raise HTTPException(status_code=502, detail=str(e))

    campaigns = []
    for c in data.get("data", []):
        insights = c.get("insights", {}).get("data", [{}])[0] if c.get("insights") else {}
        clicks = int(insights.get("clicks", 0) or 0)
        impressions = int(insights.get("impressions", 0) or 0)
        spend = float(insights.get("spend", 0) or 0)
        ctr = clicks / impressions if impressions else 0
        # ROAS from purchase action value
        purchase_value = sum(float(a.get("value", 0)) for a in (insights.get("actions") or []) if a.get("action_type") == "offsite_conversion.fb_pixel_purchase")
        roas = purchase_value / spend if spend else None
        campaigns.append({
            "id": c["id"],
            "name": c["name"],
            "status": c.get("status", "UNKNOWN"),
            "objective": c.get("objective", ""),
            "daily_budget": float(c.get("daily_budget", 0) or 0) / 100,
            "spend": spend,
            "impressions": impressions,
            "clicks": clicks,
            "ctr": ctr,
            "roas": roas,
        })
    # Cache in DB
    await db.ads_campaigns_cache.update_one(
        {"platform": "meta"},
        {"$set": {"campaigns": campaigns, "updated_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    return {"campaigns": campaigns}

@api_router.post("/ads/meta/generate-campaign")
async def meta_ads_generate(data: AdCampaignRequest, current_user: dict = Depends(require_editor)):
    """Use AI to generate a Meta Ads campaign structure."""
    prompt = f"""Generate a complete Meta Ads campaign structure for the following:

Product/Service: {data.description}
Target Audience: {data.audience or "General"}
Campaign Goal: {data.goal}
Daily Budget: ${data.budget_daily}
Duration: {data.duration_days} days

Return ONLY valid JSON matching this exact structure:
{{
  "campaign_name": "...",
  "objective": "OUTCOME_TRAFFIC|OUTCOME_LEADS|OUTCOME_SALES|OUTCOME_AWARENESS",
  "targeting": {{
    "age_min": 25,
    "age_max": 54,
    "genders": [1, 2],
    "geo_locations": {{"countries": ["IN"]}},
    "interests": [{{"id": "6003139266461", "name": "Digital marketing"}}]
  }},
  "bid_strategy": "LOWEST_COST_WITHOUT_CAP|COST_CAP",
  "daily_budget_cents": {int(data.budget_daily * 100)},
  "ads": [
    {{"headline": "...", "primary_text": "...", "cta": "LEARN_MORE|SHOP_NOW|SIGN_UP"}},
    {{"headline": "...", "primary_text": "...", "cta": "LEARN_MORE|SHOP_NOW|SIGN_UP"}},
    {{"headline": "...", "primary_text": "...", "cta": "LEARN_MORE|SHOP_NOW|SIGN_UP"}}
  ]
}}

Make all 3 ad variations distinct in tone: professional, emotional, and curiosity-driven."""
    result = await _ads_ai_generate(prompt)
    logger.info(f"Meta campaign generated for: {data.description[:50]}")
    return result

@api_router.post("/ads/meta/create-campaign")
async def meta_ads_create(data: dict = Body(...), current_user: dict = Depends(require_editor)):
    """Create a campaign on Meta Marketing API using generated structure."""
    creds = await _get_ads_credentials("meta")
    ad_account_id = creds.get("ad_account_id", "")
    access_token = creds["access_token"]
    base_url = "https://graph.facebook.com/v19.0"
    created = {"campaign_id": None, "ad_sets": [], "ads": []}
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            # 1. Create campaign
            camp_resp = await client.post(f"{base_url}/{ad_account_id}/campaigns", data={
                "name": data.get("campaign_name", "AI Generated Campaign"),
                "objective": data.get("objective", "OUTCOME_TRAFFIC"),
                "status": "PAUSED",  # Start paused for safety
                "special_ad_categories": "[]",
                "access_token": access_token,
            })
            camp_resp.raise_for_status()
            camp_id = camp_resp.json().get("id")
            created["campaign_id"] = camp_id
            logger.info(f"Meta campaign created: {camp_id}")

            # 2. Create ad set
            targeting = data.get("targeting", {})
            adset_resp = await client.post(f"{base_url}/{ad_account_id}/adsets", data={
                "name": f"{data.get('campaign_name', 'AI Campaign')} — Ad Set",
                "campaign_id": camp_id,
                "billing_event": "IMPRESSIONS",
                "optimization_goal": "REACH" if "AWARENESS" in data.get("objective", "") else "LINK_CLICKS",
                "bid_strategy": data.get("bid_strategy", "LOWEST_COST_WITHOUT_CAP"),
                "daily_budget": str(data.get("daily_budget_cents", 1000)),
                "targeting": json.dumps(targeting),
                "status": "PAUSED",
                "access_token": access_token,
            })
            adset_resp.raise_for_status()
            adset_id = adset_resp.json().get("id")
            created["ad_sets"].append(adset_id)

            # 3. Create ads (creatives + ads)
            for ad in (data.get("ads") or [])[:3]:
                creative_resp = await client.post(f"{base_url}/{ad_account_id}/adcreatives", data={
                    "name": ad.get("headline", "Ad Creative"),
                    "object_story_spec": json.dumps({
                        "page_id": ad_account_id.replace("act_", ""),
                        "link_data": {
                            "message": ad.get("primary_text", ""),
                            "link": "https://example.com",
                            "name": ad.get("headline", ""),
                            "call_to_action": {"type": ad.get("cta", "LEARN_MORE")},
                        },
                    }),
                    "access_token": access_token,
                })
                if creative_resp.status_code == 200:
                    creative_id = creative_resp.json().get("id")
                    ad_resp = await client.post(f"{base_url}/{ad_account_id}/ads", data={
                        "name": ad.get("headline", "Ad"),
                        "adset_id": adset_id,
                        "creative": json.dumps({"creative_id": creative_id}),
                        "status": "PAUSED",
                        "access_token": access_token,
                    })
                    if ad_resp.status_code == 200:
                        created["ads"].append(ad_resp.json().get("id"))
    except httpx.HTTPStatusError as e:
        logger.error(f"Meta create-campaign API error: {e.response.text}")
        raise HTTPException(status_code=502, detail=f"Meta API error: {e.response.text[:300]}")
    except Exception as e:
        logger.error(f"Meta create-campaign error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    await log_activity("global", "meta_ads_created", f"Created Meta campaign: {data.get('campaign_name')}")
    return {"success": True, "created": created}

@api_router.put("/ads/meta/campaign/{campaign_id}/pause")
async def meta_ads_pause(campaign_id: str, current_user: dict = Depends(require_editor)):
    creds = await _get_ads_credentials("meta")
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(f"https://graph.facebook.com/v19.0/{campaign_id}",
                data={"status": "PAUSED", "access_token": creds["access_token"]})
            r.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"success": True}

@api_router.put("/ads/meta/campaign/{campaign_id}/resume")
async def meta_ads_resume(campaign_id: str, current_user: dict = Depends(require_editor)):
    creds = await _get_ads_credentials("meta")
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(f"https://graph.facebook.com/v19.0/{campaign_id}",
                data={"status": "ACTIVE", "access_token": creds["access_token"]})
            r.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"success": True}

@api_router.delete("/ads/meta/campaign/{campaign_id}")
async def meta_ads_delete_campaign(campaign_id: str, current_user: dict = Depends(require_editor)):
    creds = await _get_ads_credentials("meta")
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.delete(f"https://graph.facebook.com/v19.0/{campaign_id}",
                params={"access_token": creds["access_token"]})
            r.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"success": True}

@api_router.post("/ads/meta/autopilot-settings")
async def meta_ads_autopilot_settings(data: AutopilotAdsSettings, current_user: dict = Depends(require_editor)):
    doc = data.model_dump()
    doc["updated_at"] = datetime.now(timezone.utc).isoformat()
    doc["updated_by"] = current_user.get("email", "")
    await db.ads_autopilot_settings.update_one(
        {"platform": "meta", "site_id": data.site_id},
        {"$set": doc}, upsert=True,
    )
    return {"success": True}

# ── GOOGLE ADS ROUTES ─────────────────────────────────────────────

@api_router.get("/ads/google/oauth-url")
async def google_ads_oauth_url(current_user: dict = Depends(require_editor)):
    """Return Google OAuth2 authorization URL."""
    client_id     = os.environ.get("GOOGLE_CLIENT_ID", "")
    redirect_uri  = os.environ.get("GOOGLE_REDIRECT_URI", "http://localhost:3005/ads-manager?tab=google")
    if not client_id:
        raise HTTPException(status_code=400, detail="GOOGLE_CLIENT_ID not configured in server environment")
    scope = "https://www.googleapis.com/auth/adwords"
    auth_url = (
        f"https://accounts.google.com/o/oauth2/v2/auth"
        f"?client_id={client_id}"
        f"&redirect_uri={redirect_uri}"
        f"&response_type=code"
        f"&scope={scope}"
        f"&access_type=offline"
        f"&prompt=consent"
    )
    return {"auth_url": auth_url}

@api_router.post("/ads/google/connect")
async def google_ads_connect(data: GoogleAdsConnectRequest, current_user: dict = Depends(require_editor)):
    """Exchange OAuth code for tokens, encrypt, and store."""
    client_id     = os.environ.get("GOOGLE_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")
    redirect_uri  = os.environ.get("GOOGLE_REDIRECT_URI", "http://localhost:3005/ads-manager?tab=google")
    if not client_id or not client_secret:
        raise HTTPException(status_code=400, detail="Google OAuth credentials not configured in server environment")
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post("https://oauth2.googleapis.com/token", data={
                "code": data.code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            })
            resp.raise_for_status()
            tokens = resp.json()
    except Exception as e:
        logger.error(f"Google OAuth token exchange error: {e}")
        raise HTTPException(status_code=502, detail=f"Token exchange failed: {e}")

    doc = {
        "platform": "google",
        "customer_id": data.customer_id.replace("-", ""),
        "refresh_token_encrypted": encrypt_field(tokens.get("refresh_token", "")),
        "developer_token": os.environ.get("GOOGLE_ADS_DEVELOPER_TOKEN", ""),
        "connected_at": datetime.now(timezone.utc).isoformat(),
        "connected_by": current_user.get("email", ""),
    }
    await db.ads_credentials.update_one({"platform": "google"}, {"$set": doc}, upsert=True)
    logger.info(f"Google Ads connected by {current_user.get('email')}")
    return {"success": True, "message": "Google Ads account connected"}

async def _google_ads_get_access_token(creds: dict) -> str:
    """Exchange refresh token for a fresh access token."""
    client_id     = os.environ.get("GOOGLE_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post("https://oauth2.googleapis.com/token", data={
            "refresh_token": creds.get("refresh_token", ""),
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "refresh_token",
        })
        resp.raise_for_status()
        return resp.json().get("access_token", "")

async def _google_ads_query(creds: dict, gaql: str) -> list:
    """Run a GAQL query against the Google Ads REST API."""
    access_token   = await _google_ads_get_access_token(creds)
    customer_id    = creds.get("customer_id", "")
    developer_token = creds.get("developer_token", "") or os.environ.get("GOOGLE_ADS_DEVELOPER_TOKEN", "")
    url = f"https://googleads.googleapis.com/v17/customers/{customer_id}/googleAds:searchStream"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "developer-token": developer_token,
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, headers=headers, json={"query": gaql})
        resp.raise_for_status()
        rows = []
        for chunk in resp.json():
            rows.extend(chunk.get("results", []))
        return rows

@api_router.get("/ads/google/campaigns")
async def google_ads_campaigns(current_user: dict = Depends(require_editor)):
    """Fetch campaigns via Google Ads API (REST/GAQL)."""
    creds = await _get_ads_credentials("google")
    gaql = """
        SELECT
          campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
          campaign.target_spend.target_spend_micros,
          metrics.impressions, metrics.clicks, metrics.ctr,
          metrics.average_cpc, metrics.conversions, metrics.cost_micros
        FROM campaign
        WHERE segments.date DURING LAST_30_DAYS
        ORDER BY metrics.impressions DESC
        LIMIT 50
    """
    try:
        rows = await _google_ads_query(creds, gaql)
    except httpx.HTTPStatusError as e:
        logger.error(f"Google Ads campaigns API error: {e.response.text}")
        raise HTTPException(status_code=502, detail=f"Google Ads API error: {e.response.status_code}")
    except Exception as e:
        logger.error(f"Google Ads campaigns fetch error: {e}")
        raise HTTPException(status_code=502, detail=str(e))

    campaigns = []
    for row in rows:
        c = row.get("campaign", {})
        m = row.get("metrics", {})
        cost = float(m.get("costMicros", 0) or 0) / 1_000_000
        daily_budget = float(c.get("targetSpend", {}).get("targetSpendMicros", 0) or 0) / 1_000_000
        campaigns.append({
            "id": str(c.get("id", "")),
            "name": c.get("name", ""),
            "status": c.get("status", "UNKNOWN"),
            "type": c.get("advertisingChannelType", ""),
            "daily_budget": daily_budget,
            "impressions": int(m.get("impressions", 0) or 0),
            "clicks": int(m.get("clicks", 0) or 0),
            "ctr": float(m.get("ctr", 0) or 0),
            "avg_cpc": float(m.get("averageCpc", 0) or 0) / 1_000_000,
            "conversions": float(m.get("conversions", 0) or 0),
            "cost": cost,
        })
    await db.ads_campaigns_cache.update_one(
        {"platform": "google"},
        {"$set": {"campaigns": campaigns, "updated_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    return {"campaigns": campaigns}

@api_router.post("/ads/google/generate-campaign")
async def google_ads_generate(data: AdCampaignRequest, current_user: dict = Depends(require_editor)):
    """Use AI to generate a Google Ads campaign structure."""
    prompt = f"""Generate a complete Google Ads Search campaign structure for:

Landing Page: {data.landing_url}
Keywords to target: {data.keywords or "auto-suggest based on landing page"}
Goal: {data.goal}
Daily Budget: ${data.budget_daily}
Location: {data.location}

Return ONLY valid JSON matching this exact structure:
{{
  "campaign_name": "...",
  "bidding_strategy": "MAXIMIZE_CONVERSIONS|TARGET_CPA|MANUAL_CPC",
  "landing_url": "{data.landing_url}",
  "ad_groups": [
    {{
      "name": "...",
      "keywords": [
        {{"text": "...", "match_type": "EXACT|PHRASE|BROAD"}},
        ... (at least 10 keywords total across all ad groups)
      ],
      "ads": [
        {{
          "headlines": ["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10", "H11", "H12", "H13", "H14", "H15"],
          "descriptions": ["D1", "D2", "D3", "D4"]
        }}
      ]
    }}
  ]
}}

Create 2-3 tightly themed ad groups. All headlines max 30 chars, descriptions max 90 chars."""
    result = await _ads_ai_generate(prompt)
    logger.info(f"Google campaign generated for: {data.landing_url}")
    return result

@api_router.post("/ads/google/create-campaign")
async def google_ads_create(data: dict = Body(...), current_user: dict = Depends(require_editor)):
    """Create a Google Ads campaign via the REST API."""
    creds = await _get_ads_credentials("google")
    try:
        access_token    = await _google_ads_get_access_token(creds)
        customer_id     = creds.get("customer_id", "")
        developer_token = creds.get("developer_token", "") or os.environ.get("GOOGLE_ADS_DEVELOPER_TOKEN", "")
        base_url = f"https://googleads.googleapis.com/v17/customers/{customer_id}"
        headers = {
            "Authorization": f"Bearer {access_token}",
            "developer-token": developer_token,
            "Content-Type": "application/json",
        }
        created = {"campaign_id": None, "ad_groups": []}

        async with httpx.AsyncClient(timeout=60) as client:
            # 1. Create budget
            budget_resp = await client.post(f"{base_url}/campaignBudgets:mutate", headers=headers, json={
                "operations": [{"create": {
                    "name": f"{data.get('campaign_name','AI Campaign')} Budget",
                    "amountMicros": str(int(data.get("budget_daily", 20) * 1_000_000)),
                    "deliveryMethod": "STANDARD",
                }}]
            })
            budget_data = budget_resp.json()
            budget_resource = budget_data.get("results", [{}])[0].get("resourceName", "")

            # 2. Create campaign
            camp_resp = await client.post(f"{base_url}/campaigns:mutate", headers=headers, json={
                "operations": [{"create": {
                    "name": data.get("campaign_name", "AI Generated Campaign"),
                    "advertisingChannelType": "SEARCH",
                    "status": "PAUSED",
                    "campaignBudget": budget_resource,
                    "biddingStrategyType": data.get("bidding_strategy", "MAXIMIZE_CONVERSIONS"),
                    "networkSettings": {"targetGoogleSearch": True, "targetSearchNetwork": True},
                }}]
            })
            camp_data = camp_resp.json()
            camp_resource = camp_data.get("results", [{}])[0].get("resourceName", "")
            created["campaign_id"] = camp_resource

            # 3. Create ad groups, keywords, and ads
            for ag in (data.get("ad_groups") or []):
                ag_resp = await client.post(f"{base_url}/adGroups:mutate", headers=headers, json={
                    "operations": [{"create": {
                        "name": ag.get("name", "Ad Group"),
                        "campaign": camp_resource,
                        "status": "ENABLED",
                        "type": "SEARCH_STANDARD",
                    }}]
                })
                ag_data = ag_resp.json()
                ag_resource = ag_data.get("results", [{}])[0].get("resourceName", "")
                created["ad_groups"].append(ag_resource)

                # Keywords
                kw_ops = [{"create": {
                    "adGroup": ag_resource,
                    "text": kw.get("text", ""),
                    "matchType": kw.get("match_type", "BROAD"),
                }} for kw in (ag.get("keywords") or [])]
                if kw_ops:
                    await client.post(f"{base_url}/adGroupCriteria:mutate", headers=headers, json={"operations": kw_ops})

                # Responsive search ads
                for ad in (ag.get("ads") or []):
                    headlines = [{"text": h, "pinnedField": None} for h in (ad.get("headlines") or [])[:15]]
                    descriptions = [{"text": d, "pinnedField": None} for d in (ad.get("descriptions") or [])[:4]]
                    await client.post(f"{base_url}/adGroupAds:mutate", headers=headers, json={
                        "operations": [{"create": {
                            "adGroup": ag_resource,
                            "status": "ENABLED",
                            "ad": {
                                "responsiveSearchAd": {
                                    "headlines": headlines,
                                    "descriptions": descriptions,
                                    "finalUrls": [data.get("landing_url", "https://example.com")],
                                },
                            },
                        }}]
                    })
    except httpx.HTTPStatusError as e:
        logger.error(f"Google Ads create-campaign API error: {e.response.text}")
        raise HTTPException(status_code=502, detail=f"Google Ads API error: {e.response.text[:300]}")
    except Exception as e:
        logger.error(f"Google Ads create-campaign error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    await log_activity("global", "google_ads_created", f"Created Google campaign: {data.get('campaign_name')}")
    return {"success": True, "created": created}

@api_router.put("/ads/google/campaign/{campaign_id}/pause")
async def google_ads_pause(campaign_id: str, current_user: dict = Depends(require_editor)):
    creds = await _get_ads_credentials("google")
    try:
        access_token    = await _google_ads_get_access_token(creds)
        customer_id     = creds.get("customer_id", "")
        developer_token = creds.get("developer_token", "") or os.environ.get("GOOGLE_ADS_DEVELOPER_TOKEN", "")
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(
                f"https://googleads.googleapis.com/v17/customers/{customer_id}/campaigns:mutate",
                headers={"Authorization": f"Bearer {access_token}", "developer-token": developer_token, "Content-Type": "application/json"},
                json={"operations": [{"update": {"resourceName": f"customers/{customer_id}/campaigns/{campaign_id}", "status": "PAUSED"}, "updateMask": "status"}]},
            )
            r.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"success": True}

@api_router.put("/ads/google/campaign/{campaign_id}/resume")
async def google_ads_resume(campaign_id: str, current_user: dict = Depends(require_editor)):
    creds = await _get_ads_credentials("google")
    try:
        access_token    = await _google_ads_get_access_token(creds)
        customer_id     = creds.get("customer_id", "")
        developer_token = creds.get("developer_token", "") or os.environ.get("GOOGLE_ADS_DEVELOPER_TOKEN", "")
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(
                f"https://googleads.googleapis.com/v17/customers/{customer_id}/campaigns:mutate",
                headers={"Authorization": f"Bearer {access_token}", "developer-token": developer_token, "Content-Type": "application/json"},
                json={"operations": [{"update": {"resourceName": f"customers/{customer_id}/campaigns/{campaign_id}", "status": "ENABLED"}, "updateMask": "status"}]},
            )
            r.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"success": True}

@api_router.delete("/ads/google/campaign/{campaign_id}")
async def google_ads_delete_campaign(campaign_id: str, current_user: dict = Depends(require_editor)):
    creds = await _get_ads_credentials("google")
    try:
        access_token    = await _google_ads_get_access_token(creds)
        customer_id     = creds.get("customer_id", "")
        developer_token = creds.get("developer_token", "") or os.environ.get("GOOGLE_ADS_DEVELOPER_TOKEN", "")
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(
                f"https://googleads.googleapis.com/v17/customers/{customer_id}/campaigns:mutate",
                headers={"Authorization": f"Bearer {access_token}", "developer-token": developer_token, "Content-Type": "application/json"},
                json={"operations": [{"remove": f"customers/{customer_id}/campaigns/{campaign_id}"}]},
            )
            r.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"success": True}

@api_router.get("/ads/google/search-terms")
async def google_ads_search_terms(current_user: dict = Depends(require_editor)):
    """Fetch search term report via GAQL."""
    creds = await _get_ads_credentials("google")
    gaql = """
        SELECT
          search_term_view.search_term,
          campaign.name, campaign.id,
          metrics.impressions, metrics.clicks, metrics.cost_micros
        FROM search_term_view
        WHERE segments.date DURING LAST_30_DAYS
          AND metrics.impressions > 0
        ORDER BY metrics.impressions DESC
        LIMIT 100
    """
    try:
        rows = await _google_ads_query(creds, gaql)
    except Exception as e:
        logger.error(f"Google search terms error: {e}")
        raise HTTPException(status_code=502, detail=str(e))

    terms = []
    for row in rows:
        stv = row.get("searchTermView", {})
        c   = row.get("campaign", {})
        m   = row.get("metrics", {})
        terms.append({
            "search_term": stv.get("searchTerm", ""),
            "campaign_name": c.get("name", ""),
            "campaign_id": str(c.get("id", "")),
            "impressions": int(m.get("impressions", 0) or 0),
            "clicks": int(m.get("clicks", 0) or 0),
            "cost": float(m.get("costMicros", 0) or 0) / 1_000_000,
        })
    return {"terms": terms}

@api_router.post("/ads/google/negative-keyword")
async def google_ads_negative_keyword(data: AdsNegativeKeywordRequest, current_user: dict = Depends(require_editor)):
    """Add a negative keyword to a campaign."""
    creds = await _get_ads_credentials("google")
    try:
        access_token    = await _google_ads_get_access_token(creds)
        customer_id     = creds.get("customer_id", "")
        developer_token = creds.get("developer_token", "") or os.environ.get("GOOGLE_ADS_DEVELOPER_TOKEN", "")
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(
                f"https://googleads.googleapis.com/v17/customers/{customer_id}/campaignCriteria:mutate",
                headers={"Authorization": f"Bearer {access_token}", "developer-token": developer_token, "Content-Type": "application/json"},
                json={"operations": [{"create": {
                    "campaign": f"customers/{customer_id}/campaigns/{data.campaign_id}",
                    "negative": True,
                    "keyword": {"text": data.keyword, "matchType": "BROAD"},
                }}]},
            )
            r.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"success": True, "keyword": data.keyword}

@api_router.post("/ads/google/bid-suggestions")
async def google_ads_bid_suggestions(data: AdsBidSuggestionsRequest, current_user: dict = Depends(require_editor)):
    """Use AI to analyze campaign data and suggest bid adjustments."""
    campaigns_text = json.dumps(data.campaigns or [], indent=2)[:3000]
    prompt = f"""You are a Google Ads optimization expert. Analyze these campaign metrics and provide specific bid adjustment suggestions:

{campaigns_text}

Return ONLY valid JSON:
{{
  "suggestions": [
    {{
      "campaign_name": "...",
      "suggestions": [
        "Increase mobile bid by 20% — mobile CTR is 2.3x desktop",
        "Reduce tablet bid by 15% — conversions near zero",
        "Boost bids during 9am-12pm — peak conversion window",
        "..."
      ]
    }}
  ]
}}

Be specific with percentages and reasoning based on the actual data provided."""
    result = await _ads_ai_generate(prompt)
    return result

# ── ADS AUTOPILOT SCHEDULER ───────────────────────────────────────

async def _ads_autopilot_check():
    """Every 6h: check for top-performing posts and auto-create ad campaigns."""
    try:
        settings_cursor = db.ads_autopilot_settings.find({"enabled": True})
        async for setting in settings_cursor:
            site_id     = setting.get("site_id")
            platform    = setting.get("platform", "meta")
            threshold   = int(setting.get("pageview_threshold", 500))
            max_budget  = float(setting.get("max_daily_budget", 20.0))

            # Get site info
            site = await db.sites.find_one({"id": site_id}, {"_id": 0}) if site_id else None
            if not site:
                continue

            try:
                # Check for active campaigns cache to avoid duplicates
                cache = await db.ads_campaigns_cache.find_one({"platform": platform}) or {}
                active_campaign_names = {c.get("name", "").lower() for c in cache.get("campaigns", [])}

                # Find top posts (simplified: look at posts with high view counts)
                posts_cursor = db.posts_cache.find({"site_id": site_id}).sort("view_count", -1).limit(5)
                async for post in posts_cursor:
                    view_count = post.get("view_count", 0)
                    if view_count < threshold:
                        continue
                    post_title = post.get("title", "")
                    post_url   = post.get("url", post.get("link", ""))
                    # Skip if already has a campaign
                    if post_title.lower() in active_campaign_names:
                        continue

                    logger.info(f"Ads autopilot: auto-boosting '{post_title}' ({view_count} views) on {platform}")
                    # Generate campaign via AI
                    gen_data = AdCampaignRequest(
                        site_id=site_id,
                        platform=platform,
                        description=f"Promote blog post: {post_title}",
                        audience="Blog readers interested in this topic",
                        goal="OUTCOME_TRAFFIC",
                        budget_daily=min(max_budget, 10.0),
                        duration_days=7,
                        landing_url=post_url,
                    )
                    try:
                        if platform == "meta":
                            generated = await meta_ads_generate(gen_data, current_user={"email": "autopilot"})
                            # Auto-create (paused for safety)
                            await meta_ads_create({**generated, "ads": generated.get("ads", [])[:1]}, current_user={"email": "autopilot"})
                        elif platform == "google":
                            generated = await google_ads_generate(gen_data, current_user={"email": "autopilot"})
                            await google_ads_create({**generated, "landing_url": post_url, "budget_daily": min(max_budget, 10.0)}, current_user={"email": "autopilot"})

                        # SSE notify if site has listeners
                        if site_id and site_id in autopilot_sse_queues:
                            for q in autopilot_sse_queues[site_id]:
                                await q.put({"type": "ads_autopilot", "message": f"Auto-created {platform} campaign for: {post_title}"})
                    except Exception as camp_err:
                        logger.error(f"Ads autopilot campaign creation error: {camp_err}")
            except Exception as site_err:
                logger.error(f"Ads autopilot site error ({site_id}): {site_err}")
    except Exception as e:
        logger.error(f"Ads autopilot scheduler error: {e}")
