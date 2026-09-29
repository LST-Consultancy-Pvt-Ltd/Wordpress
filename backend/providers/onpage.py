"""Platform-neutral on-page SEO auditing.

Signals come from the *rendered HTML of the live URL*, which is what a
crawler actually sees, rather than from any content-management metadata.

Scoring is deliberately deterministic: fixed thresholds and weights, no AI. A
score you can't reproduce or explain is worthless for tracking progress over
time, and an LLM asked to "rate this page 0-100" invents a number.
"""
import logging
import re
from typing import Optional

import httpx
from bs4 import BeautifulSoup

from core.http_headers import BROWSER_HEADERS

logger = logging.getLogger(__name__)

FETCH_TIMEOUT = 20.0

# Each factor: (key, label, weight). Weights sum to 100.
SCORING_FACTORS = [
    ("title",       "Title tag",           18),
    ("description", "Meta description",    16),
    ("h1",          "Single H1",           12),
    ("canonical",   "Canonical URL",        8),
    ("indexable",   "Indexable",           10),
    ("og",          "Open Graph tags",      8),
    ("schema",      "Structured data",      8),
    ("content",     "Content depth",       10),
    ("images",      "Image alt text",       6),
    ("headings",    "Heading structure",    4),
]


def score_title(title: str) -> int:
    """Google truncates around 60 characters; under ~30 wastes the slot."""
    if not title:
        return 0
    n = len(title)
    if 50 <= n <= 60:
        return 100
    if 40 <= n <= 70:
        return 70
    if 30 <= n <= 80:
        return 40
    return 20


def score_description(desc: str) -> int:
    if not desc:
        return 0
    n = len(desc)
    if 150 <= n <= 160:
        return 100
    if 130 <= n <= 180:
        return 70
    if 100 <= n <= 200:
        return 40
    return 20


async def fetch_page(url: str) -> tuple[Optional[str], Optional[int], Optional[str]]:
    """(html, status_code, error). Sends a real browser User-Agent — without it
    WAFs commonly 403 the request and every page would score zero for reasons
    that have nothing to do with its SEO."""
    try:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT, follow_redirects=True,
                                     headers=BROWSER_HEADERS) as client:
            resp = await client.get(url)
    except httpx.TimeoutException:
        return None, None, f"Timed out after {int(FETCH_TIMEOUT)}s"
    except Exception as e:
        return None, None, str(e)
    if resp.status_code >= 400:
        return None, resp.status_code, f"HTTP {resp.status_code}"
    return resp.text, resp.status_code, None


def extract_signals(html: str, url: str) -> dict:
    """Everything an on-page audit needs, read from the rendered document."""
    soup = BeautifulSoup(html, "html.parser")

    title = (soup.title.string or "").strip() if soup.title and soup.title.string else ""

    def meta(name=None, prop=None) -> str:
        tag = soup.find("meta", attrs={"name": name} if name else {"property": prop})
        return (tag.get("content") or "").strip() if tag else ""

    canonical_tag = soup.find("link", rel=lambda v: v and "canonical" in (v if isinstance(v, list) else [v]))
    canonical = (canonical_tag.get("href") or "").strip() if canonical_tag else ""

    robots = meta(name="robots").lower()

    h1s = [h.get_text(strip=True) for h in soup.find_all("h1")]
    h2s = [h.get_text(strip=True) for h in soup.find_all("h2")]

    for tag in soup(["script", "style", "nav", "footer", "header", "noscript"]):
        tag.decompose()
    text = " ".join(soup.get_text(separator=" ", strip=True).split())
    word_count = len(text.split())

    images = soup.find_all("img")
    missing_alt = [i.get("src", "") for i in images if not (i.get("alt") or "").strip()]

    schema_types: list[str] = []
    for node in BeautifulSoup(html, "html.parser").find_all("script", attrs={"type": "application/ld+json"}):
        raw = node.string or ""
        schema_types += re.findall(r'"@type"\s*:\s*"([^"]+)"', raw)

    return {
        "url": url,
        "title": title,
        "title_length": len(title),
        "description": meta(name="description"),
        "description_length": len(meta(name="description")),
        "canonical": canonical,
        "robots": robots,
        "noindex": "noindex" in robots,
        "h1_count": len(h1s),
        "h1": h1s[0] if h1s else "",
        "h2_count": len(h2s),
        "word_count": word_count,
        "image_count": len(images),
        "images_missing_alt": len(missing_alt),
        "og_title": meta(prop="og:title"),
        "og_description": meta(prop="og:description"),
        "og_image": meta(prop="og:image"),
        "schema_types": sorted(set(schema_types)),
    }


def score_page(sig: dict) -> dict:
    """Deterministic per-factor scores, a weighted overall, and the specific
    issues behind any factor that lost points."""
    scores: dict[str, int] = {}
    issues: list[dict] = []

    scores["title"] = score_title(sig["title"])
    if not sig["title"]:
        issues.append({"factor": "title", "severity": "high", "message": "No title tag."})
    elif scores["title"] < 100:
        issues.append({"factor": "title", "severity": "medium",
                       "message": f"Title is {sig['title_length']} characters; aim for 50–60."})

    scores["description"] = score_description(sig["description"])
    if not sig["description"]:
        issues.append({"factor": "description", "severity": "high", "message": "No meta description."})
    elif scores["description"] < 100:
        issues.append({"factor": "description", "severity": "medium",
                       "message": f"Meta description is {sig['description_length']} characters; aim for 150–160."})

    if sig["h1_count"] == 1:
        scores["h1"] = 100
    elif sig["h1_count"] == 0:
        scores["h1"] = 0
        issues.append({"factor": "h1", "severity": "high", "message": "No H1 heading."})
    else:
        scores["h1"] = 40
        issues.append({"factor": "h1", "severity": "medium",
                       "message": f"{sig['h1_count']} H1 headings; use exactly one."})

    scores["canonical"] = 100 if sig["canonical"] else 0
    if not sig["canonical"]:
        issues.append({"factor": "canonical", "severity": "medium", "message": "No canonical URL declared."})

    scores["indexable"] = 0 if sig["noindex"] else 100
    if sig["noindex"]:
        issues.append({"factor": "indexable", "severity": "high",
                       "message": "Page is marked noindex — it cannot rank."})

    og_present = sum(bool(sig[k]) for k in ("og_title", "og_description", "og_image"))
    scores["og"] = int(og_present / 3 * 100)
    if og_present < 3:
        issues.append({"factor": "og", "severity": "low",
                       "message": f"{3 - og_present} of 3 Open Graph tags missing (title, description, image)."})

    scores["schema"] = 100 if sig["schema_types"] else 0
    if not sig["schema_types"]:
        issues.append({"factor": "schema", "severity": "medium",
                       "message": "No structured data (JSON-LD) found."})

    wc = sig["word_count"]
    scores["content"] = 100 if wc >= 600 else 70 if wc >= 300 else 30 if wc >= 150 else 0
    if wc < 300:
        issues.append({"factor": "content", "severity": "medium" if wc >= 150 else "high",
                       "message": f"Only {wc} words of body content; thin pages rarely rank."})

    if sig["image_count"] == 0:
        scores["images"] = 100  # nothing to get wrong
    else:
        ok = sig["image_count"] - sig["images_missing_alt"]
        scores["images"] = int(ok / sig["image_count"] * 100)
        if sig["images_missing_alt"]:
            issues.append({"factor": "images", "severity": "low",
                           "message": f"{sig['images_missing_alt']} of {sig['image_count']} images have no alt text."})

    scores["headings"] = 100 if sig["h2_count"] >= 1 else 40
    if sig["h2_count"] == 0:
        issues.append({"factor": "headings", "severity": "low",
                       "message": "No H2 subheadings — content has no visible structure."})

    total = sum(scores[key] * weight for key, _, weight in SCORING_FACTORS) / 100
    return {
        "score": round(total),
        "factor_scores": scores,
        "issues": issues,
    }


async def audit_url(url: str) -> dict:
    """Fetch and score a single URL. Never raises — an unreachable page is
    reported as an error rather than scored zero, so a network problem is
    never mistaken for bad SEO."""
    html, status, error = await fetch_page(url)
    if html is None:
        return {"url": url, "ok": False, "status_code": status, "error": error,
                "score": None, "issues": [], "factor_scores": {}}
    signals = extract_signals(html, url)
    result = score_page(signals)
    return {"url": url, "ok": True, "status_code": status, "error": None,
            "signals": signals, **result}
