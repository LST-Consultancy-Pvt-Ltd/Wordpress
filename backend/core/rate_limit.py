"""Simple in-memory sliding-window rate limiter (§13) — dependency-free,
keyed by client IP (or `X-Forwarded-For` when behind a proxy).

Not distributed: counters live in a process-local dict, so if this app ever
runs multiple worker processes/instances behind a load balancer, limits are
per-process, not global. Fine for a single-instance deployment; swap the
in-memory dict for a Redis/Mongo-backed counter first if that changes.

`/api/health` and task-polling/streaming endpoints are exempt so monitoring
and normal SSE-progress polling never trip the limit.
"""
import os
import time
from collections import defaultdict, deque

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

RATE_LIMIT_REQUESTS = 300
RATE_LIMIT_WINDOW_SECONDS = 60
_EXEMPT_PREFIXES = ("/api/health", "/api/tasks/", "/api/autopilot/stream", "/api/docs", "/api/openapi.json")

_request_log: dict = defaultdict(deque)


# X-Forwarded-For is client-controlled unless the request came from our own
# reverse proxy; only then is it honoured (comma-separated IPs, e.g. "172.18.0.2").
TRUSTED_PROXIES = {ip.strip() for ip in os.environ.get("TRUSTED_PROXY_IPS", "").split(",") if ip.strip()}
_last_sweep = 0.0


def _client_key(request) -> str:
    peer = request.client.host if request.client else "unknown"
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded and peer in TRUSTED_PROXIES:
        return forwarded.split(",")[-1].strip() or peer   # the address our proxy saw
    return peer


def _sweep(now: float) -> None:
    """Drop idle clients so random keys cannot grow memory without bound."""
    global _last_sweep
    if now - _last_sweep < RATE_LIMIT_WINDOW_SECONDS:
        return
    _last_sweep = now
    for key in [k for k, w in _request_log.items() if not w or now - w[-1] > RATE_LIMIT_WINDOW_SECONDS]:
        _request_log.pop(key, None)


# Per-account login throttle, independent of the client address.
LOGIN_MAX_FAILURES = 10
LOGIN_WINDOW_SECONDS = 15 * 60
_login_failures: dict = defaultdict(deque)


def login_blocked(email: str) -> bool:
    now = time.monotonic()
    window = _login_failures[email.lower()]
    while window and now - window[0] > LOGIN_WINDOW_SECONDS:
        window.popleft()
    return len(window) >= LOGIN_MAX_FAILURES


def record_login_failure(email: str) -> None:
    _login_failures[email.lower()].append(time.monotonic())


def clear_login_failures(email: str) -> None:
    _login_failures.pop(email.lower(), None)


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path
        if not path.startswith("/api/") or any(path.startswith(p) for p in _EXEMPT_PREFIXES):
            return await call_next(request)

        key = _client_key(request)
        now = time.monotonic()
        _sweep(now)
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


MAX_BODY_BYTES = 4 * 1024 * 1024


class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    """Reject oversized request bodies before any handler parses them. Change
    sets are capped at 200 operations by schema, but nothing bounded their
    byte size; the bridge's own limit is 2 MiB per change set."""

    async def dispatch(self, request, call_next):
        length = request.headers.get("content-length")
        if length is not None:
            try:
                too_big = int(length) > MAX_BODY_BYTES
            except ValueError:
                return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})
            if too_big:
                return JSONResponse(status_code=413, content={"detail": "Request body too large"})
        elif request.method in ("POST", "PUT", "PATCH") and "chunked" in request.headers.get("transfer-encoding", ""):
            return JSONResponse(status_code=411, content={"detail": "Content-Length required"})
        return await call_next(request)
