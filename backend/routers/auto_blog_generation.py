"""MODULE: Auto Blog Generation

AI-driven pipeline that generates multiple full-length blog posts (metadata +
long-form HTML content + JSON-LD) and proposes them as ONE content change set
for review, reporting progress via SSE. Nothing is published until the change
set is approved and applied.
"""
import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import BackgroundTasks, Depends
from pydantic import BaseModel, ConfigDict

from core.activity import log_activity
from core.ai import get_ai_response
from core.content_proposals import propose_content
from core.json_utils import _repair_and_parse_json
from core.prompts import HUMANIZE_DIRECTIVE
from core.router import api_router
from core.security import require_editor
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from providers.sites import get_site

logger = logging.getLogger(__name__)

# MODULE: Auto Blog Generation
# ─────────────────────────────────────────────────────────────

class AutoBlogRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    topic: str
    keywords: List[str] = []
    num_posts: int = 3
    writing_style: str = "Professional"
    post_status: str = "draft"           # status the items get once the change set is applied
    collection: Optional[str] = None     # bridge content collection; first writable one if omitted
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
async def generate_auto_blogs(site_id: str, data: AutoBlogRequest, background_tasks: BackgroundTasks,
                              user=Depends(require_editor)):
    """Generate multiple blog posts with AI using SSE progress; the final event
    carries the created change set."""
    await get_site(site_id)
    task_id = make_task_id()
    await create_task_queue(task_id, "auto_blog_generation", site_id)
    background_tasks.add_task(_auto_blog_worker, task_id, site_id, data, user)
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


async def _auto_blog_worker(task_id: str, site_id: str, data: AutoBlogRequest, user: dict):
    try:
        site = await get_site(site_id)
        posts = []
        keywords_str = ", ".join(data.keywords) if data.keywords else data.topic
        primary = (data.primary_color or "#0A66C2").strip()
        secondary = (data.secondary_color or "").strip()
        brand = (data.brand_name or site.get("name", "")).strip()

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

                post_data["status"] = "proposed"
                await push_event(task_id, "progress", {"message": f"Post {i+1} ready: {post_data.get('title','')}",
                                                       "percent": pct + 5})
                # Keep the rendered HTML on the returned object so the frontend preview works
                post_data["content"] = content_html
                posts.append(post_data)
            except Exception as post_err:
                logger.error(f"Auto blog post {i+1} failed: {post_err}")
                await push_event(task_id, "item_error", {"post_index": i+1, "error": str(post_err)})

        changeset = None
        if posts:
            changeset = await propose_content(
                site_id, actor=user, source="blog-generation", collection=data.collection,
                title=f"{len(posts)} generated post(s): {data.topic}"[:200],
                items=[{
                    "title": p.get("title") or f"Post {n + 1}", "slug": p.get("slug"), "body": p.get("content", ""),
                    "status": data.post_status,
                    "frontmatter": {
                        "description": p.get("meta_description"), "seo_title": p.get("meta_title"),
                        "keywords": [k for k in [p.get("focus_keyword")] + list(p.get("secondary_keywords") or []) if k],
                        "tags": p.get("tags") or [], "categories": p.get("categories") or [],
                        "jsonLd": p.get("schema_jsonld") if isinstance(p.get("schema_jsonld"), dict) else None,
                        "content_format": "html", "date": datetime.now(timezone.utc).date().isoformat(),
                    },
                } for n, p in enumerate(posts)],
            )
        await log_activity(site_id, "auto_blog_generation",
                           f"Generated {len(posts)} blog posts about: {data.topic}"
                           + (f" → change set {changeset['id']}" if changeset else ""), user_id=user["id"])
        await push_event(task_id, "complete", {"message": f"Generated {len(posts)}/{data.num_posts} posts; "
                                                          "review and approve the change set to publish them",
                                               "posts": posts, "changeset": changeset, "percent": 100})
    except Exception as e:
        logger.error(f"Auto blog worker fatal error: {e}")
        await push_event(task_id, "error", {"message": str(e)})
    finally:
        await finish_task(task_id)


# ─────────────────────────────────────────────────────────────
