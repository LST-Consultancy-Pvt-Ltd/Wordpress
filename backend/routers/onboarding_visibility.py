"""Smart Onboarding (scrape a site's meta/hero text into a business description
+ audience, AI topic suggestions, save onboarding fields).
"""
import json
import logging
from typing import List, Optional

import httpx
from bs4 import BeautifulSoup
from fastapi import Depends, HTTPException
from pydantic import BaseModel

from core.ai import get_ai_response
from core.db import db
from core.router import api_router
from core.security import require_editor

logger = logging.getLogger(__name__)

# ========================
# FEATURE 1: Smart Onboarding – Scrape Meta + Topic Suggestions
# ========================

class ScrapMetaRequest(BaseModel):
    url: str

class SuggestTopicsRequest(BaseModel):
    description: str
    target_audience: str

class SaveOnboardingRequest(BaseModel):
    description: Optional[str] = None
    target_audience: Optional[str] = None
    content_topics: Optional[List[str]] = None

@api_router.post("/sites/scrape-meta")
async def scrape_site_meta(data: ScrapMetaRequest):
    """Scrape website to extract business description and target audience."""
    # User-supplied URL fetched server-side: public https hosts only (SSRF guard).
    from urllib.parse import urlsplit
    from core.url_policy import resolves_public_only
    target = urlsplit(data.url.strip())
    if target.scheme != "https" or not target.hostname or not resolves_public_only(target.hostname):
        raise HTTPException(status_code=400, detail="Only public https URLs can be scraped")
    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=False) as client:
            resp = await client.get(data.url.rstrip("/"), headers={"User-Agent": "Mozilla/5.0 (compatible; SiteAutopilot/1.0)"})
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Could not fetch {data.url}: HTTP {resp.status_code}")
        soup = BeautifulSoup(resp.text, "html.parser")
        meta_desc = ""
        og = soup.find("meta", property="og:description")
        if og:
            meta_desc = og.get("content", "")
        if not meta_desc:
            mt = soup.find("meta", attrs={"name": "description"})
            if mt:
                meta_desc = mt.get("content", "")
        hero_text = " ".join(t.get_text(strip=True) for t in soup.find_all("h1")[:3])
        if not hero_text:
            hero_text = " ".join(t.get_text(strip=True) for t in soup.find_all("h2")[:3])
        combined = f"{meta_desc} {hero_text}"[:2000]
        try:
            ai_raw = await get_ai_response([{"role": "user", "content": (
                f"Based on this website content extract concisely:\n"
                f"1. company/product/service description (max 300 chars)\n"
                f"2. target audience (max 200 chars)\n\n"
                f"Website text: {combined}\n\n"
                f'Respond as JSON: {{"description": "...", "target_audience": "..."}}'
            )}], max_tokens=300, temperature=0.3)
            for fence in ["```json", "```"]:
                if fence in ai_raw:
                    ai_raw = ai_raw.split(fence)[1].split("```")[0]
                    break
            result = json.loads(ai_raw.strip())
            return {"description": result.get("description", ""), "target_audience": result.get("target_audience", "")}
        except Exception:
            return {"description": meta_desc[:300] or hero_text[:300], "target_audience": ""}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@api_router.post("/sites/suggest-topics")
async def suggest_content_topics(data: SuggestTopicsRequest, _: dict = Depends(require_editor)):
    ai_raw = await get_ai_response([{"role": "user", "content": (
        f"Generate exactly 6 specific blog/article topic ideas for:\nDescription: {data.description}\nAudience: {data.target_audience}\n\n"
        f'Respond as JSON: {{"topics": ["Topic 1", "Topic 2", "Topic 3", "Topic 4", "Topic 5", "Topic 6"]}}'
    )}], max_tokens=400, temperature=0.7)
    for fence in ["```json", "```"]:
        if fence in ai_raw:
            ai_raw = ai_raw.split(fence)[1].split("```")[0]
            break
    return json.loads(ai_raw.strip())

@api_router.put("/sites/{site_id}/onboarding")
async def save_site_onboarding(site_id: str, data: SaveOnboardingRequest, _: dict = Depends(require_editor)):
    update_fields: dict = {}
    if data.description is not None:
        update_fields["description"] = data.description
    if data.target_audience is not None:
        update_fields["target_audience"] = data.target_audience
    if data.content_topics is not None:
        update_fields["content_topics"] = data.content_topics
    if update_fields:
        await db.sites.update_one({"id": site_id}, {"$set": update_fields})
    return {"ok": True}
