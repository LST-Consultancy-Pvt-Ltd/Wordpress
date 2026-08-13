"""Duplicate Content Detection (TF-IDF + cosine similarity scan, AI-rewrite to
de-duplicate) and Internal Link Suggestions (TF-IDF keyword extraction to find
linking opportunities, AI-generated anchor text, apply the link into the post).
"""
import asyncio
import json
import logging
import re as _re
from datetime import datetime, timezone

from fastapi import BackgroundTasks, HTTPException
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from core.activity import log_activity
from core.ai import get_ai_response
from core.content_analysis import _strip_html
from core.db import db
from core.prompts import HUMANIZE_DIRECTIVE
from core.router import api_router
from core.seo_impact import estimate_seo_impact
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from models.legacy import DuplicateContentResult, InternalLinkSuggestion
from providers.wordpress import get_wp_credentials, wp_xmlrpc_edit

logger = logging.getLogger(__name__)

# ========================
# Routes: Duplicate Content Detection
# ========================

@api_router.post("/duplicate-content/{site_id}/scan")
async def scan_duplicate_content(site_id: str, background_tasks: BackgroundTasks):
    """Start a duplicate-content scan. Returns task_id for SSE streaming."""
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_scan_duplicate_content, task_id, site_id)
    return {"task_id": task_id}


async def _scan_duplicate_content(task_id: str, site_id: str):
    try:
        await push_event(task_id, "status", {"message": "Loading posts and pages...", "percent": 5})

        posts = await db.posts.find({"site_id": site_id}, {"_id": 0}).to_list(500)
        pages = await db.pages.find({"site_id": site_id}, {"_id": 0}).to_list(500)
        all_items = posts + pages

        if len(all_items) < 2:
            await push_event(task_id, "complete", {
                "message": "Not enough content to compare.", "percent": 100, "duplicates": 0
            })
            return

        await push_event(task_id, "status", {"message": f"Comparing {len(all_items)} items...", "percent": 20})

        # Strip HTML and collect plain text
        texts = [_strip_html(item.get("content", "")) for item in all_items]
        titles = [item.get("title", "") for item in all_items]
        ids = [item.get("wp_id", 0) for item in all_items]

        # Clear old results for this site
        await db.duplicate_content.delete_many({"site_id": site_id})

        results = []

        # --- Content similarity via TF-IDF + cosine similarity ---
        # Run blocking sklearn work in executor to not block the event loop
        def _compute_similarity():
            non_empty = [t for t in texts if t]
            if len(non_empty) < 2:
                return None
            vec = TfidfVectorizer(stop_words="english", max_features=5000)
            matrix = vec.fit_transform(texts)
            return cosine_similarity(matrix)

        sim_matrix = await asyncio.get_event_loop().run_in_executor(None, _compute_similarity)

        await push_event(task_id, "status", {"message": "Analysing similarity scores...", "percent": 60})

        THRESHOLD = 0.75
        if sim_matrix is not None:
            n = len(all_items)
            for i in range(n):
                for j in range(i + 1, n):
                    score = float(sim_matrix[i, j])
                    if score >= THRESHOLD:
                        rec = DuplicateContentResult(
                            site_id=site_id,
                            post_a_id=ids[i],
                            post_a_title=titles[i],
                            post_b_id=ids[j],
                            post_b_title=titles[j],
                            similarity_score=round(score, 4),
                            type="content",
                        )
                        results.append(rec.model_dump())

        # --- Exact / near-exact title duplicates ---
        title_lower = [t.lower().strip() for t in titles]
        for i in range(len(all_items)):
            for j in range(i + 1, len(all_items)):
                if title_lower[i] and title_lower[i] == title_lower[j]:
                    # Skip if already captured as content duplicate
                    already = any(
                        r["post_a_id"] == ids[i] and r["post_b_id"] == ids[j]
                        for r in results
                    )
                    if not already:
                        rec = DuplicateContentResult(
                            site_id=site_id,
                            post_a_id=ids[i],
                            post_a_title=titles[i],
                            post_b_id=ids[j],
                            post_b_title=titles[j],
                            similarity_score=1.0,
                            type="title",
                        )
                        results.append(rec.model_dump())

        if results:
            await db.duplicate_content.insert_many(results)

        await push_event(task_id, "complete", {
            "message": f"Scan complete: {len(results)} duplicate pair(s) found.",
            "percent": 100,
            "duplicates": len(results),
        })
        await log_activity(site_id, "duplicate_content_scan", f"Found {len(results)} duplicate pairs")

    except Exception as e:
        logger.error(f"Duplicate content scan failed: {e}")
        await push_event(task_id, "error", {"message": str(e)})
    finally:
        await finish_task(task_id)


@api_router.get("/duplicate-content/{site_id}")
async def get_duplicate_content(site_id: str):
    """Return stored duplicate-content results for a site."""
    results = await db.duplicate_content.find({"site_id": site_id}, {"_id": 0}).sort("detected_at", -1).to_list(500)
    return results


@api_router.post("/duplicate-content/{site_id}/fix/{item_id}")
async def fix_duplicate_content(site_id: str, item_id: str, dry_run: bool = False):
    """Use AI to rewrite post_b of a duplicate pair so it is sufficiently different, then save via XML-RPC."""
    record = await db.duplicate_content.find_one({"id": item_id, "site_id": site_id}, {"_id": 0})
    if not record:
        raise HTTPException(status_code=404, detail="Duplicate record not found")

    site = await get_wp_credentials(site_id)

    # Fetch the post/page content for post_b from our cache
    post = await db.posts.find_one({"site_id": site_id, "wp_id": record["post_b_id"]}, {"_id": 0})
    if not post:
        post = await db.pages.find_one({"site_id": site_id, "wp_id": record["post_b_id"]}, {"_id": 0})
    if not post:
        raise HTTPException(status_code=404, detail="Source post/page not found in cache. Sync the site first.")

    original_title = post.get("title", "")
    original_content = _strip_html(post.get("content", ""))[:3000]

    system_prompt = f"You are an expert SEO content writer. Rewrite the provided content so it is unique and distinct from its near-duplicate. Keep the same general topic but change the angle, structure, examples and wording significantly.\n\n{HUMANIZE_DIRECTIVE}"
    prompt = f"""The following post is a near-duplicate (similarity {record['similarity_score'] * 100:.0f}%) of "{record['post_a_title']}".
Rewrite it to be clearly distinct while retaining its core subject matter.

Original title: {original_title}
Original content:
{original_content}

Return JSON only:
{{
  "title": "New unique title",
  "content": "Rewritten HTML content"
}}"""

    rewritten_raw = await get_ai_response(
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        temperature=0.8,
        max_tokens=2500,
    )

    # Parse JSON response
    try:
        clean = rewritten_raw
        if "```json" in clean:
            clean = clean.split("```json")[1].split("```")[0]
        elif "```" in clean:
            clean = clean.split("```")[1].split("```")[0]
        rewritten = json.loads(clean.strip())
    except Exception:
        raise HTTPException(status_code=500, detail="AI returned invalid JSON. Try again.")

    new_title = rewritten.get("title", original_title)
    new_content = rewritten.get("content", "")

    # dry_run — return the rewritten content without pushing to WordPress
    if dry_run:
        return {
            "dry_run": True,
            "new_title": new_title,
            "new_content": new_content,
            "wp_id": record["post_b_id"],
            "post_url": post.get("link", ""),
        }

    # Update via XML-RPC (handles hosts that strip Authorization header)
    await wp_xmlrpc_edit(site, record["post_b_id"], {"title": new_title, "content": new_content})

    # Update local cache
    for coll in (db.posts, db.pages):
        await coll.update_one(
            {"site_id": site_id, "wp_id": record["post_b_id"]},
            {"$set": {"title": new_title, "content": new_content}},
        )

    # Mark the duplicate record as resolved
    await db.duplicate_content.update_one(
        {"id": item_id},
        {"$set": {"resolved": True, "resolved_at": datetime.now(timezone.utc).isoformat()}},
    )

    await log_activity(site_id, "duplicate_fixed", f"Rewrote post #{record['post_b_id']}: {new_title[:60]}")
    return {"success": True, "new_title": new_title}


# ========================
# Routes: Internal Link Suggestions
# ========================

@api_router.post("/internal-links/{site_id}/suggest")
async def suggest_internal_links(site_id: str, background_tasks: BackgroundTasks):
    """Start an internal-link suggestion scan. Returns task_id for SSE streaming."""
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_suggest_internal_links, task_id, site_id)
    return {"task_id": task_id}


async def _suggest_internal_links(task_id: str, site_id: str):
    try:
        await push_event(task_id, "status", {"message": "Loading posts...", "percent": 5})

        posts = await db.posts.find(
            {"site_id": site_id, "status": "publish"},
            {"_id": 0}
        ).to_list(300)

        if len(posts) < 2:
            await push_event(task_id, "complete", {"message": "Need at least 2 published posts.", "percent": 100, "suggestions": 0})
            return

        ids = [p.get("wp_id", 0) for p in posts]
        titles = [p.get("title", "") for p in posts]
        urls = [p.get("link", "") for p in posts]
        plain_texts = [_strip_html(p.get("content", "")) for p in posts]

        await push_event(task_id, "status", {"message": "Extracting keywords via TF-IDF...", "percent": 20})

        # Extract top-5 keywords per post via TF-IDF
        def _extract_keywords():
            vec = TfidfVectorizer(stop_words="english", max_features=2000, ngram_range=(1, 2))
            matrix = vec.fit_transform(plain_texts)
            feature_names = vec.get_feature_names_out()
            kw_per_post = []
            for i in range(len(posts)):
                row = matrix[i].toarray()[0]
                top_indices = row.argsort()[-5:][::-1]
                kw_per_post.append([feature_names[idx] for idx in top_indices if row[idx] > 0])
            return kw_per_post

        kw_per_post = await asyncio.get_event_loop().run_in_executor(None, _extract_keywords)

        await push_event(task_id, "status", {"message": "Finding link opportunities...", "percent": 40})

        # For each post P (source), find posts Q (target) whose keywords appear in P's content
        MAX_PAIRS = 20
        candidates = []
        for i, source_text in enumerate(plain_texts):
            source_lower = source_text.lower()
            for j, kws in enumerate(kw_per_post):
                if i == j:
                    continue
                if not urls[j]:  # skip posts without a URL
                    continue
                # Check if at least 2 of target's keywords appear in source content
                matches = sum(1 for kw in kws if kw and kw in source_lower)
                if matches >= 2:
                    candidates.append({
                        "index": len(candidates),
                        "source_id": ids[i],
                        "source_title": titles[i],
                        "source_content": source_text[:1500],
                        "target_id": ids[j],
                        "target_title": titles[j],
                        "target_url": urls[j],
                        "target_keywords": kws[:5],
                    })
                if len(candidates) >= MAX_PAIRS:
                    break
            if len(candidates) >= MAX_PAIRS:
                break

        if not candidates:
            await push_event(task_id, "complete", {"message": "No linking opportunities found.", "percent": 100, "suggestions": 0})
            return

        await push_event(task_id, "status", {"message": f"Asking AI to generate anchor text for {len(candidates)} pairs...", "percent": 60})

        pairs_json = json.dumps([
            {
                "index": c["index"],
                "source_title": c["source_title"],
                "source_content": c["source_content"],
                "target_title": c["target_title"],
                "target_keywords": c["target_keywords"],
            }
            for c in candidates
        ], indent=2)

        ai_prompt = f"""You are an SEO expert. For each pair below, the source post's content MENTIONS topics related to the target post.
Your job: suggest a natural internal link from the source to the target.

For each pair return:
- pair_index: the index value
- anchor_text: 2–5 words from the source content to use as anchor text
- context_sentence: the exact sentence from the source content where the anchor text appears

Return ONLY a valid JSON array with those three fields per item.

Pairs:
{pairs_json}"""

        raw = await get_ai_response(
            [{"role": "user", "content": ai_prompt}],
            max_tokens=2000,
            temperature=0.3,
        )

        # Parse AI JSON
        clean = raw
        if "```json" in clean:
            clean = clean.split("```json")[1].split("```")[0]
        elif "```" in clean:
            clean = clean.split("```")[1].split("```")[0]
        ai_suggestions = json.loads(clean.strip())

        # Clear previous suggestions for this site
        await db.internal_link_suggestions.delete_many({"site_id": site_id, "applied": False})

        saved = []
        for item in ai_suggestions:
            idx = item.get("pair_index", item.get("index", -1))
            if idx < 0 or idx >= len(candidates):
                continue
            c = candidates[idx]
            if not item.get("anchor_text") or not item.get("context_sentence"):
                continue
            rec = InternalLinkSuggestion(
                site_id=site_id,
                source_post_id=c["source_id"],
                source_post_title=c["source_title"],
                target_post_id=c["target_id"],
                target_post_title=c["target_title"],
                target_url=c["target_url"],
                anchor_text=item["anchor_text"],
                context_sentence=item["context_sentence"],
            )
            saved.append(rec.model_dump())

        if saved:
            await db.internal_link_suggestions.insert_many(saved)

        await push_event(task_id, "complete", {
            "message": f"Found {len(saved)} internal link suggestion(s).",
            "percent": 100,
            "suggestions": len(saved),
        })
        await log_activity(site_id, "internal_links_suggest", f"Generated {len(saved)} internal link suggestions")

    except Exception as e:
        logger.error(f"Internal link suggestion failed: {e}")
        await push_event(task_id, "error", {"message": str(e)})
    finally:
        await finish_task(task_id)


@api_router.get("/internal-links/{site_id}")
async def get_internal_link_suggestions(site_id: str):
    """Return cached internal link suggestions for a site."""
    results = await db.internal_link_suggestions.find(
        {"site_id": site_id}, {"_id": 0}
    ).sort("detected_at", -1).to_list(500)
    return results


@api_router.post("/internal-links/{site_id}/apply/{suggestion_id}")
async def apply_internal_link(site_id: str, suggestion_id: str):
    """Insert the suggested anchor link into the source post's HTML and save via XML-RPC."""
    rec = await db.internal_link_suggestions.find_one(
        {"id": suggestion_id, "site_id": site_id}, {"_id": 0}
    )
    if not rec:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    if rec.get("applied"):
        raise HTTPException(status_code=400, detail="Suggestion already applied")

    site = await get_wp_credentials(site_id)

    # Fetch source post HTML from cache
    post = await db.posts.find_one({"site_id": site_id, "wp_id": rec["source_post_id"]}, {"_id": 0})
    if not post:
        post = await db.pages.find_one({"site_id": site_id, "wp_id": rec["source_post_id"]}, {"_id": 0})
    if not post:
        raise HTTPException(status_code=404, detail="Source post not found in cache. Sync the site first.")

    html_content = post.get("content", "")
    anchor_text = rec["anchor_text"]
    target_url = rec["target_url"]

    # Insert anchor link: replace first occurrence of anchor_text in the HTML
    # that is NOT already inside an HTML tag/attribute
    linked_anchor = f'<a href="{target_url}">{anchor_text}</a>'
    # Match the anchor_text only when it's in a text node context (not inside a tag)
    pattern = _re.compile(
        r'(?<![<"\'])(' + _re.escape(anchor_text) + r')(?![^<]*>)',
        _re.IGNORECASE,
    )
    new_html, count = pattern.subn(linked_anchor, html_content, count=1)

    if count == 0:
        # Fallback: plain substring replacement if regex didn't match
        if anchor_text in html_content:
            new_html = html_content.replace(anchor_text, linked_anchor, 1)
        else:
            raise HTTPException(
                status_code=422,
                detail=f'Anchor text "{anchor_text}" not found in post content.'
            )

    # Save to WordPress via XML-RPC
    await wp_xmlrpc_edit(site, rec["source_post_id"], {"content": new_html})

    # Update local cache
    for coll in (db.posts, db.pages):
        await coll.update_one(
            {"site_id": site_id, "wp_id": rec["source_post_id"]},
            {"$set": {"content": new_html}},
        )

    # Mark suggestion applied
    await db.internal_link_suggestions.update_one(
        {"id": suggestion_id},
        {"$set": {"applied": True, "applied_at": datetime.now(timezone.utc).isoformat()}},
    )

    await log_activity(site_id, "internal_link_applied",
                       f'Linked "{anchor_text}" in post #{rec["source_post_id"]} → #{rec["target_post_id"]}')
    return {"success": True, "anchor_text": anchor_text, "target_url": target_url, "impact_estimate": estimate_seo_impact("internal_link")}
