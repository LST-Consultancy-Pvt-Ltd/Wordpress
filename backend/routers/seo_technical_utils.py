"""SEO technical utility routes: Schema Markup Generator, Sitemap & Robots.txt
Manager, Canonical Tag Manager, Mobile Responsiveness Checker, and Keyword
Intent Categorisation.
"""

from fastapi import HTTPException, BackgroundTasks, Depends
from pydantic import BaseModel
from typing import List, Optional
import asyncio
import uuid
from datetime import datetime, timezone
import os
import httpx
import json

from core.db import db
from core.http_headers import BROWSER_HEADERS
from core.security import require_editor, require_user
from core.tasks import make_task_id, create_task_queue, push_event, finish_task
from core.activity import log_activity
from core.seo_impact import estimate_seo_impact
from core.ai import get_ai_response
from core.crypto import get_decrypted_settings
from core.router import api_router
from core.changesets import create_changeset
from providers.bridge_client import BridgeError
from providers.live_page import fetch_page, known_routes, merge_json_ld, normalise_route
from providers.sites import get_site, get_site_and_client


async def _current_overrides(site_id: str) -> dict:
    _, client = await get_site_and_client(site_id)
    try:
        meta = await client.request("GET", "/inventory/metadata")
    except BridgeError as e:
        raise e.to_http()
    return {i["route"]: i.get("fields") or {} for i in meta.get("items", [])}


# ========================
# FEATURE: Schema Markup Generator
# ========================

class SchemaGenerateRequest(BaseModel):
    path: str  # route or full URL on the site
    schema_type: str  # faq, product, article, local_business


@api_router.post("/schema/{site_id}/generate")
async def generate_schema_markup(site_id: str, data: SchemaGenerateRequest, _: dict = Depends(require_editor)):
    """Use AI to generate JSON-LD for a page, from its live content."""
    site = await get_site(site_id)
    page = await fetch_page(site, data.path)
    title, link, text_content = page["title"], page["url"], page["text"][:2000]
    schema_prompts = {
        "faq": (
            f"Generate a valid JSON-LD FAQPage schema for this page.\nTitle: {title}\nContent: {text_content}\nURL: {link}\n"
            f'Return ONLY the JSON-LD object, example: {{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[...]}}'
        ),
        "article": (
            f"Generate a valid JSON-LD Article schema.\nTitle: {title}\n"
            f"Content: {text_content[:500]}\nURL: {link}\nSite: {site['base_url']}\nReturn ONLY the JSON-LD object."
        ),
        "product": (
            f"Generate a valid JSON-LD Product schema.\nTitle: {title}\n"
            f"Content: {text_content}\nURL: {link}\nReturn ONLY the JSON-LD object."
        ),
        "local_business": (
            f"Generate a valid JSON-LD LocalBusiness schema.\nName: {title}\n"
            f"Content: {text_content}\nURL: {link}\nSite: {site['base_url']}\nReturn ONLY the JSON-LD object."
        ),
    }
    prompt = schema_prompts.get(data.schema_type, schema_prompts["article"])
    schema_raw = await get_ai_response(
        [
            {"role": "system", "content": "You are an SEO schema expert. Return only valid JSON-LD with no markdown fences or extra text."},
            {"role": "user", "content": prompt},
        ],
        max_tokens=1000,
        temperature=0.3,
    )
    for fence in ["```json", "```"]:
        if fence in schema_raw:
            schema_raw = schema_raw.split(fence)[1].split("```")[0]
            break
    schema_raw = schema_raw.strip()
    try:
        parsed = json.loads(schema_raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="AI returned invalid JSON schema")
    if not isinstance(parsed, dict) or "@type" not in parsed:
        raise HTTPException(status_code=500, detail="AI returned JSON-LD without an @type")
    doc = {
        "id": str(uuid.uuid4()), "site_id": site_id, "route": page["route"], "schema_type": data.schema_type,
        "title": title, "url": link, "schema_json": schema_raw, "status": "pending",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.schema_records.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api_router.post("/schema/{site_id}/apply/{schema_id}")
async def apply_schema_markup(site_id: str, schema_id: str, user: dict = Depends(require_editor)):
    """Propose the JSON-LD as part of the page's runtime metadata (change set)."""
    record = await db.schema_records.find_one({"id": schema_id, "site_id": site_id}, {"_id": 0})
    if not record:
        raise HTTPException(status_code=404, detail="Schema record not found")
    overrides = await _current_overrides(site_id)
    fields = dict(overrides.get(record["route"]) or {})
    fields["jsonLd"] = merge_json_ld(fields.get("jsonLd"), json.loads(record["schema_json"]))
    cs = await create_changeset(site_id, title=f"{record['schema_type']} schema for {record['route']}",
                                source="schema", actor=user,
                                operations=[{"op": "metadata.set", "route": record["route"], "fields": fields}])
    await db.schema_records.update_one({"id": schema_id}, {"": {"status": "proposed", "changeset_id": cs["id"]}})
    await log_activity(site_id, "schema_proposed", f"Proposed {record['schema_type']} schema for '{record['title']}'")
    return {"changeset": cs, "status": "proposed", "impact_estimate": estimate_seo_impact("schema_markup")}


# ========================
# FEATURE: Schema Markup Generator
# ========================

@api_router.get("/schema/{site_id}")
async def list_schema_records(site_id: str, _: dict = Depends(require_editor)):
    return await db.schema_records.find({"site_id": site_id}, {"_id": 0}).sort("created_at", -1).to_list(200)


# ========================
# FEATURE: Sitemap & Robots.txt Manager
# ========================

@api_router.get("/sitemap/{site_id}")
async def get_sitemap(site_id: str, _: dict = Depends(require_editor)):
    site = await get_site(site_id)
    base_url = site.get("base_url", "").rstrip("/")
    candidates = [
        f"{base_url}/sitemap.xml",
        f"{base_url}/sitemap_index.xml",
    ]
    content = None
    used_url = None
    async with httpx.AsyncClient(timeout=15, follow_redirects=True, headers=BROWSER_HEADERS) as client:
        for url in candidates:
            try:
                r = await client.get(url)
                if r.status_code == 200 and r.text.strip().startswith("<"):
                    content = r.text
                    used_url = url
                    break
            except Exception:
                continue
    if content is None:
        return {"sitemap_url": None, "urls": [], "total": 0, "raw_xml": "", "message": "No sitemap found"}
    import xml.etree.ElementTree as _ET
    urls = []
    try:
        root = _ET.fromstring(content)
        for loc in root.iter("{http://www.sitemaps.org/schemas/sitemap/0.9}loc"):
            urls.append(loc.text)
        if not urls:
            for loc in root.iter("loc"):
                urls.append(loc.text)
    except Exception:
        pass
    return {"sitemap_url": used_url, "urls": urls[:200], "total": len(urls), "raw_xml": content[:5000]}


@api_router.post("/sitemap/{site_id}/regenerate")
async def regenerate_sitemap(site_id: str, _: dict = Depends(require_editor)):
    site = await get_site(site_id)
    base_url = site.get("base_url", "").rstrip("/")
    results = []
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        for name, ping_url in [
            ("google_ping", f"https://www.google.com/ping?sitemap={base_url}/sitemap.xml"),
            ("bing_ping", f"https://www.bing.com/ping?sitemap={base_url}/sitemap.xml"),
        ]:
            try:
                r = await client.get(ping_url)
                results.append({"target": name, "status": r.status_code})
            except Exception as e:
                results.append({"target": name, "error": str(e)})
    await log_activity(site_id, "sitemap_regenerated", "Sitemap pinged to search engines")
    return {"ok": True, "sitemap_url": f"{base_url}/sitemap.xml", "results": results}


@api_router.get("/robots/{site_id}")
async def get_robots_txt(site_id: str, _: dict = Depends(require_editor)):
    site = await get_site(site_id)
    base_url = site.get("base_url", "").rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True, headers=BROWSER_HEADERS) as client:
            resp = await client.get(f"{base_url}/robots.txt")
            if resp.status_code == 200:
                return {"content": resp.text, "url": f"{base_url}/robots.txt"}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch robots.txt: {e}")
    return {"content": f"User-agent: *\nAllow: /\nSitemap: {base_url}/sitemap.xml\n", "url": f"{base_url}/robots.txt"}


class RobotsUpdateRequest(BaseModel):
    content: str


# ========================
# FEATURE: Canonical Tag Manager
# ========================

@api_router.get("/canonical/{site_id}")
async def get_canonicals(site_id: str, _: dict = Depends(require_user)):
    """Live canonical per known page (from the latest audit) plus any runtime
    override already stored on the bridge."""
    overrides = await _current_overrides(site_id)
    items = []
    for page in await known_routes(site_id):
        override = (overrides.get(page["route"]) or {}).get("canonical")
        live = page.get("canonical")
        effective = override or live or ""
        items.append({
            "route": page["route"], "title": page.get("title", ""), "url": page["url"],
            "canonical": effective or None, "override_canonical": override,
            "live_canonical": live, "audited": page.get("audited"),
            "is_self_referencing": bool(effective) and effective.rstrip("/") == page["url"].rstrip("/"),
            "is_missing": not effective,
        })
    return items


class CanonicalUpdateRequest(BaseModel):
    path: str
    canonical_url: str


@api_router.put("/canonical/{site_id}")
async def update_canonical(site_id: str, data: CanonicalUpdateRequest, user: dict = Depends(require_editor)):
    site = await get_site(site_id)
    route, _url = normalise_route(site, data.path)
    overrides = await _current_overrides(site_id)
    fields = {**(overrides.get(route) or {}), "canonical": data.canonical_url}
    cs = await create_changeset(site_id, title=f"Canonical for {route}", source="canonical", actor=user,
                                operations=[{"op": "metadata.set", "route": route, "fields": fields}])
    return {"changeset": cs, "route": route, "impact_estimate": estimate_seo_impact("canonical_fix")}


@api_router.post("/canonical/{site_id}/bulk-fix")
async def bulk_fix_canonicals(site_id: str, user: dict = Depends(require_editor)):
    """One change set adding a self-referencing canonical to every audited page that has none."""
    overrides = await _current_overrides(site_id)
    ops = []
    for page in await known_routes(site_id):
        existing = overrides.get(page["route"]) or {}
        if page.get("audited") and not page.get("canonical") and not existing.get("canonical"):
            ops.append({"op": "metadata.set", "route": page["route"], "fields": {**existing, "canonical": page["url"]}})
    if not ops:
        return {"changeset": None, "message": "Every audited page already has a canonical (or run an audit first)."}
    cs = await create_changeset(site_id, title=f"Self-referencing canonicals for {len(ops)} page(s)",
                                source="canonical", actor=user, operations=ops[:50])
    return {"changeset": cs, "pages": len(ops), "truncated": len(ops) > 50}

# ========================
# FEATURE: Mobile Responsiveness Checker
# ========================

@api_router.post("/mobile/{site_id}/check")
async def check_mobile_usability(site_id: str, background_tasks: BackgroundTasks, _: dict = Depends(require_editor)):
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_check_mobile_usability, task_id, site_id)
    return {"task_id": task_id}


async def _check_mobile_usability(task_id: str, site_id: str):
    try:
        site = await get_site(site_id)
        settings = await get_decrypted_settings()
        psi_key = settings.get("pagespeed_api_key") or os.environ.get("PAGESPEED_API_KEY", "")
        base_url = site.get("base_url", "").rstrip("/")
        pages_to_check = [base_url]
        for p in (await known_routes(site_id, limit=10))[:5]:
            if p["url"].rstrip("/") != base_url:
                pages_to_check.append(p["url"])
        results = []
        total = len(pages_to_check)
        async with httpx.AsyncClient(timeout=30) as client:
            for idx, url in enumerate(pages_to_check):
                await push_event(task_id, "status", {"message": f"Checking {url}…", "step": idx, "total": total})
                psi_url = f"https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url={url}&strategy=mobile"
                if psi_key:
                    psi_url += f"&key={psi_key}"
                if idx > 0:
                    # PageSpeed Insights' anonymous (no API key) quota is roughly
                    # 1 request/second — pace requests so a multi-page check
                    # doesn't immediately trip a 429.
                    await asyncio.sleep(1.2 if psi_key else 2.0)
                try:
                    resp = await client.get(psi_url)
                    if resp.status_code == 429:
                        # Back off once and retry before giving up on this page.
                        await asyncio.sleep(5.0)
                        resp = await client.get(psi_url)
                    if resp.status_code == 200:
                        data = resp.json()
                        cats = data.get("lighthouseResult", {}).get("categories", {})
                        perf_score = cats.get("performance", {}).get("score")
                        score = round((perf_score or 0) * 100)
                        audits = data.get("lighthouseResult", {}).get("audits", {})
                        failing = [
                            {"id": aid, "title": a.get("title", ""), "description": (a.get("description", "") or "")[:200]}
                            for aid, a in audits.items()
                            if a.get("score") is not None and float(a.get("score", 1)) < 0.5
                        ]
                        screenshot_data = audits.get("final-screenshot", {}).get("details", {}).get("data", "")
                        results.append({
                            "url": url,
                            "score": score,
                            "failing_audits": failing[:10],
                            "screenshot": screenshot_data[:500] if screenshot_data else "",
                            "checked_at": datetime.now(timezone.utc).isoformat(),
                        })
                    elif resp.status_code == 429:
                        results.append({
                            "url": url, "score": None,
                            "error": "Rate-limited by Google PageSpeed Insights. Add a PageSpeed API key in Settings for a higher quota, or try again in a minute.",
                            "failing_audits": [],
                        })
                    else:
                        results.append({"url": url, "score": None, "error": f"PSI returned {resp.status_code}", "failing_audits": []})
                except Exception as e:
                    results.append({"url": url, "score": None, "error": str(e), "failing_audits": []})
        doc = {
            "id": str(uuid.uuid4()),
            "site_id": site_id,
            "results": results,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.mobile_checks.replace_one({"site_id": site_id}, doc, upsert=True)
        await push_event(task_id, "status", {"message": "Mobile check complete!", "step": total, "total": total})
        await finish_task(task_id)
    except Exception as e:
        await push_event(task_id, "error", {"message": str(e)})
        await finish_task(task_id)


@api_router.get("/mobile/{site_id}")
async def get_mobile_check_results(site_id: str, _: dict = Depends(require_editor)):
    doc = await db.mobile_checks.find_one({"site_id": site_id}, {"_id": 0})
    if not doc:
        return {"site_id": site_id, "results": [], "checked_at": None}
    return doc


# ========================
# FEATURE: Keyword Intent Categorisation
# ========================

class CategorizeKeywordsRequest(BaseModel):
    keyword_ids: Optional[List[str]] = None  # None = categorize all


@api_router.post("/keywords/{site_id}/categorize")
async def categorize_keywords(
    site_id: str,
    data: CategorizeKeywordsRequest,
    background_tasks: BackgroundTasks,
    _: dict = Depends(require_editor),
):
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_categorize_keywords, task_id, site_id, data.keyword_ids)
    return {"task_id": task_id}


async def _categorize_keywords(task_id: str, site_id: str, keyword_ids: Optional[List[str]]):
    try:
        query: dict = {"site_id": site_id}
        if keyword_ids:
            query["id"] = {"$in": keyword_ids}
        keywords = await db.keyword_tracking.find(query, {"_id": 0}).to_list(500)
        total = len(keywords)
        if not total:
            await push_event(task_id, "status", {"message": "No keywords to categorize", "step": 0, "total": 0})
            await finish_task(task_id)
            return
        batch_size = 20
        for batch_start in range(0, total, batch_size):
            batch = keywords[batch_start: batch_start + batch_size]
            kw_list = [kw["keyword"] for kw in batch]
            ai_raw = await get_ai_response(
                [{"role": "user", "content": (
                    f"Classify each keyword's search intent into one of: informational, navigational, transactional, commercial.\n"
                    f"Keywords: {json.dumps(kw_list)}\n\n"
                    f'Respond as JSON: {{"results": [{{"keyword": "...", "intent": "informational|navigational|transactional|commercial"}}]}}'
                )}],
                max_tokens=600,
                temperature=0.2,
            )
            for fence in ["```json", "```"]:
                if fence in ai_raw:
                    ai_raw = ai_raw.split(fence)[1].split("```")[0]
                    break
            intent_map: dict = {}
            try:
                parsed = json.loads(ai_raw.strip())
                for item in parsed.get("results", []):
                    intent_map[item["keyword"].lower()] = item.get("intent", "informational")
            except Exception:
                pass
            for kw in batch:
                intent = intent_map.get(kw["keyword"].lower(), "informational")
                await db.keyword_tracking.update_one(
                    {"id": kw["id"]},
                    {"$set": {"intent": intent, "intent_updated_at": datetime.now(timezone.utc).isoformat()}},
                )
            done = min(batch_start + batch_size, total)
            await push_event(task_id, "status", {"message": f"Categorized {done}/{total} keywords", "step": done, "total": total})
        await finish_task(task_id)
    except Exception as e:
        await push_event(task_id, "error", {"message": str(e)})
        await finish_task(task_id)


@api_router.get("/keywords/{site_id}/by-intent")
async def get_keywords_by_intent(site_id: str, _: dict = Depends(require_editor)):
    keywords = await db.keyword_tracking.find({"site_id": site_id}, {"_id": 0}).to_list(500)
    grouped: dict = {"informational": [], "navigational": [], "transactional": [], "commercial": [], "uncategorized": []}
    for kw in keywords:
        intent = kw.get("intent") or "uncategorized"
        if intent not in grouped:
            intent = "uncategorized"
        grouped[intent].append(kw)
    return grouped
