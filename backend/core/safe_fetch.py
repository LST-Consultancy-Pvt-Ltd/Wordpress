"""Server-side fetches of URLs that a user, an AI model, or a managed site
controls.

`safe_get`:
  - allows only http/https on ports 80/443;
  - resolves the host once, requires EVERY address to be globally routable
    (`ip.is_global`: excludes RFC1918, loopback, link-local/metadata,
    CGNAT 100.64/10, ULA, reserved, multicast ...);
  - connects to the vetted IP itself (DNS pinning), with the original Host
    header and TLS SNI/certificate verification for the real hostname, so a
    second DNS answer cannot redirect the connection (rebinding);
  - follows redirects manually, re-validating every hop;
  - caps the response body.

`guard_request` is an httpx request event hook for the audit crawlers that
need many requests through one client: it re-checks the destination of every
request, including each redirect hop, without pinning.
"""
import asyncio
import ipaddress
import socket
from typing import Optional
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

MAX_BODY_BYTES = 5 * 1024 * 1024
ALLOWED_PORTS = {None, 80, 443}


class UnsafeUrlError(httpx.HTTPError):
    """Raised for a destination that must not be fetched. An httpx error, so
    existing `except httpx.HTTPError` handlers treat it as a failed fetch."""


def _check_ip(ip: str) -> ipaddress._BaseAddress:
    addr = ipaddress.ip_address(ip.split("%")[0])
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    if not addr.is_global:
        raise UnsafeUrlError("destination is not a public address")
    return addr


async def resolve_public(host: str, port: int) -> str:
    """All addresses for `host` must be public; returns the first one."""
    try:
        literal = ipaddress.ip_address(host.strip("[]"))
        return str(_check_ip(str(literal)))
    except ValueError:
        pass
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise UnsafeUrlError("host does not resolve")
    addrs = [str(_check_ip(info[4][0])) for info in infos]
    if not addrs:
        raise UnsafeUrlError("host does not resolve")
    return addrs[0]


def _validate(url: str):
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise UnsafeUrlError("only http(s) URLs can be fetched")
    if parts.username or parts.password:
        raise UnsafeUrlError("URLs with credentials are not allowed")
    if parts.port not in ALLOWED_PORTS:
        raise UnsafeUrlError("only the default http/https ports are allowed")
    return parts


class SafeResponse:
    def __init__(self, status_code: int, headers: httpx.Headers, content: bytes, url: str, history: list):
        self.status_code = status_code
        self.headers = headers
        self.content = content
        self.url = url
        self.history = history

    @property
    def text(self) -> str:
        return self.content.decode(httpx.Response(200, headers=self.headers).encoding or "utf-8", errors="replace")


async def safe_get(url: str, *, headers: Optional[dict] = None, timeout: float = 20.0, max_redirects: int = 5,
                   max_bytes: int = MAX_BODY_BYTES) -> SafeResponse:
    history: list = []
    for _ in range(max_redirects + 1):
        parts = _validate(url)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        ip = await resolve_public(parts.hostname, port)
        ip_host = f"[{ip}]" if ":" in ip else ip
        netloc = ip_host if parts.port is None else f"{ip_host}:{parts.port}"
        pinned = urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))
        req_headers = {**(headers or {}), "Host": parts.netloc}
        extensions = {"sni_hostname": parts.hostname} if parts.scheme == "https" else {}
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            async with client.stream("GET", pinned, headers=req_headers, extensions=extensions) as resp:
                if resp.is_redirect and resp.headers.get("location"):
                    history.append(resp.status_code)
                    url = urljoin(url, resp.headers["location"])
                    continue
                body = bytearray()
                async for chunk in resp.aiter_bytes():
                    body += chunk
                    if len(body) > max_bytes:
                        raise UnsafeUrlError("response too large")
                return SafeResponse(resp.status_code, resp.headers, bytes(body), url, history)
    raise UnsafeUrlError("too many redirects")


async def guard_request(request: httpx.Request) -> None:
    """httpx event hook: refuse requests (and redirect hops) to non-public hosts."""
    url = str(request.url)
    parts = _validate(url)
    await resolve_public(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))


# `httpx.AsyncClient(event_hooks=SSRF_GUARD, ...)` for clients that fetch URLs a
# user, model, managed site or content item controls.
SSRF_GUARD = {"request": [guard_request]}
