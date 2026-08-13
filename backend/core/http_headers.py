"""Shared HTTP headers for outbound requests to third-party/public sites.

Many hosts (Hostinger/LiteSpeed WAFs, LinkedIn, X/Twitter, Outlook, etc.)
block requests that look like bots — a plain httpx client with no
User-Agent gets a 403/405/429 even when the page is genuinely live. Use
BROWSER_HEADERS on any httpx.AsyncClient that fetches a public URL
(robots.txt, sitemaps, outbound links, competitor pages) to avoid false
"broken"/"inaccessible" results.
"""

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
}

# Statuses that commonly mean "blocked by anti-bot protection", not "genuinely
# unavailable" — worth a retry (e.g. HEAD -> GET) before concluding failure.
INCONCLUSIVE_STATUSES = {403, 405, 429}
