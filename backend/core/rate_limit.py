"""Simple in-memory sliding-window rate limiter (§13) — dependency-free,
keyed by client IP (or `X-Forwarded-For` when behind a proxy).

Not distributed: counters live in a process-local dict, so if this app ever
runs multiple worker processes/instances behind a load balancer, limits are
per-process, not global. Fine for a single-instance deployment; swap the
in-memory dict for a Redis/Mongo-backed counter first if that changes.

`/api/health` and task-polling/streaming endpoints are exempt so monitoring
and normal SSE-progress polling never trip the limit.
"""
import time
from collections import defaultdict, deque

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

RATE_LIMIT_REQUESTS = 300
RATE_LIMIT_WINDOW_SECONDS = 60
_EXEMPT_PREFIXES = ("/api/health", "/api/tasks/", "/api/autopilot/stream", "/api/docs", "/api/openapi.json")

_request_log: dict = defaultdict(deque)


def _client_key(request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path
        if not path.startswith("/api/") or any(path.startswith(p) for p in _EXEMPT_PREFIXES):
            return await call_next(request)

        key = _client_key(request)
        now = time.monotonic()
        window = _request_log[key]
        while window and now - window[0] > RATE_LIMIT_WINDOW_SECONDS:
            window.popleft()

        if len(window) >= RATE_LIMIT_REQUESTS:
            retry_after = max(1, int(RATE_LIMIT_WINDOW_SECONDS - (now - window[0])))
            return JSONResponse(
                status_code=429,
                content={"detail": f"Rate limit exceeded ({RATE_LIMIT_REQUESTS} requests / "
                                    f"{RATE_LIMIT_WINDOW_SECONDS}s per client). Try again shortly."},
                headers={"Retry-After": str(retry_after)},
            )

        window.append(now)
        return await call_next(request)
