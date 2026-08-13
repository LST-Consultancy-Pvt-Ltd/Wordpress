import logging
import os
from datetime import datetime, timezone

import anthropic
from fastapi import HTTPException
from openai import AsyncOpenAI

from core.crypto import get_decrypted_settings
from core.db import db

logger = logging.getLogger(__name__)

# §18 cost control: a global daily budget for LLM spend, enforced the same way
# providers/dataforseo.py enforces DFS_DAILY_LIMIT. Global (not per-site)
# because get_ai_response() is called from ~40 router modules without a
# site_id in scope — adding one to every call site would be far more
# invasive than the value justifies for a single-operator platform.
AI_DAILY_BUDGET_USD = float(os.environ.get("AI_DAILY_BUDGET_USD", "20.0"))


def _estimate_ai_cost_ceiling(messages: list, max_tokens: int) -> float:
    """Conservative upper-bound estimate (Claude's pricier rate, full
    max_tokens as output) used only to gate a call BEFORE real usage is known.
    The actual recorded spend after the call uses real token counts, not this."""
    input_chars = sum(len(m.get("content", "") or "") for m in messages)
    input_tokens_est = input_chars / 4
    return (input_tokens_est * 15 / 1_000_000) + (max_tokens * 75 / 1_000_000)


async def _ai_spend_precheck(estimated_cost: float) -> None:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    doc = await db.ai_daily_spend.find_one({"date": today})
    current = doc["total_cost"] if doc else 0.0
    if current + estimated_cost > AI_DAILY_BUDGET_USD:
        raise HTTPException(
            status_code=429,
            detail=f"Daily AI spend budget reached (${AI_DAILY_BUDGET_USD:.2f}). Resets at midnight UTC. "
                   f"Raise AI_DAILY_BUDGET_USD if this is expected usage.",
        )


async def _ai_spend_record(actual_cost: float) -> None:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        await db.ai_daily_spend.update_one(
            {"date": today},
            {"$inc": {"total_cost": actual_cost}, "$setOnInsert": {"date": today}},
            upsert=True,
        )
    except Exception as e:
        logger.warning(f"Failed to record AI spend (call already completed, not blocked): {e}")


async def get_openai_client():
    """Get OpenAI client with API key from settings or environment"""
    settings = await get_decrypted_settings()
    api_key = settings.get("openai_api_key") or os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=400, detail="OpenAI API key not configured. Please add it in Settings.")
    return AsyncOpenAI(api_key=api_key)


async def _call_claude(messages: list, max_tokens: int, temperature: float, api_key: str) -> tuple:
    """Single Claude call. Returns (text, usage_info)."""
    client = anthropic.AsyncAnthropic(api_key=api_key)
    system = next((m["content"] for m in messages if m["role"] == "system"), "")
    user_messages = [m for m in messages if m["role"] != "system"]
    create_kwargs: dict = {
        "model": "claude-opus-4-5",
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": user_messages,
    }
    if system:
        create_kwargs["system"] = system
    resp = await client.messages.create(**create_kwargs)
    usage_info = {"input_tokens": 0, "output_tokens": 0, "provider": "claude", "model": "claude-opus-4-5"}
    if hasattr(resp, "usage") and resp.usage:
        usage_info["input_tokens"] = getattr(resp.usage, "input_tokens", 0)
        usage_info["output_tokens"] = getattr(resp.usage, "output_tokens", 0)
    return resp.content[0].text, usage_info


async def _call_openai(messages: list, max_tokens: int, temperature: float, api_key: str) -> tuple:
    """Single OpenAI call. Returns (text, usage_info)."""
    client = AsyncOpenAI(api_key=api_key)
    resp = await client.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    usage_info = {"input_tokens": 0, "output_tokens": 0, "provider": "openai", "model": "gpt-4o"}
    if resp.usage:
        usage_info["input_tokens"] = resp.usage.prompt_tokens or 0
        usage_info["output_tokens"] = resp.usage.completion_tokens or 0
    return resp.choices[0].message.content, usage_info


async def get_ai_response(messages: list, max_tokens: int = 1000, temperature: float = 0.7, track_usage: bool = False) -> str:
    """Call AI provider with Claude as primary and OpenAI as automatic fallback.

    Strategy:
      1. Always try Claude first if an Anthropic key is configured.
      2. On any Claude failure (rate limit, network, auth, overloaded, etc.),
         automatically fall back to OpenAI if an OpenAI key is configured.
      3. If only one provider is configured, use that one.

    The legacy `ai_provider` setting is now used only as a tiebreaker when both
    keys are missing — it no longer overrides the Claude-first preference.
    If track_usage=True, returns a tuple (text, usage_dict) instead.
    """
    settings = await get_decrypted_settings()
    anthropic_key = settings.get("anthropic_api_key") or os.environ.get("ANTHROPIC_API_KEY")
    openai_key = settings.get("openai_api_key") or os.environ.get("OPENAI_API_KEY")

    if not anthropic_key and not openai_key:
        raise HTTPException(
            status_code=400,
            detail="No AI provider configured. Add an Anthropic (Claude) or OpenAI API key in Settings.",
        )

    await _ai_spend_precheck(_estimate_ai_cost_ceiling(messages, max_tokens))

    text_result = None
    usage_info = None
    claude_error = None

    # Primary: Claude
    if anthropic_key:
        try:
            text_result, usage_info = await _call_claude(messages, max_tokens, temperature, anthropic_key)
        except Exception as e:
            claude_error = e
            logger.warning(f"Claude call failed, will try OpenAI fallback: {e}")

    # Fallback: OpenAI
    if text_result is None:
        if not openai_key:
            # Claude failed and no OpenAI fallback configured
            raise HTTPException(
                status_code=502,
                detail=f"Claude (primary) failed and no OpenAI fallback configured: {claude_error}",
            )
        try:
            text_result, usage_info = await _call_openai(messages, max_tokens, temperature, openai_key)
            if claude_error:
                logger.info(f"OpenAI fallback succeeded after Claude failure: {claude_error}")
        except Exception as oe:
            if claude_error:
                raise HTTPException(
                    status_code=502,
                    detail=f"Both AI providers failed. Claude: {claude_error}. OpenAI: {oe}",
                )
            raise HTTPException(status_code=502, detail=f"OpenAI call failed: {oe}")

    # Estimate actual cost in USD based on which provider actually responded,
    # and record it against the daily budget regardless of track_usage (§18) —
    # the precheck above only gates on an upper-bound estimate; this is the
    # real number that accumulates in db.ai_daily_spend.
    if usage_info["provider"] == "claude":
        cost = (usage_info["input_tokens"] * 15 / 1_000_000) + (usage_info["output_tokens"] * 75 / 1_000_000)
    else:
        cost = (usage_info["input_tokens"] * 2.5 / 1_000_000) + (usage_info["output_tokens"] * 10 / 1_000_000)
    await _ai_spend_record(cost)

    if track_usage:
        usage_info["estimated_cost_usd"] = round(cost, 6)
        return text_result, usage_info
    return text_result
