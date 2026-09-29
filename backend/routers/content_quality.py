"""Duplicate Content Detection (TF-IDF + cosine similarity scan, AI-rewrite to
de-duplicate) and Internal Link Suggestions (TF-IDF keyword extraction to find
linking opportunities, AI-generated anchor text, apply the link into the post).
"""
import asyncio
import json
import logging

from fastapi import BackgroundTasks
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from core.activity import log_activity
from core.ai import get_ai_response
from core.content_analysis import _strip_html
from core.db import db
from core.router import api_router
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from models.legacy import DuplicateContentResult, InternalLinkSuggestion

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

        all_items = await db.content_items.find({"site_id": site_id}, {"_id": 0}).to_list(1000)

        if len(all_items) < 2:
            await push_event(task_id, "complete", {
                "message": "Not enough content to compare.", "percent": 100, "duplicates": 0
            })
            return

        await push_event(task_id, "status", {"message": f"Comparing {len(all_items)} items...", "percent": 20})

        # Strip HTML and collect plain text
        texts = [_strip_html(item.get("body", "")) for item in all_items]
        titles = [item.get("title", "") for item in all_items]
        ids = [item.get("content_id", 0) for item in all_items]

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

        posts = await db.content_items.find(
            {"site_id": site_id, "status": "published"},
            {"_id": 0}
        ).to_list(300)

        if len(posts) < 2:
            await push_event(task_id, "complete", {"message": "Need at least 2 published posts.", "percent": 100, "suggestions": 0})
            return

        ids = [p.get("content_id", 0) for p in posts]
        titles = [p.get("title", "") for p in posts]
        urls = [p.get("url", "") for p in posts]
        plain_texts = [_strip_html(p.get("body", "")) for p in posts]

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


