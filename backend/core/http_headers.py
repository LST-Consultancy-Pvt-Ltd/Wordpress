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
# unavailable" — worth a retry (e.g. HEAD -> GET) before concluding failure,
# and worth reporting as "blocked" rather than "broken" if the retry also
# fails. A genuinely dead page answers 404 or 410; when a plain public URL
# answers one of these, it is nearly always the host refusing the client.
#
# 400 is here because Facebook answers 400 to requests from datacenter IPs
# regardless of method — HEAD and GET alike, with a short error body — so a
# live page like facebook.com/<company> would otherwise be reported as a
# broken outbound link on every scan.
INCONCLUSIVE_STATUSES = {400, 403, 405, 429}
