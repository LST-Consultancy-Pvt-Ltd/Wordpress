"""Full Page SEO Optimizer: runs a deep AI SEO audit on a single live page,
returning before/after values for all meta fields (title, description, OG, schema)
plus a full action plan (headings, content, internal links, images, technical, off-page).

Current values come from the rendered HTML of the public URL — what search
engines actually receive — not from any CMS field.
"""
import json
import logging

import httpx
from bs4 import BeautifulSoup
from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field

from core.activity import log_activity
from core.ai import get_ai_response
from core.db import db
from core.http_headers import BROWSER_HEADERS
from core.router import api_router
from core.safe_fetch import SSRF_GUARD
from core.security import require_editor
from providers.seo_audit import route_path
from providers.sites import get_site

logger = logging.getLogger(__name__)


class FullPageAuditRequest(BaseModel):
    path: str = Field(min_length=1, max_length=2000)  # route ("/about") or full URL on the site


def _meta(soup: BeautifulSoup, **attrs) -> str:
    tag = soup.find("meta", attrs=attrs)
    return (tag.get("content") or "").strip() if tag else ""


@api_router.post("/seo/full-page-audit/{site_id}")
async def full_page_seo_audit(
    site_id: str,
    data: FullPageAuditRequest,
    _: dict = Depends(require_editor),
):
    """Run a deep AI SEO audit on a single page, returning before/after for all
    meta fields (title, description, OG, schema) plus a full action plan."""
    site = await get_site(site_id)
    base = site["base_url"].rstrip("/")
    raw = data.path.strip()
    route = route_path(raw) if "://" in raw else route_path(base + (raw if raw.startswith("/") else "/" + raw))
    page_url = f"{base}{route if route != '/' else ''}" or base
    try:
        async with httpx.AsyncClient(event_hooks=SSRF_GUARD, timeout=20, follow_redirects=True, headers=BROWSER_HEADERS) as client:
            resp = await client.get(page_url)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Could not fetch {page_url}: {type(e).__name__}")
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"{page_url} returned HTTP {resp.status_code}")

    soup = BeautifulSoup(resp.text, "html.parser")
    title = soup.title.get_text(strip=True) if soup.title else ""
    current_meta_title = title
    current_meta_desc = _meta(soup, name="description")
    current_og_title = _meta(soup, property="og:title") or current_meta_title
    current_og_desc = _meta(soup, property="og:description") or current_meta_desc
    schema_raw = "\n".join(t.get_text() for t in soup.find_all("script", attrs={"type": "application/ld+json"}))[:4000]
    for tag in soup(["script", "style", "noscript", "head"]):
        tag.decompose()
    text_content = (soup.find("main") or soup.body or soup).get_text(separator=" ", strip=True)[:4000]

    # Other pages for internal-link context: latest audit, else synced content.
    audit_doc = await db.onpage_audits.find_one({"site_id": site_id}, {"_id": 0, "pages.url": 1,
                                                                         "pages.signals.title": 1},
                                                sort=[("created_at", -1)])
    other_pages = [{"title": (p.get("signals") or {}).get("title", ""), "url": p["url"]}
                   for p in (audit_doc or {}).get("pages", []) if p.get("url") and p["url"] != page_url]
    if not other_pages:
        other_pages = [{"title": d.get("title", ""), "url": d["url"]} for d in await db.content_items.find(
            {"site_id": site_id, "url": {"$nin": [None, "", page_url]}}, {"_id": 0, "title": 1, "url": 1}).to_list(30)]
    other_pages_json = json.dumps(other_pages[:30], ensure_ascii=False)

    prompt = f"""You are a world-class SEO expert. Perform a comprehensive SEO audit of the following web page and return ONLY a valid JSON object.

PAGE DATA:
- URL: {page_url}
- Current Title Tag: {title}
- Current Meta Title: {current_meta_title}
- Current Meta Description: {current_meta_desc}
- Current OG Title: {current_og_title}
- Current OG Description: {current_og_desc}
- Current Schema JSON-LD: {schema_raw or "None"}
- Page Content (excerpt): {text_content}

OTHER PAGES ON SITE (for internal linking suggestions):
{other_pages_json}

Return a JSON object with this exact structure:
{{
  "overall_score": <integer 0-100>,
  "score_breakdown": {{
    "content_quality": <integer>,
    "keyword_optimization": <integer>,
    "technical_seo": <integer>,
    "user_experience": <integer>,
    "off_page": <integer>
  }},
  "search_intent": "<informational|transactional|navigational|commercial>",
  "primary_keyword": "<main target keyword>",
  "secondary_keywords": ["<kw1>", "<kw2>", "<kw3>"],
  "missing_keywords": ["<kw1>", "<kw2>"],
  "meta_title": {{
    "before": "<current meta title>",
    "after": "<improved title 50-60 chars keyword-rich>",
    "reason": "<why this improves CTR and ranking>"
  }},
  "meta_description": {{
    "before": "<current meta description>",
    "after": "<improved description 150-160 chars compelling with CTA>",
    "reason": "<why this improves CTR>"
  }},
  "og_title": {{
    "before": "<current OG title>",
    "after": "<improved OG title for social sharing>",
    "reason": "<why>"
  }},
  "og_description": {{
    "before": "<current OG description>",
    "after": "<improved OG description>",
    "reason": "<why>"
  }},
  "schema_markup": {{
    "before": "<current schema JSON-LD string or None>",
    "after": "<complete JSON-LD schema markup as a JSON string>",
    "reason": "<why this schema type improves rich results>"
  }},
  "heading_issues": [
    {{"issue": "<heading problem>", "suggestion": "<how to fix>", "priority": "high|medium|low"}}
  ],
  "content_recommendations": [
    {{"recommendation": "<actionable suggestion>", "priority": "high|medium|low"}}
  ],
  "internal_link_opportunities": [
    {{"anchor_text": "<suggested anchor text>", "target_url": "<URL from other pages>", "target_title": "<page title>", "reason": "<why>"}}
  ],
  "image_seo_issues": [
    {{"issue": "<problem>", "fix": "<solution>"}}
  ],
  "technical_issues": [
    {{"issue": "<technical SEO problem>", "fix": "<how to fix>", "priority": "high|medium|low"}}
  ],
  "off_page_strategy": {{
    "backlink_opportunities": ["<link building opportunity 1>", "<opportunity 2>"],
    "guest_posting_sites": ["<relevant site category or name>"],
    "outreach_email_template": "<complete outreach email with subject line and body>",
    "social_signal_ideas": ["<social media content idea 1>", "<idea 2>"]
  }},
  "action_plan": [
    {{"priority": 1, "task": "<specific actionable task>", "type": "quick_win|long_term", "impact": "high|medium|low"}}
  ]
}}

Return ONLY the JSON object. No markdown fences, no explanation."""

    try:
        raw = await get_ai_response(
            [
                {
                    "role": "system",
                    "content": "You are an expert SEO strategist. Always respond with valid JSON only, no markdown.",
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.3,
            max_tokens=4000,
        )
        if "```json" in raw:
            raw = raw.split("```json")[1].split("```")[0]
        elif "```" in raw:
            raw = raw.split("```")[1].split("```")[0]
        audit = json.loads(raw.strip())
    except Exception as e:
        logger.error(f"Full page SEO audit AI error: {e}")
        raise HTTPException(
            status_code=502,
            detail=f"AI audit generation failed: {str(e)[:200]}"
        )

    # Overwrite before values with what the live page actually serves
    audit.setdefault("meta_title", {})["before"] = current_meta_title
    audit.setdefault("meta_description", {})["before"] = current_meta_desc
    audit.setdefault("og_title", {})["before"] = current_og_title
    audit.setdefault("og_description", {})["before"] = current_og_desc
    audit.setdefault("schema_markup", {})["before"] = schema_raw or "None"

    # Attach context needed for frontend apply calls
    audit["route"] = route
    audit["page_url"] = page_url
    audit["page_title"] = title

    await log_activity(
        site_id, "full_page_seo_audit",
        f"Full SEO audit for {page_url}"
    )
    return audit
