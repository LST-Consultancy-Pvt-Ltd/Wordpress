"""Programmatic Page Engine (service×city page generation with AI FAQs +
LocalBusiness/FAQPage schema, push to WordPress) and Keyword Cluster Engine
(AI-classified local/transactional/comparison keyword clusters).
"""
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import List

from fastapi import BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

from core.activity import log_activity
from core.ai import get_ai_response
from core.db import db
from core.router import api_router
from core.security import require_editor, require_user
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from providers.wordpress import get_wp_credentials, wp_api_request

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────
# Feature: Programmatic Page Engine
# ─────────────────────────────────────────────────────────────────

class ServiceEntry(BaseModel):
    name: str
    description: str = ""
    pricing: str = ""
    features: List[str] = []

class LocationEntry(BaseModel):
    city: str
    state: str = ""
    population: int = 0
    local_keywords: List[str] = []

class ProgrammaticPageRequest(BaseModel):
    services: List[ServiceEntry]
    locations: List[LocationEntry]

class ProgrammaticPushRequest(BaseModel):
    page_ids: List[str]

@api_router.post("/programmatic/{site_id}/generate")
async def generate_programmatic_pages(
    site_id: str,
    body: ProgrammaticPageRequest,
    background_tasks: BackgroundTasks,
    _: dict = Depends(require_editor),
):
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_generate_programmatic_pages, task_id, site_id, body)
    return {"task_id": task_id}

async def _generate_programmatic_pages(task_id: str, site_id: str, body: ProgrammaticPageRequest):
    try:
        combinations = [(s, l) for s in body.services for l in body.locations]
        total = len(combinations)
        await push_event(task_id, "status", {"message": f"Generating {total} pages...", "percent": 0})

        for idx, (service, location) in enumerate(combinations):
            pct = int(((idx + 1) / total) * 90)
            city = location.city
            state = location.state
            service_slug = service.name.lower().replace(" ", "-")
            city_slug = city.lower().replace(" ", "-")
            url_slug = f"/{service_slug}-in-{city_slug}/"
            local_kws = ", ".join(location.local_keywords[:5]) if location.local_keywords else f"{service.name} {city}"
            features_html = "".join(f"<li>{f}</li>" for f in service.features[:6])

            faq_prompt = f"""Generate 3 FAQs for a {service.name} company serving {city}, {state}.
Return JSON array: [{{"question": "...", "answer": "..."}}]"""
            try:
                faq_raw = await get_ai_response(
                    [{"role": "user", "content": faq_prompt}], max_tokens=600, temperature=0.5
                )
                if "```json" in faq_raw:
                    faq_raw = faq_raw.split("```json")[1].split("```")[0]
                elif "```" in faq_raw:
                    faq_raw = faq_raw.split("```")[1].split("```")[0]
                faqs = json.loads(faq_raw.strip())
                if not isinstance(faqs, list):
                    faqs = []
            except Exception:
                faqs = []

            faq_html = ""
            faq_schema_items = []
            for f in faqs:
                faq_html += f"<h3>{f.get('question','')}</h3><p>{f.get('answer','')}</p>"
                faq_schema_items.append({"@type": "Question", "name": f.get("question",""), "acceptedAnswer": {"@type": "Answer", "text": f.get("answer","")}})

            schema = {
                "@context": "https://schema.org",
                "@graph": [
                    {
                        "@type": "LocalBusiness",
                        "name": service.name,
                        "description": service.description,
                        "areaServed": {"@type": "City", "name": city, "addressRegion": state},
                        "priceRange": service.pricing or "$$",
                    },
                    {
                        "@type": "FAQPage",
                        "mainEntity": faq_schema_items
                    }
                ]
            }
            schema_html = f'<script type="application/ld+json">{json.dumps(schema)}</script>'

            title = f"{service.name} in {city}, {state}" if state else f"{service.name} in {city}"
            meta_desc = f"Looking for {service.name} in {city}? We offer professional {service.name.lower()} services. {service.pricing or 'Call now for pricing'}."
            h1 = f"{service.name} in {city}" + (f", {state}" if state else "")
            h2_services = f"Why Choose Our {service.name} Services?"
            h2_area = f"Serving {city}" + (f" and Surrounding {state} Areas" if state else " and Surrounding Areas")

            content = f"""{schema_html}
<h1>{h1}</h1>
<p>{service.description or f'We provide expert {service.name.lower()} services in {city}. Our team is ready to help.'}</p>
<h2>{h2_services}</h2>
<ul>{features_html}</ul>
<h2>{h2_area}</h2>
<p>We proudly serve {city}{', ' + state if state else ''} and nearby communities. Keywords: {local_kws}.</p>
<h2>Pricing</h2>
<p>{service.pricing or 'Contact us for a free quote.'}</p>
<h2>Frequently Asked Questions</h2>
{faq_html}
<h2>Get a Free Quote</h2>
<p>Call us today or fill out our contact form to get started with your {service.name.lower()} project in {city}.</p>"""

            page_doc = {
                "id": str(uuid.uuid4()),
                "site_id": site_id,
                "service": service.name,
                "city": city,
                "state": state,
                "title": title,
                "url_slug": url_slug,
                "meta_description": meta_desc,
                "content": content,
                "pushed_to_wp": False,
                "wp_id": None,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            await db.programmatic_pages.insert_one(page_doc)
            await push_event(task_id, "progress", {"message": f"Generated: {title}", "percent": pct})

        await push_event(task_id, "complete", {"message": f"Generated {total} pages", "percent": 100, "total": total})
        await log_activity(site_id, "programmatic_generated", f"Generated {total} programmatic pages")
    except Exception as e:
        await push_event(task_id, "error", {"message": str(e)})
    finally:
        await finish_task(task_id)

@api_router.get("/programmatic/{site_id}")
async def list_programmatic_pages(site_id: str, _: dict = Depends(require_user)):
    docs = await db.programmatic_pages.find({"site_id": site_id}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return docs

@api_router.post("/programmatic/{site_id}/push")
async def push_programmatic_pages(
    site_id: str,
    body: ProgrammaticPushRequest,
    background_tasks: BackgroundTasks,
    _: dict = Depends(require_editor),
):
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_push_programmatic_pages, task_id, site_id, body.page_ids)
    return {"task_id": task_id}

async def _push_programmatic_pages(task_id: str, site_id: str, page_ids: List[str]):
    try:
        site = await get_wp_credentials(site_id)
        total = len(page_ids)
        pushed = 0
        for idx, page_id in enumerate(page_ids):
            doc = await db.programmatic_pages.find_one({"id": page_id, "site_id": site_id}, {"_id": 0})
            if not doc or doc.get("pushed_to_wp"):
                continue
            wp_data = {
                "title": doc["title"],
                "content": doc["content"],
                "status": "draft",
                "slug": doc["url_slug"].strip("/"),
                "meta": {"_yoast_wpseo_metadesc": doc["meta_description"]},
            }
            resp = await wp_api_request(site, "POST", "pages", wp_data)
            if resp.status_code in (200, 201):
                wp_id = resp.json()["id"]
                await db.programmatic_pages.update_one(
                    {"id": page_id}, {"$set": {"pushed_to_wp": True, "wp_id": wp_id}}
                )
                pushed += 1
            pct = int(((idx + 1) / total) * 100)
            await push_event(task_id, "progress", {"message": f"Pushed {pushed}/{total}", "percent": pct})
        await push_event(task_id, "complete", {"message": f"Pushed {pushed}/{total} pages to WordPress", "percent": 100})
        await log_activity(site_id, "programmatic_pushed", f"Pushed {pushed} programmatic pages to WP")
    except Exception as e:
        await push_event(task_id, "error", {"message": str(e)})
    finally:
        await finish_task(task_id)

@api_router.delete("/programmatic/{site_id}/{page_id}")
async def delete_programmatic_page(site_id: str, page_id: str, _: dict = Depends(require_editor)):
    result = await db.programmatic_pages.delete_one({"id": page_id, "site_id": site_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Page not found")
    return {"deleted": True}


# ─────────────────────────────────────────────────────────────────
# Feature: Keyword Cluster Engine
# ─────────────────────────────────────────────────────────────────

class KeywordClusterRequest(BaseModel):
    seed_service: str
    cities: List[str]
    competitors: List[str] = []

@api_router.post("/keyword-clusters/{site_id}/generate")
async def generate_keyword_clusters(
    site_id: str,
    body: KeywordClusterRequest,
    _: dict = Depends(require_editor),
):
    patterns_per_city = []
    for city in body.cities[:20]:
        patterns_per_city.extend([
            {"keyword": f"{body.seed_service} {city}", "intent": "local", "city": city},
            {"keyword": f"best {body.seed_service} in {city}", "intent": "local", "city": city},
            {"keyword": f"emergency {body.seed_service} near me", "intent": "transactional", "city": city},
            {"keyword": f"{body.seed_service} {city} cost", "intent": "transactional", "city": city},
            {"keyword": f"affordable {body.seed_service} {city}", "intent": "transactional", "city": city},
            {"keyword": f"{body.seed_service} company {city}", "intent": "local", "city": city},
        ])
    for competitor in body.competitors[:5]:
        patterns_per_city.append({
            "keyword": f"{body.seed_service} vs {competitor}",
            "intent": "comparison",
            "city": None,
        })

    ai_prompt = f"""You are an SEO specialist. Analyze these keywords for the service "{body.seed_service}" and classify each:
1. Add is_money_keyword: true if it's high-intent AND local (likely to convert)
2. Verify/correct the intent: transactional, local, or comparison
3. Add estimated search volume tier: high/medium/low

Keywords:
{json.dumps(patterns_per_city[:40], indent=2)}

Return a JSON array with same items, adding is_money_keyword (bool) and search_volume_tier (string).
Return ONLY the JSON array."""

    try:
        raw = await get_ai_response(
            [{"role": "system", "content": "You are an SEO keyword analyst. Return only JSON."},
             {"role": "user", "content": ai_prompt}],
            max_tokens=2000, temperature=0.3,
        )
        if "```json" in raw:
            raw = raw.split("```json")[1].split("```")[0]
        elif "```" in raw:
            raw = raw.split("```")[1].split("```")[0]
        enriched = json.loads(raw.strip())
        if not isinstance(enriched, list):
            enriched = patterns_per_city
    except Exception:
        enriched = patterns_per_city

    clusters = {
        "transactional": [k for k in enriched if k.get("intent") == "transactional"],
        "local": [k for k in enriched if k.get("intent") == "local"],
        "comparison": [k for k in enriched if k.get("intent") == "comparison"],
        "money_keywords": [k for k in enriched if k.get("is_money_keyword")],
    }

    doc = {
        "id": str(uuid.uuid4()),
        "site_id": site_id,
        "seed_service": body.seed_service,
        "cities": body.cities,
        "keywords": enriched,
        "clusters": clusters,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.keyword_clusters.insert_one(doc)
    await log_activity(site_id, "keyword_clusters_generated", f"Generated {len(enriched)} clusters for {body.seed_service}")
    return {k: v for k, v in doc.items() if k != "_id"}

@api_router.get("/keyword-clusters/{site_id}")
async def list_keyword_clusters(site_id: str, _: dict = Depends(require_user)):
    docs = await db.keyword_clusters.find({"site_id": site_id}, {"_id": 0}).sort("created_at", -1).to_list(50)
    return docs

@api_router.delete("/keyword-clusters/{site_id}/{cluster_id}")
async def delete_keyword_cluster(site_id: str, cluster_id: str, _: dict = Depends(require_editor)):
    await db.keyword_clusters.delete_one({"id": cluster_id, "site_id": site_id})
    return {"deleted": True}
