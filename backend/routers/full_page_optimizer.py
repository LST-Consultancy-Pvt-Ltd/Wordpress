"""Full Page SEO Optimizer: runs a deep AI SEO audit on a single WordPress page,
returning before/after values for all meta fields (title, description, OG, schema)
plus a full action plan (headings, content, internal links, images, technical, off-page).
"""
import json
import logging

from bs4 import BeautifulSoup
from fastapi import Depends, HTTPException
from pydantic import BaseModel

from core.activity import log_activity
from core.ai import get_ai_response
from core.router import api_router
from core.security import require_editor
from providers.wordpress import get_wp_credentials, wp_api_request

logger = logging.getLogger(__name__)

# Full Page SEO Optimizer
# ========================

class FullPageAuditRequest(BaseModel):
    wp_id: int
    content_type: str  # "post" | "page"


@api_router.post("/seo/full-page-audit/{site_id}")
async def full_page_seo_audit(
    site_id: str,
    data: FullPageAuditRequest,
    _: dict = Depends(require_editor),
):
    """Run a deep AI SEO audit on a single WordPress page, returning before/after for all
    meta fields (title, description, OG, schema) plus a full action plan."""
    site = await get_wp_credentials(site_id)
    ct_plural = "pages" if data.content_type == "page" else "posts"
    wp_id = data.wp_id

    # Fetch page from WordPress REST API including meta, Yoast head JSON, and raw Yoast head HTML
    # We request both yoast_head_json (structured) and yoast_head (HTML) so we can parse
    # the actual <title> and <meta name="description"> that Yoast renders — these reflect the
    # true current values even when _yoast_wpseo_* custom fields are not exposed via REST meta.
    ep = f"{ct_plural}/{wp_id}?context=edit&_fields=id,slug,link,title,content,meta,yoast_head_json,yoast_head"
    resp = await wp_api_request(site, "GET", ep)
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch page from WordPress: {resp.text[:200]}"
        )
    page_data = resp.json()

    title_obj = page_data.get("title", {})
    title = title_obj.get("rendered", "") if isinstance(title_obj, dict) else str(title_obj)

    content_obj = page_data.get("content", {})
    raw_html = (
        content_obj.get("raw") or content_obj.get("rendered") or ""
        if isinstance(content_obj, dict) else str(content_obj)
    )
    soup = BeautifulSoup(raw_html, "html.parser")
    text_content = soup.get_text(separator=" ", strip=True)[:4000]

    meta = page_data.get("meta") or {}
    yoast_head = page_data.get("yoast_head_json") or {}

    # Parse Yoast-rendered HTML head to reliably extract SEO title + description.
    # Yoast's _yoast_wpseo_* meta fields are often blocked by auth_callback in the REST API
    # even when the values are correctly stored in wp_postmeta, so the HTML head is the
    # ground-truth for what Yoast actually outputs on the page.
    yoast_seo_title = ""
    yoast_seo_desc = ""
    yoast_head_html = page_data.get("yoast_head") or ""
    if yoast_head_html:
        head_soup = BeautifulSoup(yoast_head_html, "html.parser")
        title_tag = head_soup.find("title")
        if title_tag:
            yoast_seo_title = title_tag.get_text(strip=True)
        desc_tag = head_soup.find("meta", attrs={"name": "description"})
        if desc_tag:
            yoast_seo_desc = desc_tag.get("content", "")

    current_meta_title = (
        meta.get("_yoast_wpseo_title") or meta.get("rank_math_title")
        or yoast_head.get("title") or yoast_seo_title or title or ""
    )
    current_meta_desc = (
        meta.get("_yoast_wpseo_metadesc") or meta.get("rank_math_description")
        or yoast_seo_desc or ""
    )
    current_og_title = (
        meta.get("_yoast_wpseo_opengraph-title")
        or yoast_head.get("og_title")
        or current_meta_title
    )
    current_og_desc = (
        meta.get("_yoast_wpseo_opengraph-description")
        or yoast_head.get("og_description")
        or current_meta_desc
    )
    og_imgs = yoast_head.get("og_image")
    current_og_image = og_imgs[0].get("url", "") if isinstance(og_imgs, list) and og_imgs else ""  # noqa: F841
    schema_raw = meta.get("_auto_seo_schema_json") or ""
    page_url = page_data.get("link", "")

    # Fetch a sample of other pages for internal link context (up to 30)
    other_pages: list = []
    for other_ct in ("posts", "pages"):
        oresp = await wp_api_request(
            site, "GET",
            f"{other_ct}?per_page=50&status=publish&_fields=id,link,title&context=view"
        )
        if oresp.status_code == 200:
            for item in oresp.json():
                if item.get("id") != wp_id:
                    t = item.get("title", {})
                    other_pages.append({
                        "id": item.get("id"),
                        "title": t.get("rendered", "") if isinstance(t, dict) else str(t),
                        "url": item.get("link", ""),
                    })
    other_pages_json = json.dumps(other_pages[:30], ensure_ascii=False)

    prompt = f"""You are a world-class SEO expert. Perform a comprehensive SEO audit of the following WordPress page and return ONLY a valid JSON object.

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

    # Overwrite before values with actual current WordPress data
    audit.setdefault("meta_title", {})["before"] = current_meta_title
    audit.setdefault("meta_description", {})["before"] = current_meta_desc
    audit.setdefault("og_title", {})["before"] = current_og_title
    audit.setdefault("og_description", {})["before"] = current_og_desc
    audit.setdefault("schema_markup", {})["before"] = schema_raw or "None"

    # Attach context needed for frontend apply calls
    audit["wp_id"] = wp_id
    audit["content_type"] = data.content_type
    audit["page_url"] = page_url
    audit["page_title"] = title

    await log_activity(
        site_id, "full_page_seo_audit",
        f"Full SEO audit for {data.content_type} {wp_id} ({page_url})"
    )
    return audit
