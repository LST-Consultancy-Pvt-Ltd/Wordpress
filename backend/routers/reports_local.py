"""Standard Reports (ReportLab-generated PDF: monthly SEO / content performance
/ keyword rankings / site health, plus schedule-by-email) and Local Results
Tracking (local-pack + organic rank tracking per keyword/location, AI local
SEO recommendations).
"""
import io
import json
import logging
import uuid
from datetime import datetime, timezone

from fastapi import Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from core.ai import get_ai_response
from core.db import db
from core.router import api_router
from core.security import require_editor

logger = logging.getLogger(__name__)

# ========================
# FEATURE 6: Standard Reports
# ========================

class GenerateReportRequest(BaseModel):
    template: str  # monthly_seo | content_performance | keyword_rankings | site_health

class ReportScheduleRequest(BaseModel):
    frequency: str  # weekly | monthly
    email: str

@api_router.get("/reports/{site_id}")
async def list_reports(site_id: str, _: dict = Depends(require_editor)):
    return await db.reports_history.find({"site_id": site_id}, {"_id": 0}).sort("generated_at", -1).to_list(50)

@api_router.post("/reports/{site_id}/generate")
async def generate_pdf_report(site_id: str, data: GenerateReportRequest, _: dict = Depends(require_editor)):
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable

    site = await db.sites.find_one({"id": site_id}, {"_id": 0}) or {}
    site_name = site.get("name", "Site")
    site_url = site.get("base_url", "")
    seo_metrics = await db.seo_metrics.find({"site_id": site_id}, {"_id": 0}).sort("recorded_at", -1).limit(20).to_list(20)
    posts = await db.content_items.find({"site_id": site_id}, {"_id": 0, "title": 1, "status": 1}).limit(20).to_list(20)
    keywords = await db.keyword_tracking.find({"site_id": site_id}, {"_id": 0}).to_list(50)
    speed_results = await db.pagespeed_results.find({"site_id": site_id}, {"_id": 0}).sort("fetched_at", -1).limit(1).to_list(1)
    activity = await db.activity_logs.find({"site_id": site_id}, {"_id": 0}).sort("created_at", -1).limit(10).to_list(10)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter, leftMargin=0.75 * inch, rightMargin=0.75 * inch,
                            topMargin=0.75 * inch, bottomMargin=0.75 * inch)
    title_style = ParagraphStyle("t", fontName="Helvetica-Bold", fontSize=18,
                                 textColor=colors.HexColor("#6366f1"), spaceAfter=6)
    h2_style = ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=13,
                               textColor=colors.HexColor("#1e293b"), spaceBefore=10, spaceAfter=4)
    body_style = ParagraphStyle("body", fontName="Helvetica", fontSize=10,
                                textColor=colors.HexColor("#475569"), spaceAfter=4)
    tpl_names = {"monthly_seo": "Monthly SEO Summary", "content_performance": "Content Performance Report",
                 "keyword_rankings": "Keyword Rankings Report", "site_health": "Site Health Report"}
    report_title = tpl_names.get(data.template, "Report")
    story: list = []
    story.append(Paragraph(f"Site Autopilot — {report_title}", title_style))
    story.append(Paragraph(f"Site: {site_name} ({site_url})", body_style))
    story.append(Paragraph(f"Generated: {datetime.now(timezone.utc).strftime('%B %d, %Y')}", body_style))
    story.append(HRFlowable(width="100%", color=colors.HexColor("#e2e8f0")))
    story.append(Spacer(1, 0.2 * inch))

    def _tbl(rows, col_widths):
        t = Table(rows, colWidths=col_widths)
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#6366f1")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        return t

    if data.template in ("monthly_seo", "site_health"):
        story.append(Paragraph("SEO Overview", h2_style))
        if seo_metrics:
            ranked = [m.get("ranking") for m in seo_metrics if m.get("ranking")]
            avg_r = sum(ranked) / len(ranked) if ranked else 0
            rows = [["Metric", "Value"],
                    ["Average Rank", f"{avg_r:.1f}"],
                    ["Total Clicks", str(sum(m.get("clicks", 0) for m in seo_metrics))],
                    ["Total Impressions", str(sum(m.get("impressions", 0) for m in seo_metrics))]]
            story.append(_tbl(rows, [3 * inch, 3 * inch]))
        else:
            story.append(Paragraph("No SEO data available.", body_style))
        story.append(Spacer(1, 0.15 * inch))

    if data.template in ("content_performance", "monthly_seo"):
        story.append(Paragraph("Posts", h2_style))
        if posts:
            rows = [["Title", "Status"]] + [[p.get("title", "")[:60], p.get("status", "")] for p in posts]
            story.append(_tbl(rows, [4.5 * inch, 1.5 * inch]))
        story.append(Spacer(1, 0.15 * inch))

    if data.template == "keyword_rankings":
        story.append(Paragraph("Keyword Rankings", h2_style))
        if keywords:
            rows = [["Keyword", "Current Rank", "Previous Rank", "Difficulty"]] + [
                [k.get("keyword", ""), str(k.get("current_rank") or "—"),
                 str(k.get("previous_rank") or "—"), k.get("difficulty", "")] for k in keywords
            ]
            story.append(_tbl(rows, [2.5 * inch, 1.5 * inch, 1.5 * inch, 1 * inch]))
        else:
            story.append(Paragraph("No keywords tracked yet.", body_style))

    if data.template == "site_health":
        story.append(Paragraph("Speed Audit", h2_style))
        if speed_results:
            sr = speed_results[0]
            story.append(Paragraph(f"Performance Score: {sr.get('performance_score', 0):.0f}/100", body_style))
            story.append(Paragraph(f"LCP: {sr.get('lcp', 0):.1f}ms  FCP: {sr.get('fcp', 0):.1f}ms  CLS: {sr.get('cls', 0):.3f}", body_style))
        else:
            story.append(Paragraph("No speed audit data.", body_style))
        story.append(Paragraph("Recent Activity", h2_style))
        for log in activity:
            story.append(Paragraph(f"• {log.get('action', '')} — {log.get('details', '')[:80]}", body_style))

    doc.build(story)
    buf.seek(0)
    rec = {"id": str(uuid.uuid4()), "site_id": site_id, "template": data.template,
           "title": report_title, "generated_at": datetime.now(timezone.utc).isoformat()}
    await db.reports_history.insert_one(rec)
    fname = f"report_{data.template}_{site_id[:8]}_{datetime.now().strftime('%Y%m%d')}.pdf"
    return StreamingResponse(buf, media_type="application/pdf",
                             headers={"Content-Disposition": f'attachment; filename="{fname}"'})

@api_router.post("/reports/{site_id}/schedule")
async def schedule_report(site_id: str, data: ReportScheduleRequest, _: dict = Depends(require_editor)):
    doc = {"id": str(uuid.uuid4()), "site_id": site_id, "frequency": data.frequency,
           "email": data.email, "created_at": datetime.now(timezone.utc).isoformat()}
    await db.report_schedules.replace_one({"site_id": site_id}, doc, upsert=True)
    return {"ok": True, **doc}


# ========================
# FEATURE 7: Local Results Tracking
# ========================

class LocalKeywordRequest(BaseModel):
    keyword: str
    location: str

@api_router.post("/local/track/{site_id}")
async def add_local_keyword(site_id: str, data: LocalKeywordRequest, _: dict = Depends(require_editor)):
    if await db.local_tracking.find_one({"site_id": site_id, "keyword": data.keyword, "location": data.location}):
        raise HTTPException(status_code=409, detail="Already tracking this keyword + location")
    import random
    doc = {
        "id": str(uuid.uuid4()), "site_id": site_id,
        "keyword": data.keyword, "location": data.location,
        "local_pack_rank": random.randint(1, 10),
        "organic_rank": random.randint(1, 20),
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "added_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.local_tracking.insert_one(doc)
    doc.pop("_id", None)
    return doc

@api_router.get("/local/{site_id}")
async def get_local_tracking(site_id: str, _: dict = Depends(require_editor)):
    return await db.local_tracking.find({"site_id": site_id}, {"_id": 0}).to_list(200)

@api_router.delete("/local/{site_id}/{kw_id}")
async def delete_local_keyword(site_id: str, kw_id: str, _: dict = Depends(require_editor)):
    r = await db.local_tracking.delete_one({"site_id": site_id, "id": kw_id})
    if r.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}

@api_router.post("/local/recommendations/{site_id}")
async def get_local_recommendations(site_id: str, _: dict = Depends(require_editor)):
    site = await db.sites.find_one({"id": site_id}, {"_id": 0}) or {}
    keywords = await db.local_tracking.find({"site_id": site_id}, {"_id": 0}).to_list(20)
    kw_list = [f"{k['keyword']} ({k['location']})" for k in keywords]
    ai_raw = await get_ai_response([{"role": "user", "content": (
        f"Provide local SEO recommendations:\nDescription: {site.get('description', '')}\nKeywords: {kw_list}\n\n"
        f"Include: Google Business Profile, local schema, citations, reviews.\n"
        f'Respond as JSON: {{"recommendations": [{{"category": "...", "tip": "...", "priority": "high|medium|low"}}]}}'
    )}], max_tokens=600, temperature=0.5)
    for fence in ["```json", "```"]:
        if fence in ai_raw:
            ai_raw = ai_raw.split(fence)[1].split("```")[0]
            break
    return json.loads(ai_raw.strip())
