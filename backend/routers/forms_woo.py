"""Forms & Leads Manager (list Contact Form 7 / WPForms, list/AI-analyze stored
entries, generate an FAQ post from entries) and WooCommerce Manager (products/
orders/customers/stats, AI product-description rewrite incl. a bulk background
task, low-stock alert) for a connected WordPress site.
"""
import base64
import json
import logging

import httpx
from bs4 import BeautifulSoup
from fastapi import BackgroundTasks, Depends, HTTPException

from core.activity import log_activity
from core.ai import get_ai_response
from core.db import db
from core.prompts import HUMANIZE_DIRECTIVE
from core.router import api_router
from core.security import require_editor
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from providers.wordpress import get_wp_credentials, wp_api_request

logger = logging.getLogger(__name__)

# ============================================================
# FEATURE 5 — FORMS & LEADS MANAGER
# ============================================================

@api_router.get("/forms/{site_id}")
async def get_forms(site_id: str, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    # Try Contact Form 7 first
    cf7_resp = await wp_api_request(site, "GET", "../../contact-form-7/v1/contact-forms?per_page=50")
    if cf7_resp.status_code == 200:
        data = cf7_resp.json()
        forms = data.get("items", data) if isinstance(data, dict) else data
        return [{"id": f.get("id"), "title": f.get("title", ""), "plugin": "cf7"} for f in forms]
    # Try WPForms
    wpf_url = site["url"].rstrip("/") + "/wp-json/wpforms/v1/forms"
    app_password = site["app_password"].replace(" ", "")
    b64 = base64.b64encode(f"{site['username']}:{app_password}".encode()).decode()
    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as hc:
        wpf_resp = await hc.get(wpf_url, headers={"Authorization": f"Basic {b64}"})
    if wpf_resp.status_code == 200:
        forms_data = wpf_resp.json()
        items = forms_data if isinstance(forms_data, list) else forms_data.get("items", [])
        return [{"id": f.get("id"), "title": f.get("title", ""), "plugin": "wpforms"} for f in items]
    return []

@api_router.get("/forms/{site_id}/{form_id}/entries")
async def get_form_entries(site_id: str, form_id: str, current_user: dict = Depends(require_editor)):
    stored = await db.form_entries.find({"site_id": site_id, "form_id": form_id}, {"_id": 0}).to_list(200)
    return stored

@api_router.post("/forms/{site_id}/ai-analyze/{form_id}")
async def analyze_form_entries(site_id: str, form_id: str, current_user: dict = Depends(require_editor)):
    entries = await db.form_entries.find({"site_id": site_id, "form_id": form_id}, {"_id": 0}).to_list(100)
    if not entries:
        return {"message": "No entries found for this form.", "topics": [], "sentiment": "neutral", "faq_suggestions": []}
    sample = "\n".join([json.dumps({k: v for k, v in e.items() if k not in ("id", "site_id", "form_id")}) for e in entries[:50]])
    analysis = await get_ai_response([
        {"role": "system", "content": "You analyze web form submissions to find patterns and insights."},
        {"role": "user", "content": f"Analyze these form entries and return JSON with keys: sentiment (positive/neutral/negative), top_topics (list of strings), common_questions (list of strings), faq_suggestions (list of {{question, answer}} objects).\n\nEntries:\n{sample}"}
    ], max_tokens=2000)
    try:
        start = analysis.find("{")
        end = analysis.rfind("}") + 1
        result = json.loads(analysis[start:end])
    except Exception:
        result = {"sentiment": "neutral", "top_topics": [], "common_questions": [], "faq_suggestions": []}
    await log_activity(site_id, "form_analyzed", f"AI analyzed form {form_id}")
    return result

@api_router.post("/forms/{site_id}/create-faq-post/{form_id}")
async def create_faq_post_from_form(site_id: str, form_id: str, current_user: dict = Depends(require_editor)):
    entries = await db.form_entries.find({"site_id": site_id, "form_id": form_id}, {"_id": 0}).to_list(100)
    site = await get_wp_credentials(site_id, current_user["id"])
    sample = "\n".join([json.dumps(e) for e in entries[:50]])
    content = await get_ai_response([
        {"role": "system", "content": f"You are an expert blog writer. Create an SEO-optimized FAQ post.\n\n{HUMANIZE_DIRECTIVE}"},
        {"role": "user", "content": f"Based on these form entries, write a complete FAQ blog post in HTML format with h2 questions and p answer paragraphs. Include a compelling title.\n\nEntries:\n{sample}"}
    ], max_tokens=3000)
    title = "Frequently Asked Questions"
    if "title:" in content.lower():
        lines = content.split("\n")
        for line in lines[:5]:
            if "title:" in line.lower():
                title = line.split(":", 1)[-1].strip()
                break
    resp = await wp_api_request(site, "POST", "posts", {"title": title, "content": content, "status": "publish"})
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail="Failed to publish FAQ post")
    post = resp.json()
    await log_activity(site_id, "faq_post_created", f"FAQ post published from form {form_id}")
    return {"success": True, "post_id": post.get("id"), "link": post.get("link"), "title": title}

# ============================================================
# FEATURE 6 — WOOCOMMERCE MANAGER
# ============================================================

async def woo_request(site: dict, method: str, endpoint: str, data: dict = None):
    """WooCommerce REST API request using consumer key/secret."""
    woo_key = site.get("woo_consumer_key", "")
    woo_secret = site.get("woo_consumer_secret", "")
    url = f"{site['url'].rstrip('/')}/wp-json/wc/v3/{endpoint}"
    auth = httpx.BasicAuth(username=woo_key, password=woo_secret)
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True, auth=auth) as hc:
        if method == "GET":
            resp = await hc.get(url)
        elif method == "POST":
            resp = await hc.post(url, json=data)
        elif method in ("PUT", "PATCH"):
            resp = await hc.put(url, json=data)
        else:
            resp = await hc.delete(url)
    return resp

@api_router.get("/woo/{site_id}/products")
async def get_woo_products(site_id: str, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    resp = await woo_request(site, "GET", "products?per_page=100")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"WooCommerce error {resp.status_code}: {resp.text[:200]}")
    return resp.json()

@api_router.get("/woo/{site_id}/orders")
async def get_woo_orders(site_id: str, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    resp = await woo_request(site, "GET", "orders?per_page=50")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"WooCommerce error: {resp.text[:200]}")
    return resp.json()

@api_router.get("/woo/{site_id}/customers")
async def get_woo_customers(site_id: str, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    resp = await woo_request(site, "GET", "customers?per_page=50")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"WooCommerce error: {resp.text[:200]}")
    return resp.json()

@api_router.get("/woo/{site_id}/stats")
async def get_woo_stats(site_id: str, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    resp = await woo_request(site, "GET", "reports/sales?period=month")
    if resp.status_code != 200:
        return {"totals": {"total_sales": 0, "total_orders": 0}}
    return resp.json()

@api_router.post("/woo/{site_id}/products/{prod_id}/ai-description")
async def woo_ai_description(site_id: str, prod_id: int, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    resp = await woo_request(site, "GET", f"products/{prod_id}")
    if resp.status_code != 200:
        raise HTTPException(status_code=404, detail="Product not found")
    product = resp.json()
    name = product.get("name", "")
    existing_desc = BeautifulSoup(product.get("description", ""), "html.parser").get_text()
    price = product.get("price", "")
    new_desc = await get_ai_response([
        {"role": "system", "content": f"You are an expert eCommerce copywriter. Write compelling, SEO-optimized product descriptions.\n\n{HUMANIZE_DIRECTIVE}"},
        {"role": "user", "content": f"Rewrite the description for this product to maximize SEO and conversions. Return HTML with h3 subheadings and bullet points.\n\nProduct: {name}\nPrice: {price}\nExisting: {existing_desc[:500]}"}
    ], max_tokens=1500)
    update_resp = await woo_request(site, "PUT", f"products/{prod_id}", {"description": new_desc})
    if update_resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail="Failed to update product")
    await log_activity(site_id, "woo_product_rewritten", f"AI rewrote description for product {prod_id}")
    return {"success": True, "product_id": prod_id, "new_description": new_desc}

@api_router.post("/woo/{site_id}/bulk-ai-descriptions")
async def woo_bulk_ai_descriptions(site_id: str, background_tasks: BackgroundTasks, current_user: dict = Depends(require_editor)):
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_woo_bulk_descriptions_task, task_id, site_id, current_user["id"])
    return {"task_id": task_id}

async def _woo_bulk_descriptions_task(task_id: str, site_id: str, user_id: str):
    site = await get_wp_credentials(site_id, user_id)
    await push_event(task_id, "progress", {"percent": 5, "message": "Fetching products..."})
    resp = await woo_request(site, "GET", "products?per_page=100")
    if resp.status_code != 200:
        await push_event(task_id, "error", {"message": "Could not fetch products"})
        await finish_task(task_id)
        return
    products = resp.json()
    short_products = [p for p in products if len(BeautifulSoup(p.get("description", ""), "html.parser").get_text().split()) < 100]
    updated = 0
    for idx, product in enumerate(short_products):
        pct = 10 + int(80 * idx / max(len(short_products), 1))
        await push_event(task_id, "progress", {"percent": pct, "message": f"Rewriting {product.get('name', '')} ({idx+1}/{len(short_products)})..."})
        try:
            name = product.get("name", "")
            new_desc = await get_ai_response([
                {"role": "system", "content": f"You are an expert eCommerce copywriter.\n\n{HUMANIZE_DIRECTIVE}"},
                {"role": "user", "content": f"Write a compelling 150-word SEO-optimized product description for: {name}. Return HTML."}
            ], max_tokens=500)
            await woo_request(site, "PUT", f"products/{product['id']}", {"description": new_desc})
            updated += 1
        except Exception:
            pass
    await push_event(task_id, "complete", {"message": f"Rewrote {updated} product descriptions."})
    await log_activity(site_id, "woo_bulk_descriptions", f"Bulk AI descriptions: {updated} products")
    await finish_task(task_id)

@api_router.post("/woo/{site_id}/low-stock-alert")
async def woo_low_stock_alert(site_id: str, current_user: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id, current_user["id"])
    resp = await woo_request(site, "GET", "products?per_page=100&stock_status=instock")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Could not fetch products")
    products = resp.json()
    low_stock = [p for p in products if (p.get("stock_quantity") or 0) < 5 and p.get("manage_stock")]
    suggestions = []
    for p in low_stock[:20]:
        suggestions.append({
            "id": p.get("id"),
            "name": p.get("name"),
            "stock": p.get("stock_quantity", 0),
            "reorder_suggestion": f"Reorder at least {max(10, (p.get('stock_quantity') or 0) * 5)} units of '{p.get('name')}'"
        })
    return {"low_stock_count": len(low_stock), "products": suggestions}
