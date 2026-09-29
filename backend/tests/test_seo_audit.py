"""Tests for the platform-neutral SEO audit engine (providers/seo_audit.py).

Everything here runs against synthetic HTML rather than a live site, so the
assertions are about the *rules* — thresholds, parsing, and which findings a
given page provokes — and cannot drift when the real site changes.

The bias throughout is against false confidence. A check that reports a clean
pass when it could not actually measure something is worse than no check, so
several tests exist purely to pin down the "we could not tell" cases.
"""
import asyncio

import pytest

from providers import seo_audit as sa
from providers.seo_audit import (
    analyse_keyword, extract_page_signals, flesch_reading_ease, infer_focus_keyword,
    prioritise, robots_blocks, route_path, run_psi, score_from_checks,
)

from tests.loop import LOOP as _loop  # noqa: E402


def _run(coro):
    return _loop.run_until_complete(coro)


def _page(**over) -> str:
    """A page with everything right, so a test can break exactly one thing."""
    d = {
        "title": "Acumatica Data Migration Services | LST Consultancy",
        "description": ("Move to Acumatica ERP with confidence. LST Consultancy handles Acumatica "
                        "data migration with accurate mapping, clean data and minimal downtime now."),
        "canonical": "https://ex.test/acumatica-data-migration",
        "robots": "index, follow",
        "h1": "Acumatica Data Migration Without the Disruption",
        "body": "<p>Acumatica data migration is the process of moving records. " * 40,
        "extra_head": "",
        "images": '<img src="/img/acumatica-data-migration.webp" alt="Acumatica migration plan" '
                  'width="800" height="600" loading="lazy" srcset="/a.webp 1x">',
        "links": '<a href="/about">About our team</a><a href="/contact">Contact us</a>',
    }
    d.update(over)
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>{d['title']}</title>
<meta name="description" content="{d['description']}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="{d['robots']}">
<link rel="canonical" href="{d['canonical']}">
<link rel="icon" href="/favicon.ico">
<meta property="og:title" content="Acumatica Data Migration">
<meta property="og:description" content="Move to Acumatica ERP with confidence.">
<meta property="og:image" content="https://ex.test/og.png">
<meta property="og:url" content="https://ex.test/acumatica-data-migration">
<meta property="og:type" content="website">
<meta property="og:site_name" content="LST">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">
{{"@context":"https://schema.org","@graph":[
 {{"@type":"Organization","name":"LST","url":"https://ex.test"}},
 {{"@type":"Service","name":"Acumatica Data Migration"}}]}}
</script>
{d['extra_head']}
</head><body>
<h1>{d['h1']}</h1>
<main><h2>How the migration works</h2>{d['body']}{d['images']}{d['links']}</main>
</body></html>"""


URL = "https://ex.test/acumatica-data-migration"


# --- signal extraction ------------------------------------------------------

def test_signals_read_everything_an_audit_needs_from_the_rendered_html():
    sig = extract_page_signals(_page(), URL, {"x-robots-tag": ""})
    assert sig["title_length"] == 51
    assert sig["h1_count"] == 1 and sig["h2_count"] == 1
    assert sig["canonical_self"] is True
    assert sig["noindex"] is False
    assert sig["lang"] == "en" and sig["charset"] and sig["doctype"] and sig["favicon"]
    assert sig["viewport"].startswith("width=device-width")
    assert set(sig["schema_types"]) == {"Organization", "Service"}
    assert sig["image_count"] == 1 and sig["images_missing_alt"] == 0
    assert sig["internal_links"] == 2 and sig["external_links"] == 0
    assert sig["og_title"] and sig["og_image"] and sig["twitter_card"] == "summary_large_image"
    assert sig["word_count"] > 300


def test_x_robots_tag_header_counts_as_noindex():
    """A noindex delivered by header is invisible in the HTML, so a check that
    only reads the meta tag reports an unindexable page as indexable."""
    sig = extract_page_signals(_page(), URL, {"x-robots-tag": "noindex, nofollow"})
    assert sig["noindex"] is True and sig["nofollow_page"] is True


def test_jsonld_graph_and_arrays_are_both_parsed():
    """Most real sites emit @graph or a top-level array; reading only a bare
    object reports "no structured data" on a page full of it."""
    array = '<script type="application/ld+json">[{"@type":"FAQPage","mainEntity":[]}]</script>'
    sig = extract_page_signals(_page(extra_head=array), URL)
    assert "FAQPage" in sig["schema_types"]
    assert {"Organization", "Service"} <= set(sig["schema_types"])


def test_unparseable_jsonld_is_reported_as_broken_not_as_absent():
    bad = '<script type="application/ld+json">{"@type":"Product",}</script>'
    sig = extract_page_signals(_page(extra_head=bad), URL)
    assert sig["schema_errors"], "a JSON syntax error must be surfaced"
    assert "Product" in sig["schema_types"], "the type is still known, so don't claim no schema"


def test_mixed_content_is_detected_only_on_https_pages():
    insecure = '<img src="http://cdn.example/logo.png">'
    assert extract_page_signals(_page(images=insecure), URL)["mixed_content"]
    assert not extract_page_signals(_page(images=insecure),
                                    "http://ex.test/x")["mixed_content"]


def test_tel_and_mailto_links_are_captured_for_local_seo():
    """The phone number normally lives in the header or footer, which the body
    extraction strips — so it has to be read from the anchors, not the copy."""
    sig = extract_page_signals(
        _page(links='<a href="tel:+971 4 000 0000">Call</a><a href="mailto:hi@ex.test">Mail</a>'),
        URL)
    assert sig["tel_links"] == ["+971 4 000 0000"]
    assert "hi@ex.test" in sig["emails"]
    assert sig["internal_links"] == 0, "tel:/mailto: are not crawlable links"


def test_heading_order_is_preserved_so_a_skipped_level_can_be_found():
    html = _page(body="<h2>Two</h2><h4>Four</h4><p>x</p>")
    levels = [h["level"] for h in extract_page_signals(html, URL)["headings"]]
    assert levels == [1, 2, 2, 4], levels


# --- readability ------------------------------------------------------------

def test_block_boundaries_count_as_sentence_boundaries():
    """Joining blocks with a space glues a heading onto the next sentence, which
    made Flesch report one 200-word sentence and a reading age nobody's copy
    actually has."""
    html = _page(body="<h2>Heading with no full stop</h2>"
                      + "<li>a short bullet</li>" * 12)
    sig = extract_page_signals(html, URL)
    assert sig["sentence_count"] >= 12
    assert sig["avg_sentence_words"] < 12, sig["avg_sentence_words"]


def test_flesch_declines_to_score_text_too_short_to_measure():
    assert flesch_reading_ease("Too short.") is None
    assert flesch_reading_ease("The cat sat on the mat. " * 12) > 60


# --- focus keywords --------------------------------------------------------

def test_keyword_is_inferred_from_the_slug_not_from_marketing_copy():
    """The slug is written by someone naming the topic; the H1 is written to
    persuade. Taking the H1's first non-stopwords produced phrases like
    "best solutions prepare business" — a guess so wrong that every placement
    check below then measured the guess instead of the page."""
    sig = extract_page_signals(_page(h1="Best Solutions To Prepare Your Business"), URL)
    assert infer_focus_keyword(sig) == "acumatica data migration"


def test_keyword_inference_falls_back_to_the_title_and_h1_overlap():
    sig = extract_page_signals(
        _page(title="Enterprise Cloud Backup | LST", h1="Enterprise Cloud Backup, Managed"),
        "https://ex.test/p/12345")
    assert infer_focus_keyword(sig) == "enterprise cloud backup"


def test_keyword_placement_reports_each_position_separately():
    sig = extract_page_signals(_page(), URL)
    result = analyse_keyword(sig, "acumatica data migration", inferred=False)
    by_id = {c["id"]: c["passed"] for c in result["checks"]}
    assert by_id["kw_title"] and by_id["kw_h1"] and by_id["kw_url"] and by_id["kw_intro"]
    assert by_id["kw_subheading"] is False, "the H2 in the fixture does not carry the keyword"
    assert result["score"] == round(result["passed"] / result["total"] * 100)


def test_density_is_not_judged_on_a_page_too_short_to_measure():
    """One mention of a one-word keyword on a 26-word page is 3.8%. Calling
    that stuffing is how a report loses its credibility."""
    sig = extract_page_signals(_page(body="<p>Careers here.</p>"), "https://ex.test/careers")
    result = analyse_keyword(sig, "careers", inferred=True)
    density_check = next(c for c in result["checks"] if c["id"] == "kw_density")
    assert density_check["passed"] is True
    assert "not meaningful" in density_check["hint"]


def test_keyword_matching_requires_whole_words():
    """A substring match passes "seo" on a page about seasons."""
    sig = extract_page_signals(_page(title="Seasonal Reporting | LST", h1="Seasonal Reporting"),
                               "https://ex.test/seasonal-reporting")
    result = analyse_keyword(sig, "seo", inferred=True)
    assert not next(c for c in result["checks"] if c["id"] == "kw_title")["passed"]


# --- robots.txt ------------------------------------------------------------

def _robots(raw: str) -> dict:
    out = {"exists": True, "raw": raw, "sitemaps": [], "groups": []}
    current = None
    for line in raw.splitlines():
        line = line.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        field, _, value = line.partition(":")
        field, value = field.strip().lower(), value.strip()
        if field == "user-agent":
            current = {"agents": [value], "allow": [], "disallow": [], "crawl_delay": None}
            out["groups"].append(current)
        elif field == "sitemap":
            out["sitemaps"].append(value)
        elif current is not None and field in ("allow", "disallow"):
            current[field].append(value)
    return out


def test_robots_longest_match_wins_and_allow_beats_disallow():
    """These are the rules search engines actually apply. Getting them wrong
    means reporting a crawlable page as blocked, or worse, the reverse."""
    r = _robots("User-agent: *\nDisallow: /admin\nDisallow: /api/\nAllow: /api/public\n")
    assert robots_blocks(r, "/admin/settings") == "/admin"
    assert robots_blocks(r, "/api/private") == "/api/"
    assert robots_blocks(r, "/api/public/docs") is None, "a longer Allow must win"
    assert robots_blocks(r, "/about") is None


def test_robots_rules_for_other_bots_do_not_apply_to_google():
    r = _robots("User-agent: SemrushBot\nDisallow: /\n")
    assert robots_blocks(r, "/anything") is None


def test_absent_robots_never_reports_a_block():
    assert robots_blocks({"exists": False, "groups": []}, "/x") is None


# --- crawl sampling --------------------------------------------------------

def test_priority_pages_survive_the_page_limit():
    """A sitemap's alphabetical order used to decide what got audited, so
    "no phone number found" could just mean "we never looked at /contact"."""
    urls = [f"https://ex.test/a{i}" for i in range(40)] + [
        "https://ex.test/", "https://ex.test/contact", "https://ex.test/about"]
    picked = [route_path(u) for u in prioritise(urls, 5)]
    assert picked[:3] == ["/", "/contact", "/about"], picked
    assert len(picked) == 5


# --- category scoring ------------------------------------------------------

def test_category_score_counts_a_warning_as_half_a_pass():
    checks = [{"status": "pass"}, {"status": "pass"}, {"status": "warn"}, {"status": "fail"}]
    assert score_from_checks(checks) == 62      # 2.5/4 = 62.5, banker's rounding
    assert score_from_checks([{"status": "info"}]) == 100, "info is not a judgement"
    assert score_from_checks([]) == 100


def _ctx(pages, **over):
    ctx = {
        "site": {"id": "s", "url": "https://ex.test"}, "base": "https://ex.test",
        "pages": pages, "ok_pages": [p for p in pages if p["ok"]],
        "robots": {"exists": False, "groups": [], "sitemaps": [], "raw": "", "url": "r"},
        "sitemap": {"found": False, "urls": [], "entries": [], "children": [], "tried": [],
                    "lastmod_count": 0, "url": None},
        "https": {"redirects_to_https": True, "final_url": "https://ex.test/"},
        "tls": {"ok": True, "days_left": 200, "issuer": "X"},
        "home_headers": {}, "url_source": "test", "link_results": {}, "link_sources": {},
        "og_image_checks": {}, "heavy_images": [], "broken_images": [], "psi": [],
        "history": [], "gsc": {}, "tracked_keywords": [],
    }
    ctx.update(over)
    return ctx


def _crawled(url, html=None, **over):
    sig = extract_page_signals(html or _page(), url)
    page = {"url": url, "path": route_path(url), "ok": True, "error": None, "status_code": 200,
            "final_url": url, "redirect_chain": [], "elapsed_ms": 120, "bytes": 40000,
            "headers": {}, "signals": sig,
            "keyword_analysis": analyse_keyword(sig, infer_focus_keyword(sig), inferred=True),
            "terms": []}
    from providers.onpage import score_page
    page.update(score_page(sig))
    page.update(over)
    return page


def test_duplicate_titles_are_reported_as_pages_competing_with_each_other():
    pages = [_crawled("https://ex.test/a"), _crawled("https://ex.test/b")]
    cat = sa.cat_keyword_content(_ctx(pages))
    chk = next(c for c in cat["checks"] if c["id"] == "unique_titles")
    assert chk["status"] == "fail" and chk["items"]


def test_orphan_pages_are_judged_only_within_the_crawl():
    linked = _crawled("https://ex.test/about")
    linker = _crawled("https://ex.test/")
    cat = sa.cat_internal_linking(_ctx([linker, linked]))
    chk = next(c for c in cat["checks"] if c["id"] == "orphans")
    # /about is linked from the fixture's nav; /contact is not in the crawl.
    assert chk["status"] == "pass", chk["detail"]
    assert "audited" in chk["detail"], "the claim must be scoped to what was crawled"


def test_noindex_plus_disallow_is_flagged_as_self_defeating():
    """Google cannot read a noindex on a page it is forbidden to fetch, so the
    URL can sit in the index indefinitely. The two directives together are a
    worse outcome than either alone."""
    page = _crawled("https://ex.test/thanks", _page(robots="noindex"))
    ctx = _ctx([page], robots=_robots("User-agent: *\nDisallow: /thanks\n"))
    cat = sa.cat_indexing(ctx)
    chk = next(c for c in cat["checks"] if c["id"] == "noindex_conflict")
    assert chk["status"] == "fail" and chk["items"]


def test_cross_domain_canonical_is_high_severity():
    page = _crawled("https://ex.test/a", _page(canonical="https://competitor.test/a"))
    cat = sa.cat_canonical(_ctx([page]))
    chk = next(c for c in cat["checks"] if c["id"] == "canonical_host")
    assert chk["status"] == "fail" and chk["severity"] == "high"


def test_relative_og_image_is_failed_because_the_preview_renders_blank():
    html = _page().replace('content="https://ex.test/og.png"', 'content="/og.png"')
    cat = sa.cat_social(_ctx([_crawled("https://ex.test/a", html)]))
    chk = next(c for c in cat["checks"] if c["id"] == "og_image_absolute")
    assert chk["status"] == "fail"


def test_missing_security_headers_are_reported_individually():
    cat = sa.cat_security(_ctx([_crawled("https://ex.test/")], home_headers={}))
    ids = {c["id"]: c["status"] for c in cat["checks"]}
    assert ids["hdr_strict_transport_security"] == "fail"      # high severity
    assert ids["hdr_referrer_policy"] == "warn"                # low severity
    assert ids["https_redirect"] == "pass"


def test_a_category_with_nothing_to_measure_scores_none_not_zero():
    """"We could not measure this" and "this is broken" are different answers,
    and conflating them either panics the user or falsely reassures them."""
    for builder in (sa.cat_keyword_content, sa.cat_on_page, sa.cat_internal_linking,
                    sa.cat_canonical, sa.cat_schema, sa.cat_local, sa.cat_social):
        cat = builder(_ctx([]))
        assert cat["score"] is None, builder.__name__


def test_performance_says_it_did_not_measure_rather_than_passing():
    cat = sa.cat_performance(_ctx([_crawled("https://ex.test/")], psi=[]))
    chk = next(c for c in cat["checks"] if c["id"] == "psi_not_run")
    assert chk["status"] == "info"


def test_report_orders_the_fix_list_by_severity_then_by_pages_affected():
    pages = [_crawled("https://ex.test/a"), _crawled("https://ex.test/b")]
    ctx = _ctx(pages)
    cats = [b(ctx) for b in sa.CATEGORY_BUILDERS]
    report = sa.build_report(cats, ctx)
    actions = report["actions"]
    assert actions, "a site with duplicate titles and no sitemap must produce actions"
    rank = {"high": 0, "medium": 1, "low": 2}
    keys = [(0 if a["status"] == "fail" else 1, rank[a["severity"]], -a["affected"])
            for a in actions]
    assert keys == sorted(keys), "the list is what people work through top-down"
    assert report["score"] is not None


# --- PageSpeed Insights ----------------------------------------------------

PSI_FIXTURE = {
    "lighthouseResult": {
        "categories": {"performance": {"score": 0.62}, "seo": {"score": 1.0},
                       "accessibility": {"score": 0.88}, "best-practices": {"score": 0.75}},
        "audits": {
            "largest-contentful-paint": {"numericValue": 4210.5, "displayValue": "4.2 s"},
            "cumulative-layout-shift": {"numericValue": 0.31, "displayValue": "0.31"},
            "total-blocking-time": {"numericValue": 150, "displayValue": "150 ms"},
            "first-contentful-paint": {"numericValue": 1700},
            "server-response-time": {"numericValue": 640, "displayValue": "640 ms"},
            "speed-index": {"numericValue": 3300},
            "viewport": {"title": "Has a viewport meta tag", "score": 1},
            "tap-targets": {"title": "Tap targets are sized appropriately", "score": 0.4,
                            "description": "Interactive elements are too close together."},
            "unused-javascript": {"title": "Reduce unused JavaScript",
                                  "description": "Ship less JS.",
                                  "details": {"type": "opportunity", "overallSavingsMs": 1800}},
            "tiny-win": {"title": "Barely matters",
                         "details": {"type": "opportunity", "overallSavingsMs": 40}},
        },
    },
    "loadingExperience": {
        "overall_category": "AVERAGE",
        "metrics": {
            "LARGEST_CONTENTFUL_PAINT_MS": {"percentile": 3100, "category": "AVERAGE"},
            "INTERACTION_TO_NEXT_PAINT": {"percentile": 180, "category": "FAST"},
            "CUMULATIVE_LAYOUT_SHIFT_SCORE": {"percentile": 12, "category": "AVERAGE"},
        },
    },
}


class _FakeResp:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload

    def json(self):
        return self._payload


class _FakeClient:
    def __init__(self, resp):
        self._resp = resp

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, *a, **k):
        return self._resp


def test_psi_response_is_parsed_into_lab_field_and_opportunities(monkeypatch):
    monkeypatch.setattr(sa.httpx, "AsyncClient",
                        lambda *a, **k: _FakeClient(_FakeResp(200, PSI_FIXTURE)))
    r = _run(run_psi("https://ex.test/", "mobile"))
    assert r["ok"] and r["performance_score"] == 62 and r["seo_score"] == 100
    assert r["lab"]["lcp_ms"] == 4210.5 and r["lab"]["cls"] == 0.31
    assert r["field"]["inp"] == {"percentile": 180, "category": "FAST"}
    assert r["field"]["overall"] == "AVERAGE"
    assert [o["id"] for o in r["opportunities"]] == ["unused-javascript"], \
        "sub-100ms savings are noise and must be dropped"
    assert "tap-targets" in r["mobile_audits"]


def test_psi_bands_follow_googles_published_thresholds(monkeypatch):
    monkeypatch.setattr(sa.httpx, "AsyncClient",
                        lambda *a, **k: _FakeClient(_FakeResp(200, PSI_FIXTURE)))
    psi = _run(run_psi("https://ex.test/", "mobile"))
    cat = sa.cat_performance(_ctx([_crawled("https://ex.test/")], psi=[psi]))
    by_id = {c["id"]: c for c in cat["checks"]}
    assert by_id["cwv_lcp"]["status"] == "fail", "4.2 s is past the 4 s poor threshold"
    assert by_id["cwv_cls"]["status"] == "fail", "0.31 is past the 0.25 poor threshold"
    assert by_id["cwv_tbt"]["status"] == "pass", "150 ms is inside the 200 ms good band"
    assert by_id["cwv_field"]["status"] == "warn", "CrUX says AVERAGE"
    assert by_id["perf_score_mobile"]["status"] == "warn"


def test_psi_rate_limit_is_reported_with_the_fix_not_swallowed(monkeypatch):
    """The keyless quota is shared and routinely exhausted. Silently scoring
    the section as if it passed would hide the one thing the user must do."""
    payload = {"error": {"message": "Quota exceeded for quota metric 'Queries'"}}
    monkeypatch.setattr(sa.httpx, "AsyncClient",
                        lambda *a, **k: _FakeClient(_FakeResp(429, payload)))
    r = _run(run_psi("https://ex.test/", "mobile"))
    assert r["ok"] is False
    assert "429" in r["error"] and "API key" in r["error"]

    cat = sa.cat_performance(_ctx([_crawled("https://ex.test/")], psi=[r]))
    chk = next(c for c in cat["checks"] if c["id"] == "psi_failed")
    assert chk["status"] == "warn" and "Quota exceeded" in chk["detail"]
