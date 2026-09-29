"""PageSpeed Insights: Google PSI + AI recommendations, stored results."""
import asyncio
import json
import logging
import os

import httpx
from fastapi import Depends, HTTPException

from core.ai import get_ai_response
from core.crypto import get_decrypted_settings
from core.db import db
from core.router import api_router
from core.security import require_editor, require_user
from models.legacy import (
    PageSpeedAIRecommendation,
    PageSpeedAnalyzeRequest,
    PageSpeedDiagnostic,
    PageSpeedOpportunity,
    PageSpeedResult,
)

logger = logging.getLogger(__name__)

# ========================
# Routes: Bulk Meta + Taxonomy
# ========================

# ========================
# Routes: PageSpeed Insights
# ========================

@api_router.post("/pagespeed/{site_id}/analyze")
async def analyze_pagespeed(
    site_id: str,
    body: PageSpeedAnalyzeRequest,
    _: dict = Depends(require_editor),
):
    """Call Google PageSpeed Insights API, parse CWVs + opportunities, generate AI recommendations."""
    if not body.url or not body.url.startswith("http"):
        raise HTTPException(status_code=400, detail="A valid URL starting with http(s) is required")

    settings = await get_decrypted_settings()
    api_key = settings.get("pagespeed_api_key") or os.environ.get("PAGESPEED_API_KEY", "")

    # ── Fetch PageSpeed data ──
    psi_url = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
    params: dict = {"url": body.url, "strategy": "mobile"}
    if api_key:
        params["key"] = api_key

    psi_data = None
    psi_error = None
    try:
        async with httpx.AsyncClient(timeout=60.0) as hc:
            resp = await hc.get(psi_url, params=params)

        if resp.status_code == 429:
            # Rate limited — retry once after 3 seconds
            await asyncio.sleep(3)
            async with httpx.AsyncClient(timeout=60.0) as hc:
                resp = await hc.get(psi_url, params=params)

        if resp.status_code == 429:
            # Still rate limited — fall back to AI-only analysis
            psi_error = (
                "Google PageSpeed API rate limit reached. "
                "Add a free PageSpeed API key in Settings → API Configuration to avoid this. "
                "AI recommendations will still be generated based on the URL."
            )
        elif resp.status_code != 200:
            psi_error = f"PageSpeed API returned {resp.status_code}. AI analysis will still run."
        else:
            psi_data = resp.json()
    except httpx.HTTPError as e:
        psi_error = f"Could not reach PageSpeed API: {e}. AI analysis will still run."

    # ── Parse lighthouse results ──
    lhr = (psi_data or {}).get("lighthouseResult", {})
    categories = lhr.get("categories", {})
    audits = lhr.get("audits", {})

    performance_score = round((categories.get("performance", {}).get("score") or 0) * 100, 1)

    def _ms(audit_id: str) -> float:
        a = audits.get(audit_id, {})
        return round(a.get("numericValue", 0.0), 1)

    fcp = _ms("first-contentful-paint")
    lcp = _ms("largest-contentful-paint")
    tbt = _ms("total-blocking-time")
    cls = round(audits.get("cumulative-layout-shift", {}).get("numericValue", 0.0), 3)

    # Top-5 opportunities (auditRefs with mode=='opportunity' or positive overallSavingsMs)
    opportunities: list[PageSpeedOpportunity] = []
    opp_refs = lhr.get("categories", {}).get("performance", {}).get("auditRefs", [])
    for ref in opp_refs:
        if len(opportunities) >= 5:
            break
        audit = audits.get(ref.get("id", ""), {})
        details = audit.get("details", {})
        overallSavingsMs = details.get("overallSavingsMs", 0)
        if details.get("type") == "opportunity" and overallSavingsMs > 0:
            opportunities.append(PageSpeedOpportunity(
                title=audit.get("title", ""),
                description=audit.get("description", ""),
                savings_ms=round(overallSavingsMs, 0),
            ))

    # Top-3 diagnostics (failed audits not already in opportunities)
    diagnostics: list[PageSpeedDiagnostic] = []
    opp_ids = {o.title for o in opportunities}
    for ref in opp_refs:
        if len(diagnostics) >= 3:
            break
        audit = audits.get(ref.get("id", ""), {})
        if audit.get("score") is not None and (audit.get("score") or 1) < 1:
            title = audit.get("title", "")
            if title not in opp_ids:
                diagnostics.append(PageSpeedDiagnostic(
                    title=title,
                    description=audit.get("description", ""),
                ))

    # ── AI recommendations ──
    opp_summary = "\n".join([f"- {o.title}: {o.savings_ms:.0f}ms savings" for o in opportunities]) or "None identified"
    diag_summary = "\n".join([f"- {d.title}" for d in diagnostics]) or "None"

    if psi_data:
        metrics_context = f"""Performance score: {performance_score}/100
FCP: {fcp}ms | LCP: {lcp}ms | TBT: {tbt}ms | CLS: {cls}

Top opportunities:
{opp_summary}

Diagnostics:
{diag_summary}"""
    else:
        metrics_context = f"""Live metrics not available (PageSpeed API rate-limited).
Provide general Next.js performance best practice recommendations for: {body.url}"""

    ai_prompt = f"""Given these PageSpeed Insights metrics for {body.url}:

{metrics_context}

Provide 5 specific, actionable recommendations to improve this Next.js site's performance (images, fonts, bundle size, caching/ISR, server response).
Respond ONLY with a JSON array (no markdown fences):
[{{"recommendation":"...", "priority":"high|medium|low", "implementation_steps":["step1","step2"]}}]"""

    ai_recs: list[PageSpeedAIRecommendation] = []
    try:
        raw = await get_ai_response(
            [{"role": "user", "content": ai_prompt}],
            max_tokens=1200,
            temperature=0.4,
        )
        # Strip markdown fences if present
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("```")[1]
            if cleaned.startswith("json"):
                cleaned = cleaned[4:]
        parsed = json.loads(cleaned.strip())
        for item in (parsed if isinstance(parsed, list) else []):
            ai_recs.append(PageSpeedAIRecommendation(
                recommendation=item.get("recommendation", ""),
                priority=item.get("priority", "medium"),
                implementation_steps=item.get("implementation_steps", []),
            ))
    except Exception as e:
        logger.warning(f"PageSpeed AI recommendations failed: {e}")

    result = PageSpeedResult(
        site_id=site_id,
        url=body.url,
        performance_score=performance_score,
        fcp=fcp,
        lcp=lcp,
        tbt=tbt,
        cls=cls,
        opportunities=opportunities,
        diagnostics=diagnostics,
        ai_recommendations=ai_recs,
    )
    result_dict = result.model_dump()
    # Attach any API warning so frontend can show it as an info banner
    if psi_error:
        result_dict["psi_warning"] = psi_error
    await db.pagespeed_results.insert_one(result_dict)
    result_dict.pop("_id", None)
    return result_dict


@api_router.get("/pagespeed/{site_id}")
async def get_pagespeed_results(site_id: str, _: dict = Depends(require_user)):
    """Return stored PageSpeed results for a site, newest first."""
    results = await db.pagespeed_results.find(
        {"site_id": site_id}, {"_id": 0}
    ).sort("fetched_at", -1).to_list(20)
    return results
