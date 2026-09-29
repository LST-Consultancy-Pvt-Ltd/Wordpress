"""AI Content Detector: the Module 10 full-scoring suite (AI-probability
detection via ZeroGPT or calibrated AI fallback, bulk site scans, the
comprehensive multi-dimensional full-score endpoint, and humanization),
plus the later Section-by-Section AI Detection, Google Helpful Content
Score, and Real Fact-Check API features. These three trailing features
share the same "Module 10" theme and are moved here from a separate,
non-adjacent location further down in the original server.py.
"""
import json
import logging
import os
from typing import Optional

import httpx
from bs4 import BeautifulSoup
from fastapi import Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from core.activity import log_activity
from core.ai import get_ai_response
from core.crypto import get_decrypted_settings
from core.db import db
from core.prompts import HUMANIZE_DIRECTIVE
from core.router import api_router
from core.security import require_editor, require_user

logger = logging.getLogger(__name__)

# MODULE: AI Content Detector (Module 10 — Full Scoring Suite)
# ─────────────────────────────────────────────────────────────

class AIContentDetectorRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    text: str

class AIContentFullScoreRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    text: str
    url: Optional[str] = None

def _compute_text_stats(text: str) -> dict:
    """Compute statistical features that help calibrate AI detection."""
    import re as _re
    sentences = [s.strip() for s in _re.split(r'[.!?]+', text) if len(s.strip()) > 10]
    words = text.split()
    unique_words = set(w.lower() for w in words)

    # Vocabulary richness (type-token ratio)
    vocab_richness = len(unique_words) / max(len(words), 1)

    # Sentence length variance (humans vary more)
    sent_lengths = [len(s.split()) for s in sentences]
    avg_sent_len = sum(sent_lengths) / max(len(sent_lengths), 1)
    variance = sum((l - avg_sent_len) ** 2 for l in sent_lengths) / max(len(sent_lengths), 1)
    sent_len_std = variance ** 0.5

    # AI marker phrases
    ai_markers = [
        "it's worth noting", "it is worth noting", "it's important to note",
        "in today's digital landscape", "in today's world", "in conclusion",
        "dive into", "delve into", "let's explore", "let's dive",
        "game-changer", "game changer", "leverage", "harness the power",
        "Navigate the", "crucial", "comprehensive guide", "step-by-step",
        "unlock the", "demystify", "in the realm of", "in the world of",
        "seamlessly", "effortlessly", "revolutionize", "cutting-edge",
        "landscape", "tapestry", "multifaceted", "holistic approach",
        "foster", "Moreover,", "Furthermore,", "Additionally,",
        "Ultimately,", "Consequently,", "Nonetheless,",
    ]
    text_lower = text.lower()
    marker_count = sum(1 for m in ai_markers if m.lower() in text_lower)

    # Paragraph starter repetition (AI often starts paragraphs the same way)
    paragraphs = [p.strip() for p in text.split('\n') if len(p.strip()) > 20]
    first_words = [p.split()[0].lower() if p.split() else '' for p in paragraphs]
    repeated_starters = len(first_words) - len(set(first_words)) if first_words else 0

    # Contraction usage (humans use more contractions)
    contractions = _re.findall(r"\b\w+'\w+\b", text)
    contraction_rate = len(contractions) / max(len(words), 1) * 100

    return {
        "vocab_richness": round(vocab_richness, 3),
        "sent_len_std": round(sent_len_std, 1),
        "avg_sent_len": round(avg_sent_len, 1),
        "marker_count": marker_count,
        "repeated_starters": repeated_starters,
        "contraction_rate": round(contraction_rate, 2),
        "word_count": len(words),
        "sentence_count": len(sentences),
    }


@api_router.post("/ai-content-detector/{site_id}/analyze")
async def analyze_ai_content(site_id: str, data: AIContentDetectorRequest, _=Depends(require_user)):
    """Analyze text to detect AI-generated content.
    Uses ZeroGPT API when key is configured, otherwise falls back to
    calibrated AI analysis with statistical pre-checks."""
    text = data.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required")

    # ── Try ZeroGPT API first (most accurate) ──
    settings = await get_decrypted_settings()
    zerogpt_key = settings.get("zerogpt_api_key", "").strip()
    if zerogpt_key:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                zr = await client.post(
                    "https://api.zerogpt.com/api/detect/detectText",
                    headers={"ApiKey": zerogpt_key, "Content-Type": "application/json"},
                    json={"input_text": text[:50000]},
                )
            if zr.status_code == 200:
                zdata = zr.json().get("data", {})
                ai_pct = zdata.get("fakePercentage", 0)
                # Build sentence-level from ZeroGPT's highlighted sentences
                ai_sentences = zdata.get("aiSentences", []) or []
                sentences = [
                    {"text": s[:200], "score": min(95, int(ai_pct + 10))}
                    for s in ai_sentences[:10]
                ]
                suggestions = []
                if ai_pct > 50:
                    suggestions = [
                        "Add personal anecdotes or first-person experiences",
                        "Vary sentence lengths — mix short punchy lines with longer ones",
                        "Use contractions (don't, won't, it's) naturally",
                        "Replace formal transition words (Moreover, Furthermore) with casual ones",
                        "Add rhetorical questions to engage readers",
                    ]
                elif ai_pct > 20:
                    suggestions = [
                        "Some sentences sound formulaic — rephrase with a conversational tone",
                        "Add specific examples or data points unique to your expertise",
                        "Break up long uniform paragraphs",
                    ]
                result = {
                    "ai_probability": round(ai_pct),
                    "sentences": sentences,
                    "suggestions": suggestions,
                    "source": "zerogpt",
                }
                await log_activity(site_id, "ai_content_detection",
                                   f"AI detection (ZeroGPT): {round(ai_pct)}% probability")
                return result
        except Exception as e:
            logger.warning(f"ZeroGPT API failed, falling back to AI: {e}")

    # ── Fallback: Calibrated AI analysis with statistical pre-checks ──
    stats = _compute_text_stats(text)

    # Build a calibration context from stats
    stat_summary = (
        f"Statistical analysis of this text:\n"
        f"- Vocabulary richness (type-token ratio): {stats['vocab_richness']} "
        f"(human typically 0.45-0.75, AI typically 0.30-0.50)\n"
        f"- Sentence length std dev: {stats['sent_len_std']} "
        f"(human typically 6-15, AI typically 3-7)\n"
        f"- AI marker phrases found: {stats['marker_count']} "
        f"(0-1 = likely human, 3+ = likely AI)\n"
        f"- Repeated paragraph starters: {stats['repeated_starters']} "
        f"(0 = human-like, 3+ = AI pattern)\n"
        f"- Contraction rate: {stats['contraction_rate']}% "
        f"(human informal 3-8%, AI formal 0-1%)\n"
        f"- Word count: {stats['word_count']}, Sentences: {stats['sentence_count']}\n"
    )

    prompt = f"""You are calibrating your AI detection to match ZeroGPT's scoring.

IMPORTANT CALIBRATION RULES:
- Human-written content with personal voice, contractions, varied sentence structure,
  colloquial language, and domain expertise should score 0-15%.
- Content with some AI-like patterns but overall human feel: 15-35%.
- Mixed content (partially AI, partially edited): 35-55%.
- Clearly AI-generated with formulaic structure, no personality, excessive transition
  words (Moreover, Furthermore, Additionally), uniform sentence length: 55-85%.
- Pure unedited AI output: 85-100%.

MOST CONTENT THAT READS NATURALLY IS HUMAN. Do NOT over-score.
Well-written professional content is NOT the same as AI content.
Conversational tone, personal anecdotes, humor, and informal language = HUMAN.

{stat_summary}

Text to analyze:
\"\"\"
{text[:5000]}
\"\"\"

Respond with JSON:
{{
    "ai_probability": <0-100 integer, calibrated to rules above>,
    "sentences": [
        {{"text": "most suspicious sentence", "score": <0-100>}},
        ...(top 10 most suspicious only)
    ],
    "suggestions": ["suggestion to make it more human-sounding", ...]
}}

Provide 3-5 humanization suggestions. Return ONLY valid JSON."""

    try:
        content = await get_ai_response(
            [
                {"role": "system", "content": (
                    "You are a calibrated AI detection system aligned with ZeroGPT scoring. "
                    "You UNDER-estimate rather than over-estimate AI probability. "
                    "Natural, conversational, well-written human content should score below 15%. "
                    "Only flag content that has clear AI patterns: uniform structure, "
                    "no personality, excessive formality, repetitive transitions."
                )},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
            max_tokens=2000,
        )
        if "```json" in content:
            content = content.split("```json")[1].split("```")[0]
        elif "```" in content:
            content = content.split("```")[1].split("```")[0]
        result = json.loads(content)

        # Apply statistical correction: if stats strongly suggest human, cap the score
        ai_prob = result.get("ai_probability", 50)
        if stats["contraction_rate"] > 2.0 and stats["sent_len_std"] > 8 and stats["marker_count"] <= 1:
            ai_prob = min(ai_prob, 20)  # Strong human signals
        elif stats["vocab_richness"] > 0.55 and stats["marker_count"] == 0:
            ai_prob = min(ai_prob, 30)
        result["ai_probability"] = ai_prob
        result["source"] = "ai_calibrated"

        await log_activity(site_id, "ai_content_detection",
                           f"AI detection (calibrated): {ai_prob}% probability")
        return result
    except Exception as e:
        logger.error(f"AI content detection failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.post("/ai-content-detector/{site_id}/bulk-scan")
async def bulk_scan_ai_content(site_id: str, _=Depends(require_user)):
    """Scan all posts on a site for AI-generated content"""
    posts_cursor = db.content_items.find({"site_id": site_id}, {"_id": 0, "title": 1, "body": 1, "content_id": 1}).limit(20)
    posts = []
    async for p in posts_cursor:
        posts.append(p)

    if not posts:
        return {"results": []}

    results = []
    for post in posts:
        text = post.get("body", "")
        if text:
            text = BeautifulSoup(text, "html.parser").get_text()[:2000]
        if len(text) < 50:
            results.append({"title": post.get("title", "Untitled"), "content_id": post.get("content_id"), "ai_probability": 0})
            continue
        try:
            stats = _compute_text_stats(text)
            content = await get_ai_response(
                [
                    {"role": "system", "content": (
                        "You are a calibrated AI detection system aligned with ZeroGPT scoring. "
                        "Human content with contractions, varied sentences, personal voice = 0-15%. "
                        "Mixed or lightly edited AI = 30-55%. Pure AI = 70-95%. "
                        "UNDER-estimate rather than over-estimate. Return ONLY a JSON object."
                    )},
                    {"role": "user", "content": (
                        f'Estimate AI probability (0-100, calibrated) for this text. '
                        f'Stats: vocab_richness={stats["vocab_richness"]}, '
                        f'sent_len_std={stats["sent_len_std"]}, '
                        f'ai_markers={stats["marker_count"]}, '
                        f'contractions={stats["contraction_rate"]}%.\n'
                        f'Respond with JSON: {{"ai_probability": <number>}}\n\n'
                        f'Text: """{text}"""'
                    )},
                ],
                temperature=0.2,
                max_tokens=100,
            )
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                content = content.split("```")[1].split("```")[0]
            parsed = json.loads(content)
            ai_prob = parsed.get("ai_probability", 0)
            # Statistical correction
            if stats["contraction_rate"] > 2.0 and stats["sent_len_std"] > 8 and stats["marker_count"] <= 1:
                ai_prob = min(ai_prob, 20)
            results.append({"title": post.get("title", "Untitled"), "content_id": post.get("content_id"), "ai_probability": ai_prob})
        except Exception:
            results.append({"title": post.get("title", "Untitled"), "content_id": post.get("content_id"), "ai_probability": -1})

    await log_activity(site_id, "ai_bulk_scan", f"Bulk AI scan: {len(results)} posts analyzed")
    return {"results": results}


@api_router.post("/ai-content-detector/{site_id}/full-score")
async def ai_content_full_score(site_id: str, data: AIContentFullScoreRequest, _=Depends(require_user)):
    """Module 10 — Comprehensive AI content scoring: AI detection, originality, readability,
    humanization, EEAT signals, content depth, semantic richness, engagement prediction,
    fact accuracy, and composite publish-readiness score."""
    text = data.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required")

    prompt = f"""You are an expert AI content analyst. Perform a comprehensive multi-dimensional analysis of the following text.

Text (first 5000 chars):
\"\"\"
{text[:5000]}
\"\"\"

Analyze and score across ALL of these dimensions. Return a JSON object with EXACTLY this structure:

{{
    "ai_detection": {{
        "ai_probability": <0-100>,
        "label": "Human-like" | "Mixed" | "AI-generated",
        "perplexity_assessment": "low|medium|high",
        "burstiness_assessment": "low|medium|high",
        "suspicious_sentences": [{{"text": "...", "score": <0-100>}}],
        "model_signature_detected": false
    }},
    "originality": {{
        "score": <0-100>,
        "duplicate_risk": "low|medium|high",
        "paraphrase_detection": "none|possible|likely",
        "notes": "..."
    }},
    "readability": {{
        "flesch_score": <0-100>,
        "grade_level": "...",
        "passive_voice_percentage": <0-100>,
        "avg_sentence_length": <number>,
        "score": <0-100>
    }},
    "humanization": {{
        "score": <0-100>,
        "natural_phrasing": <0-100>,
        "sentence_variation": <0-100>,
        "filler_word_usage": "none|low|natural|excessive",
        "generic_ai_phrases_found": ["phrase1", "phrase2"],
        "suggestions": ["suggestion1", "suggestion2", "suggestion3"]
    }},
    "eeat": {{
        "experience_score": <0-100>,
        "expertise_score": <0-100>,
        "authority_score": <0-100>,
        "trust_score": <0-100>,
        "overall_score": <0-100>,
        "missing_signals": ["signal1", "signal2"],
        "suggestions": ["suggestion1", "suggestion2"]
    }},
    "content_depth": {{
        "score": <0-100>,
        "word_count": <number>,
        "topic_coverage": "shallow|adequate|comprehensive",
        "entity_count": <number>,
        "key_entities": ["entity1", "entity2"],
        "topic_gaps": ["gap1", "gap2"]
    }},
    "semantic_richness": {{
        "score": <0-100>,
        "lsi_keyword_usage": "poor|fair|good|excellent",
        "contextual_relevance": <0-100>,
        "entity_diversity": <0-100>
    }},
    "engagement_prediction": {{
        "score": <0-100>,
        "estimated_read_time_minutes": <number>,
        "hook_strength": "weak|moderate|strong",
        "cta_presence": true|false,
        "shareability": "low|medium|high"
    }},
    "fact_accuracy": {{
        "score": <0-100>,
        "unsupported_claims": <number>,
        "flagged_claims": ["claim1", "claim2"],
        "freshness": "outdated|current|evergreen",
        "needs_update": false
    }},
    "seo_compatibility": {{
        "score": <0-100>,
        "heading_structure": "poor|fair|good|excellent",
        "keyword_integration": "poor|fair|good|excellent",
        "meta_readiness": true|false
    }},
    "composite_score": {{
        "publish_readiness": <0-100>,
        "human_quality": <0-100>,
        "overall_grade": "A|B|C|D|F",
        "top_improvements": ["improvement1", "improvement2", "improvement3"]
    }}
}}

Return ONLY valid JSON. Be precise with numeric scores."""

    try:
        content = await get_ai_response(
            [
                {"role": "system", "content": "You are an expert AI content analyst specializing in content quality, AI detection, and SEO. Respond only with valid JSON."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.3,
            max_tokens=3000,
        )
        if "```json" in content:
            content = content.split("```json")[1].split("```")[0]
        elif "```" in content:
            content = content.split("```")[1].split("```")[0]
        result = json.loads(content.strip())
        await log_activity(site_id, "ai_full_score", f"Full AI score: publish_readiness={result.get('composite_score', {}).get('publish_readiness', '?')}")
        return result
    except Exception as e:
        logger.error(f"AI full scoring failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@api_router.post("/ai-content-detector/{site_id}/humanize")
async def humanize_content(site_id: str, data: AIContentDetectorRequest, _=Depends(require_editor)):
    """Rewrite content to pass AI detection — humanize the text."""
    text = data.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required")
    rewritten = await get_ai_response(
        [
            {"role": "system", "content": f"You are an expert content humanizer. Rewrite the given text so it reads as genuinely human-written and scores below 30% on AI detection tools. Preserve the original meaning, facts, and structure.\n\n{HUMANIZE_DIRECTIVE}"},
            {"role": "user", "content": f"Rewrite this text to sound fully human-written:\n\n{text[:5000]}"},
        ],
        temperature=0.8,
        max_tokens=4000,
    )
    await log_activity(site_id, "content_humanized", "AI humanization run on content")
    return {"original_length": len(text), "rewritten": rewritten}


# ─────────────────────────────────────────────────────────────
# FEATURE: Section-by-Section AI Detection (Module 10)
# ========================

class SectionAIDetectRequest(BaseModel):
    text: str

@api_router.post("/ai-content-detector/{site_id}/section-score")
async def ai_section_by_section_score(site_id: str, data: SectionAIDetectRequest, _=Depends(require_user)):
    """Split content by H2 headings, run AI detection per section."""
    import re as _re
    text = data.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required")

    sections = _re.split(r'(?:^|\n)(?:##\s+|<h2[^>]*>)(.*?)(?:</h2>)?(?:\n|$)', text)
    parsed_sections = []
    current_heading = "Introduction"
    for i, part in enumerate(sections):
        stripped = part.strip()
        if not stripped:
            continue
        if i % 2 == 1:
            current_heading = stripped
        else:
            if len(stripped) > 50:
                parsed_sections.append({"heading": current_heading, "text": stripped})

    if not parsed_sections:
        parsed_sections = [{"heading": "Full Document", "text": text}]

    section_summaries = []
    for sec in parsed_sections[:10]:
        try:
            sec_stats = _compute_text_stats(sec['text'])
            resp = await get_ai_response([
                {"role": "system", "content": (
                    "You are a calibrated AI detection system aligned with ZeroGPT scoring. "
                    "Human content = 0-15%. Mixed = 30-55%. Pure AI = 70-95%. "
                    "UNDER-estimate rather than over-estimate. Respond with JSON only."
                )},
                {"role": "user", "content": f"""Analyze for AI detection (calibrated to ZeroGPT).
Stats: vocab_richness={sec_stats['vocab_richness']}, sent_std={sec_stats['sent_len_std']}, markers={sec_stats['marker_count']}, contractions={sec_stats['contraction_rate']}%.
Return JSON:
{{"ai_probability": <0-100 calibrated>, "label": "Human-like"|"Mixed"|"AI-generated", "risk_level": "low"|"medium"|"high", "suspicious_phrases": ["p1"]}}

Text: \"\"\"{sec['text'][:2000]}\"\"\""""},
            ], max_tokens=500, temperature=0.2)
            if "```json" in resp:
                resp = resp.split("```json")[1].split("```")[0]
            elif "```" in resp:
                resp = resp.split("```")[1].split("```")[0]
            score = json.loads(resp.strip())
            # Statistical correction
            ai_p = score.get("ai_probability", 50)
            if sec_stats["contraction_rate"] > 2.0 and sec_stats["sent_len_std"] > 8 and sec_stats["marker_count"] <= 1:
                ai_p = min(ai_p, 20)
            score["ai_probability"] = ai_p
            score["heading"] = sec["heading"]
            score["word_count"] = len(sec["text"].split())
            section_summaries.append(score)
        except Exception:
            section_summaries.append({"heading": sec["heading"], "ai_probability": 50, "label": "Unknown", "risk_level": "medium", "word_count": len(sec["text"].split())})

    avg_score = round(sum(s.get("ai_probability", 50) for s in section_summaries) / max(len(section_summaries), 1))
    high_risk = [s for s in section_summaries if s.get("risk_level") == "high"]
    await log_activity(site_id, "section_ai_detection", f"Section detection: {len(section_summaries)} sections, avg {avg_score}%")
    return {"site_id": site_id, "total_sections": len(section_summaries), "average_ai_probability": avg_score,
            "high_risk_sections": len(high_risk), "sections": section_summaries}


# ========================
# FEATURE: Google Helpful Content Score (Module 10)
# ========================

@api_router.post("/ai-content-detector/{site_id}/helpful-content-score")
async def helpful_content_score(site_id: str, data: AIContentFullScoreRequest, _=Depends(require_user)):
    """Assess Google Helpful Content compliance — people-first content signals."""
    text = data.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required")

    prompt = f"""Assess this content against Google's Helpful Content guidelines.

Text (first 4000 chars): \"\"\"{text[:4000]}\"\"\"

Score each 0-100, return JSON:
{{"people_first_score": <0-100>, "original_analysis": <0-100>, "first_hand_expertise": <0-100>,
"satisfying_answers": <0-100>, "demonstrates_depth": <0-100>, "avoids_search_engine_first": <0-100>,
"provides_substantial_value": <0-100>, "overall_helpful_score": <0-100>,
"compliance_level": "excellent"|"good"|"needs_improvement"|"poor",
"issues": ["i1"], "recommendations": ["r1", "r2"]}}"""

    try:
        resp = await get_ai_response([
            {"role": "system", "content": "You are a Google Search Quality Rater expert. JSON only."},
            {"role": "user", "content": prompt},
        ], max_tokens=1000, temperature=0.3)
        if "```json" in resp:
            resp = resp.split("```json")[1].split("```")[0]
        elif "```" in resp:
            resp = resp.split("```")[1].split("```")[0]
        result = json.loads(resp.strip())
        await log_activity(site_id, "helpful_content_score", f"Helpful Content: {result.get('overall_helpful_score', '?')}")
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ========================
# FEATURE: Real Fact-Check API (Module 10)
# ========================

@api_router.post("/ai-content-detector/{site_id}/fact-check")
async def fact_check_content(site_id: str, data: AIContentFullScoreRequest, _=Depends(require_user)):
    """Verify claims using Google Fact Check Tools API + AI analysis."""
    text = data.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required")

    try:
        claims_resp = await get_ai_response([
            {"role": "system", "content": "Extract verifiable factual claims. JSON only."},
            {"role": "user", "content": f'Extract claims: {{"claims": ["c1", "c2"]}}\n\nText: \"\"\"{text[:3000]}\"\"\"'},
        ], max_tokens=500, temperature=0.2)
        if "```json" in claims_resp:
            claims_resp = claims_resp.split("```json")[1].split("```")[0]
        elif "```" in claims_resp:
            claims_resp = claims_resp.split("```")[1].split("```")[0]
        claims = json.loads(claims_resp.strip()).get("claims", [])
    except Exception:
        claims = []

    settings = await get_decrypted_settings()
    google_api_key = settings.get("google_api_key") or os.environ.get("GOOGLE_API_KEY", "")
    verified_claims = []
    for claim in claims[:10]:
        fc_result = {"claim": claim, "google_results": [], "ai_assessment": "unverified"}
        if google_api_key:
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    resp = await client.get("https://factchecktools.googleapis.com/v1alpha1/claims:search",
                        params={"query": claim[:200], "key": google_api_key, "languageCode": "en"})
                    if resp.status_code == 200:
                        for fc in resp.json().get("claims", [])[:3]:
                            for review in fc.get("claimReview", []):
                                fc_result["google_results"].append({"publisher": review.get("publisher", {}).get("name", ""),
                                    "rating": review.get("textualRating", ""), "url": review.get("url", "")})
            except Exception:
                pass
        try:
            ai_check = await get_ai_response([
                {"role": "system", "content": "Fact-checker. Return one word: verified, likely_true, uncertain, likely_false, or false."},
                {"role": "user", "content": f"Assess: {claim}"},
            ], max_tokens=20, temperature=0.1)
            fc_result["ai_assessment"] = ai_check.strip().lower().replace('"', '').replace('.', '')
        except Exception:
            pass
        verified_claims.append(fc_result)

    verified = sum(1 for c in verified_claims if c["ai_assessment"] in ("verified", "likely_true"))
    flagged = sum(1 for c in verified_claims if c["ai_assessment"] in ("likely_false", "false"))
    await log_activity(site_id, "fact_check", f"Fact-checked {len(verified_claims)} claims: {verified} verified, {flagged} flagged")
    return {"site_id": site_id, "total_claims": len(verified_claims), "verified": verified, "flagged": flagged,
            "uncertain": len(verified_claims) - verified - flagged, "claims": verified_claims,
            "api_used": "google_fact_check" if google_api_key else "ai_only"}
