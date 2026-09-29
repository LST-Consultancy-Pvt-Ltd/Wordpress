"""AI writing assist for the content editor (improve writing, SEO-friendly
rewrite, suggest internal links, summarize, expand). Returns text only;
saving it is a change set like any other edit."""
from typing import Optional

from fastapi import Depends
from pydantic import BaseModel, Field

from core.ai import get_ai_response
from core.prompts import HUMANIZE_DIRECTIVE
from core.router import api_router
from core.security import require_editor


class AIAssistRequest(BaseModel):
    text: str = Field(max_length=100_000)
    action: str  # improve_writing | seo_friendly | add_internal_links | summarize | expand
    site_id: Optional[str] = None


@api_router.post("/ai/assist")
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
