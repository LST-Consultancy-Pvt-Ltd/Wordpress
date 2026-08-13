"""AI Blog Generation: generate a full SEO-optimized blog post from a topic
(optional DALL-E featured image, multi-language translations, readability
scoring), and translate an existing WordPress post into other languages.
"""
import asyncio
import json
import logging
import uuid

from fastapi import Depends, HTTPException

from core.activity import log_activity
from core.ai import get_ai_response, get_openai_client
from core.content_analysis import compute_readability
from core.db import db
from core.prompts import HUMANIZE_DIRECTIVE
from core.router import api_router
from core.security import require_editor
from models.legacy import PostGenerate, PostTranslateRequest
from providers.wordpress import get_wp_credentials, wp_api_request, wp_upload_image

logger = logging.getLogger(__name__)

@api_router.post("/posts/generate")
async def generate_blog_post(data: PostGenerate, _: dict = Depends(require_editor)):
    site = await get_wp_credentials(data.site_id)

    keyword_str = ", ".join(data.keywords) if data.keywords else "relevant SEO keywords"

    prompt = f"""Write a comprehensive, SEO-optimized blog post about: {data.topic}

Target keywords: {keyword_str}

Requirements:
1. Engaging headline/title
2. Introduction that hooks the reader
3. Well-structured content with H2 and H3 headings
4. Include relevant statistics and examples
5. Natural keyword integration
6. Clear conclusion with call-to-action
7. Meta description (max 160 chars)

Format the response as JSON:
{{
    "title": "Blog post title",
    "content": "Full HTML content with proper headings",
    "meta_description": "SEO meta description",
    "suggested_categories": ["category1", "category2"],
    "suggested_tags": ["tag1", "tag2", "tag3"]
}}"""

    # Writing style support
    style_prefix = ""
    if data.style_id:
        style_doc = await db.writing_styles.find_one({"id": data.style_id}, {"_id": 0})
        if style_doc:
            style_prefix = f"Writing style instructions: {style_doc['instructions']}. Tone: {style_doc['tone']}."
            if style_doc.get("example_opening"):
                style_prefix += f" Open the article similarly to: '{style_doc['example_opening']}'."
    system_msg = f"You are an expert SEO content writer. Always respond with valid JSON.\n\n{HUMANIZE_DIRECTIVE}"
    if style_prefix:
        system_msg = f"{style_prefix}\n\n{system_msg}"

    try:
        content = await get_ai_response(
            [
                {"role": "system", "content": system_msg},
                {"role": "user", "content": prompt},
            ],
            temperature=0.7,
            max_tokens=3000,
        )
        try:
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                content = content.split("```")[1].split("```")[0]
            blog_data = json.loads(content.strip())
        except json.JSONDecodeError:
            blog_data = {
                "title": data.topic,
                "content": content,
                "meta_description": f"Learn about {data.topic}",
                "suggested_categories": [],
                "suggested_tags": []
            }

        # Optional: Generate featured image via DALL-E 3
        if data.generate_image:
            try:
                image_prompt = f"High-quality blog featured image for article titled: {blog_data['title']}. Professional, clean, modern style."
                _openai_for_image = await get_openai_client()
                img_response = await _openai_for_image.images.generate(
                    model="dall-e-3",
                    prompt=image_prompt,
                    size="1792x1024",
                    quality="standard",
                    n=1,
                )
                image_url = img_response.data[0].url
                blog_data["featured_image_url"] = image_url
                # Upload to WordPress media
                media_id = await wp_upload_image(site, image_url, f"featured-{uuid.uuid4().hex[:8]}.png")
                if media_id:
                    blog_data["featured_media_id"] = media_id
            except Exception as img_err:
                logger.error(f"DALL-E image generation failed: {img_err}")
                blog_data["featured_image_error"] = str(img_err)

        await log_activity(data.site_id, "blog_generated", f"AI generated blog: {data.topic}")

        # Multi-language translations
        if data.target_languages:
            blog_data["translations"] = []
            for lang in data.target_languages:
                try:
                    trans_raw = await get_ai_response([
                        {"role": "system", "content": f"You are an expert multilingual SEO content writer. Respond only with valid JSON.\n\n{HUMANIZE_DIRECTIVE}"},
                        {"role": "user", "content": (
                            f"Translate and localize the following blog post to language code '{lang}'. "
                            f"Maintain SEO optimization and the same keyword focus. "
                            f"Return JSON with keys: title, content, meta_description.\n\n"
                            f"Title: {blog_data['title']}\n\nContent:\n{blog_data['content']}"
                        )},
                    ], max_tokens=3000, temperature=0.5)
                    if "```json" in trans_raw:
                        trans_raw = trans_raw.split("```json")[1].split("```")[0]
                    elif "```" in trans_raw:
                        trans_raw = trans_raw.split("```")[1].split("```")[0]
                    trans_data = json.loads(trans_raw.strip())
                    trans_data["language"] = lang
                    blog_data["translations"].append(trans_data)
                    await log_activity(data.site_id, "blog_translated", f"Translated blog to {lang}: {data.topic}")
                except Exception as trans_err:
                    logger.warning(f"Translation to {lang} failed: {trans_err}")

        # Attach readability metrics to the generated content
        try:
            metrics = await asyncio.to_thread(compute_readability, blog_data.get("content", ""))
            if "error" not in metrics:
                ease = metrics["flesch_reading_ease"]
                if ease >= 90:
                    grade = "Very Easy"
                elif ease >= 70:
                    grade = "Easy"
                elif ease >= 50:
                    grade = "Standard"
                elif ease >= 30:
                    grade = "Difficult"
                else:
                    grade = "Very Difficult"
                blog_data["readability"] = {"grade_label": grade, **metrics}
        except Exception:
            pass

        return blog_data

    except Exception as e:
        logger.error(f"Blog generation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@api_router.post("/posts/translate/{site_id}/{wp_id}")
async def translate_post(
    site_id: str,
    wp_id: int,
    body: PostTranslateRequest,
    current_user: dict = Depends(require_editor),
):
    """Translate an existing WP post to one or more languages and create new posts for each."""
    site = await get_wp_credentials(site_id)
    user_id = current_user.get("id") if current_user else "global"

    # Fetch the original post
    cached = await db.posts.find_one({"site_id": site_id, "wp_id": wp_id}, {"_id": 0})
    if not cached:
        resp = await wp_api_request(site, "GET", f"posts/{wp_id}")
        if resp.status_code != 200:
            raise HTTPException(status_code=404, detail="Post not found")
        p = resp.json()
        original_title = p["title"]["rendered"] if isinstance(p.get("title"), dict) else str(p.get("title", ""))
        original_content = p["content"]["rendered"] if isinstance(p.get("content"), dict) else str(p.get("content", ""))
    else:
        original_title = cached.get("title", "")
        original_content = cached.get("content", "")

    created_posts = []
    for lang in body.target_languages:
        try:
            trans_raw = await get_ai_response([
                {"role": "system", "content": f"You are an expert multilingual SEO content writer. Respond only with valid JSON.\n\n{HUMANIZE_DIRECTIVE}"},
                {"role": "user", "content": (
                    f"Translate and localize the following blog post to language code '{lang}'. "
                    f"Maintain SEO optimization. "
                    f"Return JSON: {{\"title\": \"...\", \"content\": \"...\", \"meta_description\": \"...\"}}\n\n"
                    f"Title: {original_title}\n\nContent:\n{original_content[:3000]}"
                )},
            ], max_tokens=3000, temperature=0.5)
            if "```json" in trans_raw:
                trans_raw = trans_raw.split("```json")[1].split("```")[0]
            elif "```" in trans_raw:
                trans_raw = trans_raw.split("```")[1].split("```")[0]
            trans_data = json.loads(trans_raw.strip())
        except Exception as exc:
            logger.warning(f"Translation to {lang} failed: {exc}")
            continue

        wp_payload = {
            "title": trans_data.get("title", f"{original_title} [{lang}]"),
            "content": trans_data.get("content", ""),
            "status": "draft",
            "meta": {"_wp_page_template": "", "language": lang},
        }
        create_resp = await wp_api_request(site, "POST", "posts", wp_payload)
        if create_resp.status_code in [200, 201]:
            new_wp = create_resp.json()
            created_posts.append({
                "language": lang,
                "wp_id": new_wp["id"],
                "title": trans_data.get("title", ""),
                "link": new_wp.get("link", ""),
            })
            await log_activity(site_id, "post_translated",
                               f"Translated post {wp_id} to {lang}: {trans_data.get('title', '')}", "success", user_id)

    return {"original_wp_id": wp_id, "translations": created_posts}
