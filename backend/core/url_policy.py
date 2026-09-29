"""URL policy for site and bridge endpoints (SSRF guard).

- Public base URL: https only.
- Bridge URL: https, or http only when the site explicitly allows private-
  network HTTP AND the host is a private address / single-label Docker
  service name / loopback.
- No userinfo, fragments, or query strings.
- A public https bridge host must not resolve to a private, loopback,
  link-local, multicast or reserved address (checked at registration and
  again before each request by the bridge client).
"""
import ipaddress
import socket
from urllib.parse import urlsplit

BRIDGE_PATH = "/api/automation-bridge/v1"


class UrlPolicyError(ValueError):
    pass


def _is_private_ip(ip: ipaddress._BaseAddress) -> bool:
    """Anything not globally routable (RFC1918, loopback, link-local/metadata,
    CGNAT 100.64/10, ULA, reserved, multicast, IPv4-mapped forms of those)."""
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return not ip.is_global or ip.is_multicast


def _literal_ip(host: str):
    try:
        return ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return None


def is_private_host(host: str) -> bool:
    ip = _literal_ip(host)
    if ip is not None:
        return _is_private_ip(ip)
    # Single-label names (e.g. `bridge`, `site-bridge`) only resolve inside a
    # Docker network / local resolver; `localhost` is loopback.
    return host == "localhost" or "." not in host


def resolves_public_only(host: str) -> bool:
    ip = _literal_ip(host)
    if ip is not None:
        return not _is_private_ip(ip)
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    addrs = {info[4][0] for info in infos}
    return bool(addrs) and all(not _is_private_ip(ipaddress.ip_address(a.split("%")[0])) for a in addrs)


def _split(url: str, what: str):
    if not isinstance(url, str) or not url.strip():
        raise UrlPolicyError(f"{what} is required")
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https"):
        raise UrlPolicyError(f"{what} must start with https://")
    if not parts.hostname:
        raise UrlPolicyError(f"{what} has no host")
    if parts.username or parts.password:
        raise UrlPolicyError(f"{what} must not contain credentials")
    if parts.fragment or parts.query:
        raise UrlPolicyError(f"{what} must not contain a query string or fragment")
    return parts


def validate_base_url(url: str, *, resolve: bool = True) -> str:
    """The public URL is fetched server-side by audits and crawls, so it must be
    a public https host — never an internal address reachable only from here."""
    parts = _split(url, "Public base URL")
    if parts.scheme != "https":
        raise UrlPolicyError("Public base URL must use https://")
    host = parts.hostname.lower()
    if is_private_host(host) or (resolve and not resolves_public_only(host)):
        raise UrlPolicyError("Public base URL must be a public host (it is fetched by audits)")
    return f"https://{parts.netloc.lower()}{parts.path.rstrip('/')}"


def validate_bridge_url(url: str, *, allow_private_http: bool, resolve: bool = True) -> str:
    parts = _split(url, "Bridge URL")
    host = parts.hostname.lower()
    private = is_private_host(host)
    if parts.scheme == "http":
        if not allow_private_http:
            raise UrlPolicyError("Bridge URL must use https:// (plain http is only allowed on a private Docker network, "
                                 "and only when 'allow private-network HTTP' is enabled for this site)")
        if not private:
            raise UrlPolicyError("Plain http is only allowed for private hosts (Docker service names, RFC1918 or loopback)")
    else:
        if parts.port not in (None, 443) and not private:
            raise UrlPolicyError("Public bridge URLs must use the default https port")
        if not private and resolve and not resolves_public_only(host):
            raise UrlPolicyError("Bridge host resolves to a private or reserved address; "
                                 "use the private-network option instead of a public name")
    path = parts.path.rstrip("/")
    if not path.endswith(BRIDGE_PATH):
        raise UrlPolicyError(f"Bridge URL must end with {BRIDGE_PATH}")
    return f"{parts.scheme}://{parts.netloc.lower()}{path}"
