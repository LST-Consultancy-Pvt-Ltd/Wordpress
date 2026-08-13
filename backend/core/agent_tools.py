"""Tool definitions and dispatcher for the multi-turn AI Agent chat feature
(`/api/agent-sessions/*`): lets the LLM call back into the app to read/write
WordPress content and SEO data mid-conversation.
"""
import json

import httpx

from core.ai import get_ai_response
from core.db import db
from providers.wordpress import wp_api_request

AGENT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_site_posts",
            "description": "Get all posts from the WordPress site",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_site_pages",
            "description": "Get all pages from the WordPress site",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_post",
            "description": "Create a new blog post on the WordPress site",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Post title"},
                    "content": {"type": "string", "description": "HTML content"},
                    "status": {"type": "string", "enum": ["draft", "publish"], "default": "draft"},
                },
                "required": ["title", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_post",
            "description": "Update an existing post's title, content, or status",
            "parameters": {
                "type": "object",
                "properties": {
                    "wp_id": {"type": "integer", "description": "WordPress post ID"},
                    "title": {"type": "string"},
                    "content": {"type": "string"},
                    "meta_description": {"type": "string"},
                    "status": {"type": "string", "enum": ["draft", "publish"]},
                },
                "required": ["wp_id"],
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

async def execute_agent_tool(tool_name: str, tool_args: dict, site: dict) -> str:
    """Execute an agent tool call and return a string result."""
    try:
        if tool_name == "get_site_posts":
            posts = await db.posts.find({"site_id": site["id"]}, {"_id": 0}).to_list(50)
            return json.dumps([{"id": p.get("wp_id"), "title": p.get("title"), "status": p.get("status"), "link": p.get("link")} for p in posts])

        elif tool_name == "get_site_pages":
            pages = await db.pages.find({"site_id": site["id"]}, {"_id": 0}).to_list(50)
            return json.dumps([{"id": p.get("wp_id"), "title": p.get("title"), "status": p.get("status"), "link": p.get("link")} for p in pages])

        elif tool_name == "create_post":
            wp_data = {"title": tool_args["title"], "content": tool_args["content"], "status": tool_args.get("status", "draft")}
            response = await wp_api_request(site, "POST", "posts", wp_data)
            if response.status_code in (200, 201):
                wp_post = response.json()
                return json.dumps({"success": True, "wp_id": wp_post["id"], "link": wp_post["link"]})
            return json.dumps({"success": False, "error": response.text})

        elif tool_name == "update_post":
            wp_id = tool_args.pop("wp_id")
            response = await wp_api_request(site, "PUT", f"posts/{wp_id}", tool_args)
            if response.status_code == 200:
                return json.dumps({"success": True, "wp_id": wp_id})
            return json.dumps({"success": False, "error": response.text})

        elif tool_name == "analyze_seo":
            page_url = tool_args["page_url"]
            try:
                async with httpx.AsyncClient(timeout=20.0) as hc:
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
        return json.dumps({"error": str(e)})
