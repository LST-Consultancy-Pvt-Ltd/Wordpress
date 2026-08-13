"""Live Editor: list/get/save WordPress posts+pages for in-app editing, plus
an AI-assist action (improve writing, SEO-friendly rewrite, suggest internal
links, summarize, expand).
"""
import logging
from typing import Optional

from fastapi import Depends, HTTPException
from pydantic import BaseModel

from core.ai import get_ai_response
from core.prompts import HUMANIZE_DIRECTIVE
from core.router import api_router
from core.security import require_editor
from providers.wordpress import get_wp_credentials, wp_api_request

logger = logging.getLogger(__name__)

class AIAssistRequest(BaseModel):
    text: str
    action: str  # improve_writing | seo_friendly | add_internal_links | summarize | expand
    site_id: Optional[str] = None

class SaveEditorPostRequest(BaseModel):
    content: str
    title: Optional[str] = None
    status: Optional[str] = None  # publish | draft

@api_router.get("/editor/{site_id}/posts")
async def editor_list_posts(site_id: str, _: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id)
    posts_resp = await wp_api_request(site, "GET", "posts?per_page=50&status=any&_fields=id,title,status,slug")
    pages_resp = await wp_api_request(site, "GET", "pages?per_page=50&status=any&_fields=id,title,status,slug")
    posts = posts_resp.json() if posts_resp.status_code == 200 else []
    pages = pages_resp.json() if pages_resp.status_code == 200 else []
    return {
        "posts": [{"id": p["id"], "title": p["title"]["rendered"], "status": p["status"], "type": "post"} for p in posts],
        "pages": [{"id": p["id"], "title": p["title"]["rendered"], "status": p["status"], "type": "page"} for p in pages],
    }

@api_router.get("/editor/{site_id}/post/{wp_id}")
async def editor_get_post(site_id: str, wp_id: int, content_type: str = "post", _: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id)
    ep = "pages" if content_type == "page" else "posts"
    resp = await wp_api_request(site, "GET", f"{ep}/{wp_id}")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"WP returned {resp.status_code}")
    d = resp.json()
    return {"id": d["id"], "title": d["title"]["rendered"], "content": d["content"]["rendered"],
            "status": d["status"], "slug": d.get("slug", ""), "type": content_type}

@api_router.put("/editor/{site_id}/post/{wp_id}")
async def editor_save_post(site_id: str, wp_id: int, data: SaveEditorPostRequest, _: dict = Depends(require_editor)):
    site = await get_wp_credentials(site_id)
    payload: dict = {"content": data.content}
    if data.title:
        payload["title"] = data.title
    if data.status:
        payload["status"] = data.status
    resp = await wp_api_request(site, "POST", f"posts/{wp_id}", payload)
    if resp.status_code not in [200, 201]:
        raise HTTPException(status_code=502, detail=f"WP returned {resp.status_code}")
    return {"ok": True, "status": resp.json().get("status")}

@api_router.post("/editor/ai-assist")
async def editor_ai_assist(data: AIAssistRequest, _: dict = Depends(require_editor)):
    prompts = {
        "improve_writing": "Improve writing quality and clarity. Keep the same meaning and length.",
        "seo_friendly": "Rewrite to be more SEO-friendly with natural keyword usage. Keep readability high.",
        "add_internal_links": "Suggest internal link opportunities. Mark them as [LINK: anchor text] inline.",
        "summarize": "Write a concise 2-3 sentence summary.",
        "expand": "Expand with more detail, examples and depth. Maintain tone.",
    }
    instruction = prompts.get(data.action, "Improve this text.")
    result = await get_ai_response([
        {"role": "system", "content": f"You are an expert content editor. Return only the edited text, no preamble.\n\n{HUMANIZE_DIRECTIVE}"},
        {"role": "user", "content": f"{instruction}\n\nText:\n{data.text}"}
    ], max_tokens=2000, temperature=0.5)
    return {"result": result}
