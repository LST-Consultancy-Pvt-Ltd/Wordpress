"""Client for the Automation Bridge protocol v1 (protocol/automation-bridge-v1.md).

- HMAC-SHA256 request signing with timestamp + nonce (replay-safe).
- Timeouts on every call; retries only for GETs and for mutations that
  carry an Idempotency-Key (and then only on connection failures/timeouts,
  where the request may not have reached the bridge).
- Bridge errors are mapped to `BridgeError` with the bridge's stable code;
  `to_http()` turns them into control-plane responses without leaking
  secrets or upstream internals.
- Capability negotiation: `handshake()` refuses unsupported protocol majors.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
import uuid
from typing import Any, Optional
from urllib.parse import quote, urlencode, urlsplit

import httpx
from fastapi import HTTPException

from core.redact import redact, redact_text
from core.safe_fetch import UnsafeUrlError, resolve_public
from core.url_policy import UrlPolicyError, is_private_host, resolves_public_only

logger = logging.getLogger(__name__)

SUPPORTED_PROTOCOL_MAJORS = {"1"}
DEFAULT_TIMEOUT = httpx.Timeout(15.0, connect=5.0)
LONG_TIMEOUT = httpx.Timeout(120.0, connect=5.0)
MAX_RESPONSE_BYTES = 8 * 1024 * 1024


class BridgeError(Exception):
    def __init__(self, status: int, code: str, message: str, *, correlation_id: Optional[str] = None,
                 details: Optional[dict] = None):
        super().__init__(f"{code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.correlation_id = correlation_id
        self.details = details or {}

    def to_http(self) -> HTTPException:
        # The bridge rejecting OUR credential is a platform-side configuration
        # problem, not the end user's auth failure — never surface it as 401/403.
        if self.status in (401, 403):
            status, code = 502, f"BRIDGE_{self.code}"
        elif self.status in (400, 404, 409, 413, 422, 429):
            status, code = self.status, self.code
        elif self.status == 504 or self.code == "BRIDGE_TIMEOUT":
            status, code = 504, self.code
        else:
            status, code = 502, self.code
        detail = {"code": code, "message": redact_text(self.message), "correlation_id": self.correlation_id}
        if self.details:
            detail["details"] = redact(self.details)
        return HTTPException(status_code=status, detail=detail)


def decode_secret(secret_b64url: str) -> bytes:
    padded = secret_b64url + "=" * (-len(secret_b64url) % 4)
    raw = base64.urlsafe_b64decode(padded.encode())
    if len(raw) != 32:
        raise ValueError("bridge secret must decode to 32 bytes")
    return raw


def canonical_string(method: str, path_with_query: str, timestamp: int, nonce: str, body: bytes) -> str:
    return f"{method.upper()}\n{path_with_query}\n{timestamp}\n{nonce}\n{hashlib.sha256(body).hexdigest()}"


def sign(secret_b64url: str, method: str, path_with_query: str, timestamp: int, nonce: str, body: bytes) -> str:
    key = decode_secret(secret_b64url)
    return hmac.new(key, canonical_string(method, path_with_query, timestamp, nonce, body).encode(),
                    hashlib.sha256).hexdigest()


def new_idempotency_key(prefix: str = "idem") -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


class BridgeClient:
    def __init__(self, bridge_url: str, key_id: str, secret: str, *, allow_private_http: bool = False,
                 transport: Optional[httpx.AsyncBaseTransport] = None, check_dns: bool = True):
        self.base = bridge_url.rstrip("/")
        parts = urlsplit(self.base)
        self._base_path = parts.path
        self._host = parts.hostname or ""
        self._scheme = parts.scheme
        self.key_id = key_id
        self._secret = secret
        self._allow_private_http = allow_private_http
        self._transport = transport
        self._check_dns = check_dns and transport is None

    def __repr__(self) -> str:  # never print the secret
        return f"BridgeClient({self.base!r}, key_id={self.key_id!r})"

    def _guard(self) -> None:
        if self._scheme == "http" and not (self._allow_private_http and is_private_host(self._host)):
            raise BridgeError(400, "URL_POLICY", "plain http bridge URL is not allowed for this site")
        # Re-check at request time: a public name that later resolves to an
        # internal address (DNS rebinding) must not become an SSRF vector.
        if self._check_dns and self._scheme == "https" and not is_private_host(self._host):
            if not resolves_public_only(self._host):
                raise BridgeError(400, "URL_POLICY", "bridge host no longer resolves to a public address")

    async def request(self, method: str, path: str, *, params: Optional[dict] = None, body: Any = None,
                      idempotency_key: Optional[str] = None, correlation_id: Optional[str] = None,
                      timeout: httpx.Timeout = DEFAULT_TIMEOUT, retries: Optional[int] = None) -> Any:
        method = method.upper()
        mutating = method not in ("GET", "HEAD")
        if mutating and not idempotency_key:
            idempotency_key = new_idempotency_key()
        try:
            self._guard()
        except UrlPolicyError as e:
            raise BridgeError(400, "URL_POLICY", str(e))
        query = ""
        if params:
            clean = {k: v for k, v in params.items() if v is not None}
            if clean:
                query = "?" + urlencode(clean, quote_via=quote)
        if not path.startswith("/"):
            path = "/" + path
        path_with_query = f"{self._base_path}{path}{query}"
        url = f"{self._scheme}://{urlsplit(self.base).netloc}{path_with_query}"
        payload = b"" if body is None else json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()
        correlation_id = correlation_id or "c_" + uuid.uuid4().hex[:20]
        attempts = 1 + (retries if retries is not None else 2)

        last_exc: Optional[Exception] = None
        for attempt in range(attempts):
            ts = int(time.time())
            nonce = secrets.token_urlsafe(18)
            headers = {
                "X-Bridge-Key-Id": self.key_id,
                "X-Bridge-Timestamp": str(ts),
                "X-Bridge-Nonce": nonce,
                "X-Bridge-Signature": sign(self._secret, method, path_with_query, ts, nonce, payload),
                "X-Correlation-Id": correlation_id,
                "Accept": "application/json",
            }
            if payload:
                headers["Content-Type"] = "application/json"
            if idempotency_key:
                headers["Idempotency-Key"] = idempotency_key
            try:
                target, extensions = url, {}
                if self._check_dns and self._scheme == "https" and not is_private_host(self._host):
                    # Pin the connection to a vetted public address so a second
                    # DNS answer cannot point it at an internal host (rebinding).
                    try:
                        ip = await resolve_public(self._host, urlsplit(self.base).port or 443)
                    except UnsafeUrlError:
                        raise BridgeError(400, "URL_POLICY", "bridge host does not resolve to a public address")
                    parts = urlsplit(url)
                    ip_host = f"[{ip}]" if ":" in ip else ip
                    target = parts._replace(netloc=ip_host if parts.port is None else f"{ip_host}:{parts.port}").geturl()
                    headers["Host"] = parts.netloc
                    extensions = {"sni_hostname": self._host}
                async with httpx.AsyncClient(transport=self._transport, timeout=timeout,
                                             follow_redirects=False) as client:
                    async with client.stream(method, target, content=payload or None, headers=headers,
                                             extensions=extensions) as streamed:
                        body = bytearray()
                        async for chunk in streamed.aiter_bytes():
                            body += chunk
                            if len(body) > MAX_RESPONSE_BYTES:
                                raise BridgeError(502, "BRIDGE_RESPONSE_TOO_LARGE",
                                                  "bridge response exceeded the size limit",
                                                  correlation_id=correlation_id)
                        resp = httpx.Response(streamed.status_code, headers=streamed.headers,
                                              content=bytes(body), request=streamed.request)
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout, httpx.RemoteProtocolError,
                    httpx.WriteError, httpx.PoolTimeout) as e:
                last_exc = e
                retry_ok = not mutating or idempotency_key is not None
                if retry_ok and attempt + 1 < attempts:
                    await asyncio.sleep(0.3 * (2 ** attempt))
                    continue
                code = "BRIDGE_TIMEOUT" if isinstance(e, (httpx.ReadTimeout, httpx.ConnectTimeout, httpx.PoolTimeout)) else "BRIDGE_UNREACHABLE"
                raise BridgeError(504 if code == "BRIDGE_TIMEOUT" else 502, code,
                                  f"could not reach the bridge ({type(e).__name__})",
                                  correlation_id=correlation_id) from None

            if resp.status_code in (502, 503, 504) and not mutating and attempt + 1 < attempts:
                await asyncio.sleep(0.3 * (2 ** attempt))
                continue
            if resp.status_code == 429 and not mutating and attempt + 1 < attempts:
                retry_after = min(float(resp.headers.get("Retry-After", "1") or 1), 5.0)
                await asyncio.sleep(retry_after)
                continue
            return self._parse(resp, correlation_id)
        raise BridgeError(502, "BRIDGE_UNREACHABLE", "bridge request failed", correlation_id=correlation_id) from last_exc

    @staticmethod
    def _parse(resp: httpx.Response, correlation_id: str) -> Any:
        cid = resp.headers.get("X-Correlation-Id") or correlation_id
        if len(resp.content) > MAX_RESPONSE_BYTES:
            raise BridgeError(502, "BRIDGE_RESPONSE_TOO_LARGE", "bridge response exceeded the size limit",
                              correlation_id=cid)
        try:
            data = resp.json() if resp.content else {}
        except ValueError:
            data = None
        if 200 <= resp.status_code < 300:
            if data is None:
                raise BridgeError(502, "BRIDGE_BAD_RESPONSE", "bridge returned a non-JSON response", correlation_id=cid)
            if isinstance(data, dict) and resp.headers.get("Idempotent-Replay") == "true":
                data.setdefault("_idempotent_replay", True)
            return data
        err = (data or {}).get("error") if isinstance(data, dict) else None
        if isinstance(err, dict):
            raise BridgeError(resp.status_code, str(err.get("code") or "UNKNOWN"), str(err.get("message") or ""),
                              correlation_id=err.get("correlation_id") or cid, details=err.get("details"))
        raise BridgeError(resp.status_code, "BRIDGE_HTTP_%d" % resp.status_code,
                          "bridge returned an unexpected error response", correlation_id=cid)

    # ---- typed helpers -------------------------------------------------------

    async def capabilities(self) -> dict:
        return await self.request("GET", "/capabilities")

    async def health(self) -> dict:
        return await self.request("GET", "/health")

    async def handshake(self) -> dict:
        caps = await self.capabilities()
        major = str(caps.get("protocol_version", "")).split(".")[0]
        if major not in SUPPORTED_PROTOCOL_MAJORS:
            raise BridgeError(422, "PROTOCOL_UNSUPPORTED",
                              f"bridge speaks protocol v{major or '?'}; this platform supports "
                              f"v{', v'.join(sorted(SUPPORTED_PROTOCOL_MAJORS))}. Upgrade the bridge or the platform.")
        try:
            health = await self.health()
        except BridgeError as e:
            health = {"status": "down", "ready": False, "error": e.code}
        return {"capabilities": caps, "health": health}

    async def plan(self, change_id: str, operations: list, base_revision: Optional[str] = None) -> dict:
        return await self.request("POST", "/changesets/plan", body={
            "change_id": change_id, "operations": operations, "base_revision": base_revision})

    async def apply(self, change_id: str, operations: list, base_revision: Optional[str],
                    expected_plan_sha256: str, idempotency_key: str) -> dict:
        return await self.request("POST", "/changesets/apply", body={
            "change_id": change_id, "operations": operations, "base_revision": base_revision,
            "expected_plan_sha256": expected_plan_sha256,
        }, idempotency_key=idempotency_key, timeout=LONG_TIMEOUT)

    async def rollback(self, revision_id: str, reason: str, idempotency_key: str, force: bool = False) -> dict:
        body = {"reason": reason}
        if force:
            body["force"] = True
        return await self.request("POST", f"/revisions/{quote(revision_id, safe='')}/rollback", body=body,
                                  idempotency_key=idempotency_key, timeout=LONG_TIMEOUT)

    async def job(self, job_id: str) -> dict:
        return await self.request("GET", f"/jobs/{quote(job_id, safe='')}")

    async def wait_job(self, job_id: str, *, poll: float = 1.0, timeout: float = 1800, on_update=None) -> dict:
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            job = await self.job(job_id)
            if on_update and job != last:
                await on_update(job)
            last = job
            if job.get("status") in ("succeeded", "failed", "cancelled"):
                return job
            await asyncio.sleep(poll)
        raise BridgeError(504, "BRIDGE_TIMEOUT", "bridge job did not finish in time")


def capability_enabled(site: dict, name: str) -> bool:
    caps = ((site or {}).get("capabilities") or {}).get("capabilities") or {}
    return caps.get(name) is True


def require_capability(site: dict, name: str) -> None:
    if not capability_enabled(site, name):
        raise HTTPException(status_code=422, detail={
            "code": "CAPABILITY_UNSUPPORTED", "capability": name,
            "message": f"This site's bridge does not offer '{name}'. Enable and configure it on the bridge, "
                       "then refresh the connection.",
        })
