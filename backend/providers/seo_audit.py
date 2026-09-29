"""Comprehensive, platform-neutral SEO audit engine.

Every signal here is taken from what a crawler actually sees — the rendered
HTML of the live URL, the response headers, robots.txt, the sitemap and the
PageSpeed Insights API. Nothing is read from a content-management plugin, so
scores reflect what search engines actually receive.

Contrast providers/onpage.py, which scores a single page on ten core factors.
This module keeps that scoring intact (it imports and reuses it) and adds the
site-wide dimensions that only make sense across a whole crawl: the internal
link graph, sitemap/robots agreement, redirect chains, broken links, duplicate
canonicals and so on.

Scoring stays deterministic — fixed thresholds, no AI. A score you cannot
reproduce is useless for tracking progress, and an LLM asked to "rate this
page out of 100" simply invents a number.
"""
import asyncio
import json
import logging
import re
import ssl
import socket
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Callable, Optional
from urllib.parse import urljoin, urlparse, urlsplit

import httpx
from bs4 import BeautifulSoup

from core.http_headers import BROWSER_HEADERS, INCONCLUSIVE_STATUSES
from providers.onpage import SCORING_FACTORS, score_page

logger = logging.getLogger(__name__)

FETCH_TIMEOUT = 25.0
CRAWL_CONCURRENCY = 4          # polite against the site's own origin
LINK_CHECK_CONCURRENCY = 8
MAX_LINKS_TO_CHECK = 300       # unique URLs; beyond this the report stops being read
PSI_TIMEOUT = 90.0

# Formats that are already efficient. Anything else on a modern site is a
# missed win, not an error — hence "warn", never "fail".
MODERN_IMAGE_FORMATS = {"webp", "avif"}
RASTER_FORMATS = {"jpg", "jpeg", "png", "gif", "bmp", "tiff"}

STOPWORDS = {
    "a", "about", "above", "after", "again", "all", "am", "an", "and", "any", "are", "as", "at",
    "be", "because", "been", "before", "being", "below", "between", "both", "but", "by", "can",
    "did", "do", "does", "doing", "down", "during", "each", "few", "for", "from", "further",
    "had", "has", "have", "having", "he", "her", "here", "hers", "him", "his", "how", "i", "if",
    "in", "into", "is", "it", "its", "just", "me", "more", "most", "my", "no", "nor", "not", "now",
    "of", "off", "on", "once", "only", "or", "other", "our", "ours", "out", "over", "own", "same",
    "she", "should", "so", "some", "such", "than", "that", "the", "their", "theirs", "them",
    "then", "there", "these", "they", "this", "those", "through", "to", "too", "under", "until",
    "up", "very", "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom",
    "why", "will", "with", "you", "your", "yours",
}

# Anchor text that tells a search engine (and a screen reader) nothing.
GENERIC_ANCHORS = {
    "click here", "here", "read more", "more", "learn more", "this", "link", "this link",
    "continue", "continue reading", "details", "view", "see more", "go", "download",
}

SECURITY_HEADERS = [
    ("strict-transport-security", "HSTS", "high",
     "Tells browsers to only ever use HTTPS for this host."),
    ("content-security-policy", "Content-Security-Policy", "medium",
     "Limits which sources scripts and styles can load from."),
    ("x-content-type-options", "X-Content-Type-Options", "medium",
     "Stops browsers guessing (and mis-executing) a response's type."),
    ("x-frame-options", "X-Frame-Options", "medium",
     "Blocks clickjacking by refusing to be framed by other sites."),
    ("referrer-policy", "Referrer-Policy", "low",
     "Controls how much of the URL is leaked to other sites."),
    ("permissions-policy", "Permissions-Policy", "low",
     "Opts out of browser features the site does not use."),
]


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def route_path(url: str) -> str:
    """Route path with a normalised trailing slash — the key everything joins on."""
    try:
        path = urlparse(url).path or "/"
    except Exception:
        return url or "/"
    if len(path) > 1:
        path = path.rstrip("/")
    return path or "/"


def same_host(a: str, b: str) -> bool:
    try:
        ha, hb = urlparse(a).netloc.lower(), urlparse(b).netloc.lower()
    except Exception:
        return False
    return ha.replace("www.", "") == hb.replace("www.", "")


def _ext_of(url: str) -> str:
    path = urlsplit(url).path
    return path.rsplit(".", 1)[-1].lower() if "." in path.rsplit("/", 1)[-1] else ""


def _text_words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", (text or "").lower())


def _syllables(word: str) -> int:
    """Rough syllable count — enough for a Flesch band, not for linguistics."""
    word = word.lower().strip("'")
    if not word:
        return 0
    groups = re.findall(r"[aeiouy]+", word)
    n = len(groups)
    if word.endswith("e") and n > 1 and not word.endswith(("le", "ee", "ye")):
        n -= 1
    return max(n, 1)


def flesch_reading_ease(text: str) -> Optional[float]:
    """Higher is easier. ~60+ is comfortable for a general business audience."""
    sentences = [s for s in re.split(r"[.!?]+", text or "") if s.strip()]
    words = _text_words(text)
    if len(words) < 30 or not sentences:
        return None
    syl = sum(_syllables(w) for w in words)
    score = 206.835 - 1.015 * (len(words) / len(sentences)) - 84.6 * (syl / len(words))
    return round(max(0.0, min(100.0, score)), 1)


def _status_of(passed: bool, warn_only: bool = False) -> str:
    return "pass" if passed else ("warn" if warn_only else "fail")


def check(cid: str, label: str, status: str, detail: str,
          severity: str = "medium", value=None, items: Optional[list] = None) -> dict:
    """One audit finding. `items` carries the specific offenders so the UI can
    show *which* pages fail, never just that some do."""
    return {"id": cid, "label": label, "status": status, "detail": detail,
            "severity": severity, "value": value, "items": items or []}


def score_from_checks(checks: list[dict]) -> int:
    """A category's score is the share of its checks that pass, with warnings
    counting half. Deliberately blunt: an explainable number beats a tuned one."""
    graded = [c for c in checks if c["status"] in ("pass", "warn", "fail")]
    if not graded:
        return 100
    earned = sum(1.0 if c["status"] == "pass" else 0.5 if c["status"] == "warn" else 0.0
                 for c in graded)
    return round(earned / len(graded) * 100)


# --------------------------------------------------------------------------
# fetching
# --------------------------------------------------------------------------

async def fetch_document(client: httpx.AsyncClient, url: str) -> dict:
    """One page fetch, keeping everything an audit needs beyond the body:
    the redirect chain (for redirect hygiene), the response headers (for
    X-Robots-Tag, caching and security) and the elapsed time (for TTFB)."""
    try:
        resp = await client.get(url)
    except httpx.TimeoutException:
        return {"url": url, "ok": False, "error": f"Timed out after {int(FETCH_TIMEOUT)}s"}
    except Exception as e:
        return {"url": url, "ok": False, "error": str(e)}

    chain = [{"status": r.status_code, "url": str(r.url)} for r in resp.history]
    base = {
        "url": url,
        "final_url": str(resp.url),
        "status_code": resp.status_code,
        "redirect_chain": chain,
        "elapsed_ms": round(resp.elapsed.total_seconds() * 1000) if resp.elapsed else None,
        "headers": {k.lower(): v for k, v in resp.headers.items()},
        "bytes": len(resp.content or b""),
    }
    if resp.status_code >= 400:
        return {**base, "ok": False, "error": f"HTTP {resp.status_code}"}
    ctype = resp.headers.get("content-type", "")
    if "html" not in ctype.lower():
        return {**base, "ok": False, "error": f"Not HTML (content-type: {ctype or 'unknown'})"}
    return {**base, "ok": True, "error": None, "html": resp.text}


# --------------------------------------------------------------------------
# signal extraction
# --------------------------------------------------------------------------

def _meta_lookup(soup: BeautifulSoup) -> Callable[..., str]:
    def meta(name: Optional[str] = None, prop: Optional[str] = None) -> str:
        attrs = {"name": name} if name else {"property": prop}
        tag = soup.find("meta", attrs=attrs)
        if not tag and prop:                      # some sites use name= for og:*
            tag = soup.find("meta", attrs={"name": prop})
        if not tag and name:                      # ...and property= for twitter:*
            tag = soup.find("meta", attrs={"property": name})
        return (tag.get("content") or "").strip() if tag else ""
    return meta


def _parse_jsonld(html: str) -> tuple[list[dict], list[str], list[str]]:
    """(objects, types, parse_errors). Handles @graph and arrays, because most
    real sites emit one of those rather than a bare object."""
    objects: list[dict] = []
    errors: list[str] = []
    soup = BeautifulSoup(html, "html.parser")
    for node in soup.find_all("script", attrs={"type": "application/ld+json"}):
        raw = (node.string or node.get_text() or "").strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except Exception as e:
            errors.append(str(e).split(":")[0][:80])
            # Even unparseable JSON-LD usually still names its types, and
            # reporting "no schema" for a typo'd block sends the fix in the
            # wrong direction.
            for t in re.findall(r'"@type"\s*:\s*"([^"]+)"', raw):
                objects.append({"@type": t, "_unparsed": True})
            continue
        for item in (data if isinstance(data, list) else [data]):
            if not isinstance(item, dict):
                continue
            graph = item.get("@graph")
            if isinstance(graph, list):
                objects += [g for g in graph if isinstance(g, dict)]
            else:
                objects.append(item)
    types: list[str] = []
    for obj in objects:
        t = obj.get("@type")
        if isinstance(t, list):
            types += [str(x) for x in t]
        elif t:
            types.append(str(t))
    return objects, sorted(set(types)), errors


def extract_page_signals(html: str, url: str, headers: Optional[dict] = None) -> dict:
    """Everything a full audit needs, read once from the rendered document."""
    headers = headers or {}
    soup = BeautifulSoup(html, "html.parser")
    meta = _meta_lookup(soup)

    title = (soup.title.get_text(strip=True) if soup.title else "") or ""
    description = meta(name="description")

    html_tag = soup.find("html")
    lang = (html_tag.get("lang") or "").strip() if html_tag else ""

    canonical_tag = soup.find("link", rel=lambda v: v and "canonical" in (v if isinstance(v, list) else [v]))
    canonical = (canonical_tag.get("href") or "").strip() if canonical_tag else ""
    if canonical:
        canonical = urljoin(url, canonical)

    robots_meta = meta(name="robots").lower()
    x_robots = (headers.get("x-robots-tag") or "").lower()
    robots_combined = f"{robots_meta} {x_robots}".strip()

    # Headings, in document order — the order is the point, since a jump from
    # H2 straight to H4 is exactly the defect this catches.
    headings = [{"level": int(h.name[1]), "text": h.get_text(" ", strip=True)[:200]}
                for h in soup.find_all(["h1", "h2", "h3", "h4", "h5", "h6"])]
    h1s = [h["text"] for h in headings if h["level"] == 1]

    images = []
    for img in soup.find_all("img"):
        src = (img.get("src") or img.get("data-src") or "").strip()
        abs_src = urljoin(url, src) if src else ""
        images.append({
            "src": abs_src,
            "alt": (img.get("alt") or "").strip(),
            "has_alt_attr": img.has_attr("alt"),
            "loading": (img.get("loading") or "").strip().lower(),
            "width": (img.get("width") or "").strip(),
            "height": (img.get("height") or "").strip(),
            "srcset": bool(img.get("srcset") or img.get("data-srcset")),
            "ext": _ext_of(abs_src),
            "filename": urlsplit(abs_src).path.rsplit("/", 1)[-1][:120],
        })

    links = []
    tel_links: list[str] = []
    mailto_links: list[str] = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.lower().startswith("tel:"):
            tel_links.append(href[4:].strip())
            continue
        if href.lower().startswith("mailto:"):
            mailto_links.append(href[7:].split("?")[0].strip())
            continue
        if not href or href.startswith(("#", "javascript:", "data:")):
            continue
        abs_href = urljoin(url, href)
        if not abs_href.startswith(("http://", "https://")):
            continue
        rel = " ".join(a.get("rel") or []).lower()
        links.append({
            "href": abs_href.split("#")[0],
            "anchor": a.get_text(" ", strip=True)[:160],
            "rel": rel,
            "nofollow": "nofollow" in rel,
            "internal": same_host(abs_href, url),
            "target_blank": (a.get("target") or "") == "_blank",
            "is_image_link": bool(a.find("img")) and not a.get_text(strip=True),
        })

    jsonld_objects, schema_types, schema_errors = _parse_jsonld(html)

    hreflang = [{"lang": (l.get("hreflang") or ""), "href": urljoin(url, l.get("href") or "")}
                for l in soup.find_all("link", rel=lambda v: v and "alternate" in (v if isinstance(v, list) else [v]))
                if l.get("hreflang")]

    # Third-party tags, detected from the raw HTML rather than from a plugin
    # list, so it is true regardless of how they were installed.
    lower_html = html.lower()
    analytics = {
        "ga4": bool(re.search(r"gtag\('config',\s*'g-|googletagmanager\.com/gtag/js\?id=g-", lower_html)),
        "gtm": "googletagmanager.com/gtm.js" in lower_html or "gtm-" in lower_html,
        "universal_analytics": "google-analytics.com/analytics.js" in lower_html,
        "gsc_verification": bool(soup.find("meta", attrs={"name": "google-site-verification"})),
        "bing_verification": bool(soup.find("meta", attrs={"name": "msvalidate.01"})),
        "facebook_pixel": "connect.facebook.net" in lower_html,
        "linkedin_insight": "snap.licdn.com" in lower_html,
        "clarity": "clarity.ms" in lower_html,
        "hotjar": "hotjar.com" in lower_html,
        "plausible_or_fathom": "plausible.io" in lower_html or "usefathom.com" in lower_html,
        "vercel_analytics": "/_vercel/insights" in lower_html,
    }
    gsc_token = ""
    gsc_tag = soup.find("meta", attrs={"name": "google-site-verification"})
    if gsc_tag:
        gsc_token = (gsc_tag.get("content") or "")[:40]

    # Mixed content: an http:// subresource on an https:// page is blocked by
    # the browser, so it is a real breakage rather than a style point.
    mixed_content = []
    if url.startswith("https://"):
        for tag, attr in (("img", "src"), ("script", "src"), ("link", "href"),
                          ("iframe", "src"), ("source", "src"), ("video", "src")):
            for node in soup.find_all(tag):
                val = (node.get(attr) or "").strip()
                if val.startswith("http://"):
                    mixed_content.append(val[:200])

    # Body text, with chrome removed so the word count reflects the article
    # rather than the navigation.
    body_soup = BeautifulSoup(html, "html.parser")
    for tag in body_soup(["script", "style", "noscript", "nav", "footer", "header", "aside", "form"]):
        tag.decompose()
    main = body_soup.find("main") or body_soup.find("article") or body_soup.body or body_soup
    # Block boundaries ARE sentence boundaries. Joining blocks with a space
    # (as get_text does by default) glues a heading or a bullet onto the next
    # sentence, so a readability score computed over it reports one 200-word
    # sentence and a reading age nobody's copy actually has.
    blocks = [ln.strip() for ln in main.get_text(separator="\n", strip=True).split("\n") if ln.strip()]
    text = " ".join(b if b[-1] in ".!?:;" else b + "." for b in blocks)
    words = _text_words(text)

    paragraphs = [p.get_text(" ", strip=True) for p in main.find_all("p")] if hasattr(main, "find_all") else []
    long_paragraphs = sum(1 for p in paragraphs if len(_text_words(p)) > 150)

    sentences = [x for x in re.split(r"[.!?]+", text) if x.strip()]
    avg_sentence_words = round(len(words) / len(sentences), 1) if sentences else None

    # NAP signals for local SEO — phone/address/email as they appear to a user.
    # A tel: link is unambiguous, so it is trusted first; the text scan only
    # catches numbers that were typed as plain copy. Scanning the whole
    # document (not just <main>) matters because the number usually lives in
    # the header or footer, which the body extraction above strips out.
    visible_all = " ".join(BeautifulSoup(html, "html.parser").get_text(" ", strip=True).split())
    loose = re.findall(r"(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}", visible_all[:20000])
    phones = list(dict.fromkeys(
        [re.sub(r"[^\d+]", "", t) for t in tel_links if len(re.sub(r"\D", "", t)) >= 8]
        + [t.strip() for t in loose if 8 <= len(re.sub(r"\D", "", t)) <= 15]
    ))[:6]
    emails = list(dict.fromkeys(mailto_links
                                + re.findall(r"[\w.+-]+@[\w-]+\.[\w.]{2,}", html)))[:6]

    breadcrumb = ("BreadcrumbList" in schema_types
                  or bool(soup.find(attrs={"aria-label": re.compile("breadcrumb", re.I)}))
                  or bool(soup.find(class_=re.compile("breadcrumb", re.I))))

    return {
        "url": url,
        "path": route_path(url),
        "title": title,
        "title_length": len(title),
        "description": description,
        "description_length": len(description),
        "canonical": canonical,
        "canonical_self": bool(canonical) and route_path(canonical) == route_path(url),
        "robots": robots_combined,
        "robots_meta": robots_meta,
        "x_robots_tag": x_robots,
        "noindex": "noindex" in robots_combined,
        "nofollow_page": "nofollow" in robots_combined,
        "lang": lang,
        "charset": bool(soup.find("meta", attrs={"charset": True})) or "charset=" in lower_html[:2000],
        "viewport": meta(name="viewport"),
        "doctype": lower_html.lstrip().startswith("<!doctype html"),
        "favicon": bool(soup.find("link", rel=lambda v: v and any("icon" in x for x in (v if isinstance(v, list) else [v])))),
        "headings": headings,
        "h1": h1s[0] if h1s else "",
        "h1_count": len(h1s),
        "h2_count": sum(1 for h in headings if h["level"] == 2),
        "h3_count": sum(1 for h in headings if h["level"] == 3),
        "word_count": len(words),
        "text": text[:20000],
        "paragraph_count": len(paragraphs),
        "long_paragraphs": long_paragraphs,
        "sentence_count": len(sentences),
        "avg_sentence_words": avg_sentence_words,
        "reading_ease": flesch_reading_ease(text),
        "images": images,
        "image_count": len(images),
        "images_missing_alt": sum(1 for i in images if not i["alt"]),
        "links": links,
        "internal_links": sum(1 for l in links if l["internal"]),
        "external_links": sum(1 for l in links if not l["internal"]),
        "og_title": meta(prop="og:title"),
        "og_description": meta(prop="og:description"),
        "og_image": meta(prop="og:image"),
        "og_url": meta(prop="og:url"),
        "og_type": meta(prop="og:type"),
        "og_site_name": meta(prop="og:site_name"),
        "twitter_card": meta(name="twitter:card"),
        "twitter_title": meta(name="twitter:title"),
        "twitter_description": meta(name="twitter:description"),
        "twitter_image": meta(name="twitter:image"),
        "schema_types": schema_types,
        "schema_objects": jsonld_objects[:40],
        "schema_errors": schema_errors,
        "microdata": bool(soup.find(attrs={"itemtype": True})),
        "hreflang": hreflang,
        "analytics": analytics,
        "gsc_token": gsc_token,
        "mixed_content": mixed_content[:20],
        "phones": phones,
        "tel_links": list(dict.fromkeys(tel_links))[:6],
        "emails": emails,
        "breadcrumb": breadcrumb,
        "iframe_count": len(soup.find_all("iframe")),
        "has_map_embed": bool(re.search(r"google\.com/maps|maps\.google\.|maps\.googleapis", lower_html)),
    }


# --------------------------------------------------------------------------
# site-level resources
# --------------------------------------------------------------------------

async def fetch_robots(client: httpx.AsyncClient, base: str) -> dict:
    """robots.txt as both raw text and parsed rules, plus the sitemap URLs it
    advertises — which is where a crawler actually looks for them."""
    url = f"{base}/robots.txt"
    out = {"url": url, "exists": False, "status": None, "raw": "", "sitemaps": [],
           "groups": [], "error": None}
    try:
        resp = await client.get(url)
    except Exception as e:
        out["error"] = str(e)
        return out
    out["status"] = resp.status_code
    ctype = resp.headers.get("content-type", "").lower()
    if resp.status_code != 200:
        out["error"] = f"HTTP {resp.status_code}"
        return out
    if "html" in ctype:
        # A SPA that answers every unknown path with index.html looks like it
        # has a robots.txt when it does not; crawlers treat this as absent.
        out["error"] = "Served HTML, not plain text — robots.txt is effectively missing."
        return out
    out["exists"] = True
    out["raw"] = resp.text[:20000]

    current: Optional[dict] = None
    for line in out["raw"].splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        field, _, value = line.partition(":")
        field, value = field.strip().lower(), value.strip()
        if field == "user-agent":
            if current and current["agents"] and (current["allow"] or current["disallow"]):
                out["groups"].append(current)
                current = None
            if not current:
                current = {"agents": [], "allow": [], "disallow": [], "crawl_delay": None}
            current["agents"].append(value)
        elif field == "sitemap":
            out["sitemaps"].append(value)
        elif current is not None and field in ("allow", "disallow"):
            current[field].append(value)
        elif current is not None and field == "crawl-delay":
            current["crawl_delay"] = value
    if current:
        out["groups"].append(current)
    return out


def robots_blocks(robots: dict, path: str) -> Optional[str]:
    """The Disallow rule that would stop Googlebot fetching `path`, if any.
    Longest-match wins and Allow beats Disallow at equal length, which is the
    rule search engines actually apply."""
    if not robots.get("exists"):
        return None
    applicable = [g for g in robots["groups"] if any(a == "*" or "googlebot" in a.lower() for a in g["agents"])]
    if not applicable:
        return None
    best: tuple[int, Optional[str], bool] = (-1, None, False)
    for group in applicable:
        for rule in group["disallow"]:
            if rule and path.startswith(rule.rstrip("*")) and len(rule) > best[0]:
                best = (len(rule), rule, False)
        for rule in group["allow"]:
            if rule and path.startswith(rule.rstrip("*")) and len(rule) >= best[0]:
                best = (len(rule), rule, True)
    return None if best[2] or best[1] is None else best[1]


async def fetch_sitemaps(client: httpx.AsyncClient, base: str,
                         advertised: Optional[list[str]] = None) -> dict:
    """Every URL the site publishes, following sitemap indexes one level.
    Returns the candidates tried so a missing sitemap says where we looked."""
    ns = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
    import xml.etree.ElementTree as ET

    candidates = list(dict.fromkeys((advertised or []) + [
        f"{base}/sitemap.xml", f"{base}/sitemap_index.xml",
        f"{base}/sitemap-index.xml", f"{base}/sitemap/sitemap.xml",
    ]))
    out = {"found": False, "url": None, "tried": candidates[:6], "urls": [],
           "entries": [], "children": [], "error": None, "lastmod_count": 0}

    async def read(u: str) -> Optional[ET.Element]:
        try:
            r = await client.get(u)
        except Exception:
            return None
        if r.status_code != 200 or not r.text.lstrip().startswith("<"):
            return None
        try:
            return ET.fromstring(r.text.encode("utf-8", "ignore"))
        except Exception:
            return None

    for candidate in candidates[:6]:
        root = await read(candidate)
        if root is None:
            continue
        # A <sitemapindex> nests further sitemaps; a <urlset> holds URLs.
        if root.tag.endswith("sitemapindex"):
            children = [el.text.strip() for el in root.iter(f"{ns}loc") if el.text] or \
                       [el.text.strip() for el in root.iter("loc") if el.text]
            out["children"] = children[:50]
            for child in children[:15]:
                sub = await read(child)
                if sub is None:
                    continue
                for node in list(sub.iter(f"{ns}url")) or list(sub.iter("url")):
                    loc = node.findtext(f"{ns}loc") or node.findtext("loc") or ""
                    lastmod = node.findtext(f"{ns}lastmod") or node.findtext("lastmod") or ""
                    if loc.strip():
                        out["entries"].append({"loc": loc.strip(), "lastmod": lastmod.strip(),
                                               "sitemap": child})
        else:
            for node in list(root.iter(f"{ns}url")) or list(root.iter("url")):
                loc = node.findtext(f"{ns}loc") or node.findtext("loc") or ""
                lastmod = node.findtext(f"{ns}lastmod") or node.findtext("lastmod") or ""
                if loc.strip():
                    out["entries"].append({"loc": loc.strip(), "lastmod": lastmod.strip(),
                                           "sitemap": candidate})
        if out["entries"]:
            out["found"] = True
            out["url"] = candidate
            out["urls"] = [e["loc"] for e in out["entries"]]
            out["lastmod_count"] = sum(1 for e in out["entries"] if e["lastmod"])
            return out

    out["error"] = "No sitemap found at any of the usual locations."
    return out


def tls_certificate(hostname: str) -> dict:
    """Certificate issuer and expiry. Run in a thread — ssl is blocking."""
    out = {"ok": False, "error": None, "issuer": "", "not_after": None, "days_left": None}
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((hostname, 443), timeout=10) as sock:
            with ctx.wrap_socket(sock, server_hostname=hostname) as ssock:
                cert = ssock.getpeercert()
        issuer = dict(x[0] for x in cert.get("issuer", []) if x)
        out["issuer"] = issuer.get("organizationName") or issuer.get("commonName") or ""
        not_after = cert.get("notAfter")
        if not_after:
            expiry = datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
            out["not_after"] = expiry.isoformat()
            out["days_left"] = (expiry - datetime.now(timezone.utc)).days
        out["ok"] = True
    except Exception as e:
        out["error"] = str(e)
    return out


async def check_https_redirect(base: str) -> dict:
    """Does http:// end up on https://? An un-redirected http origin splits
    link equity and is the single most common "we have SSL" false positive."""
    http_url = "http://" + urlparse(base).netloc
    out = {"checked": http_url, "redirects_to_https": None, "final_url": None, "error": None}
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True, headers=BROWSER_HEADERS) as c:
            resp = await c.get(http_url)
        out["final_url"] = str(resp.url)
        out["redirects_to_https"] = str(resp.url).startswith("https://")
    except Exception as e:
        out["error"] = str(e)
    return out


async def check_link(client: httpx.AsyncClient, url: str) -> dict:
    """HEAD first (cheap), falling back to a ranged GET when a host refuses
    HEAD — plenty of CDNs answer 403/405 to HEAD while the URL is perfectly
    fine, and reporting those as broken destroys trust in the whole report.

    A status still in INCONCLUSIVE_STATUSES after the retry is reported as
    `blocked`, not broken. Those codes mean the host refused *us*: Facebook
    answers 400 to any datacenter IP, Cloudflare 403s an unfamiliar client.
    A genuinely dead page answers 404 or 410. Listing a live LinkedIn or
    Facebook profile as a broken link on every scan is how a broken-link
    report gets ignored.
    """
    try:
        resp = await client.head(url)
        if resp.status_code in INCONCLUSIVE_STATUSES or resp.status_code == 404:
            resp = await client.get(url, headers={**BROWSER_HEADERS, "Range": "bytes=0-2048"})
    except httpx.TimeoutException:
        return {"url": url, "status": None, "ok": False, "blocked": False, "error": "timeout"}
    except Exception as e:
        return {"url": url, "status": None, "ok": False, "blocked": False, "error": str(e)[:120]}
    chain = [{"status": r.status_code, "url": str(r.url)} for r in resp.history]
    status = resp.status_code
    blocked = status in INCONCLUSIVE_STATUSES
    return {"url": url, "status": status, "final_url": str(resp.url),
            "redirect_chain": chain,
            "ok": status < 400 or blocked,
            "blocked": blocked,
            "error": None if status < 400 else
                     f"HTTP {status} — the host refused our request, not necessarily a dead page"
                     if blocked else f"HTTP {status}"}


async def run_psi(url: str, strategy: str, api_key: str = "") -> dict:
    """PageSpeed Insights for one URL. Returns field (CrUX) data when Google
    has it for this origin and lab data always, plus the mobile-usability and
    performance audits that other categories reuse."""
    params = {"url": url, "strategy": strategy,
              "category": ["performance", "seo", "accessibility", "best-practices"]}
    if api_key:
        params["key"] = api_key
    try:
        async with httpx.AsyncClient(timeout=PSI_TIMEOUT) as c:
            resp = await c.get("https://www.googleapis.com/pagespeedonline/v5/runPagespeed",
                               params=params)
    except Exception as e:
        return {"url": url, "strategy": strategy, "ok": False, "error": str(e)[:160]}
    if resp.status_code != 200:
        detail = ""
        try:
            detail = (resp.json().get("error", {}).get("message") or "")[:160]
        except Exception:
            pass
        hint = (" Add a free PageSpeed API key in Settings to lift the quota."
                if resp.status_code == 429 else "")
        return {"url": url, "strategy": strategy, "ok": False,
                "error": f"PageSpeed API returned {resp.status_code}. {detail}{hint}".strip()}

    data = resp.json()
    lh = data.get("lighthouseResult", {})
    audits = lh.get("audits", {})
    cats = lh.get("categories", {})

    def numeric(aid: str):
        return audits.get(aid, {}).get("numericValue")

    def display(aid: str):
        return audits.get(aid, {}).get("displayValue")

    def cat_score(cid: str):
        v = cats.get(cid, {}).get("score")
        return round(v * 100) if isinstance(v, (int, float)) else None

    crux = data.get("loadingExperience", {}).get("metrics", {}) or {}

    def field(metric: str):
        m = crux.get(metric)
        if not m:
            return None
        return {"percentile": m.get("percentile"), "category": m.get("category")}

    opportunities = []
    for aid, audit in audits.items():
        if audit.get("details", {}).get("type") != "opportunity":
            continue
        saving = audit.get("details", {}).get("overallSavingsMs") or 0
        if saving < 100:
            continue
        opportunities.append({"id": aid, "title": audit.get("title", ""),
                              "savings_ms": round(saving),
                              "description": (audit.get("description") or "")[:300]})
    opportunities.sort(key=lambda o: -o["savings_ms"])

    # Audits that specifically describe the small-screen experience.
    mobile_audits = {}
    for aid in ("viewport", "font-size", "tap-targets", "content-width",
                "plugins", "uses-responsive-images"):
        a = audits.get(aid)
        if a:
            mobile_audits[aid] = {"title": a.get("title", ""), "score": a.get("score"),
                                  "display": a.get("displayValue"),
                                  "description": (a.get("description") or "")[:240]}

    return {
        "url": url, "strategy": strategy, "ok": True, "error": None,
        "performance_score": cat_score("performance"),
        "seo_score": cat_score("seo"),
        "accessibility_score": cat_score("accessibility"),
        "best_practices_score": cat_score("best-practices"),
        "lab": {
            "lcp_ms": numeric("largest-contentful-paint"),
            "cls": numeric("cumulative-layout-shift"),
            "tbt_ms": numeric("total-blocking-time"),
            "fcp_ms": numeric("first-contentful-paint"),
            "si_ms": numeric("speed-index"),
            "ttfb_ms": numeric("server-response-time"),
            "lcp_display": display("largest-contentful-paint"),
            "cls_display": display("cumulative-layout-shift"),
            "tbt_display": display("total-blocking-time"),
            "ttfb_display": display("server-response-time"),
        },
        "field": {
            "lcp": field("LARGEST_CONTENTFUL_PAINT_MS"),
            "inp": field("INTERACTION_TO_NEXT_PAINT"),
            "cls": field("CUMULATIVE_LAYOUT_SHIFT_SCORE"),
            "fcp": field("FIRST_CONTENTFUL_PAINT_MS"),
            "ttfb": field("EXPERIMENTAL_TIME_TO_FIRST_BYTE"),
            "overall": data.get("loadingExperience", {}).get("overall_category"),
            "origin_fallback": bool(data.get("originLoadingExperience")
                                    and not data.get("loadingExperience", {}).get("metrics")),
        },
        "opportunities": opportunities[:8],
        "mobile_audits": mobile_audits,
    }


# --------------------------------------------------------------------------
# keyword & content analysis
# --------------------------------------------------------------------------

# Slug segments that are structure, not subject.
SLUG_NOISE = {"index", "home", "page", "en", "us", "uk", "ae", "www", "blog", "post", "posts"}


def _longest_common_run(a: list[str], b: list[str], minimum: int = 2) -> list[str]:
    """The longest run of words appearing in both lists, in order. The overlap
    between a page's title and its H1 is almost always its actual topic —
    that is the whole reason to compute it."""
    best: list[str] = []
    for i in range(len(a)):
        for j in range(len(b)):
            k = 0
            while i + k < len(a) and j + k < len(b) and a[i + k] == b[j + k]:
                k += 1
            if k > len(best):
                best = a[i:i + k]
    return best if len(best) >= minimum else []


def infer_focus_keyword(sig: dict) -> str:
    """A best guess when nobody has set one. Always reported as inferred — an
    assumed keyword presented as a decision is how pages end up optimised for
    the wrong term.

    The URL slug is tried first, because on a real site it is written by
    someone naming the topic ("/azure-data-migration"), whereas the H1 is
    written to persuade ("Azure Data Migration, Seamlessly Delivered"). Taking
    the H1's first few non-stopwords produced phrases like "best solutions
    prepare business" — a guess wrong enough that every placement check below
    was then measuring the guess rather than the page.
    """
    title_head = re.split(r"\s*[|–—•]\s*", sig.get("title") or "")[0]
    title_words = [w for w in _text_words(title_head) if w not in STOPWORDS]
    h1_words = [w for w in _text_words(sig.get("h1") or "") if w not in STOPWORDS]
    body = (sig.get("text") or "").lower()

    slug = (sig.get("path") or "/").strip("/").split("/")[-1]
    slug_words = [w for w in _text_words(slug.replace("-", " ").replace("_", " "))
                  if w not in STOPWORDS and w not in SLUG_NOISE][:5]

    def appears(words: list[str]) -> bool:
        phrase = " ".join(words)
        return bool(phrase) and (phrase in body or phrase in " ".join(title_words)
                                 or phrase in " ".join(h1_words))

    # 1. The slug, when the page's own copy actually uses it.
    if slug_words and appears(slug_words):
        return " ".join(slug_words)
    # 2. What the title and the H1 agree on.
    overlap = _longest_common_run(title_words, h1_words)
    if overlap:
        return " ".join(overlap[:5])
    # 3. The slug even unconfirmed — still a deliberate naming decision.
    if slug_words:
        return " ".join(slug_words)
    # 4. The title, brand suffix removed. Last resort, and the weakest.
    return " ".join(title_words[:4])


def analyse_keyword(sig: dict, keyword: str, inferred: bool) -> dict:
    """Where the focus keyword does and does not appear, plus density."""
    kw = (keyword or "").strip().lower()
    if not kw:
        return {"keyword": "", "inferred": inferred, "checks": [], "score": None,
                "note": "No focus keyword set for this page."}

    kw_words = [w for w in _text_words(kw) if w]
    text = (sig.get("text") or "").lower()
    words = _text_words(text)
    occurrences = len(re.findall(re.escape(kw), text)) if kw else 0
    density = round(occurrences * len(kw_words) / len(words) * 100, 2) if words else 0.0
    first_100 = " ".join(words[:100])
    h2_text = " ".join(h["text"].lower() for h in sig.get("headings", []) if h["level"] == 2)
    slug = sig.get("path", "").lower()

    def kw_in(haystack: str) -> bool:
        if not haystack:
            return False
        if kw in haystack:
            return True
        # Slugs hyphenate, and partial-word matches ("seo" inside "season")
        # would otherwise pass, so match on whole words.
        hay_words = set(_text_words(haystack.replace("-", " ")))
        return all(w in hay_words for w in kw_words)

    results = [
        {"id": "kw_title", "label": "Keyword in SEO title", "passed": kw_in(sig.get("title", "").lower()),
         "hint": "Google weights the title heavily; lead with the keyword where it reads naturally."},
        {"id": "kw_description", "label": "Keyword in meta description",
         "passed": kw_in(sig.get("description", "").lower()),
         "hint": "It is bolded in the results page, which lifts click-through even though it is not a ranking factor."},
        {"id": "kw_h1", "label": "Keyword in H1", "passed": kw_in(sig.get("h1", "").lower()),
         "hint": "The H1 should state the page's topic in the searcher's words."},
        {"id": "kw_url", "label": "Keyword in URL slug", "passed": kw_in(slug),
         "hint": "Short, keyword-relevant, hyphen-separated."},
        {"id": "kw_intro", "label": "Keyword in first 100 words", "passed": kw_in(first_100),
         "hint": "Confirms the topic to the reader (and the crawler) immediately."},
        {"id": "kw_subheading", "label": "Keyword or variant in an H2", "passed": kw_in(h2_text),
         "hint": "Shows the page covers the topic in depth rather than mentioning it once."},
        {"id": "kw_density", "label": "Keyword density 0.5–2.5%",
         # Below ~100 words the figure is noise, so it is not judged rather
         # than judged wrongly: one mention on a 26-word page is 3.8%.
         "passed": len(words) < 100 or 0.5 <= density <= 2.5,
         "hint": (f"Currently {density}%. Below 0.5% reads as off-topic; above 2.5% reads as stuffing."
                  if len(words) >= 100 else
                  f"Only {len(words)} words on this page — density is not meaningful below 100.")},
        {"id": "kw_image_alt", "label": "Keyword in at least one image alt",
         "passed": any(kw_in((i.get("alt") or "").lower()) for i in sig.get("images", [])),
         "hint": "One descriptive alt is enough — repeating it on every image is stuffing."},
    ]
    passed = sum(1 for r in results if r["passed"])
    return {
        "keyword": keyword, "inferred": inferred, "occurrences": occurrences,
        "density": density, "checks": results, "passed": passed, "total": len(results),
        "score": round(passed / len(results) * 100),
    }


def content_terms(sig: dict, limit: int = 12) -> list[dict]:
    """The page's own most prominent terms — useful for spotting that a page
    is actually about something other than its focus keyword."""
    words = [w for w in _text_words(sig.get("text", "")) if w not in STOPWORDS and len(w) > 3]
    bigrams = [" ".join(pair) for pair in zip(words, words[1:])]
    counts = Counter(bigrams).most_common(limit * 2)
    out = [{"term": t, "count": c} for t, c in counts if c > 1][:limit]
    if not out:
        out = [{"term": t, "count": c} for t, c in Counter(words).most_common(limit)]
    return out


# --------------------------------------------------------------------------
# category evaluators
#
# Each returns {key, label, score, summary, checks, items?}. `checks` are the
# site-wide findings; `items` carries per-page rows the UI can drill into.
# A category with nothing to judge returns status "info" rather than a
# passing score it has not earned.
# --------------------------------------------------------------------------

def _pct(part: int, whole: int) -> int:
    return round(part / whole * 100) if whole else 0


def _page_ref(page: dict, detail: str = "") -> dict:
    return {"url": page["url"], "path": page["path"], "detail": detail}


def cat_keyword_content(ctx: dict) -> dict:
    pages = ctx["ok_pages"]
    checks: list[dict] = []
    if not pages:
        return {"key": "keyword_content", "label": "Keyword & Content SEO", "score": None,
                "summary": "No pages could be fetched.", "checks": [], "items": []}

    set_kw = [p for p in pages if p.get("keyword_analysis", {}).get("keyword")
              and not p["keyword_analysis"].get("inferred")]
    checks.append(check(
        "kw_assigned", "Every page has a focus keyword assigned",
        _status_of(len(set_kw) == len(pages), warn_only=True),
        f"{len(set_kw)} of {len(pages)} pages have a keyword you chose; the rest use one inferred "
        f"from the URL slug, title and H1. Set them on the Pages tab so the analysis measures your "
        f"intent rather than a guess.",
        severity="medium", value=f"{len(set_kw)}/{len(pages)}",
        items=[_page_ref(p, f"inferred: “{p['keyword_analysis'].get('keyword','')}”")
               for p in pages if p.get("keyword_analysis", {}).get("inferred")][:50]))

    # Judged only on keywords the user actually chose. Grading an inferred
    # guess would report a failure about our guess, which nobody can act on.
    weak = [p for p in set_kw if (p.get("keyword_analysis", {}).get("score") or 0) < 60]
    checks.append(check(
        "kw_placement", "Focus keyword used in the places that matter",
        "info" if not set_kw else _status_of(not weak, warn_only=True),
        (f"{len(weak)} of {len(set_kw)} pages with a chosen keyword place it in fewer than 5 of the "
         f"8 checked positions (title, description, H1, URL, intro, H2, alt text, density)." if weak
         else f"All {len(set_kw)} pages with a chosen keyword place it in at least 5 of the 8 "
              f"checked positions." if set_kw else
         "No focus keywords assigned yet, so placement is not graded — the table below shows the "
         "inferred keyword and its placement for reference only."),
        severity="high" if set_kw and len(weak) > len(set_kw) / 2 else "medium",
        items=[_page_ref(p, f"{p['keyword_analysis'].get('passed',0)}/8 placements — "
                            f"“{p['keyword_analysis'].get('keyword','')}”") for p in weak][:50]))

    # Only on pages long enough for a percentage to mean anything — one
    # mention of a one-word keyword on a 26-word page is 3.8%, and reporting
    # that as manipulation is how a report loses its credibility.
    stuffed = [p for p in pages
               if (p.get("keyword_analysis", {}).get("density") or 0) > 3.0
               and p["signals"]["word_count"] >= 100]
    checks.append(check(
        "kw_stuffing", "No keyword stuffing", _status_of(not stuffed),
        "Density above 3% reads as manipulation to both a reader and a classifier."
        if stuffed else "No page over 100 words exceeds 3% keyword density.",
        severity="high",
        items=[_page_ref(p, f"{p['keyword_analysis']['density']}% density for "
                             f"“{p['keyword_analysis'].get('keyword','')}”"
                             + (" (inferred)" if p["keyword_analysis"].get("inferred") else ""))
               for p in stuffed][:50]))

    thin = [p for p in pages if p["signals"]["word_count"] < 300]
    checks.append(check(
        "content_depth", "Enough content to answer the query",
        _status_of(not thin, warn_only=len(thin) <= len(pages) / 4),
        (f"{len(thin)} of {len(pages)} pages have under 300 words of body copy. Thin pages rarely "
         f"rank for competitive terms, though a genuine utility page can be short on purpose."
         if thin else f"Every one of the {len(pages)} pages has at least 300 words."),
        severity="medium",
        items=[_page_ref(p, f"{p['signals']['word_count']} words") for p in thin][:50]))

    rambling = [p for p in pages if (p["signals"].get("avg_sentence_words") or 0) > 25]
    checks.append(check(
        "sentence_length", "Sentences average under 25 words",
        _status_of(not rambling, warn_only=True),
        (f"{len(rambling)} pages average over 25 words per sentence. Long sentences are the half of "
         f"readability you can actually fix — splitting them helps more than swapping vocabulary."
         if rambling else
         f"Every page averages under 25 words per sentence."),
        severity="low",
        items=[_page_ref(p, f"{p['signals'].get('avg_sentence_words')} words/sentence")
               for p in rambling][:50]))

    scores = [p["signals"]["reading_ease"] for p in pages if p["signals"].get("reading_ease") is not None]
    avg_ease = round(sum(scores) / len(scores), 1) if scores else None
    hard = [p for p in pages if (p["signals"].get("reading_ease") or 100) < 30]
    checks.append(check(
        "readability", "Readability (Flesch Reading Ease)",
        "info" if not hard else "warn",
        (f"Average {avg_ease} across {len(scores)} pages. "
         if avg_ease is not None else "")
        + (f"{len(hard)} pages score under 30, which is heavy going. Flesch penalises long words, so "
           f"technical vocabulary drags this down legitimately — treat it as context, not a target, "
           f"and fix sentence length first." if hard
           else "Nothing scores below 30. Flesch penalises long words, so technical copy scores low "
                "legitimately; read this as context rather than a target."),
        severity="low", value=avg_ease,
        items=[_page_ref(p, f"Flesch {p['signals'].get('reading_ease')}") for p in hard][:50]))

    walls = [p for p in pages if p["signals"].get("long_paragraphs", 0) > 0]
    checks.append(check(
        "paragraph_length", "No wall-of-text paragraphs", _status_of(not walls, warn_only=True),
        (f"{len(walls)} pages contain a paragraph over 150 words." if walls
         else "No wall-of-text paragraphs."), severity="low",
        items=[_page_ref(p, f"{p['signals']['long_paragraphs']} long paragraph(s)") for p in walls][:50]))

    # Duplicate titles/descriptions are a content problem before they are a
    # metadata one: two pages with the same title usually target the same query.
    title_groups = defaultdict(list)
    for p in pages:
        t = (p["signals"]["title"] or "").strip().lower()
        if t:
            title_groups[t].append(p)
    dupe_titles = {t: ps for t, ps in title_groups.items() if len(ps) > 1}
    checks.append(check(
        "unique_titles", "Every page has a unique title", _status_of(not dupe_titles),
        f"{len(dupe_titles)} title(s) are shared by more than one page — those pages compete with "
        f"each other for the same query." if dupe_titles else "All titles are unique.",
        severity="high",
        items=[{"url": ps[0]["url"], "path": ", ".join(x["path"] for x in ps),
                "detail": f"“{ps[0]['signals']['title'][:70]}” on {len(ps)} pages"}
               for ps in dupe_titles.values()][:30]))

    faq_pages = sum(1 for p in pages if "FAQPage" in p["signals"]["schema_types"]
                    or re.search(r"\bfaq\b|frequently asked", (p["signals"].get("text") or "")[:4000], re.I))
    checks.append(check(
        "faq_coverage", "FAQ content where it helps",
        "pass" if faq_pages else "warn",
        f"{faq_pages} of {len(pages)} pages include FAQ content. FAQs capture long-tail queries and "
        f"can earn extra result real estate when marked up as FAQPage.",
        severity="low", value=faq_pages))

    items = [{
        "url": p["url"], "path": p["path"],
        "keyword": p.get("keyword_analysis", {}).get("keyword", ""),
        "inferred": p.get("keyword_analysis", {}).get("inferred", True),
        "keyword_score": p.get("keyword_analysis", {}).get("score"),
        "density": p.get("keyword_analysis", {}).get("density"),
        "word_count": p["signals"]["word_count"],
        "reading_ease": p["signals"].get("reading_ease"),
        "avg_sentence_words": p["signals"].get("avg_sentence_words"),
        "checks": p.get("keyword_analysis", {}).get("checks", []),
        "terms": p.get("terms", []),
    } for p in pages]
    items.sort(key=lambda i: (i["keyword_score"] is None, i["keyword_score"] or 0))

    return {"key": "keyword_content", "label": "Keyword & Content SEO",
            "score": score_from_checks(checks),
            "summary": f"{len(pages)} pages analysed for keyword placement, depth and readability.",
            "checks": checks, "items": items}


def cat_on_page(ctx: dict) -> dict:
    pages = ctx["ok_pages"]
    checks: list[dict] = []
    if not pages:
        return {"key": "on_page", "label": "On-Page SEO", "score": None,
                "summary": "No pages could be fetched.", "checks": [], "items": []}

    no_title = [p for p in pages if not p["signals"]["title"]]
    bad_len = [p for p in pages if p["signals"]["title"] and not (50 <= p["signals"]["title_length"] <= 60)]
    checks.append(check("title_present", "Every page has a title tag", _status_of(not no_title),
                        f"{len(no_title)} pages have no <title>." if no_title else "All pages have a title.",
                        severity="high", items=[_page_ref(p) for p in no_title][:50]))
    checks.append(check("title_length", "Titles are 50–60 characters",
                        _status_of(not bad_len, warn_only=True),
                        (f"{len(bad_len)} of {len(pages)} titles fall outside 50–60 characters, so Google "
                         f"either truncates them or leaves the slot half-used."
                         if bad_len else "Every title is 50–60 characters."), severity="medium",
                        items=[_page_ref(p, f"{p['signals']['title_length']} chars — “{p['signals']['title'][:70]}”")
                               for p in bad_len][:50]))

    no_desc = [p for p in pages if not p["signals"]["description"]]
    bad_desc = [p for p in pages if p["signals"]["description"]
                and not (150 <= p["signals"]["description_length"] <= 160)]
    checks.append(check("desc_present", "Every page has a meta description", _status_of(not no_desc),
                        f"{len(no_desc)} pages have no meta description — Google then invents a snippet "
                        f"from the body copy." if no_desc else "All pages have a meta description.",
                        severity="high", items=[_page_ref(p) for p in no_desc][:50]))
    checks.append(check("desc_length", "Descriptions are 150–160 characters",
                        _status_of(not bad_desc, warn_only=True),
                        (f"{len(bad_desc)} of {len(pages)} descriptions fall outside 150–160 characters."
                         if bad_desc else "Every description is 150–160 characters."),
                        severity="medium",
                        items=[_page_ref(p, f"{p['signals']['description_length']} chars")
                               for p in bad_desc][:50]))

    desc_groups = defaultdict(list)
    for p in pages:
        d = (p["signals"]["description"] or "").strip().lower()
        if d:
            desc_groups[d].append(p)
    dupe_desc = {d: ps for d, ps in desc_groups.items() if len(ps) > 1}
    checks.append(check("desc_unique", "Descriptions are unique per page", _status_of(not dupe_desc),
                        f"{len(dupe_desc)} description(s) are reused across pages." if dupe_desc
                        else "Every description is unique.", severity="medium",
                        items=[{"url": ps[0]["url"], "path": ", ".join(x["path"] for x in ps),
                                "detail": f"shared by {len(ps)} pages"} for ps in dupe_desc.values()][:30]))

    no_h1 = [p for p in pages if p["signals"]["h1_count"] == 0]
    many_h1 = [p for p in pages if p["signals"]["h1_count"] > 1]
    checks.append(check("h1_single", "Exactly one H1 per page",
                        _status_of(not no_h1 and not many_h1),
                        (f"{len(no_h1)} pages have no H1 and {len(many_h1)} have more than one. Page "
                         f"builders often emit extra H1s for visual weight — use CSS for size instead."
                         if (no_h1 or many_h1) else "Every page has exactly one H1."),
                        severity="high",
                        items=([_page_ref(p, "no H1") for p in no_h1]
                               + [_page_ref(p, f"{p['signals']['h1_count']} H1s") for p in many_h1])[:50]))

    no_h2 = [p for p in pages if p["signals"]["h2_count"] == 0 and p["signals"]["word_count"] > 300]
    checks.append(check("h2_structure", "Substantial pages use H2 sections",
                        _status_of(not no_h2, warn_only=True),
                        (f"{len(no_h2)} pages over 300 words have no H2 — the content has no scannable "
                         f"structure." if no_h2 else "Every substantial page uses H2 sections."),
                        severity="medium",
                        items=[_page_ref(p, f"{p['signals']['word_count']} words, no H2") for p in no_h2][:50]))

    # A heading level skipped (H2 -> H4) breaks the outline for assistive tech
    # and for the crawler's understanding of what nests under what.
    skipped = []
    for p in pages:
        levels = [h["level"] for h in p["signals"]["headings"]]
        for prev, nxt in zip(levels, levels[1:]):
            if nxt - prev > 1:
                skipped.append(_page_ref(p, f"H{prev} → H{nxt}"))
                break
    checks.append(check("heading_order", "Heading levels are not skipped",
                        _status_of(not skipped, warn_only=True),
                        (f"{len(skipped)} pages jump a heading level." if skipped
                         else "No page skips a heading level."), severity="low",
                        items=skipped[:50]))

    bad_slug = []
    for p in pages:
        path, reasons = p["path"], []
        if path != path.lower():
            reasons.append("uppercase")
        if "_" in path:
            reasons.append("underscores")
        if re.search(r"\?|=|&", p["url"].split("#")[0].split("?", 1)[-1]) and "?" in p["url"]:
            reasons.append("query string")
        if len(path) > 90:
            reasons.append(f"{len(path)} chars")
        if len([s for s in path.split("/") if s]) > 4:
            reasons.append("deeply nested")
        if reasons:
            bad_slug.append(_page_ref(p, ", ".join(reasons)))
    checks.append(check("slug_hygiene", "URLs are short, lowercase and hyphen-separated",
                        _status_of(not bad_slug, warn_only=True),
                        f"{len(bad_slug)} URLs have hygiene issues." if bad_slug
                        else "Every URL is clean.", severity="low", items=bad_slug[:50]))

    return {"key": "on_page", "label": "On-Page SEO", "score": score_from_checks(checks),
            "summary": f"Title, description, headings and URL checked on {len(pages)} pages.",
            "checks": checks,
            "items": [{"url": p["url"], "path": p["path"], "score": p.get("score"),
                       "title": p["signals"]["title"], "title_length": p["signals"]["title_length"],
                       "description": p["signals"]["description"],
                       "description_length": p["signals"]["description_length"],
                       "h1": p["signals"]["h1"], "h1_count": p["signals"]["h1_count"],
                       "h2_count": p["signals"]["h2_count"],
                       "headings": p["signals"]["headings"][:40],
                       "issues": p.get("issues", [])} for p in pages]}


def cat_technical(ctx: dict) -> dict:
    pages, checks = ctx["ok_pages"], []
    home = ctx.get("home_headers") or {}

    slow = [p for p in pages if (p.get("elapsed_ms") or 0) > 800]
    avg_ttfb = round(sum(p.get("elapsed_ms") or 0 for p in pages) / len(pages)) if pages else None
    checks.append(check("server_response", "Server responds in under 800 ms",
                        _status_of(not slow, warn_only=True),
                        f"Average response {avg_ttfb} ms across {len(pages)} pages"
                        + (f"; {len(slow)} took over 800 ms." if slow else ", none over 800 ms."),
                        severity="medium", value=f"{avg_ttfb} ms",
                        items=[_page_ref(p, f"{p['elapsed_ms']} ms") for p in slow][:50]))

    no_viewport = [p for p in pages if not p["signals"]["viewport"]]
    checks.append(check("viewport", "Responsive viewport declared", _status_of(not no_viewport),
                        f"{len(no_viewport)} pages have no viewport meta tag — mobile browsers then "
                        f"render at desktop width and zoom out." if no_viewport
                        else "Every page declares a viewport.", severity="high",
                        items=[_page_ref(p) for p in no_viewport][:50]))

    no_lang = [p for p in pages if not p["signals"]["lang"]]
    checks.append(check("html_lang", "<html lang> set", _status_of(not no_lang, warn_only=True),
                        (f"{len(no_lang)} pages do not declare a language." if no_lang
                         else "Every page declares a language."), severity="low",
                        items=[_page_ref(p) for p in no_lang][:50]))

    no_charset = [p for p in pages if not p["signals"]["charset"]]
    checks.append(check("charset", "Character set declared", _status_of(not no_charset, warn_only=True),
                        (f"{len(no_charset)} pages declare no charset." if no_charset
                         else "Every page declares a charset."), severity="low",
                        items=[_page_ref(p) for p in no_charset][:50]))

    no_doctype = [p for p in pages if not p["signals"]["doctype"]]
    checks.append(check("doctype", "HTML5 doctype", _status_of(not no_doctype, warn_only=True),
                        (f"{len(no_doctype)} pages start without <!doctype html>." if no_doctype
                         else "Every page starts with an HTML5 doctype."), severity="low",
                        items=[_page_ref(p) for p in no_doctype][:50]))

    no_favicon = [p for p in pages if not p["signals"]["favicon"]]
    checks.append(check("favicon", "Favicon declared", _status_of(not no_favicon, warn_only=True),
                        (f"{len(no_favicon)} pages declare no favicon — it appears beside your result "
                         f"on mobile." if no_favicon else "Every page declares a favicon."),
                        severity="low", items=[_page_ref(p) for p in no_favicon][:20]))

    compressed = (home.get("content-encoding") or "").lower()
    checks.append(check("compression", "Text compression enabled (gzip/brotli)",
                        _status_of(compressed in ("gzip", "br", "deflate", "zstd")),
                        f"Homepage served with Content-Encoding: {compressed or 'none'}."
                        + ("" if compressed else " Enabling brotli or gzip typically cuts HTML transfer "
                                                 "by 70%."), severity="medium", value=compressed or "none"))

    cache_control = home.get("cache-control") or ""
    checks.append(check("caching", "Cache headers present",
                        _status_of(bool(cache_control), warn_only=True),
                        f"Homepage Cache-Control: {cache_control or 'not set'}.", severity="low",
                        value=cache_control or "not set"))

    hreflang_pages = sum(1 for p in pages if p["signals"]["hreflang"])
    checks.append(check("hreflang", "hreflang declared where the site is multilingual",
                        "pass" if hreflang_pages else "info",
                        f"{hreflang_pages} pages declare hreflang alternates. Only needed if you serve "
                        f"more than one language or region." , severity="low", value=hreflang_pages))

    big = [p for p in pages if (p.get("bytes") or 0) > 500_000]
    checks.append(check("html_weight", "HTML document under 500 KB",
                        _status_of(not big, warn_only=True),
                        (f"{len(big)} pages ship over 500 KB of HTML, which delays first paint." if big
                         else "Every document is under 500 KB."), severity="low",
                        items=[_page_ref(p, f"{round((p.get('bytes') or 0)/1024)} KB") for p in big][:50]))

    return {"key": "technical", "label": "Technical SEO", "score": score_from_checks(checks),
            "summary": f"Transport, rendering and document-level technical checks on {len(pages)} pages.",
            "checks": checks,
            "items": [{"url": p["url"], "path": p["path"], "status": p.get("status_code"),
                       "response_ms": p.get("elapsed_ms"), "bytes": p.get("bytes"),
                       "viewport": p["signals"]["viewport"], "lang": p["signals"]["lang"],
                       "server": (p.get("headers") or {}).get("server", ""),
                       "content_encoding": (p.get("headers") or {}).get("content-encoding", ""),
                       "cache_control": (p.get("headers") or {}).get("cache-control", "")}
                      for p in pages]}


def cat_images(ctx: dict) -> dict:
    pages, checks = ctx["ok_pages"], []
    all_images = [(p, img) for p in pages for img in p["signals"]["images"]]
    total = len(all_images)
    if not total:
        return {"key": "images", "label": "Image SEO", "score": None,
                "summary": "No <img> elements found on the audited pages.",
                "checks": [check("no_images", "Images found", "info",
                                 "No images were found, so there is nothing to optimise. If your images "
                                 "are CSS backgrounds they are invisible to image search.", "low")],
                "items": []}

    missing_alt = [(p, i) for p, i in all_images if not i["alt"]]
    checks.append(check("alt_text", "Every image has descriptive alt text",
                        _status_of(not missing_alt),
                        f"{len(missing_alt)} of {total} images have no alt text ({_pct(total - len(missing_alt), total)}% "
                        f"covered). Decorative images should carry an explicit empty alt=\"\".",
                        severity="medium",
                        items=[{"url": p["url"], "path": p["path"], "detail": i["filename"] or i["src"][:90]}
                               for p, i in missing_alt][:80]))

    stuffed = [(p, i) for p, i in all_images if i["alt"] and len(_text_words(i["alt"])) > 14]
    checks.append(check("alt_quality", "Alt text is a description, not a keyword list",
                        _status_of(not stuffed, warn_only=True),
                        (f"{len(stuffed)} images have alt text over 14 words, which usually means "
                         f"keywords were stacked rather than the image described."
                         if stuffed else "No over-long alt text."), severity="low",
                        items=[{"url": p["url"], "path": p["path"], "detail": i["alt"][:110]}
                               for p, i in stuffed][:50]))

    bad_names = [(p, i) for p, i in all_images
                 if i["filename"] and re.match(r"^(img|image|dsc|photo|screenshot|untitled|\d)", i["filename"], re.I)]
    checks.append(check("filenames", "Filenames describe the image",
                        _status_of(not bad_names, warn_only=True),
                        (f"{len(bad_names)} images use a camera or placeholder filename such as "
                         f"IMG_1234.jpg. Rename to salesforce-implementation-dashboard.webp style."
                         if bad_names else "Every filename is descriptive."),
                        severity="low",
                        items=[{"url": p["url"], "path": p["path"], "detail": i["filename"]}
                               for p, i in bad_names][:50]))

    raster = [(p, i) for p, i in all_images if i["ext"] in RASTER_FORMATS]
    modern = [(p, i) for p, i in all_images if i["ext"] in MODERN_IMAGE_FORMATS]
    # Next.js /_next/image serves WebP by content negotiation, so the URL
    # extension understates modern-format use; say so rather than flagging it.
    optimizer = sum(1 for _p, i in all_images if "/_next/image" in i["src"] or "/cdn-cgi/image" in i["src"])
    checks.append(check("modern_formats", "Images served as WebP or AVIF",
                        "pass" if not raster or optimizer else ("warn" if raster else "pass"),
                        f"{len(modern)} of {total} image URLs are WebP/AVIF and {len(raster)} are "
                        f"JPEG/PNG/GIF."
                        + (f" {optimizer} are served through an image optimiser that negotiates format "
                           f"per browser, so the extension understates this." if optimizer else
                           " Converting typically saves 25–50% of image bytes."),
                        severity="low",
                        items=[{"url": p["url"], "path": p["path"], "detail": f"{i['ext']} — {i['filename']}"}
                               for p, i in raster][:50]))

    no_dims = [(p, i) for p, i in all_images if not (i["width"] and i["height"])]
    checks.append(check("dimensions", "Width and height set on every image",
                        _status_of(not no_dims, warn_only=True),
                        f"{len(no_dims)} images declare no width/height, so the browser cannot reserve "
                        f"space and the layout shifts as they load — this is the main cause of CLS.",
                        severity="medium",
                        items=[{"url": p["url"], "path": p["path"], "detail": i["filename"] or i["src"][:90]}
                               for p, i in no_dims][:50]))

    # Everything below the fold should be lazy; the hero should NOT be, since
    # lazy-loading the LCP image delays it.
    lazy = sum(1 for _p, i in all_images if i["loading"] == "lazy")
    checks.append(check("lazy_loading", "Below-the-fold images lazy-load",
                        "pass" if lazy >= max(1, total // 3) else "warn",
                        f"{lazy} of {total} images use loading=\"lazy\". Leave the hero image eager — "
                        f"lazy-loading the largest visible image delays LCP.", severity="low",
                        value=f"{lazy}/{total}"))

    responsive = sum(1 for _p, i in all_images if i["srcset"])
    checks.append(check("responsive_images", "Images ship a srcset for smaller screens",
                        "pass" if responsive >= max(1, total // 3) else "warn",
                        f"{responsive} of {total} images declare a srcset, so phones can download a "
                        f"smaller file than desktops.", severity="low", value=f"{responsive}/{total}"))

    heavy = ctx.get("heavy_images") or []
    if heavy:
        checks.append(check("file_size", "No image over 200 KB",
                            _status_of(not heavy, warn_only=True),
                            f"{len(heavy)} of the sampled images exceed 200 KB.", severity="medium",
                            items=[{"url": h["url"], "path": h.get("page", ""),
                                    "detail": f"{h['kb']} KB"} for h in heavy][:50]))

    return {"key": "images", "label": "Image SEO", "score": score_from_checks(checks),
            "summary": f"{total} images across {len(pages)} pages; "
                       f"{_pct(total - len(missing_alt), total)}% have alt text.",
            "checks": checks,
            "items": [{"url": p["url"], "path": p["path"],
                       "image_count": p["signals"]["image_count"],
                       "missing_alt": p["signals"]["images_missing_alt"],
                       "images": p["signals"]["images"][:40]} for p in pages
                      if p["signals"]["image_count"]]}


def cat_internal_linking(ctx: dict) -> dict:
    pages, checks = ctx["ok_pages"], []
    if not pages:
        return {"key": "internal_linking", "label": "Internal Linking", "score": None,
                "summary": "No pages could be fetched.", "checks": [], "items": []}

    known = {p["path"] for p in pages}
    inbound: dict[str, set] = defaultdict(set)
    outbound: dict[str, int] = {}
    anchors: dict[str, list[str]] = defaultdict(list)

    for p in pages:
        internal = [l for l in p["signals"]["links"] if l["internal"]]
        outbound[p["path"]] = len(internal)
        for link in internal:
            target = route_path(link["href"])
            if target != p["path"]:
                inbound[target].add(p["path"])
                if link["anchor"]:
                    anchors[target].append(link["anchor"])

    # Orphans are judged only within the crawl — a page nothing in the crawl
    # links to. Saying more than that would overclaim, since the crawl is a
    # sample of the site.
    orphans = [p for p in pages if not inbound.get(p["path"]) and p["path"] != "/"]
    checks.append(check("orphans", "No orphan pages",
                        _status_of(not orphans),
                        f"{len(orphans)} of {len(pages)} audited pages receive no internal link from "
                        f"any other audited page. Search engines discover and weight pages through "
                        f"links, so an orphan depends entirely on the sitemap.",
                        severity="high",
                        items=[_page_ref(p, "no inbound internal links") for p in orphans][:50]))

    thin_out = [p for p in pages if outbound.get(p["path"], 0) < 3]
    checks.append(check("outbound_internal", "Every page links out to at least 3 others",
                        _status_of(not thin_out, warn_only=True),
                        (f"{len(thin_out)} pages contain fewer than 3 internal links, which leaves them "
                         f"as dead ends for both readers and crawlers."
                         if thin_out else "Every page links out to at least 3 others."), severity="medium",
                        items=[_page_ref(p, f"{outbound.get(p['path'], 0)} internal links")
                               for p in thin_out][:50]))

    excessive = [p for p in pages if outbound.get(p["path"], 0) > 150]
    checks.append(check("link_volume", "No page has an excessive link count",
                        _status_of(not excessive, warn_only=True),
                        (f"{len(excessive)} pages carry over 150 internal links, which dilutes the value "
                         f"each one passes." if excessive else "No page carries an excessive link count."),
                        severity="low",
                        items=[_page_ref(p, f"{outbound.get(p['path'], 0)} links") for p in excessive][:50]))

    generic = []
    for p in pages:
        bad = [l["anchor"] for l in p["signals"]["links"]
               if l["internal"] and l["anchor"].strip().lower() in GENERIC_ANCHORS]
        if bad:
            generic.append(_page_ref(p, f"{len(bad)}× e.g. “{bad[0]}”"))
    checks.append(check("anchor_text", "Anchor text describes the destination",
                        _status_of(not generic, warn_only=True),
                        (f"{len(generic)} pages use non-descriptive anchors such as “click here”, which "
                         f"tell a search engine nothing about the page being linked to."
                         if generic else "No generic anchor text found."), severity="medium",
                        items=generic[:50]))

    empty_anchor = []
    for p in pages:
        n = sum(1 for l in p["signals"]["links"]
                if l["internal"] and not l["anchor"] and not l["is_image_link"])
        if n:
            empty_anchor.append(_page_ref(p, f"{n} link(s) with no text"))
    checks.append(check("empty_anchors", "No internal link is completely unlabelled",
                        _status_of(not empty_anchor, warn_only=True),
                        (f"{len(empty_anchor)} pages contain internal links with neither text nor an "
                         f"image to describe them." if empty_anchor
                         else "Every internal link is labelled."), severity="low", items=empty_anchor[:50]))

    nofollow_internal = []
    for p in pages:
        n = sum(1 for l in p["signals"]["links"] if l["internal"] and l["nofollow"])
        if n:
            nofollow_internal.append(_page_ref(p, f"{n} nofollowed internal link(s)"))
    checks.append(check("internal_nofollow", "Internal links are not nofollowed",
                        _status_of(not nofollow_internal, warn_only=True),
                        "Nofollowing your own links wastes the equity they would otherwise pass."
                        if nofollow_internal else "No internal link is nofollowed.",
                        severity="low", items=nofollow_internal[:50]))

    external_total = sum(p["signals"]["external_links"] for p in pages)
    unsafe_external = []
    for p in pages:
        n = sum(1 for l in p["signals"]["links"]
                if not l["internal"] and l["target_blank"] and "noopener" not in l["rel"])
        if n:
            unsafe_external.append(_page_ref(p, f"{n} target=_blank without rel=noopener"))
    checks.append(check("external_links", "External links open safely",
                        _status_of(not unsafe_external, warn_only=True),
                        f"{external_total} outbound external links found; {len(unsafe_external)} pages "
                        f"open one in a new tab without rel=\"noopener\".", severity="low",
                        items=unsafe_external[:50]))

    items = [{
        "url": p["url"], "path": p["path"],
        "inbound": len(inbound.get(p["path"], set())),
        "inbound_from": sorted(inbound.get(p["path"], set()))[:20],
        "outbound_internal": outbound.get(p["path"], 0),
        "outbound_external": p["signals"]["external_links"],
        "top_anchors": [a for a, _ in Counter(anchors.get(p["path"], [])).most_common(5)],
    } for p in pages]
    items.sort(key=lambda i: i["inbound"])

    return {"key": "internal_linking", "label": "Internal Linking",
            "score": score_from_checks(checks),
            "summary": f"{sum(outbound.values())} internal links mapped across {len(pages)} pages; "
                       f"{len(orphans)} orphans.",
            "checks": checks, "items": items}


# Required properties Google documents for its rich-result types. Only the
# genuinely required ones — flagging recommended fields as errors trains people
# to ignore the report.
SCHEMA_REQUIRED = {
    "Organization": ["name", "url"],
    "LocalBusiness": ["name", "address"],
    "Article": ["headline"],
    "BlogPosting": ["headline"],
    "NewsArticle": ["headline"],
    "Product": ["name"],
    "Service": ["name"],
    "FAQPage": ["mainEntity"],
    "BreadcrumbList": ["itemListElement"],
    "Review": ["itemReviewed"],
    "Event": ["name", "startDate", "location"],
    "Person": ["name"],
    "SoftwareApplication": ["name"],
    "JobPosting": ["title", "datePosted", "hiringOrganization"],
    "WebSite": ["name", "url"],
    "WebPage": ["name"],
}


def cat_schema(ctx: dict) -> dict:
    pages, checks = ctx["ok_pages"], []
    if not pages:
        return {"key": "schema", "label": "Schema / Structured Data", "score": None,
                "summary": "No pages could be fetched.", "checks": [], "items": []}

    with_schema = [p for p in pages if p["signals"]["schema_types"]]
    checks.append(check("schema_present", "Structured data on every page",
                        _status_of(len(with_schema) == len(pages)),
                        (f"{len(with_schema)} of {len(pages)} pages emit JSON-LD."
                         + ("" if len(with_schema) == len(pages) else " Without it Google has to infer "
                            "what the page represents and no rich result is possible.")),
                        severity="medium",
                        items=[_page_ref(p, "no JSON-LD") for p in pages
                               if not p["signals"]["schema_types"]][:50]))

    broken = [p for p in pages if p["signals"]["schema_errors"]]
    checks.append(check("schema_valid", "JSON-LD parses cleanly", _status_of(not broken),
                        f"{len(broken)} pages contain JSON-LD that is not valid JSON — a crawler "
                        f"discards the whole block." if broken else "All JSON-LD blocks parse.",
                        severity="high",
                        items=[_page_ref(p, "; ".join(p["signals"]["schema_errors"])[:100])
                               for p in broken][:50]))

    # Required-property validation, per object, per page.
    incomplete = []
    for p in pages:
        for obj in p["signals"]["schema_objects"]:
            types = obj.get("@type")
            types = types if isinstance(types, list) else [types] if types else []
            for t in types:
                required = SCHEMA_REQUIRED.get(str(t))
                if not required or obj.get("_unparsed"):
                    continue
                missing = [f for f in required if not obj.get(f)]
                if missing:
                    incomplete.append({"url": p["url"], "path": p["path"],
                                       "detail": f"{t} missing {', '.join(missing)}"})
    checks.append(check("schema_required", "Required properties present on each type",
                        _status_of(not incomplete),
                        f"{len(incomplete)} structured-data objects are missing a property Google "
                        f"requires for that type, so they will not produce a rich result."
                        if incomplete else "Every recognised type has its required properties.",
                        severity="high", items=incomplete[:50]))

    all_types = Counter(t for p in pages for t in p["signals"]["schema_types"])
    site_types = set(all_types)
    checks.append(check("org_schema", "Organization or LocalBusiness declared site-wide",
                        _status_of(bool({"Organization", "LocalBusiness", "Corporation"} & site_types)),
                        "Organization (or LocalBusiness) schema is what ties your brand to its logo, "
                        "social profiles and knowledge panel."
                        if not ({"Organization", "LocalBusiness", "Corporation"} & site_types)
                        else "Organization-level schema found.", severity="medium"))

    checks.append(check("breadcrumb_schema", "BreadcrumbList markup present",
                        _status_of("BreadcrumbList" in site_types, warn_only=True),
                        "BreadcrumbList replaces the raw URL in the search result with a readable path."
                        if "BreadcrumbList" not in site_types else "BreadcrumbList found.",
                        severity="low"))

    blog_pages = [p for p in pages if re.search(r"/blog|/news|/article|/post", p["path"])]
    unmarked_blog = [p for p in blog_pages
                     if not ({"Article", "BlogPosting", "NewsArticle"} & set(p["signals"]["schema_types"]))]
    checks.append(check("article_schema", "Blog and news pages use Article markup",
                        "info" if not blog_pages else _status_of(not unmarked_blog, warn_only=True),
                        f"{len(unmarked_blog)} of {len(blog_pages)} blog-style pages carry no Article "
                        f"or BlogPosting markup." if blog_pages
                        else "No blog-style URLs in this crawl.", severity="medium",
                        items=[_page_ref(p) for p in unmarked_blog][:50]))

    # A page whose schema claims a type unrelated to its content is worse than
    # no schema — Google treats mismatched markup as a spam signal.
    checks.append(check("schema_accuracy", "Markup matches the page's actual content",
                        "info",
                        "Schema is not scored for accuracy automatically. Review the types below "
                        "against what each page really is — a Product on a services page or an "
                        "invented Review is a manual-action risk.", severity="medium",
                        value=", ".join(f"{t} ×{n}" for t, n in all_types.most_common(12))))

    return {"key": "schema", "label": "Schema / Structured Data",
            "score": score_from_checks(checks),
            "summary": f"{len(with_schema)}/{len(pages)} pages carry JSON-LD; "
                       f"{len(all_types)} distinct types found.",
            "checks": checks,
            "items": [{"url": p["url"], "path": p["path"],
                       "types": p["signals"]["schema_types"],
                       "errors": p["signals"]["schema_errors"],
                       "microdata": p["signals"]["microdata"],
                       "objects": [{"type": o.get("@type"), "keys": sorted(k for k in o if not k.startswith("@"))[:12]}
                                   for o in p["signals"]["schema_objects"][:8]]} for p in pages],
            "type_counts": [{"type": t, "count": n} for t, n in all_types.most_common(30)]}


def cat_sitemap(ctx: dict) -> dict:
    sm, robots, checks = ctx["sitemap"], ctx["robots"], []
    pages = ctx["ok_pages"]

    checks.append(check("sitemap_exists", "XML sitemap reachable", _status_of(sm["found"]),
                        f"Found at {sm['url']} with {len(sm['urls'])} URLs." if sm["found"]
                        else f"No sitemap at any of: {', '.join(sm['tried'][:4])}. Without one, "
                             f"discovery relies entirely on internal links.",
                        severity="high", value=sm.get("url")))

    if not sm["found"]:
        return {"key": "sitemap", "label": "XML Sitemap", "score": score_from_checks(checks),
                "summary": "No sitemap found.", "checks": checks, "items": []}

    checks.append(check("sitemap_in_robots", "Sitemap advertised in robots.txt",
                        _status_of(bool(robots.get("sitemaps"))),
                        f"robots.txt lists {len(robots.get('sitemaps') or [])} sitemap(s)."
                        if robots.get("sitemaps")
                        else "robots.txt does not name the sitemap, which is the first place a crawler "
                             "looks. Add: Sitemap: " + (sm["url"] or ""), severity="medium",
                        value=", ".join(robots.get("sitemaps") or [])))

    checks.append(check("sitemap_size", "Under the 50,000-URL / 50 MB limit",
                        _status_of(len(sm["urls"]) <= 50000),
                        f"{len(sm['urls'])} URLs listed.", severity="high", value=len(sm["urls"])))

    checks.append(check("sitemap_lastmod", "lastmod dates supplied",
                        _status_of(sm["lastmod_count"] == len(sm["urls"]), warn_only=True),
                        f"{sm['lastmod_count']} of {len(sm['urls'])} entries carry a <lastmod>. "
                        f"Accurate dates help crawlers prioritise what changed.",
                        severity="low", value=f"{sm['lastmod_count']}/{len(sm['urls'])}"))

    # Everything in the sitemap must be canonical, indexable and 200. These
    # are the three ways a sitemap actively misleads a crawler.
    sm_paths = {route_path(u) for u in sm["urls"]}
    audited = {p["path"]: p for p in pages}

    noindexed = [audited[path] for path in sm_paths & set(audited) if audited[path]["signals"]["noindex"]]
    checks.append(check("sitemap_noindex", "No noindexed URL is listed", _status_of(not noindexed),
                        f"{len(noindexed)} sitemap URLs are marked noindex — you are asking Google to "
                        f"crawl pages you have told it not to index." if noindexed
                        else "No listed URL is noindexed.", severity="high",
                        items=[_page_ref(p) for p in noindexed][:50]))

    non_canonical = [audited[path] for path in sm_paths & set(audited)
                     if audited[path]["signals"]["canonical"]
                     and not audited[path]["signals"]["canonical_self"]]
    checks.append(check("sitemap_canonical", "Listed URLs are their own canonical",
                        _status_of(not non_canonical, warn_only=True),
                        f"{len(non_canonical)} listed URLs point their canonical at a different page, "
                        f"so the sitemap contradicts the page." if non_canonical
                        else "Every listed URL that was audited is self-canonical.", severity="medium",
                        items=[_page_ref(p, f"canonical → {p['signals']['canonical']}")
                               for p in non_canonical][:50]))

    redirected = [audited[path] for path in sm_paths & set(audited) if audited[path].get("redirect_chain")]
    checks.append(check("sitemap_redirects", "Listed URLs return 200, not a redirect",
                        _status_of(not redirected, warn_only=True),
                        f"{len(redirected)} listed URLs redirect. A sitemap should contain final URLs."
                        if redirected else "No listed URL redirects.", severity="medium",
                        items=[_page_ref(p, f"→ {p.get('final_url', '')}") for p in redirected][:50]))

    broken_sm = [p for p in ctx["pages"] if not p["ok"] and p["path"] in sm_paths]
    checks.append(check("sitemap_errors", "Listed URLs are all reachable",
                        _status_of(not broken_sm),
                        f"{len(broken_sm)} listed URLs could not be fetched." if broken_sm
                        else "Every audited sitemap URL responded.", severity="high",
                        items=[_page_ref(p, p.get("error") or "") for p in broken_sm][:50]))

    # Pages the crawl found by following links but that the sitemap omits.
    linked_paths = {route_path(l["href"]) for p in pages for l in p["signals"]["links"] if l["internal"]}
    missing = sorted((linked_paths & set(audited)) - sm_paths)[:50]
    checks.append(check("sitemap_coverage", "Internally linked pages are listed",
                        _status_of(not missing, warn_only=True),
                        f"{len(missing)} pages you link to internally are absent from the sitemap."
                        if missing else "Every internally linked page that was audited is listed.",
                        severity="medium",
                        items=[{"url": audited[m]["url"], "path": m, "detail": "not in sitemap"}
                               for m in missing][:50]))

    return {"key": "sitemap", "label": "XML Sitemap", "score": score_from_checks(checks),
            "summary": f"{len(sm['urls'])} URLs in {sm['url']}"
                       + (f" via {len(sm['children'])} child sitemaps" if sm["children"] else ""),
            "checks": checks,
            "sitemap_url": sm["url"], "children": sm["children"],
            "items": [{"url": e["loc"], "path": route_path(e["loc"]), "lastmod": e["lastmod"],
                       "sitemap": e["sitemap"]} for e in sm["entries"][:500]]}


def cat_robots(ctx: dict) -> dict:
    robots, checks = ctx["robots"], []
    pages = ctx["ok_pages"]

    checks.append(check("robots_exists", "robots.txt served as plain text",
                        _status_of(robots["exists"]),
                        f"Served from {robots['url']}." if robots["exists"]
                        else f"{robots.get('error') or 'Not found'}. Without robots.txt every crawler "
                             f"assumes full access, which is usually fine but leaves you no control.",
                        severity="medium", value=robots.get("status")))

    if not robots["exists"]:
        return {"key": "robots", "label": "Robots.txt", "score": score_from_checks(checks),
                "summary": "No robots.txt.", "checks": checks, "items": [], "raw": ""}

    blanket = []
    for group in robots["groups"]:
        if any(a == "*" for a in group["agents"]) and "/" in group["disallow"]:
            blanket.append("User-agent: * Disallow: /")
    checks.append(check("robots_not_blocking_site", "Site is not blocked wholesale",
                        _status_of(not blanket),
                        "robots.txt disallows the entire site for all crawlers — nothing can be indexed."
                        if blanket else "No blanket disallow.", severity="high"))

    blocked = []
    for p in pages:
        rule = robots_blocks(robots, p["path"])
        if rule:
            blocked.append(_page_ref(p, f"blocked by Disallow: {rule}"))
    checks.append(check("robots_pages_allowed", "No audited page is disallowed",
                        _status_of(not blocked),
                        f"{len(blocked)} audited pages are blocked by a Disallow rule." if blocked
                        else "Every audited page is crawlable.", severity="high", items=blocked[:50]))

    # Blocking CSS/JS stops Google rendering the page as a user sees it, which
    # then breaks its mobile-friendliness and layout assessment.
    asset_blocks = []
    for group in robots["groups"]:
        for rule in group["disallow"]:
            if re.search(r"\.(css|js)$|/_next/|/assets|/static", rule or "", re.I):
                asset_blocks.append(f"{', '.join(group['agents'])} → Disallow: {rule}")
    checks.append(check("robots_assets", "CSS and JS are not blocked",
                        _status_of(not asset_blocks),
                        "Blocking stylesheets or scripts stops Google rendering the page, which "
                        "distorts everything it concludes about layout and mobile usability."
                        if asset_blocks else "No asset directories are disallowed.",
                        severity="high", value="; ".join(asset_blocks[:5])))

    checks.append(check("robots_sitemap", "Sitemap directive present",
                        _status_of(bool(robots["sitemaps"])),
                        f"{len(robots['sitemaps'])} sitemap(s) advertised." if robots["sitemaps"]
                        else "Add a Sitemap: line so crawlers find your sitemap without guessing.",
                        severity="medium", value=", ".join(robots["sitemaps"])))

    has_noindex_directive = re.search(r"^\s*noindex\s*:", robots["raw"], re.I | re.M)
    checks.append(check("robots_no_noindex", "No unsupported Noindex directive",
                        _status_of(not has_noindex_directive),
                        "robots.txt contains a Noindex: line. Google has not supported that since 2019 "
                        "— use a robots meta tag or X-Robots-Tag header instead."
                        if has_noindex_directive
                        else "No unsupported directives. Remember robots.txt controls crawling, not "
                             "indexing — a blocked URL can still appear in results.",
                        severity="medium"))

    return {"key": "robots", "label": "Robots.txt", "score": score_from_checks(checks),
            "summary": f"{len(robots['groups'])} user-agent group(s), "
                       f"{sum(len(g['disallow']) for g in robots['groups'])} disallow rule(s).",
            "checks": checks, "raw": robots["raw"], "robots_url": robots["url"],
            "sitemaps": robots["sitemaps"],
            "items": [{"path": "; ".join(g["agents"]), "url": robots["url"],
                       "detail": f"{len(g['allow'])} allow / {len(g['disallow'])} disallow",
                       "allow": g["allow"], "disallow": g["disallow"],
                       "crawl_delay": g["crawl_delay"]} for g in robots["groups"]]}


def cat_canonical(ctx: dict) -> dict:
    pages, checks = ctx["ok_pages"], []
    if not pages:
        return {"key": "canonical", "label": "Canonical URLs", "score": None,
                "summary": "No pages could be fetched.", "checks": [], "items": []}

    missing = [p for p in pages if not p["signals"]["canonical"]]
    checks.append(check("canonical_present", "Every page declares a canonical",
                        _status_of(not missing),
                        f"{len(missing)} pages have no canonical link. Without one, any URL variant "
                        f"(query strings, trailing slash, http) can be indexed separately."
                        if missing else "Every page declares a canonical URL.", severity="medium",
                        items=[_page_ref(p) for p in missing][:50]))

    cross = [p for p in pages if p["signals"]["canonical"] and not p["signals"]["canonical_self"]]
    checks.append(check("canonical_self", "Canonicals are self-referencing",
                        _status_of(not cross, warn_only=True),
                        f"{len(cross)} pages point their canonical at a different URL. That is correct "
                        f"for a deliberate duplicate and a serious mistake otherwise — it asks Google "
                        f"to drop the page." if cross else "Every canonical points at its own URL.",
                        severity="high",
                        items=[_page_ref(p, f"→ {p['signals']['canonical']}") for p in cross][:50]))

    groups = defaultdict(list)
    for p in pages:
        if p["signals"]["canonical"]:
            groups[p["signals"]["canonical"].rstrip("/")].append(p)
    collisions = {c: ps for c, ps in groups.items() if len(ps) > 1}
    checks.append(check("canonical_unique", "No two pages share a canonical",
                        _status_of(not collisions),
                        f"{len(collisions)} canonical URL(s) are claimed by more than one page, which "
                        f"consolidates pages you may not have meant to merge." if collisions
                        else "Each canonical is claimed once.", severity="high",
                        items=[{"url": ps[0]["url"], "path": ", ".join(x["path"] for x in ps),
                                "detail": f"{len(ps)} pages → {c}"} for c, ps in collisions.items()][:30]))

    base_scheme = urlparse(ctx["base"]).scheme
    wrong_scheme = [p for p in pages if p["signals"]["canonical"]
                    and urlparse(p["signals"]["canonical"]).scheme != base_scheme]
    checks.append(check("canonical_scheme", "Canonicals use the live scheme and host",
                        _status_of(not wrong_scheme),
                        f"{len(wrong_scheme)} canonicals use a different scheme from the live site."
                        if wrong_scheme else "All canonicals match the live scheme.", severity="high",
                        items=[_page_ref(p, p["signals"]["canonical"]) for p in wrong_scheme][:50]))

    wrong_host = [p for p in pages if p["signals"]["canonical"]
                  and not same_host(p["signals"]["canonical"], p["url"])]
    checks.append(check("canonical_host", "Canonicals stay on this domain",
                        _status_of(not wrong_host),
                        f"{len(wrong_host)} canonicals point at another domain — those pages are "
                        f"handing their rankings away." if wrong_host
                        else "No canonical points off-domain.", severity="high",
                        items=[_page_ref(p, p["signals"]["canonical"]) for p in wrong_host][:50]))

    # A trailing-slash mismatch between the URL and its own canonical creates
    # exactly the duplicate the canonical was meant to prevent.
    slash_mismatch = [p for p in pages if p["signals"]["canonical"]
                      and p["signals"]["canonical_self"]
                      and (p["signals"]["canonical"].rstrip("/") != p.get("final_url", p["url"]).rstrip("/"))]
    checks.append(check("canonical_trailing_slash", "Canonical matches the served URL exactly",
                        _status_of(not slash_mismatch, warn_only=True),
                        f"{len(slash_mismatch)} pages declare a canonical that differs from the URL "
                        f"actually served (usually a trailing slash)." if slash_mismatch
                        else "Canonicals match the served URLs.", severity="low",
                        items=[_page_ref(p, f"served {p.get('final_url', p['url'])} vs canonical "
                                            f"{p['signals']['canonical']}") for p in slash_mismatch][:50]))

    return {"key": "canonical", "label": "Canonical URLs", "score": score_from_checks(checks),
            "summary": f"{len(pages) - len(missing)}/{len(pages)} pages canonicalised, "
                       f"{len(cross)} pointing elsewhere.",
            "checks": checks,
            "items": [{"url": p["url"], "path": p["path"], "canonical": p["signals"]["canonical"],
                       "self_referencing": p["signals"]["canonical_self"],
                       "final_url": p.get("final_url")} for p in pages]}


def cat_indexing(ctx: dict) -> dict:
    pages, checks = ctx["ok_pages"], []
    robots = ctx["robots"]
    if not pages:
        return {"key": "indexing", "label": "Indexing & Crawling", "score": None,
                "summary": "No pages could be fetched.", "checks": [], "items": []}

    noindexed = [p for p in pages if p["signals"]["noindex"]]
    indexable = [p for p in pages if not p["signals"]["noindex"]
                 and not robots_blocks(robots, p["path"])]
    checks.append(check("indexable_count", "Pages are indexable",
                        _status_of(len(indexable) == len(pages), warn_only=bool(noindexed)),
                        f"{len(indexable)} of {len(pages)} audited pages are indexable. Noindex is "
                        f"correct for thank-you pages, internal search results and utility pages — "
                        f"check the list below is deliberate.", severity="high",
                        value=f"{len(indexable)}/{len(pages)}",
                        items=[_page_ref(p, f"noindex via {'X-Robots-Tag header' if p['signals']['x_robots_tag'] else 'meta robots'}")
                               for p in noindexed][:50]))

    # noindex + Disallow is self-defeating: Google cannot read the noindex on
    # a page it is forbidden to fetch, so the URL can linger in the index.
    conflict = [p for p in pages if p["signals"]["noindex"] and robots_blocks(robots, p["path"])]
    checks.append(check("noindex_conflict", "No page is both noindexed and disallowed",
                        _status_of(not conflict),
                        f"{len(conflict)} pages carry noindex but are also blocked in robots.txt. "
                        f"Google never reads the noindex, so the URL can stay indexed indefinitely — "
                        f"allow crawling and keep the noindex." if conflict
                        else "No noindex/disallow conflicts.", severity="high",
                        items=conflict and [_page_ref(p) for p in conflict][:50] or []))

    nofollow = [p for p in pages if p["signals"]["nofollow_page"]]
    checks.append(check("page_nofollow", "No page-level nofollow", _status_of(not nofollow),
                        f"{len(nofollow)} pages tell crawlers not to follow any link on them, cutting "
                        f"off discovery of everything downstream." if nofollow
                        else "No page-level nofollow directives.", severity="high",
                        items=[_page_ref(p) for p in nofollow][:50]))

    canonical_conflict = [p for p in pages if p["signals"]["noindex"]
                          and p["signals"]["canonical"] and p["signals"]["canonical_self"]]
    checks.append(check("canonical_noindex_conflict", "Self-canonical pages are not noindexed",
                        _status_of(not canonical_conflict, warn_only=True),
                        f"{len(canonical_conflict)} pages say 'index this URL' via a self-canonical and "
                        f"'do not index' via meta robots. Google resolves the contradiction itself, "
                        f"often not the way you intended." if canonical_conflict
                        else "No canonical/noindex contradictions.", severity="medium",
                        items=[_page_ref(p) for p in canonical_conflict][:50]))

    sm = ctx["sitemap"]
    checks.append(check("discovery_route", "Crawlers have a discovery route",
                        _status_of(sm["found"] or any(p["signals"]["internal_links"] for p in pages)),
                        f"Sitemap: {'yes' if sm['found'] else 'no'}. "
                        f"Internal links found on {sum(1 for p in pages if p['signals']['internal_links'])} "
                        f"pages.", severity="medium"))

    gsc = ctx.get("gsc") or {}
    if gsc.get("connected"):
        checks.append(check("gsc_indexed", "Search Console confirms indexed pages", "pass",
                            f"Search Console reports {gsc.get('indexed_count', 0)} URLs with impressions "
                            f"in the last 28 days.", severity="low", value=gsc.get("indexed_count")))
    else:
        checks.append(check("gsc_indexed", "Search Console connected for real index status", "info",
                            "Only Google can confirm what is actually indexed. Connect Search Console "
                            "in Settings to replace this inference with live coverage data.",
                            severity="low"))

    return {"key": "indexing", "label": "Indexing & Crawling", "score": score_from_checks(checks),
            "summary": f"{len(indexable)}/{len(pages)} audited pages indexable.",
            "checks": checks,
            "items": [{"url": p["url"], "path": p["path"],
                       "noindex": p["signals"]["noindex"],
                       "robots_meta": p["signals"]["robots_meta"],
                       "x_robots_tag": p["signals"]["x_robots_tag"],
                       "robots_txt_rule": robots_blocks(robots, p["path"]),
                       "canonical": p["signals"]["canonical"],
                       "in_sitemap": p["path"] in {route_path(u) for u in sm["urls"]}} for p in pages]}


def cat_redirects(ctx: dict) -> dict:
    all_pages, checks = ctx["pages"], []
    pages = ctx["ok_pages"]

    chained = [p for p in all_pages if len(p.get("redirect_chain") or []) > 1]
    single = [p for p in all_pages if len(p.get("redirect_chain") or []) == 1]
    checks.append(check("redirect_chains", "No redirect chains",
                        _status_of(not chained),
                        f"{len(chained)} URLs redirect more than once before resolving. Each hop costs "
                        f"latency and a little link equity — point the first URL at the final one."
                        if chained else f"{len(single)} single redirects, no chains.", severity="medium",
                        items=[{"url": p["url"], "path": p["path"],
                                "detail": " → ".join(f"{h['status']}" for h in p["redirect_chain"])
                                          + f" → {p.get('final_url', '')}"} for p in chained][:50]))

    temp = [p for p in all_pages
            if any(h["status"] in (302, 303, 307) for h in (p.get("redirect_chain") or []))]
    checks.append(check("permanent_redirects", "Permanent moves use 301/308",
                        _status_of(not temp, warn_only=True),
                        f"{len(temp)} URLs use a temporary redirect. A 302 tells Google to keep the old "
                        f"URL indexed, so a permanent move should be 301." if temp
                        else "No temporary redirects on the audited URLs.", severity="medium",
                        items=[{"url": p["url"], "path": p["path"],
                                "detail": ", ".join(str(h["status"]) for h in p["redirect_chain"])}
                               for p in temp][:50]))

    not_found = [p for p in all_pages if p.get("status_code") == 404]
    checks.append(check("no_404s", "No audited URL returns 404", _status_of(not not_found),
                        f"{len(not_found)} URLs return 404. If they used to exist, 301 them to the "
                        f"closest live page rather than leaving them dead." if not_found
                        else "No 404s among the audited URLs.", severity="high",
                        items=[_page_ref(p, "404") for p in not_found][:50]))

    server_err = [p for p in all_pages if (p.get("status_code") or 0) >= 500]
    checks.append(check("no_5xx", "No server errors", _status_of(not server_err),
                        f"{len(server_err)} URLs return a 5xx." if server_err
                        else "No server errors.", severity="high",
                        items=[_page_ref(p, str(p.get("status_code"))) for p in server_err][:50]))

    https_state = ctx.get("https") or {}
    checks.append(check("http_to_https", "http:// redirects to https://",
                        _status_of(bool(https_state.get("redirects_to_https"))),
                        f"http://{urlparse(ctx['base']).netloc} → {https_state.get('final_url')}"
                        if https_state.get("redirects_to_https")
                        else f"The http:// origin does not end up on https:// "
                             f"({https_state.get('error') or https_state.get('final_url')}). That leaves "
                             f"two crawlable copies of every page.", severity="high"))

    # A trailing-slash inconsistency is the redirect problem people notice
    # last and that costs the most crawl budget.
    with_slash = sum(1 for p in pages if p.get("final_url", "").rstrip("?").endswith("/"))
    without = len(pages) - with_slash
    checks.append(check("slash_consistency", "Trailing slashes are consistent",
                        _status_of(with_slash == 0 or without <= 1, warn_only=True),
                        f"{with_slash} served URLs end in a slash and {without} do not. Pick one form "
                        f"and 301 the other, or both get crawled.", severity="low",
                        value=f"{with_slash} with / {without} without"))

    redirect_items = [{"url": p["url"], "path": p["path"], "status": p.get("status_code"),
                       "final_url": p.get("final_url"),
                       "hops": len(p.get("redirect_chain") or []),
                       "chain": p.get("redirect_chain") or [],
                       "error": p.get("error")}
                      for p in all_pages if (p.get("redirect_chain") or []) or not p["ok"]]

    return {"key": "redirects", "label": "URL & Redirect Management",
            "score": score_from_checks(checks),
            "summary": f"{len(single) + len(chained)} redirecting URLs, {len(chained)} chains, "
                       f"{len(not_found)} 404s.",
            "checks": checks, "items": redirect_items}


# Core Web Vitals thresholds as Google publishes them: (good, needs-work).
CWV_THRESHOLDS = {
    "lcp": (2500, 4000),      # ms
    "inp": (200, 500),        # ms
    "cls": (0.1, 0.25),       # unitless
    "fcp": (1800, 3000),      # ms
    "ttfb": (800, 1800),      # ms
    "tbt": (200, 600),        # ms — lab proxy for INP
}


def _cwv_band(metric: str, value) -> str:
    if value is None:
        return "unknown"
    good, poor = CWV_THRESHOLDS[metric]
    return "good" if value <= good else ("needs-improvement" if value <= poor else "poor")


def cat_performance(ctx: dict) -> dict:
    psi = [r for r in (ctx.get("psi") or [])]
    ok_psi = [r for r in psi if r.get("ok")]
    checks: list[dict] = []
    pages = ctx["ok_pages"]

    if not psi:
        checks.append(check("psi_not_run", "PageSpeed Insights measurement", "info",
                            "Core Web Vitals were not measured in this run. Enable 'Measure Core Web "
                            "Vitals' before auditing — each URL takes 20–40 seconds, so only a sample "
                            "is measured.", severity="medium"))
    elif not ok_psi:
        checks.append(check("psi_failed", "PageSpeed Insights reachable", "warn",
                            "; ".join(dict.fromkeys(r.get("error", "") for r in psi))[:400],
                            severity="medium"))

    mobile = [r for r in ok_psi if r["strategy"] == "mobile"]
    desktop = [r for r in ok_psi if r["strategy"] == "desktop"]

    if mobile:
        scores = [r["performance_score"] for r in mobile if r["performance_score"] is not None]
        avg = round(sum(scores) / len(scores)) if scores else None
        checks.append(check("perf_score_mobile", "Mobile performance score 90+",
                            _status_of((avg or 0) >= 90, warn_only=(avg or 0) >= 50),
                            f"Average Lighthouse mobile performance {avg} across {len(mobile)} sampled "
                            f"URLs. Mobile is the score that matters — Google indexes mobile-first.",
                            severity="high", value=avg,
                            items=[{"url": r["url"], "path": route_path(r["url"]),
                                    "detail": f"{r['performance_score']}/100"} for r in mobile]))

        for metric, label, unit in (("lcp", "Largest Contentful Paint", "ms"),
                                    ("cls", "Cumulative Layout Shift", ""),
                                    ("tbt", "Total Blocking Time (INP proxy)", "ms")):
            key = f"{metric}_ms" if unit else metric
            vals = [r["lab"].get(key) for r in mobile if r["lab"].get(key) is not None]
            if not vals:
                continue
            worst = max(vals)
            band = _cwv_band(metric, worst)
            checks.append(check(f"cwv_{metric}", f"{label} in the good band",
                                "pass" if band == "good" else ("warn" if band == "needs-improvement" else "fail"),
                                f"Worst sampled value {round(worst, 3)}{unit} — {band}. Google's good "
                                f"threshold is {CWV_THRESHOLDS[metric][0]}{unit}.",
                                severity="high" if metric in ("lcp", "cls") else "medium",
                                value=round(worst, 3)))

        field_rows = [r for r in mobile if (r.get("field") or {}).get("overall")]
        if field_rows:
            worst_overall = sorted(field_rows,
                                   key=lambda r: {"FAST": 0, "AVERAGE": 1, "SLOW": 2}.get(r["field"]["overall"], 3))[-1]
            checks.append(check("cwv_field", "Real-user Core Web Vitals pass",
                                "pass" if worst_overall["field"]["overall"] == "FAST"
                                else ("warn" if worst_overall["field"]["overall"] == "AVERAGE" else "fail"),
                                f"Chrome real-user data rates the worst sampled URL "
                                f"{worst_overall['field']['overall']}. Field data is what the Core Web "
                                f"Vitals report in Search Console uses.", severity="high",
                                value=worst_overall["field"]["overall"]))
        else:
            checks.append(check("cwv_field", "Real-user Core Web Vitals available", "info",
                                "Chrome has no real-user (CrUX) data for these URLs yet — that needs "
                                "enough traffic. Lab scores above are the best available proxy.",
                                severity="low"))

    if desktop:
        scores = [r["performance_score"] for r in desktop if r["performance_score"] is not None]
        avg = round(sum(scores) / len(scores)) if scores else None
        checks.append(check("perf_score_desktop", "Desktop performance score 90+",
                            _status_of((avg or 0) >= 90, warn_only=(avg or 0) >= 50),
                            f"Average Lighthouse desktop performance {avg}.", severity="medium",
                            value=avg))

    slow_ttfb = [p for p in pages if (p.get("elapsed_ms") or 0) > 800]
    checks.append(check("ttfb_crawl", "Time to first byte under 800 ms",
                        _status_of(not slow_ttfb, warn_only=True),
                        (f"{len(slow_ttfb)} of {len(pages)} pages took over 800 ms to respond during "
                         f"the crawl. Caching and a CDN are the usual fixes." if slow_ttfb
                         else f"All {len(pages)} pages responded in under 800 ms."), severity="medium",
                        items=[_page_ref(p, f"{p['elapsed_ms']} ms") for p in slow_ttfb][:50]))

    cdn_headers = ctx.get("home_headers") or {}
    cdn = next((v for k, v in cdn_headers.items()
                if k in ("cf-cache-status", "x-vercel-cache", "x-cache", "x-nextjs-cache",
                         "x-litespeed-cache", "x-served-by")), "")
    checks.append(check("cdn_or_cache", "Served through a cache or CDN",
                        _status_of(bool(cdn), warn_only=True),
                        f"Cache header found: {cdn}." if cdn
                        else "No CDN or cache header on the homepage response. A CDN cuts latency for "
                             "visitors far from your origin.", severity="low", value=cdn or "none"))

    opportunities: list[dict] = []
    for r in ok_psi:
        for opp in r.get("opportunities", []):
            opportunities.append({**opp, "url": r["url"], "strategy": r["strategy"]})
    opportunities.sort(key=lambda o: -o["savings_ms"])

    return {"key": "performance", "label": "Page Speed & Core Web Vitals",
            "score": score_from_checks(checks),
            "summary": (f"{len(ok_psi)} PageSpeed measurements" if ok_psi
                        else "Crawl-time response measured; PageSpeed not run."),
            "checks": checks,
            "opportunities": opportunities[:20],
            "items": [{"url": r["url"], "path": route_path(r["url"]), "strategy": r["strategy"],
                       "performance_score": r["performance_score"], "seo_score": r["seo_score"],
                       "accessibility_score": r["accessibility_score"],
                       "best_practices_score": r["best_practices_score"],
                       "lab": r["lab"], "field": r["field"],
                       "bands": {m: _cwv_band(m, r["lab"].get(f"{m}_ms" if m != "cls" else "cls"))
                                 for m in ("lcp", "cls", "tbt", "fcp", "ttfb")}}
                      for r in ok_psi]}


def cat_mobile(ctx: dict) -> dict:
    pages, checks = ctx["ok_pages"], []
    psi_mobile = [r for r in (ctx.get("psi") or []) if r.get("ok") and r["strategy"] == "mobile"]

    no_viewport = [p for p in pages if not p["signals"]["viewport"]]
    checks.append(check("viewport_present", "Viewport meta tag on every page",
                        _status_of(not no_viewport),
                        f"{len(no_viewport)} pages have no viewport tag." if no_viewport
                        else "Every page declares a viewport.", severity="high",
                        items=[_page_ref(p) for p in no_viewport][:50]))

    bad_viewport = [p for p in pages if p["signals"]["viewport"]
                    and ("user-scalable=no" in p["signals"]["viewport"].replace(" ", "")
                         or "maximum-scale=1" in p["signals"]["viewport"].replace(" ", ""))]
    checks.append(check("viewport_zoomable", "Pinch-zoom is not disabled",
                        _status_of(not bad_viewport),
                        f"{len(bad_viewport)} pages block zooming, which fails accessibility and "
                        f"annoys users on small screens." if bad_viewport
                        else "No page blocks pinch-zoom.", severity="medium",
                        items=[_page_ref(p, p["signals"]["viewport"]) for p in bad_viewport][:50]))

    width_device = [p for p in pages if p["signals"]["viewport"]
                    and "width=device-width" not in p["signals"]["viewport"].replace(" ", "")]
    checks.append(check("viewport_device_width", "Viewport uses width=device-width",
                        _status_of(not width_device),
                        f"{len(width_device)} pages set a fixed viewport width instead of "
                        f"width=device-width." if width_device
                        else "All viewports use width=device-width.", severity="high",
                        items=[_page_ref(p, p["signals"]["viewport"]) for p in width_device][:50]))

    responsive_imgs = sum(1 for p in pages for i in p["signals"]["images"] if i["srcset"])
    total_imgs = sum(p["signals"]["image_count"] for p in pages)
    checks.append(check("responsive_images_mobile", "Images adapt to screen width",
                        "pass" if total_imgs and responsive_imgs >= total_imgs / 3 else
                        ("info" if not total_imgs else "warn"),
                        f"{responsive_imgs} of {total_imgs} images declare a srcset, so phones do not "
                        f"download desktop-sized files.", severity="medium",
                        value=f"{responsive_imgs}/{total_imgs}"))

    # PSI's own mobile-usability audits: font size, tap targets, content width.
    if psi_mobile:
        for aid, label, sev in (("font-size", "Legible font sizes", "medium"),
                                ("tap-targets", "Tap targets are big enough", "medium"),
                                ("content-width", "Content fits the viewport width", "high"),
                                ("plugins", "No mobile-incompatible plugins", "low")):
            rows = [r["mobile_audits"].get(aid) for r in psi_mobile if r["mobile_audits"].get(aid)]
            if not rows:
                continue
            worst = min((r["score"] if r["score"] is not None else 1) for r in rows)
            checks.append(check(f"psi_{aid.replace('-', '_')}", label,
                                "pass" if worst >= 0.9 else ("warn" if worst >= 0.5 else "fail"),
                                rows[0].get("description") or rows[0].get("title") or label,
                                severity=sev, value=rows[0].get("display")))
        scores = [r["performance_score"] for r in psi_mobile if r["performance_score"] is not None]
        if scores:
            avg = round(sum(scores) / len(scores))
            checks.append(check("mobile_speed", "Mobile page speed 90+",
                                _status_of(avg >= 90, warn_only=avg >= 50),
                                f"Average mobile Lighthouse performance {avg}. Mobile speed is a "
                                f"ranking factor in the mobile-first index.", severity="high",
                                value=avg))
    else:
        checks.append(check("psi_mobile_missing", "Mobile usability measured by Lighthouse", "info",
                            "Enable 'Measure Core Web Vitals' to add Lighthouse's font-size, "
                            "tap-target and content-width audits to this section.", severity="low"))

    checks.append(check("manual_mobile_review", "Manual review on a real device", "info",
                        "Automated checks cannot judge navigation, popups or form usability on a phone. "
                        "Open the lowest-scoring pages on a real device before signing this off.",
                        severity="low"))

    return {"key": "mobile", "label": "Mobile SEO", "score": score_from_checks(checks),
            "summary": f"{len(pages) - len(no_viewport)}/{len(pages)} pages mobile-ready by markup"
                       + (f"; Lighthouse mobile data for {len(psi_mobile)} URLs" if psi_mobile else ""),
            "checks": checks,
            "items": [{"url": p["url"], "path": p["path"], "viewport": p["signals"]["viewport"],
                       "responsive_images": sum(1 for i in p["signals"]["images"] if i["srcset"]),
                       "image_count": p["signals"]["image_count"]} for p in pages]}


def cat_local(ctx: dict) -> dict:
    pages, checks = ctx["ok_pages"], []
    if not pages:
        return {"key": "local", "label": "Local SEO", "score": None,
                "summary": "No pages could be fetched.", "checks": [], "items": []}

    all_types = {t for p in pages for t in p["signals"]["schema_types"]}
    local_schema = bool({"LocalBusiness", "Organization", "ProfessionalService", "Corporation"} & all_types)
    checks.append(check("local_schema", "LocalBusiness or Organization schema present",
                        _status_of(local_schema),
                        "Found: " + ", ".join(sorted({"LocalBusiness", "Organization",
                                                      "ProfessionalService", "Corporation"} & all_types))
                        if local_schema else
                        "No business schema found. LocalBusiness markup carrying your name, address, "
                        "phone and opening hours is what feeds the local pack and knowledge panel.",
                        severity="high"))

    # Address is checked from the schema first (structured, unambiguous) and
    # from visible text second.
    address_objs = [o for p in pages for o in p["signals"]["schema_objects"]
                    if o.get("address") or o.get("@type") == "PostalAddress"]
    checks.append(check("nap_address", "Address published in structured data",
                        _status_of(bool(address_objs), warn_only=True),
                        f"{len(address_objs)} schema object(s) carry a postal address." if address_objs
                        else "No address in structured data. Add PostalAddress to your "
                             "LocalBusiness/Organization schema.", severity="medium"))

    # A tel: link is the reliable signal; loose text matches are noisy (prices
    # and dates look like phone numbers), so consistency is judged on tel:
    # links alone and the text scan only answers "is a number visible at all".
    phone_pages = [p for p in pages if p["signals"]["phones"]]
    linked = Counter(re.sub(r"\D", "", t) for p in pages for t in p["signals"].get("tel_links", []))
    distinct = [n for n in linked if len(n) >= 8]
    checks.append(check("nap_phone", "Phone number visible and click-to-call",
                        "pass" if linked else ("warn" if phone_pages else "fail"),
                        (f"{len(linked)} distinct tel: link(s) across {len(phone_pages)} pages — "
                         f"tappable on mobile." if linked else
                         "A number appears in the copy but is not a tel: link, so mobile visitors "
                         "cannot tap to call." if phone_pages else
                         "No phone number found on the audited pages. Local searchers expect one in "
                         "the header or footer of every page — and if your contact page was outside "
                         "this crawl's page limit, raise the limit and re-run before acting on this."),
                        severity="medium", value=", ".join(sorted(linked)[:5]),
                        items=[_page_ref(p, ", ".join(p["signals"].get("tel_links", [])[:3]))
                               for p in pages if p["signals"].get("tel_links")][:30]))

    # NAP consistency: several different numbers across the site is the single
    # most common local-SEO defect, and it is invisible until you count them.
    checks.append(check("nap_consistency", "One consistent phone number site-wide",
                        "info" if not distinct else
                        _status_of(len(distinct) == 1, warn_only=len(distinct) == 2),
                        f"{len(distinct)} distinct phone numbers are linked across the audited pages. "
                        f"Inconsistent NAP data splits your local signals — pick one primary number."
                        if len(distinct) > 1 else
                        "The same number is linked throughout." if distinct else
                        "No linked phone number to compare.", severity="medium",
                        value=", ".join(sorted(distinct)[:5])))

    geo = any(o.get("geo") for p in pages for o in p["signals"]["schema_objects"])
    checks.append(check("geo_coordinates", "Geo coordinates in schema",
                        _status_of(geo, warn_only=True),
                        "GeoCoordinates in your LocalBusiness schema pin the business precisely."
                        if not geo else "Geo coordinates found.", severity="low"))

    hours = any(o.get("openingHours") or o.get("openingHoursSpecification")
                for p in pages for o in p["signals"]["schema_objects"])
    checks.append(check("opening_hours", "Opening hours in schema",
                        _status_of(hours, warn_only=True),
                        "Opening hours let Google show 'Open now' on your result."
                        if not hours else "Opening hours found.", severity="low"))

    maps = [p for p in pages if p["signals"]["has_map_embed"]]
    checks.append(check("map_embed", "Map embed on a contact or location page",
                        _status_of(bool(maps), warn_only=True),
                        f"A map embed appears on {len(maps)} page(s)." if maps
                        else "No map embed found — a Google Maps embed on the contact page reinforces "
                             "the location.", severity="low",
                        items=[_page_ref(p) for p in maps][:20]))

    gbp = any(re.search(r"google\.com/maps/place|g\.page|business\.google\.com", l["href"], re.I)
              for p in pages for l in p["signals"]["links"])
    checks.append(check("gbp_link", "Google Business Profile linked",
                        _status_of(gbp, warn_only=True),
                        "A link to your Google Business Profile (or a g.page short link) connects the "
                        "site to the listing." if not gbp else "Business Profile link found.",
                        severity="low"))

    # Location pages: judged only if the site looks like it targets locations.
    location_pages = [p for p in pages
                      if re.search(r"/(locations?|areas?-we-serve|[a-z-]+-(?:uae|dubai|abu-dhabi|"
                                   r"saudi|india|usa|uk|london|city))(/|$)", p["path"], re.I)]
    checks.append(check("location_pages", "Dedicated location pages exist",
                        "pass" if location_pages else "info",
                        f"{len(location_pages)} location-style pages found in this crawl. If you serve "
                        f"specific cities, one substantive page per city outranks a single page listing "
                        f"them all.", severity="low",
                        items=[_page_ref(p) for p in location_pages][:30]))

    checks.append(check("reviews_citations", "Reviews and directory citations", "info",
                        "Review volume and NAP consistency across external directories cannot be read "
                        "from your own HTML. Track those in Local Citations, and never mark up reviews "
                        "you have not actually received.", severity="low"))

    return {"key": "local", "label": "Local SEO", "score": score_from_checks(checks),
            "summary": ("Business schema present" if local_schema else "No business schema")
                       + f"; {len(distinct)} distinct phone number(s).",
            "checks": checks,
            "items": [{"url": p["url"], "path": p["path"], "phones": p["signals"]["phones"],
                       "emails": p["signals"]["emails"], "map": p["signals"]["has_map_embed"],
                       "types": [t for t in p["signals"]["schema_types"]
                                 if t in ("LocalBusiness", "Organization", "PostalAddress",
                                          "ProfessionalService", "Corporation")]}
                      for p in pages if p["signals"]["phones"] or p["signals"]["has_map_embed"]]}


def cat_social(ctx: dict) -> dict:
    pages, checks = ctx["ok_pages"], []
    if not pages:
        return {"key": "social", "label": "Social Sharing / Open Graph", "score": None,
                "summary": "No pages could be fetched.", "checks": [], "items": []}

    for field, label, sev in (("og_title", "og:title", "high"),
                              ("og_description", "og:description", "high"),
                              ("og_image", "og:image", "high"),
                              ("og_url", "og:url", "medium"),
                              ("og_type", "og:type", "low"),
                              ("og_site_name", "og:site_name", "low")):
        missing = [p for p in pages if not p["signals"][field]]
        checks.append(check(f"has_{field}", f"{label} set on every page",
                            _status_of(not missing, warn_only=sev == "low"),
                            f"{len(missing)} of {len(pages)} pages are missing {label}."
                            + (" Without it LinkedIn and Facebook invent a preview from whatever they "
                               "find first." if field == "og_image" and missing else ""),
                            severity=sev, items=[_page_ref(p) for p in missing][:50]))

    no_twitter = [p for p in pages if not p["signals"]["twitter_card"]]
    checks.append(check("twitter_card", "twitter:card declared",
                        _status_of(not no_twitter, warn_only=True),
                        f"{len(no_twitter)} pages have no twitter:card. Use summary_large_image so the "
                        f"preview shows a full-width image.", severity="medium",
                        items=[_page_ref(p) for p in no_twitter][:50]))

    small_card = [p for p in pages if p["signals"]["twitter_card"]
                  and p["signals"]["twitter_card"] != "summary_large_image"]
    checks.append(check("twitter_large", "twitter:card is summary_large_image",
                        _status_of(not small_card, warn_only=True),
                        f"{len(small_card)} pages use the small card variant.", severity="low",
                        items=[_page_ref(p, p["signals"]["twitter_card"]) for p in small_card][:50]))

    # An og:image that 404s or is not absolute silently produces a blank
    # preview, which is indistinguishable from having no tag at all.
    relative = [p for p in pages if p["signals"]["og_image"]
                and not p["signals"]["og_image"].startswith(("http://", "https://"))]
    checks.append(check("og_image_absolute", "og:image is an absolute URL",
                        _status_of(not relative),
                        f"{len(relative)} pages give a relative og:image path. Crawlers do not resolve "
                        f"those, so the preview comes out blank." if relative
                        else "All og:image values are absolute URLs.", severity="high",
                        items=[_page_ref(p, p["signals"]["og_image"]) for p in relative][:50]))

    og_checks = ctx.get("og_image_checks") or {}
    broken_og = [(p, og_checks[p["signals"]["og_image"]]) for p in pages
                 if p["signals"]["og_image"] in og_checks
                 and not og_checks[p["signals"]["og_image"]]["ok"]]
    if og_checks:
        checks.append(check("og_image_loads", "og:image actually loads",
                            _status_of(not broken_og),
                            f"{len(broken_og)} pages reference an og:image that does not load."
                            if broken_og else f"All {len(og_checks)} distinct og:image URLs load.",
                            severity="high",
                            items=[_page_ref(p, r.get("error") or "") for p, r in broken_og][:50]))

    mismatch = [p for p in pages if p["signals"]["og_title"] and p["signals"]["title"]
                and p["signals"]["og_title"].strip().lower() not in p["signals"]["title"].strip().lower()
                and p["signals"]["title"].strip().lower() not in p["signals"]["og_title"].strip().lower()]
    checks.append(check("og_title_alignment", "og:title reflects the page title",
                        _status_of(not mismatch, warn_only=True),
                        f"{len(mismatch)} pages share a social title that has nothing in common with "
                        f"their SEO title. That is fine when deliberate (social copy can be punchier) "
                        f"and a bug otherwise.", severity="low",
                        items=[_page_ref(p, f"og “{p['signals']['og_title'][:50]}” vs title "
                                            f"“{p['signals']['title'][:50]}”") for p in mismatch][:50]))

    return {"key": "social", "label": "Social Sharing / Open Graph",
            "score": score_from_checks(checks),
            "summary": f"{sum(1 for p in pages if p['signals']['og_title'] and p['signals']['og_description'] and p['signals']['og_image'])}"
                       f"/{len(pages)} pages have a complete Open Graph set.",
            "checks": checks,
            "items": [{"url": p["url"], "path": p["path"],
                       "og_title": p["signals"]["og_title"],
                       "og_description": p["signals"]["og_description"],
                       "og_image": p["signals"]["og_image"],
                       "og_type": p["signals"]["og_type"],
                       "twitter_card": p["signals"]["twitter_card"],
                       "twitter_title": p["signals"]["twitter_title"],
                       "twitter_image": p["signals"]["twitter_image"]} for p in pages]}


def cat_security(ctx: dict) -> dict:
    pages, checks = ctx["ok_pages"], []
    headers = ctx.get("home_headers") or {}
    tls = ctx.get("tls") or {}
    https_state = ctx.get("https") or {}

    checks.append(check("https_served", "Site served over HTTPS",
                        _status_of(ctx["base"].startswith("https://")),
                        f"Base URL is {ctx['base']}.", severity="high"))

    checks.append(check("https_redirect", "http:// redirects to https://",
                        _status_of(bool(https_state.get("redirects_to_https"))),
                        f"http:// resolves to {https_state.get('final_url')}"
                        if https_state.get("redirects_to_https")
                        else f"http:// does not redirect to https "
                             f"({https_state.get('error') or https_state.get('final_url')}).",
                        severity="high"))

    if tls.get("ok"):
        days = tls.get("days_left")
        checks.append(check("tls_valid", "TLS certificate valid and not expiring",
                            "pass" if (days or 0) > 30 else ("warn" if (days or 0) > 7 else "fail"),
                            f"Issued by {tls.get('issuer') or 'unknown'}, expires in {days} days.",
                            severity="high", value=days))
    else:
        checks.append(check("tls_valid", "TLS certificate verifiable", "warn",
                            f"Could not read the certificate: {tls.get('error')}", severity="high"))

    for header, label, sev, why in SECURITY_HEADERS:
        present = bool(headers.get(header))
        checks.append(check(f"hdr_{header.replace('-', '_')}", f"{label} header set",
                            _status_of(present, warn_only=sev != "high"),
                            f"{why} " + (f"Current value: {headers.get(header, '')[:120]}" if present
                                         else "Not set on the homepage response."),
                            severity=sev, value=headers.get(header, "")[:160]))

    mixed = [p for p in pages if p["signals"]["mixed_content"]]
    checks.append(check("mixed_content", "No mixed content", _status_of(not mixed),
                        f"{len(mixed)} pages load an http:// resource on an https:// page. Browsers "
                        f"block those outright, so the asset simply does not appear." if mixed
                        else "No insecure subresources found.", severity="high",
                        items=[_page_ref(p, "; ".join(p["signals"]["mixed_content"][:3]))
                               for p in mixed][:50]))

    server = headers.get("server", "")
    powered = headers.get("x-powered-by", "")
    checks.append(check("version_disclosure", "No software version disclosed in headers",
                        _status_of(not re.search(r"\d+\.\d+", f"{server} {powered}"), warn_only=True),
                        f"Server: {server or 'not sent'}; X-Powered-By: {powered or 'not sent'}. "
                        f"Version numbers tell an attacker exactly which exploits to try.",
                        severity="low", value=f"{server} {powered}".strip()))

    insecure_forms = [p for p in pages if p["signals"]["emails"] and not p["url"].startswith("https://")]
    checks.append(check("form_transport", "Pages collecting data are HTTPS-only",
                        _status_of(not insecure_forms), "All audited pages are HTTPS."
                        if not insecure_forms else f"{len(insecure_forms)} non-HTTPS pages expose "
                                                   f"contact details or forms.", severity="high"))

    return {"key": "security", "label": "Security & HTTPS", "score": score_from_checks(checks),
            "summary": f"HTTPS {'enforced' if https_state.get('redirects_to_https') else 'not enforced'}"
                       + (f", certificate expires in {tls.get('days_left')} days" if tls.get("ok") else ""),
            "checks": checks,
            "items": [{"path": "homepage response headers", "url": ctx["base"],
                       "detail": f"{len(headers)} headers", "headers": headers}]}


def cat_broken_links(ctx: dict) -> dict:
    results = ctx.get("link_results") or {}
    sources = ctx.get("link_sources") or {}
    checks: list[dict] = []

    if not results:
        checks.append(check("links_not_checked", "Outbound links verified", "info",
                            "Link checking was not enabled for this run.", severity="medium"))
        return {"key": "broken_links", "label": "Broken Link Management", "score": None,
                "summary": "Link checking not run.", "checks": checks, "items": []}

    broken = {u: r for u, r in results.items() if not r["ok"]}
    internal_broken = {u: r for u, r in broken.items() if same_host(u, ctx["base"])}
    external_broken = {u: r for u, r in broken.items() if not same_host(u, ctx["base"])}
    blocked = {u: r for u, r in results.items() if r.get("blocked")}
    redirecting = {u: r for u, r in results.items()
                   if r["ok"] and not r.get("blocked") and (r.get("redirect_chain") or [])}

    checks.append(check("internal_links_ok", "No broken internal links",
                        _status_of(not internal_broken),
                        f"{len(internal_broken)} of {sum(1 for u in results if same_host(u, ctx['base']))} "
                        f"internal links are broken. These waste crawl budget and dead-end readers."
                        if internal_broken else "Every internal link resolves.", severity="high",
                        items=[{"url": u, "path": route_path(u),
                                "detail": f"{r.get('status') or r.get('error')} — linked from "
                                          f"{', '.join(sorted(sources.get(u, []))[:3])}"}
                               for u, r in internal_broken.items()][:80]))

    checks.append(check("external_links_ok", "No broken external links",
                        _status_of(not external_broken, warn_only=True),
                        f"{len(external_broken)} external links are broken. External rot is normal — "
                        f"replace or remove them so readers do not hit dead ends." if external_broken
                        else "Every external link resolves.", severity="medium",
                        items=[{"url": u, "path": urlparse(u).netloc,
                                "detail": f"{r.get('status') or r.get('error')} — linked from "
                                          f"{', '.join(sorted(sources.get(u, []))[:3])}"}
                               for u, r in external_broken.items()][:80]))

    checks.append(check("links_direct", "Links point at final URLs",
                        _status_of(not redirecting, warn_only=True),
                        f"{len(redirecting)} links resolve via a redirect. Updating the href saves a "
                        f"round trip." if redirecting else "No link redirects.", severity="low",
                        items=[{"url": u, "path": route_path(u),
                                "detail": f"→ {r.get('final_url')}"}
                               for u, r in redirecting.items()][:60]))

    if blocked:
        checks.append(check(
            "links_blocked", "Links a bot cannot verify", "info",
            f"{len(blocked)} links answered a status that means the host refused our request "
            f"(400/403/405/429) rather than that the page is gone — Facebook and LinkedIn do this "
            f"to any datacenter IP. Open these by hand rather than treating them as broken.",
            severity="low",
            items=[{"url": u, "path": urlparse(u).netloc, "detail": f"HTTP {r.get('status')}"}
                   for u, r in blocked.items()][:50]))

    broken_images = ctx.get("broken_images") or []
    checks.append(check("images_load", "Every image loads",
                        _status_of(not broken_images),
                        f"{len(broken_images)} images return an error." if broken_images
                        else "All sampled images load.", severity="medium",
                        items=[{"url": b["url"], "path": b.get("page", ""),
                                "detail": b.get("error") or str(b.get("status"))}
                               for b in broken_images][:50]))

    return {"key": "broken_links", "label": "Broken Link Management",
            "score": score_from_checks(checks),
            "summary": f"{len(results)} unique links checked, {len(broken)} broken "
                       f"({len(internal_broken)} internal)"
                       + (f", {len(blocked)} unverifiable." if blocked else "."),
            "checks": checks,
            "items": [{"url": u, "status": r.get("status"), "ok": r["ok"], "error": r.get("error"),
                       "blocked": bool(r.get("blocked")), "final_url": r.get("final_url"),
                       "internal": same_host(u, ctx["base"]),
                       "sources": sorted(sources.get(u, []))[:10]}
                      for u, r in sorted(results.items(), key=lambda kv: (kv[1]["ok"], kv[0]))
                      if not r["ok"] or r.get("blocked") or (r.get("redirect_chain") or [])]}


def cat_gsc_analytics(ctx: dict) -> dict:
    pages, checks = ctx["ok_pages"], []
    gsc = ctx.get("gsc") or {}
    if not pages:
        return {"key": "gsc_analytics", "label": "Search Console & Analytics", "score": None,
                "summary": "No pages could be fetched.", "checks": [], "items": []}

    def tag_pages(key: str) -> list[dict]:
        return [p for p in pages if p["signals"]["analytics"].get(key)]

    ga4, gtm, ua = tag_pages("ga4"), tag_pages("gtm"), tag_pages("universal_analytics")
    verified = tag_pages("gsc_verification")

    analytics_present = ga4 or gtm or tag_pages("plausible_or_fathom") or tag_pages("vercel_analytics")
    checks.append(check("analytics_installed", "Analytics installed site-wide",
                        _status_of(bool(analytics_present) and len(analytics_present) == len(pages),
                                   warn_only=bool(analytics_present)),
                        f"GA4 on {len(ga4)} pages, Google Tag Manager on {len(gtm)}, "
                        f"privacy-first analytics on {len(tag_pages('plausible_or_fathom')) + len(tag_pages('vercel_analytics'))}, "
                        f"out of {len(pages)} audited. Pages without a tag are invisible in reporting.",
                        severity="high",
                        items=[_page_ref(p, "no analytics tag") for p in pages
                               if p not in analytics_present][:50]))

    checks.append(check("ua_retired", "No retired Universal Analytics tag",
                        _status_of(not ua),
                        f"{len(ua)} pages still load analytics.js. Universal Analytics stopped "
                        f"processing data in July 2024 — that tag now collects nothing." if ua
                        else "No Universal Analytics tag found.", severity="medium",
                        items=[_page_ref(p) for p in ua][:50]))

    if gsc.get("connected"):
        checks.append(check("gsc_connected", "Search Console connected to this app", "pass",
                            f"Live data for {gsc.get('property')}: {gsc.get('clicks', 0)} clicks and "
                            f"{gsc.get('impressions', 0)} impressions in the last 28 days across "
                            f"{gsc.get('indexed_count', 0)} URLs.", severity="high"))
    else:
        checks.append(check("gsc_connected", "Search Console connected to this app", "fail",
                            gsc.get("error") or
                            "No Search Console credentials configured. Add a Google service-account JSON "
                            "and gsc_site_url in Settings to pull queries, clicks, impressions, CTR, "
                            "position and coverage into these reports.", severity="high"))

    checks.append(check("gsc_verification_tag", "Search Console verification present",
                        _status_of(bool(verified), warn_only=True),
                        f"A google-site-verification meta tag appears on {len(verified)} pages."
                        if verified else
                        "No google-site-verification meta tag found. Verification may still be done by "
                        "DNS or file, which this check cannot see.", severity="low"))

    checks.append(check("bing_verification", "Bing Webmaster Tools verification",
                        _status_of(bool(tag_pages("bing_verification")), warn_only=True),
                        "Bing feeds ChatGPT search and Copilot as well as Bing itself."
                        if not tag_pages("bing_verification") else "Bing verification tag found.",
                        severity="low"))

    consistent = len({tuple(sorted(k for k, v in p["signals"]["analytics"].items() if v))
                      for p in pages}) <= 1
    checks.append(check("tagging_consistent", "The same tags on every page",
                        _status_of(consistent, warn_only=True),
                        "Tag coverage differs between pages, which produces gaps in every funnel and "
                        "attribution report." if not consistent
                        else "Tag coverage is identical across audited pages.", severity="medium"))

    sitemap_submitted = bool((ctx.get("robots") or {}).get("sitemaps"))
    checks.append(check("sitemap_submitted", "Sitemap discoverable for Search Console",
                        _status_of(sitemap_submitted, warn_only=True),
                        "robots.txt advertises the sitemap, so Search Console picks it up automatically. "
                        "Submitting it explicitly in Search Console still gives you per-sitemap coverage "
                        "reporting." if sitemap_submitted
                        else "Advertise the sitemap in robots.txt and submit it in Search Console.",
                        severity="medium"))

    return {"key": "gsc_analytics", "label": "Search Console & Analytics",
            "score": score_from_checks(checks),
            "summary": ("Search Console connected" if gsc.get("connected") else "Search Console not connected")
                       + f"; analytics on {len(analytics_present)}/{len(pages)} pages.",
            "checks": checks,
            "gsc": gsc,
            "items": [{"url": p["url"], "path": p["path"],
                       "tags": sorted(k for k, v in p["signals"]["analytics"].items() if v),
                       "gsc_token": p["signals"]["gsc_token"]} for p in pages]}


def cat_monitoring(ctx: dict) -> dict:
    pages, checks = ctx["ok_pages"], []
    history = ctx.get("history") or []
    tracked = ctx.get("tracked_keywords") or []
    sm = ctx["sitemap"]

    if len(history) >= 2:
        delta = (history[-1].get("site_score") or 0) - (history[0].get("site_score") or 0)
        checks.append(check("score_trend", "Site score is improving",
                            _status_of(delta >= 0, warn_only=delta > -5),
                            f"Site score moved {delta:+d} points across {len(history)} audits "
                            f"(oldest {history[0].get('site_score')} → latest "
                            f"{history[-1].get('site_score')}).", severity="medium", value=delta))
    else:
        checks.append(check("score_trend", "Score history for trend analysis", "info",
                            f"{len(history)} audit(s) recorded. Run the audit on a schedule — a single "
                            f"snapshot cannot show whether anything is improving.", severity="low"))

    checks.append(check("rank_tracking", "Keywords tracked for rank movement",
                        _status_of(bool(tracked), warn_only=True),
                        f"{len(tracked)} keywords are being tracked for this site."
                        if tracked else "No keywords tracked yet. Add your focus keywords in Keyword "
                                        "Tracking so ranking changes are measured rather than assumed.",
                        severity="medium", value=len(tracked),
                        items=[{"url": k.get("url", ""), "path": k.get("keyword", ""),
                                "detail": (f"position {k.get('position')}" if k.get("position")
                                           else "not yet ranked")} for k in tracked[:50]]))

    # Content freshness, from sitemap lastmod where available.
    stale: list[dict] = []
    now = datetime.now(timezone.utc)
    for entry in sm.get("entries", []):
        if not entry["lastmod"]:
            continue
        try:
            when = datetime.fromisoformat(entry["lastmod"].replace("Z", "+00:00"))
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
        except Exception:
            continue
        age = (now - when).days
        if age > 365:
            stale.append({"url": entry["loc"], "path": route_path(entry["loc"]),
                          "detail": f"last modified {age} days ago"})
    if any(e["lastmod"] for e in sm.get("entries", [])):
        checks.append(check("content_freshness", "Content updated within the last year",
                            _status_of(not stale, warn_only=True),
                            f"{len(stale)} pages have not been modified in over a year, according to "
                            f"the sitemap's lastmod dates.", severity="medium", items=stale[:60]))
    else:
        checks.append(check("content_freshness", "Content freshness measurable", "info",
                            "The sitemap carries no lastmod dates, so freshness cannot be assessed "
                            "from outside. Adding them also helps crawlers prioritise.", severity="low"))

    # Near-duplicate detection on the body copy — the cheap version: identical
    # opening 400 characters. Cheap, but it never produces a false positive.
    fingerprints = defaultdict(list)
    for p in pages:
        fp = re.sub(r"\W+", "", (p["signals"].get("text") or "")[:400]).lower()
        if len(fp) > 100:
            fingerprints[fp].append(p)
    dupes = [ps for ps in fingerprints.values() if len(ps) > 1]
    checks.append(check("duplicate_content", "No near-duplicate pages", _status_of(not dupes),
                        f"{len(dupes)} group(s) of pages open with identical copy, so they compete for "
                        f"the same queries." if dupes else "No duplicate openings detected.",
                        severity="high",
                        items=[{"url": ps[0]["url"], "path": ", ".join(x["path"] for x in ps),
                                "detail": f"{len(ps)} pages share their opening copy"} for ps in dupes][:30]))

    checks.append(check("scheduled_audits", "Audits run on a schedule", "info",
                        "Monitoring means repeating this audit. Use the Autopilot or Loop scheduling to "
                        "run it weekly, so a regression is caught by the report rather than by a "
                        "traffic drop.", severity="low"))

    return {"key": "monitoring", "label": "Content & Rank Monitoring",
            "score": score_from_checks(checks),
            "summary": f"{len(history)} audits recorded, {len(tracked)} keywords tracked, "
                       f"{len(stale)} pages over a year old.",
            "checks": checks,
            "history": history,
            "items": [{"url": p["url"], "path": p["path"], "score": p.get("score"),
                       "word_count": p["signals"]["word_count"],
                       "keyword": p.get("keyword_analysis", {}).get("keyword", "")} for p in pages]}


# Order matters: this is the order the UI renders, and it walks from what you
# write to what you measure.
CATEGORY_BUILDERS = [
    cat_keyword_content,
    cat_on_page,
    cat_technical,
    cat_images,
    cat_internal_linking,
    cat_schema,
    cat_sitemap,
    cat_robots,
    cat_canonical,
    cat_indexing,
    cat_redirects,
    cat_performance,
    cat_mobile,
    cat_local,
    cat_social,
    cat_security,
    cat_broken_links,
    cat_gsc_analytics,
    cat_monitoring,
]


def build_report(categories: list[dict], ctx: dict) -> dict:
    """The SEO Audit & Reporting category: a roll-up over every other one,
    plus the single prioritised fix list, which is what anyone actually acts
    on. Ordered by severity and then by how many pages each finding affects."""
    scored = [c for c in categories if c.get("score") is not None]
    overall = round(sum(c["score"] for c in scored) / len(scored)) if scored else None

    severity_rank = {"high": 0, "medium": 1, "low": 2}
    actions = []
    for cat in categories:
        for chk in cat.get("checks", []):
            if chk["status"] not in ("fail", "warn"):
                continue
            actions.append({
                "category": cat["label"], "category_key": cat["key"],
                "id": chk["id"], "label": chk["label"], "status": chk["status"],
                "severity": chk["severity"], "detail": chk["detail"],
                "affected": len(chk.get("items") or []),
                "items": (chk.get("items") or [])[:10],
            })
    actions.sort(key=lambda a: (0 if a["status"] == "fail" else 1,
                                severity_rank.get(a["severity"], 3),
                                -a["affected"]))

    checks = [
        check("overall_score", "Overall SEO health",
              "pass" if (overall or 0) >= 80 else ("warn" if (overall or 0) >= 60 else "fail"),
              f"{overall}/100 across {len(scored)} audited categories.", severity="high",
              value=overall),
        check("critical_failures", "No critical failures",
              _status_of(not [a for a in actions if a["status"] == "fail" and a["severity"] == "high"]),
              f"{len([a for a in actions if a['status'] == 'fail' and a['severity'] == 'high'])} "
              f"high-severity checks are failing.", severity="high"),
        check("coverage", "Audit coverage",
              _status_of(len(ctx["ok_pages"]) >= 10, warn_only=len(ctx["ok_pages"]) >= 3),
              f"{len(ctx['ok_pages'])} of {len(ctx['pages'])} URLs were fetched and scored, discovered "
              f"via {ctx['url_source']}. Raise the page limit for a fuller picture.",
              severity="medium", value=len(ctx["ok_pages"])),
        check("authority", "Off-site authority", "info",
              "Backlinks, referring domains and brand mentions are off-page signals and cannot be read "
              "from your own site. Track them in Backlink Outreach and Link Reclamation.",
              severity="low"),
    ]

    return {"key": "reporting", "label": "SEO Audit & Reporting", "score": overall,
            "summary": f"{len([a for a in actions if a['status'] == 'fail'])} failing and "
                       f"{len([a for a in actions if a['status'] == 'warn'])} warning checks across "
                       f"{len(scored)} categories.",
            "checks": checks, "actions": actions[:120],
            "items": [{"path": c["label"], "url": "", "detail": c.get("summary", ""),
                       "score": c.get("score"), "key": c["key"]} for c in categories]}


# --------------------------------------------------------------------------
# orchestration
# --------------------------------------------------------------------------

# When the crawl is a sample of the site, these are the pages the sample must
# not miss: the home page takes most of the traffic, and the contact/about/
# location pages are where the NAP data local SEO depends on actually lives.
# Without this, a sitemap's alphabetical order decided what got audited and
# "no phone number found" meant "we never looked at /contact".
PRIORITY_PATTERNS = (
    r"^/$",
    r"^/(contact|contact-us|get-in-touch)",
    r"^/(about|about-us|company)",
    r"^/(locations?|offices?|areas-we-serve)",
    r"^/(services|solutions|products)/?$",
    r"^/(blog|news|insights)/?$",
)


def prioritise(urls: list[str], limit: int) -> list[str]:
    """The priority pages first, then everything else in its original order."""
    seen: set[str] = set()
    front: list[str] = []
    for pattern in PRIORITY_PATTERNS:
        for u in urls:
            path = route_path(u)
            if u not in seen and re.match(pattern, path, re.I):
                front.append(u)
                seen.add(u)
                break
    rest = [u for u in urls if u not in seen]
    return (front + rest)[:limit]


async def discover_urls(client: httpx.AsyncClient, base: str, sitemap: dict,
                        limit: int, cached: Optional[list[str]] = None) -> tuple[list[str], str]:
    """Where the page list comes from, in order of authority. The source is
    returned so the report can say what it covered instead of implying it saw
    the whole site."""
    if sitemap.get("urls"):
        urls = [u for u in sitemap["urls"] if same_host(u, base)]
        if urls:
            return prioritise(urls, limit), f"sitemap ({sitemap['url'].rsplit('/', 1)[-1]})"

    # No sitemap: follow the homepage's own internal links one level deep.
    doc = await fetch_document(client, base)
    if doc.get("ok"):
        sig = extract_page_signals(doc["html"], base, doc.get("headers"))
        linked = list(dict.fromkeys(
            l["href"] for l in sig["links"] if l["internal"] and not _ext_of(l["href"])))
        if linked:
            return prioritise([base] + [u for u in linked if u.rstrip("/") != base.rstrip("/")],
                              limit), "homepage links"

    if cached:
        return prioritise(cached, limit), "synced content"
    return ([base] if base else []), "homepage only"


async def _sample_asset_sizes(client: httpx.AsyncClient, pages: list[dict],
                              limit: int = 60) -> tuple[list[dict], list[dict]]:
    """(heavy_images, broken_images) for a sample of distinct image URLs.
    Sampled rather than exhaustive: a 50-page crawl can reference thousands of
    images, and HEADing all of them would take longer than the crawl itself."""
    seen: dict[str, str] = {}
    for p in pages:
        for img in p["signals"]["images"]:
            if img["src"] and img["src"] not in seen:
                seen[img["src"]] = p["path"]
            if len(seen) >= limit:
                break
        if len(seen) >= limit:
            break

    heavy: list[dict] = []
    broken: list[dict] = []
    sem = asyncio.Semaphore(LINK_CHECK_CONCURRENCY)

    async def one(url: str, page: str):
        async with sem:
            try:
                resp = await client.head(url)
                if resp.status_code in INCONCLUSIVE_STATUSES:
                    resp = await client.get(url, headers={**BROWSER_HEADERS, "Range": "bytes=0-1"})
            except Exception as e:
                broken.append({"url": url, "page": page, "status": None, "error": str(e)[:100]})
                return
            if resp.status_code >= 400:
                broken.append({"url": url, "page": page, "status": resp.status_code,
                               "error": f"HTTP {resp.status_code}"})
                return
            size = resp.headers.get("content-length")
            if size and size.isdigit() and int(size) > 200_000:
                heavy.append({"url": url, "page": page, "kb": round(int(size) / 1024)})

    await asyncio.gather(*(one(u, p) for u, p in seen.items()))
    heavy.sort(key=lambda h: -h["kb"])
    return heavy, broken


async def run_full_audit(
    site: dict,
    *,
    max_pages: int = 25,
    urls: Optional[list[str]] = None,
    check_links: bool = True,
    measure_cwv: bool = False,
    psi_sample: int = 3,
    psi_api_key: str = "",
    focus_keywords: Optional[dict[str, str]] = None,
    cached_urls: Optional[list[str]] = None,
    history: Optional[list[dict]] = None,
    tracked_keywords: Optional[list[dict]] = None,
    gsc: Optional[dict] = None,
    progress: Optional[Callable] = None,
) -> dict:
    """Crawl the site and evaluate every SEO category. `progress(message, i, n)`
    is awaited if supplied, so a caller can stream the crawl to the UI."""
    base = (site.get("base_url") or "").rstrip("/")
    if not base:
        raise ValueError("The site has no URL configured.")
    focus_keywords = focus_keywords or {}

    async def say(message: str, current: int = 0, total: int = 0):
        if progress:
            await progress(message, current, total)

    limits = httpx.Limits(max_connections=CRAWL_CONCURRENCY * 2,
                          max_keepalive_connections=CRAWL_CONCURRENCY)
    async with httpx.AsyncClient(timeout=FETCH_TIMEOUT, follow_redirects=True,
                                 headers=BROWSER_HEADERS, limits=limits) as client:
        await say("Reading robots.txt and sitemap…")
        robots = await fetch_robots(client, base)
        sitemap = await fetch_sitemaps(client, base, robots.get("sitemaps"))

        await say("Checking HTTPS and the TLS certificate…")
        https_state, tls = await asyncio.gather(
            check_https_redirect(base),
            asyncio.to_thread(tls_certificate, urlparse(base).netloc.split(":")[0]),
        )

        if urls:
            page_urls, url_source = urls[:max_pages], "supplied"
        else:
            page_urls, url_source = await discover_urls(client, base, sitemap, max_pages, cached_urls)
        if not page_urls:
            raise ValueError("No pages found to audit. Publish a sitemap at /sitemap.xml, "
                             "or link pages from your homepage.")

        await say(f"Crawling {len(page_urls)} pages from {url_source}…", 0, len(page_urls))
        sem = asyncio.Semaphore(CRAWL_CONCURRENCY)
        done = 0
        pages: list[dict] = []

        async def crawl(url: str):
            nonlocal done
            async with sem:
                doc = await fetch_document(client, url)
            page = {"url": url, "path": route_path(url), "ok": doc.get("ok", False),
                    "error": doc.get("error"), "status_code": doc.get("status_code"),
                    "final_url": doc.get("final_url", url),
                    "redirect_chain": doc.get("redirect_chain") or [],
                    "elapsed_ms": doc.get("elapsed_ms"), "bytes": doc.get("bytes"),
                    "headers": doc.get("headers") or {}}
            if doc.get("ok"):
                sig = extract_page_signals(doc["html"], url, doc.get("headers"))
                page["signals"] = sig
                # Reuse the ten-factor page score so the number shown here and
                # on the per-page view are the same number.
                page.update(score_page(sig))
                explicit = focus_keywords.get(page["path"], "")
                keyword = explicit or infer_focus_keyword(sig)
                page["keyword_analysis"] = analyse_keyword(sig, keyword, inferred=not explicit)
                page["terms"] = content_terms(sig)
            else:
                page["signals"] = None
                page["score"] = None
                page["issues"] = []
                page["factor_scores"] = {}
            pages.append(page)
            done += 1
            await say(f"Crawled {done}/{len(page_urls)} — {url}", done, len(page_urls))

        await asyncio.gather(*(crawl(u) for u in page_urls))
        pages.sort(key=lambda p: (p.get("score") is None, p.get("score") or 0))
        ok_pages = [p for p in pages if p["ok"] and p.get("signals")]

        home_headers = next((p["headers"] for p in pages if p["path"] == "/" and p["ok"]), None)
        if home_headers is None:
            home_doc = await fetch_document(client, base)
            home_headers = home_doc.get("headers") or {}

        link_results: dict[str, dict] = {}
        link_sources: dict[str, set] = defaultdict(set)
        og_image_checks: dict[str, dict] = {}
        heavy_images: list[dict] = []
        broken_images: list[dict] = []

        if check_links and ok_pages:
            for p in ok_pages:
                for link in p["signals"]["links"]:
                    link_sources[link["href"]].add(p["path"])
            # Internal links first — a broken internal link is your bug, while
            # a broken external one is someone else's.
            candidates = sorted(link_sources, key=lambda u: (not same_host(u, base), u))
            candidates = candidates[:MAX_LINKS_TO_CHECK]
            await say(f"Checking {len(candidates)} unique links…", 0, len(candidates))
            sem_l = asyncio.Semaphore(LINK_CHECK_CONCURRENCY)
            checked = 0

            async def one_link(url: str):
                nonlocal checked
                async with sem_l:
                    link_results[url] = await check_link(client, url)
                checked += 1
                if checked % 25 == 0:
                    await say(f"Checked {checked}/{len(candidates)} links…", checked, len(candidates))

            await asyncio.gather(*(one_link(u) for u in candidates))

            await say("Sampling image weights…")
            heavy_images, broken_images = await _sample_asset_sizes(client, ok_pages)

            og_urls = list(dict.fromkeys(
                p["signals"]["og_image"] for p in ok_pages
                if p["signals"]["og_image"].startswith(("http://", "https://"))))[:20]
            if og_urls:
                results = await asyncio.gather(*(check_link(client, u) for u in og_urls))
                og_image_checks = {r["url"]: r for r in results}

    psi_results: list[dict] = []
    if measure_cwv and ok_pages:
        # Homepage plus the weakest pages: the homepage because it takes most
        # of the traffic, the weakest because that is where the wins are.
        sample: list[str] = []
        home = next((p for p in ok_pages if p["path"] == "/"), None)
        if home:
            sample.append(home["final_url"] or home["url"])
        for p in ok_pages:
            target = p["final_url"] or p["url"]
            if target not in sample:
                sample.append(target)
            if len(sample) >= max(1, min(psi_sample, 10)):
                break
        await say(f"Measuring Core Web Vitals for {len(sample)} URLs (20–40s each)…")
        for idx, url in enumerate(sample, start=1):
            await say(f"PageSpeed {idx}/{len(sample)} — {url}", idx, len(sample))
            mobile, desktop = await asyncio.gather(
                run_psi(url, "mobile", psi_api_key),
                run_psi(url, "desktop", psi_api_key),
            )
            psi_results += [mobile, desktop]

    ctx = {
        "site": site, "base": base, "pages": pages, "ok_pages": ok_pages,
        "robots": robots, "sitemap": sitemap, "https": https_state, "tls": tls,
        "home_headers": home_headers, "url_source": url_source,
        "link_results": link_results,
        "link_sources": {k: v for k, v in link_sources.items()},
        "og_image_checks": og_image_checks,
        "heavy_images": heavy_images, "broken_images": broken_images,
        "psi": psi_results, "history": history or [], "gsc": gsc or {},
        "tracked_keywords": tracked_keywords or [],
    }

    await say("Scoring categories…")
    categories: list[dict] = []
    for builder in CATEGORY_BUILDERS:
        try:
            categories.append(builder(ctx))
        except Exception as e:
            logger.exception(f"Category {builder.__name__} failed")
            categories.append({"key": builder.__name__.replace("cat_", ""),
                               "label": builder.__name__.replace("cat_", "").replace("_", " ").title(),
                               "score": None, "summary": f"This section could not be evaluated: {e}",
                               "checks": [], "items": []})
    categories.append(build_report(categories, ctx))

    scored = [p for p in pages if p.get("score") is not None]
    site_score = round(sum(p["score"] for p in scored) / len(scored)) if scored else None

    factor_totals: dict[str, list[int]] = defaultdict(list)
    for p in scored:
        for key, value in (p.get("factor_scores") or {}).items():
            factor_totals[key].append(value)
    factor_summary = sorted(
        [{"key": key, "label": label, "weight": weight,
          "average": round(sum(factor_totals[key]) / len(factor_totals[key])) if factor_totals.get(key) else 0}
         for key, label, weight in SCORING_FACTORS],
        key=lambda f: f["average"])

    return {
        "site_id": site.get("id"),
        "site_url": base,
        "site_score": site_score,
        "overall_score": categories[-1]["score"],
        "pages_audited": len(scored),
        "pages_failed": len(pages) - len(scored),
        "url_source": url_source,
        "factor_summary": factor_summary,
        # Stored without `text`, `links` and `schema_objects`: they are large,
        # only needed while scoring, and a 50-page audit with them attached is
        # tens of megabytes in a single document.
        "pages": [_slim_page(p) for p in pages],
        "categories": categories,
        "options": {"max_pages": max_pages, "check_links": check_links,
                    "measure_cwv": measure_cwv, "psi_sample": psi_sample},
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def _slim_page(page: dict) -> dict:
    """A stored page row: everything the UI shows, none of the crawl scratch."""
    sig = page.get("signals")
    slim_sig = None
    if sig:
        slim_sig = {k: v for k, v in sig.items()
                    if k not in ("text", "links", "schema_objects", "images", "headings")}
        slim_sig["images"] = sig["images"][:25]
        slim_sig["headings"] = sig["headings"][:40]
    return {
        "url": page["url"], "path": page["path"], "ok": page["ok"], "error": page.get("error"),
        "status_code": page.get("status_code"), "final_url": page.get("final_url"),
        "redirect_chain": page.get("redirect_chain"), "elapsed_ms": page.get("elapsed_ms"),
        "bytes": page.get("bytes"), "score": page.get("score"),
        "factor_scores": page.get("factor_scores"), "issues": page.get("issues"),
        "signals": slim_sig, "keyword_analysis": page.get("keyword_analysis"),
        "terms": page.get("terms"),
    }
