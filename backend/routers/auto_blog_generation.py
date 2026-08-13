"""MODULE: Auto Blog Generation

AI-driven pipeline that generates multiple full-length blog posts (metadata +
long-form HTML content, optional DALL-E featured image, on-page SEO meta for
Yoast/RankMath/AIOSEO) and publishes them to WordPress, reporting progress via SSE.
"""
import json
import logging
import uuid
from datetime import datetime, timezone

from fastapi import BackgroundTasks, Depends
from pydantic import BaseModel, ConfigDict
from typing import List

from core.activity import log_activity
from core.ai import get_ai_response, get_openai_client
from core.json_utils import _repair_and_parse_json
from core.prompts import HUMANIZE_DIRECTIVE
from core.router import api_router
from core.security import require_editor
from core.tasks import make_task_id, create_task_queue, push_event, finish_task
from providers.wordpress import get_wp_credentials, wp_api_request, wp_upload_image, wp_xmlrpc_write, wp_xmlrpc_edit

logger = logging.getLogger(__name__)

# MODULE: Auto Blog Generation
# ─────────────────────────────────────────────────────────────

class AutoBlogRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    topic: str
    keywords: List[str] = []
    num_posts: int = 3
    writing_style: str = "Professional"
    post_status: str = "draft"
    auto_image: bool = True
    auto_seo: bool = True
    # Blog Generation Engine inputs
    target_country: str = "Global"
    target_audience: str = "SMB"          # SMB | Enterprise | Tech | Non-tech | Consumer
    primary_color: str = "#0A66C2"        # HEX
    secondary_color: str = ""             # HEX (optional)
    brand_name: str = ""
    tone: str = "Professional"            # Professional | Conversational | Technical
    word_count_min: int = 1200
    word_count_max: int = 2000

@api_router.post("/auto-blog-generation/{site_id}/generate")
async def generate_auto_blogs(site_id: str, data: AutoBlogRequest, background_tasks: BackgroundTasks, _=Depends(require_editor)):
    """Generate multiple blog posts with AI using SSE progress"""
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_auto_blog_worker, task_id, site_id, data)
    return {"task_id": task_id}

def _parse_blog_ai_output(raw: str) -> tuple[dict, str]:
    """Parse the AI's blog response. Supports two formats:

    1. NEW (preferred) — sentinel-delimited:
         <<<JSON_META>>> {...} <<<END_JSON_META>>>
         <<<HTML_CONTENT>>> ...html... <<<END_HTML_CONTENT>>>

    2. LEGACY — single JSON object containing a "content_html" string field.

    Tolerates: missing END sentinels, extra prose, code fences, smart quotes,
    trailing commas, raw newlines inside JSON string values.

    Returns: (post_data_dict, content_html_string)
    """
    import re as _re
    text = (raw or "").strip()
    meta: dict = {}
    html_body: str = ""

    # --- 1. Try to extract JSON block (sentinel form, with or without END) ---
    json_blob = ""
    m = _re.search(r"<<<JSON_META>>>(.*?)<<<END_JSON_META>>>", text, _re.DOTALL)
    if m:
        json_blob = m.group(1).strip()
        # remove the matched section so what remains can be searched for HTML
        remainder = text[:m.start()] + text[m.end():]
    else:
        # Try just the start sentinel — take until the next '}\n' that closes a balanced object
        m2 = _re.search(r"<<<JSON_META>>>(.*)", text, _re.DOTALL)
        if m2:
            tail = m2.group(1)
            json_blob, consumed = _extract_balanced_json(tail)
            remainder = text[:m2.start()] + tail[consumed:]
        else:
            remainder = text

    # --- 2. Try to extract HTML block ---
    h = _re.search(r"<<<HTML_CONTENT>>>(.*?)<<<END_HTML_CONTENT>>>", text, _re.DOTALL)
    if h:
        html_body = h.group(1).strip()
    else:
        h2 = _re.search(r"<<<HTML_CONTENT>>>(.*)", text, _re.DOTALL)
        if h2:
            html_body = h2.group(1).strip()

    # Strip code fences around HTML if present
    if html_body.startswith("```"):
        html_body = _re.sub(r"^```(?:html)?\s*", "", html_body)
        html_body = _re.sub(r"\s*```\s*$", "", html_body)
        html_body = html_body.strip()

    # --- 3. Parse the JSON metadata ---
    if json_blob:
        if json_blob.startswith("```"):
            json_blob = _re.sub(r"^```(?:json)?\s*|\s*```$", "", json_blob, flags=_re.MULTILINE).strip()
        try:
            meta = json.loads(json_blob)
        except Exception:
            meta = _repair_and_parse_json(json_blob)
    else:
        # No sentinel JSON — assume legacy: whole response is one JSON object
        legacy = text
        if "```json" in legacy:
            legacy = legacy.split("```json", 1)[1].split("```", 1)[0]
        elif legacy.startswith("```"):
            parts = legacy.split("```")
            if len(parts) >= 2:
                legacy = parts[1]
        legacy = legacy.strip()
        try:
            meta = json.loads(legacy)
        except Exception:
            meta = _repair_and_parse_json(legacy)

    # --- 4. If HTML still empty, try to recover ---
    if not html_body:
        # 4a. Legacy: HTML may be inside meta.content_html
        if isinstance(meta, dict) and meta.get("content_html"):
            html_body = meta.get("content_html") or ""
        else:
            # 4b. Look for raw HTML after the JSON object in the remainder
            tag_match = _re.search(r"(<(?:div|h1|h2|p|article|section|figure|header)[\s>][\s\S]+)", remainder, _re.IGNORECASE)
            if tag_match:
                html_body = tag_match.group(1).strip()
                # Strip a trailing fence if present
                if html_body.endswith("```"):
                    html_body = html_body.rsplit("```", 1)[0].strip()

    if not html_body:
        logger.error(
            "Blog parser produced empty content_html. "
            f"meta_keys={list(meta.keys()) if isinstance(meta, dict) else type(meta).__name__}. "
            f"Raw head: {(raw or '')[:600]!r}"
        )

    return meta if isinstance(meta, dict) else {}, html_body or ""


def _extract_balanced_json(s: str) -> tuple[str, int]:
    """From the start of `s`, return (json_text, chars_consumed) for the first
    balanced {...} object, or ("", 0) if not found."""
    start = s.find("{")
    if start == -1:
        return "", 0
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
        ch = s[i]
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return s[start:i + 1], i + 1
    return "", 0


# _repair_and_parse_json now lives in core/json_utils.py (imported at top of this file).


async def _write_seo_meta(site: dict, wp_id: int, post_data: dict, prefer_xmlrpc: bool = False) -> None:
    """Write on-page SEO meta to WordPress for Yoast, RankMath, and All in One SEO.

    Tries REST `meta` first (works if the SEO plugin registers fields with show_in_rest=true),
    then falls back to XML-RPC custom_fields (which writes directly to wp_postmeta — works
    for ALL SEO plugins regardless of REST registration).
    """
    if not wp_id:
        return

    meta_title = (post_data.get("meta_title") or post_data.get("title") or "").strip()
    meta_desc = (post_data.get("meta_description") or "").strip()
    focus_kw = (post_data.get("focus_keyword") or "").strip()
    secondary_kws = post_data.get("secondary_keywords", []) or []
    og_title = (post_data.get("og_title") or meta_title).strip()
    og_desc = (post_data.get("og_description") or meta_desc).strip()
    tw_title = (post_data.get("twitter_title") or meta_title).strip()
    tw_desc = (post_data.get("twitter_description") or meta_desc).strip()
    canonical_url = (post_data.get("url") or "").strip()

    # Build the unified meta map covering Yoast, RankMath, AIOSEO
    seo_meta = {
        # Yoast SEO
        "_yoast_wpseo_title": meta_title,
        "_yoast_wpseo_metadesc": meta_desc,
        "_yoast_wpseo_focuskw": focus_kw,
        "_yoast_wpseo_focuskeywords": json.dumps(
            [{"keyword": k, "score": ""} for k in secondary_kws]
        ) if secondary_kws else "",
        "_yoast_wpseo_opengraph-title": og_title,
        "_yoast_wpseo_opengraph-description": og_desc,
        "_yoast_wpseo_twitter-title": tw_title,
        "_yoast_wpseo_twitter-description": tw_desc,
        "_yoast_wpseo_canonical": canonical_url,
        "_yoast_wpseo_meta-robots-noindex": "0",
        "_yoast_wpseo_meta-robots-nofollow": "0",
        # RankMath
        "rank_math_title": meta_title,
        "rank_math_description": meta_desc,
        "rank_math_focus_keyword": ", ".join([focus_kw] + list(secondary_kws)).strip(", "),
        "rank_math_canonical_url": canonical_url,
        "rank_math_facebook_title": og_title,
        "rank_math_facebook_description": og_desc,
        "rank_math_twitter_title": tw_title,
        "rank_math_twitter_description": tw_desc,
        "rank_math_robots": ["index", "follow"],
        # All in One SEO (AIOSEO uses both legacy postmeta + a custom table; postmeta still helps)
        "_aioseo_title": meta_title,
        "_aioseo_description": meta_desc,
        "_aioseo_keywords": ", ".join([focus_kw] + list(secondary_kws)).strip(", "),
        "_aioseop_title": meta_title,
        "_aioseop_description": meta_desc,
        "_aioseop_keywords": ", ".join([focus_kw] + list(secondary_kws)).strip(", "),
    }
    # Drop empty values
    seo_meta = {k: v for k, v in seo_meta.items() if v not in (None, "", [])}

    rest_ok = False
    if not prefer_xmlrpc:
        # Attempt REST API meta write (works only for SEO plugins that register meta in REST)
        try:
            resp = await wp_api_request(site, "POST", f"posts/{wp_id}", {"meta": seo_meta})
            if resp.status_code in (200, 201):
                rest_ok = True
        except Exception:
            pass

    # XML-RPC custom_fields fallback — writes directly to wp_postmeta, bypassing REST registration.
    # This always works as long as the WP user has edit_post capability.
    try:
        custom_fields = []
        for key, val in seo_meta.items():
            if isinstance(val, list):
                val = ",".join(val)
            custom_fields.append({"key": key, "value": str(val)})
        await wp_xmlrpc_edit(site, wp_id, {"custom_fields": custom_fields})
    except Exception as xr_err:
        if not rest_ok:
            logger.warning(f"SEO meta XML-RPC write failed for post {wp_id}: {xr_err}")


async def _auto_blog_worker(task_id: str, site_id: str, data: AutoBlogRequest):
    try:
        site = await get_wp_credentials(site_id)
        posts = []
        keywords_str = ", ".join(data.keywords) if data.keywords else data.topic
        primary = (data.primary_color or "#0A66C2").strip()
        secondary = (data.secondary_color or "").strip()
        brand = (data.brand_name or site.get("name", "")).strip()

        # Pre-fetch existing WP categories & tags so we can map AI suggestions to IDs
        cat_map: dict = {}
        tag_map: dict = {}
        try:
            cats_resp = await wp_api_request(site, "GET", "categories?per_page=100")
            if cats_resp.status_code == 200:
                cat_map = {c["name"].lower(): c["id"] for c in cats_resp.json()}
            tags_resp = await wp_api_request(site, "GET", "tags?per_page=100")
            if tags_resp.status_code == 200:
                tag_map = {t["name"].lower(): t["id"] for t in tags_resp.json()}
        except Exception:
            pass

        async def _resolve_taxonomy(names: list[str], existing: dict, endpoint: str) -> list[int]:
            ids: list[int] = []
            for name in names:
                if not name or not isinstance(name, str):
                    continue
                key = name.strip().lower()
                if key in existing:
                    ids.append(existing[key])
                    continue
                try:
                    create_resp = await wp_api_request(site, "POST", endpoint, {"name": name.strip()})
                    if create_resp.status_code in (200, 201):
                        new_id = create_resp.json().get("id")
                        if new_id:
                            existing[key] = new_id
                            ids.append(new_id)
                except Exception:
                    pass
            return ids

        # Per-section word budget so the model knows exactly how much to write
        num_sections = 5
        words_per_section = max(200, (data.word_count_min - 300) // num_sections)  # 300w reserved for intro/FAQ/CTA/boxes
        words_per_subsection = max(80, words_per_section // 3)

        for i in range(data.num_posts):
            pct = int(((i) / data.num_posts) * 100)
            await push_event(task_id, "progress", {"message": f"Generating post {i+1}/{data.num_posts} — metadata...", "percent": pct})

            # ── CALL 1: Metadata JSON ──────────────────────────────────────
            meta_system = (
                "You are an SEO metadata expert. Return ONLY a single valid JSON object, "
                "no markdown fences, no commentary, nothing else."
            )
            meta_prompt = f"""Generate SEO metadata for a blog post.

Topic: {data.topic}
Target Country: {data.target_country}
Target Audience: {data.target_audience}
Brand: {brand or "(unbranded)"}
Keywords: {keywords_str}
Post variation: {i+1} of {data.num_posts} — unique angle

Return ONLY this JSON (no fences):
{{
  "title": "SEO title, under 65 chars, engaging",
  "meta_title": "under 60 chars, focus keyword near start",
  "slug": "kebab-case-url-slug",
  "meta_description": "max 155 chars, includes primary keyword",
  "focus_keyword": "single primary keyword phrase",
  "secondary_keywords": ["kw1", "kw2", "kw3"],
  "og_title": "under 70 chars",
  "og_description": "under 200 chars",
  "twitter_title": "under 70 chars",
  "twitter_description": "under 200 chars",
  "featured_image_prompt": "Detailed DALL-E prompt: modern SaaS illustration, 16:9, topic-relevant, brand color {primary}",
  "featured_image_alt": "under 125 chars, includes focus keyword",
  "featured_image_caption": "1 sentence",
  "tags": ["tag1","tag2","tag3","tag4","tag5"],
  "categories": ["primary-category"],
  "internal_link_suggestions": [{{"anchor_text":"...","topic_to_link_to":"..."}}],
  "external_link_suggestions": [{{"anchor_text":"...","url":"https://example.com","why":"..."}}],
  "schema_jsonld": {{
    "@context": "https://schema.org", "@type": "Article",
    "headline": "...", "description": "...",
    "author": {{"@type": "Organization", "name": "{brand or 'Editorial Team'}"}},
    "datePublished": "{datetime.now(timezone.utc).strftime('%Y-%m-%d')}",
    "keywords": "{keywords_str}"
  }},
  "social_captions": {{
    "linkedin": "Professional post, 3-5 sentences, 3-5 hashtags",
    "twitter": "under 270 chars, 2-3 hashtags"
  }}
}}"""

            try:
                meta_raw = await get_ai_response(
                    [{"role": "system", "content": meta_system},
                     {"role": "user", "content": meta_prompt}],
                    temperature=0.5,
                    max_tokens=1500,
                )
                import re as _re_meta
                # Strip code fences including language identifiers like ```json, ```html
                meta_raw = _re_meta.sub(r'^```[a-z]*\s*', '', meta_raw.lstrip(), flags=_re_meta.IGNORECASE)
                meta_raw = _re_meta.sub(r'\s*```\s*$', '', meta_raw.rstrip())
                # Strip stray language identifiers left at the start (e.g. 'html\n' or 'json\n')
                meta_raw = _re_meta.sub(r'^(html|json|text|markdown)\s*\n', '', meta_raw.lstrip(), flags=_re_meta.IGNORECASE)
                # Extract JSON object if there's surrounding prose
                j_start = meta_raw.find('{')
                j_end = meta_raw.rfind('}')
                if j_start != -1 and j_end > j_start:
                    meta_raw = meta_raw[j_start:j_end+1]
                try:
                    post_data = json.loads(meta_raw.strip())
                except Exception:
                    post_data = _repair_and_parse_json(meta_raw)
            except Exception as meta_err:
                logger.warning(f"Meta generation failed for post {i+1}: {meta_err}")
                post_data = {"title": f"{data.topic} — Guide {i+1}", "slug": f"guide-{i+1}"}

            await push_event(task_id, "progress", {"message": f"Post {i+1} — writing content ({data.word_count_min} words)...", "percent": pct + 5})

            # ── CALL 2: HTML Content ────────────────────────────────────────
            content_system = (
                "You are a real human expert and blogger — not an AI assistant. "
                "You have lived experience with this topic. You write like someone who has done this, "
                "failed at it, learned from it, and now wants to share what actually works. "
                "Your writing is warm, opinionated, slightly messy, and always specific. "
                "You do NOT sound like a content marketing bot or a corporate blog. "
                "You sound like a trusted colleague explaining something over coffee.\n\n"
                f"{HUMANIZE_DIRECTIVE}"
            )

            content_prompt = f"""I need you to write a long-form blog article. Your job is to WRITE — not to follow a template.

TOPIC: {data.topic}
AUDIENCE: {data.target_audience} in {data.target_country}
BRAND VOICE: {brand or '(none)'} — {data.tone} tone, {data.writing_style} style
KEYWORDS (use naturally in prose): {keywords_str}
TITLE TO USE: {post_data.get('title', data.topic)}

MINIMUM {data.word_count_min} WORDS OF READABLE TEXT. This is the only hard rule.
HTML tags don't count. Only the words a reader sees count.
Do not close the article until you've written at least {data.word_count_min} readable words.

WRITE LIKE A HUMAN — THE MOST IMPORTANT RULES:
- Your paragraphs must vary wildly in length. Some are 1 sentence. Some are 6. Never uniform.
- Tell AT LEAST 3 personal stories or real specific examples ("I remember when a client in {data.target_country} told me...", "Back in 2023 I tested this approach and...", "I'll be honest — I was sceptical until...")
- Have opinions. Say what you actually think. Disagree with common advice where relevant.
- Use contractions everywhere: don't, it's, you'll, we've, I'd, that's, here's
- Start sentences with: And, But, So, Look, Honestly, See, Actually, Here's the thing
- Throw in rhetorical questions and answer them yourself ("Why does this matter? Simple.")
- Use parenthetical asides: (Yeah, I know.), (Spoiler: it worked.), (Trust me on this.)
- Reference specific real tools, platforms, companies relevant to {data.topic}
- Include specific numbers and approximate costs/stats relevant to {data.target_country}

WHAT TO COVER (write each section as LONG NATURAL PROSE — not bullet summaries):
1. An opening that hooks the reader personally and sets up why this matters right now
2. Background / context — what's the landscape here, what most people get wrong
3. The core concepts — go deep, use sub-sections (H3), write multiple paragraphs per sub-section
4. Practical how-to — at least 5 concrete numbered steps, each with a real explanation (not just a one-liner)
5. Common mistakes and how to avoid them — be specific, share real examples
6. Tools, resources, costs — specific recommendations relevant to {data.target_country}
7. FAQ — 6 real questions people ask, with detailed answers (3-4 sentences each)
8. Wrap-up thoughts — what you'd do if starting over, final honest advice

SPRINKLE IN (where they feel natural — not forced):
- 1 Key Insight callout box when you hit an important non-obvious insight
- 1 Pro Tip callout box for a practical tactical tip
- A stats grid with 4 real-ish numbers/percentages relevant to the topic
- A summary box near the end
- A CTA at the very end

FORMATTING — inline styles only, no <style> or <script> tags:
Intro block: <div style="background:{primary}10;border-left:5px solid {primary};padding:20px 24px;border-radius:8px;margin:0 0 32px 0;"><p style="margin:0;font-size:17px;line-height:1.7;color:#1a1a1a;">text</p></div>
H2: <h2 style="color:{primary};font-size:28px;font-weight:700;margin:40px 0 16px;border-bottom:3px solid {primary};padding-bottom:8px;">Title</h2>
H3: <h3 style="color:#1a1a1a;font-size:22px;font-weight:600;margin:28px 0 12px;">Sub</h3>
P: <p style="font-size:16px;line-height:1.75;color:#333;margin:0 0 16px;">text</p>
HR: <hr style="border:none;height:1px;background:linear-gradient(to right,transparent,{primary}40,transparent);margin:40px 0;" />
Key Insight: <div style="background:linear-gradient(135deg,{primary}15,{primary}05);border:1px solid {primary}30;border-radius:12px;padding:24px;margin:28px 0;"><p style="margin:0 0 8px;font-weight:700;color:{primary};font-size:14px;letter-spacing:0.5px;text-transform:uppercase;">💡 Key Insight</p><p style="margin:0;font-size:16px;line-height:1.7;color:#222;">text</p></div>
Pro Tip: <div style="background:#fff8e1;border-left:4px solid #f5a623;border-radius:6px;padding:18px 22px;margin:24px 0;"><p style="margin:0 0 6px;font-weight:700;color:#b8860b;font-size:13px;text-transform:uppercase;">⚡ Pro Tip</p><p style="margin:0;font-size:15px;line-height:1.65;color:#333;">text</p></div>
Bullets: <ul style="list-style:none;padding:0;margin:16px 0 24px;"><li style="padding:8px 0 8px 28px;position:relative;font-size:16px;line-height:1.7;color:#333;"><span style="position:absolute;left:0;color:{primary};font-weight:700;">✓</span>text</li></ul>
Stats grid: <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin:24px 0 32px;"><div style="background:#f9f9f9;border-radius:10px;padding:20px;text-align:center;border-top:3px solid {primary};"><div style="font-size:32px;font-weight:800;color:{primary};line-height:1;">73%</div><div style="font-size:13px;color:#666;margin-top:6px;">label</div></div></div>
Step card: <div style="background:#fafbfc;border-radius:10px;padding:20px 24px;margin:14px 0;border-left:4px solid {primary};"><div style="display:flex;gap:14px;align-items:flex-start;"><div style="background:{primary};color:#fff;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0;">1</div><div><h4 style="margin:0 0 6px;font-size:17px;color:#1a1a1a;">Title</h4><p style="margin:0;font-size:15px;color:#555;line-height:1.65;">desc</p></div></div></div>
FAQ: <div style="background:#f9f9f9;border-radius:10px;padding:20px 24px;margin:14px 0;"><h4 style="margin:0 0 10px;font-size:17px;color:{primary};">Q: ?</h4><p style="margin:0;font-size:15px;line-height:1.7;color:#333;">A: text</p></div>
Summary: <div style="background:{primary};color:#fff;border-radius:12px;padding:28px;margin:32px 0;"><p style="margin:0 0 10px;font-weight:700;font-size:14px;letter-spacing:0.8px;text-transform:uppercase;opacity:0.9;">📌 Summary</p><p style="margin:0;font-size:16px;line-height:1.7;">text</p></div>
CTA: <div style="background:linear-gradient(135deg,{primary},{secondary or primary});color:#fff;border-radius:14px;padding:36px 32px;margin:36px 0 12px;text-align:center;"><h3 style="color:#fff;margin:0 0 12px;font-size:24px;font-weight:700;">heading</h3><p style="color:#ffffffdd;margin:0 0 20px;font-size:16px;line-height:1.6;">copy</p><a href="#" style="display:inline-block;background:#fff;color:{primary};padding:12px 32px;border-radius:8px;font-weight:700;text-decoration:none;">text →</a></div>

OUTPUT — raw HTML only, wrapped in sentinels:
<<<HTML_CONTENT>>>
[write your complete article here — remember: MINIMUM {data.word_count_min} readable words]
<<<END_HTML_CONTENT>>>"""

            try:
                content_raw = await get_ai_response(
                    [{"role": "system", "content": content_system},
                     {"role": "user", "content": content_prompt}],
                    temperature=0.95,
                    max_tokens=16000,
                )
                _, content_html = _parse_blog_ai_output(content_raw)

                # If still short, expand with a continuation call
                import re as _re
                visible_text = _re.sub(r"<[^>]+>", " ", content_html)
                visible_words = len(visible_text.split())
                if visible_words < data.word_count_min * 0.85:
                    logger.warning(f"Post {i+1} word count {visible_words} below target {data.word_count_min}, expanding...")
                    await push_event(task_id, "progress", {"message": f"Post {i+1} — expanding content ({visible_words}/{data.word_count_min} words so far)...", "percent": pct + 8})
                    shortfall = data.word_count_min - visible_words
                    expand_raw = await get_ai_response(
                        [
                            {"role": "system", "content": content_system},
                            {"role": "user", "content": content_prompt},
                            {"role": "assistant", "content": content_raw},
                            {"role": "user", "content": (
                                f"Your article is only {visible_words} words — {shortfall} words short of the {data.word_count_min}-word minimum. "
                                f"Continue the article naturally. Don't summarise or conclude — just keep writing as if the article isn't finished. "
                                f"Add {max(2, shortfall // 180)} more H2 sections with deep, opinionated prose (multiple paragraphs each). "
                                f"Write like you're still in the middle of the piece — personal, specific, conversational. "
                                "Output ONLY the additional HTML sections (no sentinels, no opening line, no 'continuing from...' preamble)."
                            )},
                        ],
                        temperature=0.95,
                        max_tokens=8000,
                    )
                    # Strip any sentinels from the expansion
                    extra_html = expand_raw
                    for sentinel in ["<<<HTML_CONTENT>>>", "<<<END_HTML_CONTENT>>>", "<<<JSON_META>>>", "<<<END_JSON_META>>>"]:
                        extra_html = extra_html.replace(sentinel, "")
                    if extra_html.strip().startswith("```"):
                        extra_html = _re.sub(r"^```(?:html)?\s*", "", extra_html.strip())
                        extra_html = _re.sub(r"\s*```\s*$", "", extra_html.strip())
                    # Insert expansion before the summary/CTA (before the last closing div that contains "Summary" or "CTA")
                    summary_marker = '<div style="background:{primary};color:#fff'.format(primary=primary)
                    cta_marker = "background:linear-gradient(135deg,"
                    insert_pos = content_html.rfind(summary_marker)
                    if insert_pos == -1:
                        insert_pos = content_html.rfind(cta_marker)
                    if insert_pos != -1:
                        content_html = content_html[:insert_pos] + extra_html.strip() + "\n" + content_html[insert_pos:]
                    else:
                        content_html = content_html + "\n" + extra_html.strip()

                # Inject JSON-LD schema
                schema = post_data.get("schema_jsonld") or {}
                if isinstance(schema, dict) and schema:
                    try:
                        schema_block = (
                            '\n<script type="application/ld+json">'
                            + json.dumps(schema, ensure_ascii=False)
                            + "</script>\n"
                        )
                        content_html = content_html + schema_block
                    except Exception:
                        pass

                # Resolve tag/category names to IDs (creating any that don't exist)
                tag_ids = await _resolve_taxonomy(post_data.get("tags", []) or [], tag_map, "tags")
                cat_ids = await _resolve_taxonomy(post_data.get("categories", []) or [], cat_map, "categories")

                # Optional featured image via DALL-E
                featured_media_id = None
                if data.auto_image and post_data.get("featured_image_prompt"):
                    try:
                        oai = await get_openai_client()
                        img_resp = await oai.images.generate(
                            model="dall-e-3",
                            prompt=post_data["featured_image_prompt"],
                            size="1792x1024",
                            quality="standard",
                            n=1,
                        )
                        img_url = img_resp.data[0].url
                        featured_media_id = await wp_upload_image(
                            site,
                            img_url,
                            f"featured-{post_data.get('slug', uuid.uuid4().hex[:8])}.png",
                        )
                        post_data["featured_image_url"] = img_url
                    except Exception as img_err:
                        logger.warning(f"DALL-E featured image failed: {img_err}")

                # Push to WordPress
                wp_payload = {
                    "title": post_data.get("title", f"Auto Post {i+1}"),
                    "content": content_html,
                    "status": data.post_status,
                    "excerpt": post_data.get("meta_description", ""),
                    "slug": post_data.get("slug", ""),
                }
                if tag_ids:
                    wp_payload["tags"] = tag_ids
                if cat_ids:
                    wp_payload["categories"] = cat_ids
                if featured_media_id:
                    wp_payload["featured_media"] = featured_media_id

                try:
                    response = await wp_api_request(site, "POST", "posts", wp_payload)
                    if response.status_code in (200, 201):
                        wp_post = response.json()
                        post_data["wp_id"] = wp_post.get("id")
                        post_data["url"] = wp_post.get("link", "")
                        post_data["status"] = data.post_status
                        # Write on-page SEO meta (Yoast, RankMath, AIOSEO) — non-blocking
                        try:
                            await _write_seo_meta(site, wp_post.get("id"), post_data)
                        except Exception as seo_err:
                            logger.warning(f"SEO meta write failed for post {wp_post.get('id')}: {seo_err}")
                        await push_event(task_id, "progress", {"message": f"Post {i+1} published: {post_data.get('title','')}", "percent": pct + 5})
                    else:
                        logger.warning(f"Auto blog WP push REST failed ({response.status_code}): {response.text[:200]}")
                        # XML-RPC fallback for hosts that strip Authorization header
                        try:
                            xr = await wp_xmlrpc_write(
                                site, "post",
                                wp_payload["title"], wp_payload["content"], data.post_status,
                            )
                            post_data["wp_id"] = xr.get("wp_id")
                            post_data["url"] = xr.get("link", "")
                            post_data["status"] = data.post_status
                            try:
                                await _write_seo_meta(site, xr.get("wp_id"), post_data, prefer_xmlrpc=True)
                            except Exception as seo_err:
                                logger.warning(f"SEO meta write (XML-RPC) failed: {seo_err}")
                            await push_event(task_id, "progress", {"message": f"Post {i+1} published via XML-RPC: {post_data.get('title','')}", "percent": pct + 5})
                        except Exception as xr_err:
                            logger.warning(f"XML-RPC fallback failed: {xr_err}")
                            post_data["status"] = "local_only"
                except Exception as wp_err:
                    logger.warning(f"Auto blog WP push failed: {wp_err}")
                    post_data["status"] = "local_only"

                # Keep the rendered HTML on the returned object so the frontend preview works
                post_data["content"] = content_html
                posts.append(post_data)
            except Exception as post_err:
                logger.error(f"Auto blog post {i+1} failed: {post_err}")
                await push_event(task_id, "item_error", {"post_index": i+1, "error": str(post_err)})

        await log_activity(site_id, "auto_blog_generation", f"Generated {len(posts)} blog posts about: {data.topic}")
        await push_event(task_id, "complete", {"message": f"Generated {len(posts)}/{data.num_posts} posts", "posts": posts, "percent": 100})
    except Exception as e:
        logger.error(f"Auto blog worker fatal error: {e}")
        await push_event(task_id, "error", {"message": str(e)})
    finally:
        await finish_task(task_id)


# ─────────────────────────────────────────────────────────────
