/**
 * Client-side mirror of the control plane's URL policy for site connections
 * (protocol/control-plane-api.md → "URL policy"). The backend re-validates;
 * this only gives immediate feedback.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isPrivateHost(host) {
  const h = (host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h === "::1") return true;
  // Docker service names have no dots (e.g. "automation-bridge").
  if (!h.includes(".") && !h.includes(":")) return true;
  const m = h.match(IPV4);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // IPv6 ULA
  return false;
}

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function common(u) {
  if (u.username || u.password) return "Credentials in the URL are not allowed.";
  if (u.hash) return "Fragments (#…) are not allowed.";
  return null;
}

export function validateBaseUrl(url) {
  if (!url) return "Required.";
  const u = parse(url);
  if (!u) return "Not a valid URL.";
  if (u.protocol !== "https:") return "The public site URL must use https://.";
  const c = common(u);
  if (c) return c;
  if (u.port && !isPrivateHost(u.hostname)) return "Non-default ports are not allowed on public hosts.";
  return null;
}

export function validateBridgeUrl(url, allowPrivateHttp) {
  if (!url) return "Required.";
  const u = parse(url);
  if (!u) return "Not a valid URL.";
  const c = common(u);
  if (c) return c;
  const priv = isPrivateHost(u.hostname);
  if (u.protocol === "http:") {
    if (!allowPrivateHttp) return "Plain http:// is only allowed on a private network — enable the private-network toggle.";
    if (!priv) return "http:// is only allowed for Docker service names, RFC 1918 or loopback addresses.";
  } else if (u.protocol !== "https:") {
    return "The bridge URL must use https:// (or http:// on a private network).";
  }
  if (u.port && !priv) return "Non-default ports are not allowed on public hosts.";
  if (!u.pathname.replace(/\/+$/, "").endsWith("/api/automation-bridge/v1")) {
    return "The bridge URL should end with /api/automation-bridge/v1.";
  }
  return null;
}

export const SITE_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
