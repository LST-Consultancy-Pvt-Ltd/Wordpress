"""Tool definitions and dispatcher for the multi-turn AI Agent chat feature
(`/api/agent-sessions/*`): lets the LLM read site content and SEO data and
*propose* changes mid-conversation. Proposals become change sets that a
person reviews; the agent has no tool that applies anything.
"""
import json
from urllib.parse import urlsplit

import httpx

from core.ai import get_ai_response
from core.content_proposals import propose_content
from core.changesets import create_changeset
from core.db import db
from core.http_headers import BROWSER_HEADERS

AGENT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_site_content",
            "description": "List the site's synced content items (collection, slug, title, status, url)",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_post",
            "description": "Propose a new or updated content item. Creates a change set for human review; "
                           "nothing is published until a deployer approves and applies it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Post title"},
                    "content": {"type": "string", "description": "HTML content"},
                    "slug": {"type": "string", "description": "URL slug (optional; derived from the title)"},
                    "description": {"type": "string", "description": "Meta description (max 160 chars)"},
                    "status": {"type": "string", "enum": ["draft", "published"], "default": "draft"},
                },
                "required": ["title", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_metadata",
            "description": "Propose SEO metadata (title, description, canonical) for one route, e.g. '/about'. "
                           "Creates a change set for human review.",
            "parameters": {
                "type": "object",
                "properties": {
                    "route": {"type": "string"},
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "canonical": {"type": "string"},
                },
                "required": ["route"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "analyze_seo",
            "description": "Analyze SEO for a given URL and return recommendations",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_url": {"type": "string", "description": "Full URL to analyze"},
                },
                "required": ["page_url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_seo_metrics",
            "description": "Get the stored SEO metrics for the site",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_company_profile",
            "description": "Get the verified business facts (name, address, phone, website, description) for this "
                            "site, if one has been set up. Use this instead of asking the user to repeat NAP details "
                            "already on file, or before drafting anything that needs the business's real name/address/phone.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_offpage_score",
            "description": "Get this site's off-page authority score (0-100) and its breakdown "
                            "(backlinks acquired, brand mentions, citations, guest posts, etc.) — real counts from "
                            "the site's actual off-page SEO data, not an estimate.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_backlink_opportunities",
            "description": "List this site's discovered backlink opportunities (prospect domains, relevance score, "
                            "estimated domain authority, outreach status). Each result's data_source field says "
                            "whether it came from real DataForSEO data or an AI estimate — mention that distinction "
                            "if asked how confident to be in a given opportunity.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]

def _same_site(url: str, site: dict) -> bool:
    """The model chooses the URL, so only the managed site's own host may be
    fetched — otherwise this tool is a server-side request forgery primitive."""
    target, own = urlsplit(url), urlsplit(site.get("base_url", ""))
    return target.scheme == "https" and bool(own.hostname) and target.hostname == own.hostname


async def execute_agent_tool(tool_name: str, tool_args: dict, site: dict, actor: dict) -> str:
    """Execute an agent tool call and return a string result."""
    try:
        if tool_name == "get_site_content":
            items = await db.content_items.find({"site_id": site["id"]}, {"_id": 0, "body": 0}).to_list(100)
            return json.dumps([{"collection": i.get("collection"), "slug": i.get("slug"), "title": i.get("title"),
                                "status": i.get("status"), "url": i.get("url")} for i in items])

        elif tool_name == "propose_post":
            cs = await propose_content(
                site["id"], actor=actor, source="ai-agent", title=f"AI agent: {tool_args['title']}"[:200],
                items=[{"title": tool_args["title"], "body": tool_args["content"], "slug": tool_args.get("slug"),
                        "status": tool_args.get("status", "draft"),
                        "frontmatter": {"description": tool_args.get("description"), "content_format": "html"}}])
            return json.dumps({"proposed": True, "changeset_id": cs["id"], "status": cs["status"],
                               "note": "A person must approve and apply this change set before it goes live."})

        elif tool_name == "propose_metadata":
            fields = {k: tool_args[k] for k in ("title", "description", "canonical") if tool_args.get(k)}
            if not fields:
                return json.dumps({"error": "supply at least one of title, description, canonical"})
            cs = await create_changeset(site["id"], title=f"AI agent: metadata for {tool_args['route']}",
                                        source="ai-agent", actor=actor,
                                        operations=[{"op": "metadata.set", "route": tool_args["route"], "fields": fields}])
            return json.dumps({"proposed": True, "changeset_id": cs["id"], "status": cs["status"],
                               "warnings": (cs.get("plan") or {}).get("warnings", [])})

        elif tool_name == "analyze_seo":
            page_url = tool_args["page_url"]
            if not _same_site(page_url, site):
                return json.dumps({"error": "analyze_seo only fetches https pages on this site's own domain"})
            try:
                async with httpx.AsyncClient(timeout=20.0, headers=BROWSER_HEADERS, follow_redirects=False) as hc:
                    page_resp = await hc.get(page_url)
                    page_content = page_resp.text[:3000]
            except Exception:
                page_content = "Could not fetch"
            prompt = f"Analyze SEO for {page_url}. Content preview: {page_content[:1500]}. Return JSON with score, issues, recommendations."
            return await get_ai_response([{"role": "user", "content": prompt}], max_tokens=800)

        elif tool_name == "get_seo_metrics":
            metrics = await db.seo_metrics.find({"site_id": site["id"]}, {"_id": 0}).to_list(50)
            return json.dumps([{"url": m.get("page_url"), "keyword": m.get("keyword"), "ctr": m.get("ctr"), "ranking": m.get("ranking")} for m in metrics])

        elif tool_name == "get_company_profile":
            profile = await db.company_profiles.find_one({"site_id": site["id"]}, {"_id": 0})
            if not profile:
                return json.dumps({"exists": False, "message": "No company profile set up for this site yet."})
            return json.dumps({"exists": True, **profile})

        elif tool_name == "get_offpage_score":
            from routers.opportunities import offpage_score
            result = await offpage_score(site["id"], {})
            return json.dumps(result)

        elif tool_name == "get_backlink_opportunities":
            opps = await db.backlink_outreach.find({"site_id": site["id"]}, {"_id": 0}).sort("created_at", -1).to_list(50)
            return json.dumps([{
                "prospect_domain": o.get("prospect_domain"), "status": o.get("status"),
                "relevance_score": o.get("relevance_score"), "estimated_da": o.get("estimated_da"),
                "data_source": o.get("data_source"), "is_estimated": o.get("is_estimated"),
            } for o in opps])

        else:
            return json.dumps({"error": f"Unknown tool: {tool_name}"})
    except Exception as e:
        detail = getattr(e, "detail", None)
        return json.dumps({"error": detail if isinstance(detail, (str, dict)) else type(e).__name__})
