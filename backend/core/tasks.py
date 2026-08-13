import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import AsyncGenerator, Dict, List, Optional

from core.db import db

# In-memory task progress store  {task_id: asyncio.Queue}
task_queues: Dict[str, asyncio.Queue] = {}
# Task status store for REST polling  {task_id: {status, progress, error, result}}
task_status_store: Dict[str, dict] = {}

# Autopilot SSE queues keyed by site_id — multiple listeners supported via list of queues
autopilot_sse_queues: Dict[str, List[asyncio.Queue]] = {}


def make_task_id() -> str:
    return str(uuid.uuid4())


async def create_task_queue(task_id: str, task_type: str = "", site_id: str = "") -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    task_queues[task_id] = q
    task_status_store[task_id] = {"status": "pending", "progress": None, "error": None, "result": None}
    # Durable record in db.task_runs — §9: task progress/result now survives a
    # process restart instead of vanishing with the in-memory dict, and gives
    # a queryable audit trail. Best-effort: a Mongo hiccup here must never
    # break the live in-memory SSE stream callers actually depend on.
    try:
        now = datetime.now(timezone.utc)
        await db.task_runs.insert_one({
            "task_id": task_id, "task_type": task_type, "site_id": site_id,
            "status": "pending", "progress": None, "error": None, "result": None,
            "created_at": now, "updated_at": now,
        })
    except Exception:
        pass
    return q


async def push_event(task_id: str, event_type: str, data: dict):
    if task_id in task_queues:
        await task_queues[task_id].put({"type": event_type, "data": data})
    # Mirror into polling store
    update = None
    if task_id in task_status_store:
        if event_type in ("done", "complete", "completed"):
            update = {"status": "completed", "result": data, "progress": data}
        elif event_type in ("error", "failed"):
            update = {"status": "failed", "error": data.get("message", str(data)), "progress": data}
        else:
            update = {"status": "running", "progress": data}
        task_status_store[task_id].update(update)
    if update is not None:
        try:
            update["updated_at"] = datetime.now(timezone.utc)
            await db.task_runs.update_one({"task_id": task_id}, {"$set": update})
        except Exception:
            pass


async def finish_task(task_id: str):
    if task_id in task_queues:
        await task_queues[task_id].put(None)  # sentinel
    if task_id in task_status_store and task_status_store[task_id]["status"] not in ("failed",):
        task_status_store[task_id]["status"] = "completed"
    try:
        await db.task_runs.update_one(
            {"task_id": task_id, "status": {"$ne": "failed"}},
            {"$set": {"status": "completed", "updated_at": datetime.now(timezone.utc)}},
        )
    except Exception:
        pass


async def get_durable_task_status(task_id: str) -> Optional[dict]:
    """Task status lookup that survives process restarts (§9): checks the
    live in-memory store first (fresher / still-streaming tasks), then falls
    back to the durable `db.task_runs` record if the process restarted since
    the task ran. Returns None if the task genuinely doesn't exist anywhere.
    """
    if task_id in task_status_store:
        return task_status_store[task_id]
    doc = await db.task_runs.find_one({"task_id": task_id}, {"_id": 0})
    return doc


async def sse_generator(task_id: str) -> AsyncGenerator[str, None]:
    if task_id not in task_queues:
        yield f"data: {json.dumps({'type': 'error', 'data': {'message': 'Task not found'}})}\n\n"
        return
    q = task_queues[task_id]
    MAX_TOTAL_WAIT = 600  # 10 minutes overall cap
    KEEPALIVE_INTERVAL = 30  # send a heartbeat every 30s to prevent proxy/browser timeout
    elapsed = 0
    try:
        while elapsed < MAX_TOTAL_WAIT:
            try:
                item = await asyncio.wait_for(q.get(), timeout=KEEPALIVE_INTERVAL)
            except asyncio.TimeoutError:
                elapsed += KEEPALIVE_INTERVAL
                # SSE comment lines (starting with ':') are ignored by clients but keep the
                # TCP connection alive through proxies and prevent browser auto-close.
                yield ": keepalive\n\n"
                continue
            if item is None:
                yield f"data: {json.dumps({'type': 'done', 'data': {}})}\n\n"
                break
            yield f"data: {json.dumps(item)}\n\n"
            elapsed = 0  # reset idle timer on any real event
        else:
            yield f"data: {json.dumps({'type': 'timeout', 'data': {}})}\n\n"
    finally:
        task_queues.pop(task_id, None)
