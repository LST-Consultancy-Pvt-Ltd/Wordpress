"""Multi-turn AI Agent chat (session CRUD, streamed agent turns with tool-calling
against a connected WordPress site) plus the legacy single-turn `/api/ai/command`
endpoint kept for backward compatibility.
"""
import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import BackgroundTasks, Depends, HTTPException

from core.activity import log_activity
from core.agent_tools import AGENT_TOOLS, execute_agent_tool
from core.ai import get_ai_response, get_openai_client
from core.db import db
from core.router import api_router
from core.security import get_current_user
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from models.legacy import (
    AgentSession, AgentSessionCreate, AgentTurnRequest, AICommand, AICommandCreate,
)
from providers.wordpress import get_wp_credentials

logger = logging.getLogger(__name__)

@api_router.post("/agent/sessions")
async def create_agent_session(data: AgentSessionCreate, current_user: Optional[dict] = Depends(get_current_user)):
    user_id = current_user["id"] if current_user else "global"
    session = AgentSession(site_id=data.site_id, user_id=user_id, title=data.title or "New Session")
    await db.agent_sessions.insert_one(session.model_dump())
    return session.model_dump()

@api_router.get("/agent/sessions/{site_id}")
async def get_agent_sessions(site_id: str, current_user: Optional[dict] = Depends(get_current_user)):
    user_id = current_user["id"] if current_user else "global"
    sessions = await db.agent_sessions.find(
        {"site_id": site_id, "user_id": user_id}, {"_id": 0}
    ).sort("updated_at", -1).to_list(50)
    return sessions

@api_router.get("/agent/session/{session_id}")
async def get_agent_session(session_id: str, current_user: Optional[dict] = Depends(get_current_user)):
    session = await db.agent_sessions.find_one({"id": session_id}, {"_id": 0})
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session

@api_router.delete("/agent/session/{session_id}")
async def delete_agent_session(session_id: str):
    await db.agent_sessions.delete_one({"id": session_id})
    return {"message": "Session deleted"}

@api_router.post("/agent/turn")
async def agent_turn(turn_data: AgentTurnRequest, background_tasks: BackgroundTasks, current_user: Optional[dict] = Depends(get_current_user)):
    """Start an agent turn, returns task_id for SSE streaming."""
    user_id = current_user["id"] if current_user else "global"
    session = await db.agent_sessions.find_one({"id": turn_data.session_id}, {"_id": 0})
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    task_id = make_task_id()
    await create_task_queue(task_id)
    background_tasks.add_task(_run_agent_turn, task_id, session, turn_data.message, user_id)
    return {"task_id": task_id}

async def _run_agent_turn(task_id: str, session: dict, user_message: str, user_id: str):
    try:
        openai_client = await get_openai_client()
        site = await get_wp_credentials(session["site_id"])

        # Append user message
        session["messages"].append({"role": "user", "content": user_message})

        system_prompt = f"""You are an expert AI WordPress manager for site: {site['name']} ({site['url']}).
You have access to tools to manage posts, pages, and SEO.
Chain multiple actions as needed to fulfill the user's request completely.
Always explain each step you take."""

        messages = [{"role": "system", "content": system_prompt}] + session["messages"]

        await push_event(task_id, "status", {"message": "Agent started...", "step": 0})

        step = 0
        MAX_STEPS = 10
        while step < MAX_STEPS:
            step += 1
            await push_event(task_id, "thinking", {"message": f"Agent thinking (step {step})...", "step": step})

            response = await openai_client.chat.completions.create(
                model="gpt-4o",
                messages=messages,
                tools=AGENT_TOOLS,
                tool_choice="auto",
                max_tokens=2000,
            )

            choice = response.choices[0]
            msg = choice.message

            # Append assistant message
            msg_dict = {"role": "assistant", "content": msg.content or ""}
            if msg.tool_calls:
                msg_dict["tool_calls"] = [
                    {"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                    for tc in msg.tool_calls
                ]
            messages.append(msg_dict)

            if msg.content:
                await push_event(task_id, "assistant_message", {"content": msg.content, "step": step})

            # If no tool calls, we're done
            if not msg.tool_calls or choice.finish_reason == "stop":
                break

            # Execute tool calls
            for tc in msg.tool_calls:
                fn_name = tc.function.name
                try:
                    fn_args = json.loads(tc.function.arguments)
                except Exception:
                    fn_args = {}

                await push_event(task_id, "tool_call", {"tool": fn_name, "args": fn_args, "step": step})
                tool_result = await execute_agent_tool(fn_name, fn_args, site)
                await push_event(task_id, "tool_result", {"tool": fn_name, "result": tool_result[:500], "step": step})

                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": tool_result,
                })

        # Build final assistant response
        final_content = ""
        for m in reversed(messages):
            if m.get("role") == "assistant" and m.get("content"):
                final_content = m["content"]
                break

        # Save updated session messages (exclude system prompt)
        session_msgs = [m for m in messages if m.get("role") != "system"]
        now = datetime.now(timezone.utc).isoformat()
        await db.agent_sessions.update_one(
            {"id": session["id"]},
            {"$set": {"messages": session_msgs, "updated_at": now}}
        )

        await log_activity(session["site_id"], "agent_turn", f"Agent turn: {user_message[:60]}...", user_id=user_id)
        await push_event(task_id, "complete", {"content": final_content})
    except Exception as e:
        logger.error(f"Agent turn error: {e}")
        await push_event(task_id, "error", {"message": str(e)})
    finally:
        await finish_task(task_id)

# Legacy single-turn endpoint (kept for backward compatibility)
@api_router.post("/ai/command", response_model=AICommand)
async def execute_ai_command(command_data: AICommandCreate):
    site = await get_wp_credentials(command_data.site_id)

    command = AICommand(
        site_id=command_data.site_id,
        command=command_data.command,
        status="processing"
    )
    await db.ai_commands.insert_one(command.model_dump())

    system_prompt = f"""You are an expert AI WordPress website manager for site {site['name']} ({site['url']}).
When asked to perform an action, provide a structured JSON response with action, data, and message fields.
For analysis or suggestions, provide helpful insights in the message field."""

    try:
        ai_response = await get_ai_response(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": command_data.command},
            ],
            temperature=0.7,
            max_tokens=2000,
        )

        await db.ai_commands.update_one(
            {"id": command.id},
            {"$set": {
                "response": ai_response,
                "status": "completed",
                "completed_at": datetime.now(timezone.utc).isoformat()
            }}
        )

        command.response = ai_response
        command.status = "completed"
        command.completed_at = datetime.now(timezone.utc).isoformat()

        await log_activity(command_data.site_id, "ai_command", f"Executed: {command_data.command[:50]}...")

        return command

    except Exception as e:
        logger.error(f"AI command failed: {e}")
        await db.ai_commands.update_one(
            {"id": command.id},
            {"$set": {"status": "failed", "response": str(e)}}
        )
        command.status = "failed"
        command.response = str(e)
        return command

@api_router.get("/ai/commands/{site_id}", response_model=List[AICommand])
async def get_ai_commands(site_id: str, limit: int = 50):
    commands = await db.ai_commands.find(
        {"site_id": site_id},
        {"_id": 0}
    ).sort("created_at", -1).to_list(limit)
    return commands
