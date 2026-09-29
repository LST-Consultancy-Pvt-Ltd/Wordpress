"""On-page SEO: audit and metadata editing workspace.

Every signal is sourced from what a crawler sees — the rendered HTML of the
live URL, the response headers, robots.txt, the sitemap and the PageSpeed
Insights API — so scores reflect what search engines actually receive.

Edits never write directly: metadata changes become change sets (plan →
review → approve → apply on the bridge). The bridge reports per route
whether the page opted in to runtime metadata; an override on a route that
has not opted in is flagged in the plan rather than shown as effective.
"""
import csv
import io
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict

from core.activity import log_activity
from core.crypto import get_decrypted_settings
from core.db import db
from core.http_headers import BROWSER_HEADERS
from core.router import api_router
from core.security import require_editor, require_user
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from core.changesets import create_changeset
from providers.bridge_client import BridgeError, capability_enabled
from providers.sites import get_site, get_site_and_client
from providers.onpage import SCORING_FACTORS, audit_url  # noqa: F401  (audit_url re-exported)
from providers import seo_audit
from providers.seo_audit import (
    extract_page_signals, fetch_document, fetch_robots, fetch_sitemaps, route_path,
    run_full_audit, score_page,
)

logger = logging.getLogger(__name__)

MAX_PAGES_PER_SCAN = 25
HARD_PAGE_LIMIT = 200


def _route_path(url: str) -> str:
    """The override store is keyed by route path; audits record full URLs."""
    return route_path(url)


class MetaUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    path: str = ""                      # route path, e.g. "/about"
    url: str = ""                       # or a full URL, converted to a path
    title: Optional[str] = None
    description: Optional[str] = None
    canonical: Optional[str] = None
    ogTitle: Optional[str] = None
    ogDescription: Optional[str] = None
    ogImage: Optional[str] = None
    noindex: Optional[bool] = None
    jsonLd: Optional[list[dict]] = None


class MovePage(BaseModel):
    model_config = ConfigDict(extra="ignore")
    from_path: str = ""
    to_path: str = ""


class FocusKeyword(BaseModel):
    model_config = ConfigDict(extra="ignore")
    path: str = ""
    url: str = ""
    keyword: str = ""
    secondary: list[str] = []
    intent: str = ""                    # informational / commercial / transactional / navigational


class OnPageScanRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    urls: list[str] = []                # explicit list wins; otherwise auto-discovered
    max_pages: int = MAX_PAGES_PER_SCAN
    check_links: bool = True            # verify every internal + external link
    measure_cwv: bool = False           # PageSpeed Insights; 20–40s per URL
    psi_sample: int = 3                 # how many URLs to measure when it is on


async def _discover_urls(site: dict, limit: int) -> tuple[list[str], str]:
    """Page list for this site, preferring the sitemap (authoritative and
    platform-neutral) and falling back to homepage links then synced content.
    Returns (urls, source) so the UI can say where the list came from rather
    than implying a completeness it cannot guarantee."""
    base = (site.get("base_url") or "").rstrip("/")
    if not base:
        return [], "none"
    cached = [d["url"] for d in await db.content_items.find(
        {"site_id": site["id"], "url": {"$nin": [None, ""]}}, {"_id": 0, "url": 1}
    ).to_list(limit) if d.get("url")]
    async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers=BROWSER_HEADERS) as client:
        robots = await fetch_robots(client, base)
        sitemap = await fetch_sitemaps(client, base, robots.get("sitemaps"))
        return await seo_audit.discover_urls(client, base, sitemap, limit, cached)


async def _focus_keywords(site_id: str) -> dict[str, dict]:
    docs = await db.onpage_keywords.find({"site_id": site_id}, {"_id": 0}).to_list(1000)
    return {d["path"]: d for d in docs}


async def _gsc_snapshot(site: dict) -> dict:
    """Live Search Console data when credentials are configured. Never invents
    a connection: without credentials the report says so and explains what to
    add, rather than presenting inference as Google's own numbers."""
    try:
        settings = await get_decrypted_settings()
    except Exception as e:
        return {"connected": False, "error": f"Could not read settings: {e}"}
    if not (settings.get("google_search_console_credentials")
            or settings.get("google_analytics_credentials")):
        return {"connected": False,
                "error": "No Search Console credentials configured. Add a Google service-account "
                         "JSON and gsc_site_url in Settings."}
    property_url = settings.get("gsc_site_url") or (site.get("base_url") or "")
    try:
        from providers.google_analytics import fetch_gsc_metrics
        rows = await fetch_gsc_metrics(settings, property_url)
    except Exception as e:
        return {"connected": False, "error": f"Search Console request failed: {e}",
                "property": property_url}
    if not rows:
        return {"connected": False, "property": property_url,
                "error": f"Search Console returned no rows for {property_url}. The property URL must "
                         f"match how it is verified in Search Console, exactly."}
    return {
        "connected": True, "property": property_url,
        "clicks": sum(r.get("clicks", 0) for r in rows),
        "impressions": sum(r.get("impressions", 0) for r in rows),
        "indexed_count": len({r.get("page_url", "") for r in rows if r.get("page_url")}),
        "queries": sorted(rows, key=lambda r: -r.get("clicks", 0))[:50],
    }


@api_router.post("/onpage/{site_id}/scan")
async def scan_onpage_seo(site_id: str, req: OnPageScanRequest, background_tasks: BackgroundTasks,
                          user=Depends(require_editor)):
    """Crawl the site's live pages and evaluate every SEO category."""
    site = await get_site(site_id)
    task_id = make_task_id()
    await create_task_queue(task_id, task_type="onpage_audit", site_id=site_id)

    async def run(tid):
        try:
            limit = max(1, min(req.max_pages, HARD_PAGE_LIMIT))

            async def progress(message: str, current: int = 0, total: int = 0):
                await push_event(tid, "progress", {"message": message,
                                                   "current": current, "total": total})

            keywords = await _focus_keywords(site_id)
            history = await db.onpage_audits.find(
                {"site_id": site_id}, {"_id": 0, "created_at": 1, "site_score": 1,
                                       "overall_score": 1, "pages_audited": 1},
            ).sort("created_at", 1).to_list(50)
            tracked = await db.keyword_tracking.find({"site_id": site_id}, {"_id": 0}).to_list(200)
            cached = [d["url"] for d in await db.content_items.find(
                {"site_id": site_id, "url": {"$nin": [None, ""]}}, {"_id": 0, "url": 1}
            ).to_list(limit) if d.get("url")]

            psi_key = ""
            if req.measure_cwv:
                try:
                    settings = await get_decrypted_settings()
                    psi_key = settings.get("pagespeed_api_key") or ""
                except Exception:
                    psi_key = ""

            gsc = await _gsc_snapshot(site)

            audit = await run_full_audit(
                site,
                max_pages=limit,
                urls=req.urls or None,
                check_links=req.check_links,
                measure_cwv=req.measure_cwv,
                psi_sample=req.psi_sample,
                psi_api_key=psi_key,
                focus_keywords={p: (d.get("keyword") or "") for p, d in keywords.items()},
                cached_urls=cached,
                history=history,
                tracked_keywords=tracked,
                gsc=gsc,
                progress=progress,
            )
            audit["id"] = str(uuid.uuid4())
            audit["site_id"] = site_id
            await db.onpage_audits.insert_one(dict(audit))
            await log_activity(site_id, "onpage_audit",
                               f"SEO audit: {audit['pages_audited']} pages, "
                               f"overall score {audit['overall_score']}")
            failing = sum(1 for a in (audit["categories"][-1].get("actions") or [])
                          if a["status"] == "fail")
            await push_event(tid, "complete", {
                "message": f"Audited {audit['pages_audited']} pages — overall score "
                           f"{audit['overall_score']}/100, {failing} failing checks.",
                "site_score": audit["site_score"], "overall_score": audit["overall_score"],
                "pages_audited": audit["pages_audited"], "pages_failed": audit["pages_failed"],
                "audit_id": audit["id"],
            })
        except Exception as e:
            logger.exception(f"On-page audit failed for {site_id}")
            await push_event(tid, "error", {"message": str(e)})
        finally:
            await finish_task(tid)

    background_tasks.add_task(run, task_id)
    return {"task_id": task_id}


@api_router.get("/onpage/{site_id}")
async def get_onpage_audit(site_id: str, user=Depends(require_user)):
    """The most recent audit for this site, in full."""
    doc = await db.onpage_audits.find_one({"site_id": site_id}, {"_id": 0}, sort=[("created_at", -1)])
    if not doc:
        return {"site_id": site_id, "site_score": None, "overall_score": None, "pages": [],
                "categories": [], "factor_summary": [], "pages_audited": 0,
                "message": "No audit yet — run a scan."}
    return doc


@api_router.get("/onpage/{site_id}/summary")
async def get_onpage_summary(site_id: str, user=Depends(require_user)):
    """Scores and headline counts only — small enough to render the tab strip
    without shipping every page row."""
    doc = await db.onpage_audits.find_one({"site_id": site_id}, {"_id": 0}, sort=[("created_at", -1)])
    if not doc:
        return {"site_id": site_id, "overall_score": None, "categories": [],
                "message": "No audit yet — run a scan."}
    return {
        "site_id": site_id,
        "created_at": doc.get("created_at"),
        "site_score": doc.get("site_score"),
        "overall_score": doc.get("overall_score"),
        "pages_audited": doc.get("pages_audited"),
        "pages_failed": doc.get("pages_failed"),
        "url_source": doc.get("url_source"),
        "options": doc.get("options", {}),
        "factor_summary": doc.get("factor_summary", []),
        "categories": [{
            "key": c["key"], "label": c["label"], "score": c.get("score"),
            "summary": c.get("summary", ""),
            "failing": sum(1 for k in c.get("checks", []) if k["status"] == "fail"),
            "warning": sum(1 for k in c.get("checks", []) if k["status"] == "warn"),
            "passing": sum(1 for k in c.get("checks", []) if k["status"] == "pass"),
        } for c in doc.get("categories", [])],
    }


@api_router.get("/onpage/{site_id}/category/{key}")
async def get_onpage_category(site_id: str, key: str, user=Depends(require_user)):
    """One category in full, so the UI fetches detail only for the open tab."""
    doc = await db.onpage_audits.find_one({"site_id": site_id}, {"_id": 0}, sort=[("created_at", -1)])
    if not doc:
        raise HTTPException(status_code=404, detail="No audit yet — run a scan first.")
    for cat in doc.get("categories", []):
        if cat["key"] == key:
            return {**cat, "created_at": doc.get("created_at")}
    raise HTTPException(status_code=404, detail=f"No category '{key}' in the latest audit.")


META_FIELDS = ("title", "description", "canonical", "robots", "openGraph", "jsonLd")


async def _bridge_metadata_state(site_id: str) -> dict:
    """Current overrides and per-route opt-in status, read from the bridge."""
    site, client = await get_site_and_client(site_id)
    state = {"site": site, "overrides": {}, "opted_in": {}, "supported": capability_enabled(site, "metadata.write"),
             "error": None}
    if not state["supported"]:
        state["error"] = ("This site's bridge does not offer runtime metadata (capability 'metadata.write'). "
                          "Enable the metadata store on the bridge and opt pages in with withAutomationMetadata().")
        return state
    try:
        meta = await client.request("GET", "/inventory/metadata")
        state["overrides"] = {i["route"]: i.get("fields") or {} for i in meta.get("items", [])}
        routes = await client.request("GET", "/inventory/routes")
        state["opted_in"] = {r["route"]: r.get("metadata") == "generateMetadata-optin"
                             for r in routes.get("items", [])}
    except BridgeError as e:
        state["supported"], state["error"] = False, f"{e.code}: {e.message}"
    return state


@api_router.get("/onpage/{site_id}/pages")
async def list_onpage_pages(site_id: str, user=Depends(require_user)):
    """Every page known for this site, with its latest score, its focus
    keyword and the runtime metadata override currently stored for it."""
    site = await get_site(site_id)

    audit = await db.onpage_audits.find_one({"site_id": site_id}, {"_id": 0}, sort=[("created_at", -1)])
    by_url: dict[str, dict] = {}
    for page in (audit or {}).get("pages", []):
        by_url[page["url"]] = page

    audited = bool(by_url)
    if not by_url:
        # No audit has run yet — list the pages we know about so they can still
        # be browsed and edited, explicitly flagged as un-audited rather than
        # left to look like fetch failures.
        urls, _source = await _discover_urls(site, MAX_PAGES_PER_SCAN)
        for u in urls:
            by_url[u] = {"url": u, "score": None, "issues": [], "ok": None, "audited": False}

    state = await _bridge_metadata_state(site_id)
    keywords = await _focus_keywords(site_id)

    pages = []
    for url, page in by_url.items():
        route = _route_path(url)
        signals = page.get("signals") or {}
        kw = keywords.get(route) or {}
        pages.append({
            "url": url,
            "path": route,
            "score": page.get("score"),
            # `audited` distinguishes "we fetched it and it failed" from "we
            # have never looked at it".
            "audited": page.get("audited", audited),
            "ok": page.get("ok"),
            "error": page.get("error"),
            "signals": signals or None,
            "issue_count": len(page.get("issues") or []),
            "issues": page.get("issues") or [],
            "live_title": signals.get("title", ""),
            "live_description": signals.get("description", ""),
            "override": state["overrides"].get(route),
            "metadata_opted_in": state["opted_in"].get(route),
            "focus_keyword": kw.get("keyword", ""),
            "secondary_keywords": kw.get("secondary", []),
            "search_intent": kw.get("intent", ""),
            "keyword_analysis": page.get("keyword_analysis"),
        })
    pages.sort(key=lambda p: (p["score"] is None, p["score"] if p["score"] is not None else 0))

    return {
        "site_id": site_id,
        "pages": pages,
        "meta_editing_supported": state["supported"],
        "meta_editing_note": state["error"],
        "audited_at": (audit or {}).get("created_at"),
    }


@api_router.get("/onpage/{site_id}/meta-capabilities")
async def get_meta_capabilities(site_id: str, user=Depends(require_user)):
    """Which metadata fields can be edited, and on which routes they take
    effect, so the UI never offers an edit that would be silently ignored."""
    state = await _bridge_metadata_state(site_id)
    return {
        "supported": state["supported"],
        "supported_fields": list(META_FIELDS) if state["supported"] else [],
        "opted_in_routes": sorted(r for r, ok in state["opted_in"].items() if ok),
        "not_opted_in_routes": sorted(r for r, ok in state["opted_in"].items() if not ok),
        "note": state["error"],
    }


def _normalise_route(raw: str) -> str:
    raw = (raw or "").strip()
    # Accept a full URL and always reduce it to a route path; a URL stored as
    # the key would never match the route the site looks up.
    return _route_path(raw) if "://" in raw else _route_path("http://x" + (raw if raw.startswith("/") else "/" + raw))


def _merge_meta(existing: dict, body: "MetaUpdate") -> dict:
    fields = {k: v for k, v in (existing or {}).items() if k in META_FIELDS}
    if body.title is not None:
        fields["title"] = body.title
    if body.description is not None:
        fields["description"] = body.description
    if body.canonical is not None:
        fields["canonical"] = body.canonical
    og = dict(fields.get("openGraph") or {})
    for src, dst in (("ogTitle", "title"), ("ogDescription", "description"), ("ogImage", "image")):
        value = getattr(body, src)
        if value is not None:
            og[dst] = value
    if og:
        fields["openGraph"] = og
    if body.noindex is not None:
        fields["robots"] = {"index": not body.noindex, "follow": True}
    if body.jsonLd is not None:
        fields["jsonLd"] = body.jsonLd
    return {k: v for k, v in fields.items() if v not in (None, "", {}, [])}


@api_router.put("/onpage/{site_id}/meta")
async def set_onpage_meta(site_id: str, body: MetaUpdate, user=Depends(require_editor)):
    """Propose metadata for one page. Creates a change set; nothing changes on
    the site until it is approved and applied."""
    raw = body.path.strip() or body.url.strip()
    if not raw:
        raise HTTPException(status_code=400, detail="Supply either `path` (e.g. \"/about\") or `url`.")
    route = _normalise_route(raw)
    state = await _bridge_metadata_state(site_id)
    if not state["supported"]:
        raise HTTPException(status_code=422, detail={"code": "CAPABILITY_UNSUPPORTED", "capability": "metadata.write",
                                                     "message": state["error"]})
    fields = _merge_meta(state["overrides"].get(route) or {}, body)
    if not fields:
        raise HTTPException(status_code=400, detail="Nothing to set — supply at least one field, e.g. `title`.")
    cs = await create_changeset(site_id, title=f"Metadata for {route}", source="onpage-seo", actor=user,
                                operations=[{"op": "metadata.set", "route": route, "fields": fields}],
                                description=f"Fields: {', '.join(sorted(fields))}")
    await log_activity(site_id, "onpage_meta_proposed", f"Proposed SEO metadata for {route} ({cs['id']})",
                       user_id=user["id"])
    return {"changeset": cs, "route": route, "opted_in": state["opted_in"].get(route)}


@api_router.delete("/onpage/{site_id}/meta")
async def clear_onpage_meta(site_id: str, path: str, user=Depends(require_editor)):
    """Propose removing the override for a route, handing control back to the
    page's own generateMetadata()."""
    route = _normalise_route(path)
    cs = await create_changeset(site_id, title=f"Clear metadata override for {route}", source="onpage-seo",
                                actor=user, operations=[{"op": "metadata.clear", "route": route}])
    return {"changeset": cs, "route": route}


@api_router.post("/onpage/{site_id}/move-page")
async def move_page(site_id: str, body: MovePage, user=Depends(require_editor)):
    """Propose moving a page's stored metadata override to a new route plus a
    301 from the old route, and move its focus keyword. The route itself is a
    folder in the Next.js repo: renaming it is a code change (a `file.*`
    change set from the code workspace, or a normal commit) and a deploy."""
    old_raw, new_raw = body.from_path.strip(), body.to_path.strip()
    if not old_raw or not new_raw:
        raise HTTPException(status_code=400, detail="Supply both `from_path` and `to_path`, e.g. "
                             "\"/about\" and \"/company/about\".")
    old, new = _normalise_route(old_raw), _normalise_route(new_raw)
    if old == new:
        raise HTTPException(status_code=400, detail="from_path and to_path are the same route.")
    state = await _bridge_metadata_state(site_id)
    site = state["site"]
    ops: list[dict] = []
    fields = state["overrides"].get(old)
    if fields:
        ops += [{"op": "metadata.set", "route": new, "fields": fields}, {"op": "metadata.clear", "route": old}]
    if capability_enabled(site, "redirects.write"):
        ops.append({"op": "redirect.upsert", "source": old, "destination": new, "permanent": True})
    cs = None
    if ops:
        cs = await create_changeset(site_id, title=f"Move {old} to {new}", source="onpage-seo", actor=user,
                                    operations=ops, require_capabilities=True)
    kw = await db.onpage_keywords.find_one({"site_id": site_id, "path": old})
    if kw:
        await db.onpage_keywords.delete_many({"site_id": site_id, "path": new})
        await db.onpage_keywords.update_one({"_id": kw["_id"]}, {"$set": {"path": new}})
    await log_activity(site_id, "onpage_page_move_proposed", f"Proposed moving {old} to {new}", user_id=user["id"])
    return {
        "from_path": old, "to_path": new, "changeset": cs, "focus_keyword_moved": bool(kw),
        "instructions": [
            f"Rename the route folder in the Next.js repo so {old} becomes {new} "
            f"(e.g. git mv app{old.rstrip('/') or '/(home)'} app{new.rstrip('/')}), then deploy.",
        ] + ([] if capability_enabled(site, "redirects.write") else [
            "This bridge cannot manage redirects; add the redirect below to next.config.mjs in the same deploy.",
        ]),
        "redirect_snippet": None if capability_enabled(site, "redirects.write") else _redirects_snippet([(old, new)]),
    }


# --- Focus keywords ---------------------------------------------------------
# Stored here rather than on the site, because a keyword is a decision about
# intent that no crawl can read off the page. Without it the analysis falls
# back to a keyword inferred from the H1, and says so.

@api_router.get("/onpage/{site_id}/keywords")
async def list_focus_keywords(site_id: str, user=Depends(require_user)):
    await get_site(site_id)
    docs = await db.onpage_keywords.find({"site_id": site_id}, {"_id": 0}).to_list(1000)
    return {"site_id": site_id, "keywords": docs}


@api_router.put("/onpage/{site_id}/keyword")
async def set_focus_keyword(site_id: str, body: FocusKeyword, user=Depends(require_editor)):
    """Assign the focus keyword (and optional secondary keywords / intent) for
    one page. Re-scores that page's keyword placement immediately."""
    await get_site(site_id)
    raw = body.path.strip() or body.url.strip()
    if not raw:
        raise HTTPException(status_code=400, detail="Supply either `path` or `url`.")
    route = _route_path(raw) if "://" in raw else _route_path(
        "http://x" + (raw if raw.startswith("/") else "/" + raw))
    keyword = body.keyword.strip()
    if not keyword:
        raise HTTPException(status_code=400, detail="`keyword` cannot be empty — use DELETE to clear it.")

    doc = {"site_id": site_id, "path": route, "keyword": keyword,
           "secondary": [s.strip() for s in body.secondary if s.strip()],
           "intent": body.intent.strip(),
           "updated_at": datetime.now(timezone.utc).isoformat()}
    await db.onpage_keywords.update_one({"site_id": site_id, "path": route},
                                        {"$set": doc}, upsert=True)
    await log_activity(site_id, "onpage_keyword_set", f"Focus keyword for {route}: {keyword}")

    # Re-analyse the live page against the new keyword so the answer is about
    # the page as it stands, not as it was at the last crawl.
    analysis = None
    site = await get_site(site_id)
    page_url = f"{(site.get('url') or '').rstrip('/')}{route}"
    try:
        async with httpx.AsyncClient(timeout=25, follow_redirects=True,
                                     headers=BROWSER_HEADERS) as client:
            fetched = await fetch_document(client, page_url)
        if fetched.get("ok"):
            sig = extract_page_signals(fetched["html"], page_url, fetched.get("headers"))
            analysis = seo_audit.analyse_keyword(sig, keyword, inferred=False)
    except Exception as e:
        logger.warning(f"Could not re-analyse {page_url} for keyword '{keyword}': {e}")

    return {**doc, "keyword_analysis": analysis}


@api_router.delete("/onpage/{site_id}/keyword")
async def clear_focus_keyword(site_id: str, path: str, user=Depends(require_editor)):
    await get_site(site_id)
    route = _route_path(path) if "://" in path else _route_path(
        "http://x" + (path if path.startswith("/") else "/" + path))
    result = await db.onpage_keywords.delete_one({"site_id": site_id, "path": route})
    if not result.deleted_count:
        raise HTTPException(status_code=404, detail=f"No focus keyword set for {route}.")
    await log_activity(site_id, "onpage_keyword_cleared", f"Cleared focus keyword for {route}")
    return {"cleared": route}


@api_router.get("/onpage/{site_id}/history")
async def get_onpage_history(site_id: str, user=Depends(require_user)):
    """Score over time, so improvements are visible rather than asserted."""
    docs = await db.onpage_audits.find(
        {"site_id": site_id},
        {"_id": 0, "created_at": 1, "site_score": 1, "overall_score": 1, "pages_audited": 1},
    ).sort("created_at", -1).to_list(50)
    return list(reversed(docs))


@api_router.post("/onpage/{site_id}/page")
async def audit_single_page(site_id: str, req: OnPageScanRequest, user=Depends(require_editor)):
    """Audit one URL immediately, without a background task. Returns the full
    signal set as well as the ten-factor score, so a single page can be
    inspected after an edit without re-crawling the site."""
    site = await get_site(site_id)
    if not req.urls:
        raise HTTPException(status_code=400, detail="Supply a URL in `urls`.")
    url = req.urls[0]
    if not url.startswith("http"):
        url = f"{(site.get('url') or '').rstrip('/')}{url if url.startswith('/') else '/' + url}"

    async with httpx.AsyncClient(timeout=25, follow_redirects=True, headers=BROWSER_HEADERS) as client:
        doc = await fetch_document(client, url)
    if not doc.get("ok"):
        return {"url": url, "ok": False, "status_code": doc.get("status_code"),
                "error": doc.get("error"), "score": None, "issues": [], "factor_scores": {}}

    signals = extract_page_signals(doc["html"], url, doc.get("headers"))
    scored = score_page(signals)
    keywords = await _focus_keywords(site_id)
    stored = (keywords.get(route_path(url)) or {}).get("keyword", "")
    keyword = stored or seo_audit.infer_focus_keyword(signals)
    return {
        "url": url, "path": route_path(url), "ok": True,
        "status_code": doc.get("status_code"), "final_url": doc.get("final_url"),
        "redirect_chain": doc.get("redirect_chain"), "elapsed_ms": doc.get("elapsed_ms"),
        "bytes": doc.get("bytes"), "error": None,
        "signals": {k: v for k, v in signals.items() if k not in ("text", "schema_objects")},
        **scored,
        "keyword_analysis": seo_audit.analyse_keyword(signals, keyword, inferred=not stored),
        "terms": seo_audit.content_terms(signals),
    }


@api_router.get("/onpage/{site_id}/export")
async def export_onpage_audit(site_id: str, kind: str = Query("actions", pattern="^(actions|pages|checks)$"),
                              user=Depends(require_user)):
    """The audit as CSV — the prioritised fix list, the per-page scores, or
    every check. Reporting people can hand to someone who does not have a
    login is the point of an audit."""
    doc = await db.onpage_audits.find_one({"site_id": site_id}, {"_id": 0}, sort=[("created_at", -1)])
    if not doc:
        raise HTTPException(status_code=404, detail="No audit yet — run a scan first.")

    buf = io.StringIO()
    writer = csv.writer(buf)
    if kind == "actions":
        writer.writerow(["Priority", "Status", "Severity", "Category", "Finding", "Pages affected", "Detail"])
        actions = (doc["categories"][-1].get("actions") if doc.get("categories") else []) or []
        for idx, a in enumerate(actions, start=1):
            writer.writerow([idx, a["status"], a["severity"], a["category"], a["label"],
                             a["affected"], a["detail"]])
    elif kind == "pages":
        writer.writerow(["URL", "Path", "Score", "Status", "Title", "Title length",
                         "Description", "Description length", "H1", "H1 count", "Words",
                         "Images", "Images missing alt", "Canonical", "Noindex", "Issues"])
        for p in doc.get("pages", []):
            s = p.get("signals") or {}
            writer.writerow([p["url"], p.get("path", ""), p.get("score"),
                             p.get("status_code") or p.get("error") or "",
                             s.get("title", ""), s.get("title_length", ""),
                             s.get("description", ""), s.get("description_length", ""),
                             s.get("h1", ""), s.get("h1_count", ""), s.get("word_count", ""),
                             s.get("image_count", ""), s.get("images_missing_alt", ""),
                             s.get("canonical", ""), s.get("noindex", ""),
                             len(p.get("issues") or [])])
    else:
        writer.writerow(["Category", "Category score", "Check", "Status", "Severity", "Detail", "Value"])
        for cat in doc.get("categories", []):
            for chk in cat.get("checks", []):
                writer.writerow([cat["label"], cat.get("score"), chk["label"], chk["status"],
                                 chk["severity"], chk["detail"], chk.get("value")])

    stamp = (doc.get("created_at") or "")[:10]
    filename = f"seo-audit-{kind}-{stamp or 'latest'}.csv"
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# --- Code-owned fixes -------------------------------------------------------
# Some SEO surfaces genuinely cannot be edited from outside a Next.js repo:
# robots.txt and the sitemap are generated by app/robots.ts and app/sitemap.ts,
# redirects live in next.config, and canonical/noindex live in the page's own
# generateMetadata(). Rather than pretend those are editable here — or leave
# the audit pointing at problems with no route to a fix — the findings are
# turned into the exact code to paste, pre-filled with this site's own values.

def _robots_snippet(site_url: str, robots: dict, disallow: list[str]) -> str:
    rules = "\n".join(f'        "{d}",' for d in disallow) or '        "/api/",'
    return f'''// app/robots.ts — replaces a static public/robots.txt
import type {{ MetadataRoute }} from "next";

export default function robots(): MetadataRoute.Robots {{
  return {{
    rules: {{
      userAgent: "*",
      allow: "/",
      disallow: [
{rules}
      ],
    }},
    sitemap: "{site_url}/sitemap.xml",
    host: "{site_url}",
  }};
}}'''


def _sitemap_snippet(site_url: str) -> str:
    return f'''// app/sitemap.ts — a lastmod on every entry, which the audit checks for
import type {{ MetadataRoute }} from "next";
import {{ getAllPages, getAllPosts }} from "@/lib/content";   // your own loaders

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {{
  const base = "{site_url}";
  const pages = await getAllPages();
  const posts = await getAllPosts();

  return [
    {{ url: `${{base}}/`, lastModified: new Date(), changeFrequency: "weekly", priority: 1 }},
    ...pages.map((p) => ({{
      url: `${{base}}/${{p.slug}}/`,
      // A real timestamp, not new Date() — an always-now lastmod teaches
      // crawlers to ignore the field entirely.
      lastModified: new Date(p.updatedAt ?? p.publishedAt),
      changeFrequency: "monthly" as const,
      priority: 0.8,
    }})),
    ...posts.map((p) => ({{
      url: `${{base}}/blog/${{p.slug}}/`,
      lastModified: new Date(p.updatedAt ?? p.date),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    }})),
  ];
}}'''


def _redirects_snippet(pairs: list[tuple[str, str]]) -> str:
    if not pairs:
        return ("// No 404s or redirect chains were found in this crawl, so there is nothing to add.\n"
                "// When a URL does change, add it here rather than leaving the old one dead:\n"
                "//   { source: \"/old-path\", destination: \"/new-path\", permanent: true }")
    entries = "\n".join(
        f'      {{ source: "{src}", destination: "{dst}", permanent: true }},' for src, dst in pairs)
    return f'''// next.config.mjs — permanent: true emits a 301, which moves ranking signals.
// A 302 (permanent: false) tells Google to keep the OLD url indexed.
const nextConfig = {{
  async redirects() {{
    return [
{entries}
    ];
  }},
}};

export default nextConfig;'''


def _metadata_snippet(site_url: str, examples: list[dict]) -> str:
    ex = examples[0] if examples else {"path": "/about", "title": "About Us | Your Brand",
                                       "description": "A 150–160 character summary of this page."}
    return f'''// app/{ex["path"].strip("/") or "(home)"}/page.tsx
// Canonical, noindex and the OG title/description live here — the SEO Bridge
// stores the title, description and OG image, but these fields are code.
import type {{ Metadata }} from "next";

const PATH = "{ex["path"]}";

export const metadata: Metadata = {{
  title: {ex.get("title", "")!r},
  description: {ex.get("description", "")!r},
  alternates: {{
    // Self-referencing, absolute, and matching the URL you actually serve
    // (mind the trailing slash — a mismatch creates the duplicate the
    // canonical was meant to prevent).
    canonical: `{site_url}${{PATH}}/`,
  }},
  openGraph: {{
    title: {ex.get("title", "")!r},
    description: {ex.get("description", "")!r},
    url: `{site_url}${{PATH}}/`,
    siteName: "Your Brand",
    images: [{{ url: "{site_url}/og/default.png", width: 1200, height: 630 }}],
    type: "website",
  }},
  twitter: {{ card: "summary_large_image" }},
  // Only for pages that must stay out of the index — thank-you pages,
  // internal search results, utility pages.
  // robots: {{ index: false, follow: true }},
}};'''


def _schema_snippet(site_url: str, missing_types: list[str]) -> str:
    wants_local = "LocalBusiness" in missing_types or "Organization" in missing_types
    body = f'''// app/layout.tsx — one JSON-LD block per real entity on the page.
// Never mark up something the page does not actually contain: mismatched
// structured data is a manual-action risk, not a free rich result.
const organization = {{
  "@context": "https://schema.org",
  "@type": "{'LocalBusiness' if wants_local else 'Organization'}",
  name: "Your Brand",
  url: "{site_url}",
  logo: "{site_url}/logo.png",
  sameAs: ["https://www.linkedin.com/company/your-brand"],'''
    if wants_local:
        body += '''
  telephone: "+971-4-000-0000",
  address: {
    "@type": "PostalAddress",
    streetAddress: "Office 000, Building",
    addressLocality: "Dubai",
    addressCountry: "AE",
  },
  geo: { "@type": "GeoCoordinates", latitude: 25.2048, longitude: 55.2708 },
  openingHoursSpecification: [{
    "@type": "OpeningHoursSpecification",
    dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    opens: "09:00", closes: "18:00",
  }],'''
    body += '''
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organization) }}
        />
        {children}
      </body>
    </html>
  );
}'''
    return body


def _security_headers_snippet(missing: list[str]) -> str:
    known = {
        "strict-transport-security": ("Strict-Transport-Security",
                                      "max-age=63072000; includeSubDomains; preload"),
        "content-security-policy": ("Content-Security-Policy",
                                    "default-src 'self'; img-src 'self' data: https:; "
                                    "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"),
        "x-content-type-options": ("X-Content-Type-Options", "nosniff"),
        "x-frame-options": ("X-Frame-Options", "SAMEORIGIN"),
        "referrer-policy": ("Referrer-Policy", "strict-origin-when-cross-origin"),
        "permissions-policy": ("Permissions-Policy", "camera=(), microphone=(), geolocation=()"),
    }
    rows = "\n".join(f'          {{ key: "{known[m][0]}", value: "{known[m][1]}" }},'
                     for m in missing if m in known)
    if not rows:
        return "// Every security header this audit checks is already set."
    return f'''// next.config.mjs — headers() applies to every route.
// Roll CSP out in report-only mode first; a strict policy will break inline
// scripts and third-party embeds until they are allow-listed.
const nextConfig = {{
  async headers() {{
    return [
      {{
        source: "/(.*)",
        headers: [
{rows}
        ],
      }},
    ];
  }},
}};

export default nextConfig;'''


@api_router.get("/onpage/{site_id}/snippets")
async def get_nextjs_snippets(site_id: str, user=Depends(require_user)):
    """Ready-to-paste Next.js code for the SEO surfaces that live in the repo
    rather than in the bridge, pre-filled from this site's latest audit."""
    site = await get_site(site_id)
    base = (site.get("base_url") or "").rstrip("/")
    doc = await db.onpage_audits.find_one({"site_id": site_id}, {"_id": 0}, sort=[("created_at", -1)])
    cats = {c["key"]: c for c in (doc or {}).get("categories", [])}

    robots = cats.get("robots") or {}
    existing_disallow: list[str] = []
    for row in robots.get("items", []):
        existing_disallow += [d for d in (row.get("disallow") or []) if d]

    # Every 404 the crawl hit is a redirect that should exist. The destination
    # is left as "/" rather than guessed — a wrong 301 is worse than none.
    redirect_pairs: list[tuple[str, str]] = []
    for row in (cats.get("redirects") or {}).get("items", []):
        if row.get("status") == 404:
            redirect_pairs.append((row.get("path") or "/", "/"))
        elif (row.get("hops") or 0) > 1 and row.get("final_url"):
            redirect_pairs.append((row.get("path") or "/", route_path(row["final_url"])))

    missing_headers = [c["id"].replace("hdr_", "").replace("_", "-")
                       for c in (cats.get("security") or {}).get("checks", [])
                       if c["id"].startswith("hdr_") and c["status"] != "pass"]

    schema_types_present = {t["type"] for t in (cats.get("schema") or {}).get("type_counts", [])}
    missing_schema = [t for t in ("Organization", "LocalBusiness", "BreadcrumbList")
                      if t not in schema_types_present]

    weak_meta = [{"path": p.get("path", "/"),
                  "title": (p.get("signals") or {}).get("title", ""),
                  "description": (p.get("signals") or {}).get("description", "")}
                 for p in (doc or {}).get("pages", [])
                 if (p.get("signals") or {}).get("canonical", "") == ""][:3]

    snippets = [
        {"key": "robots", "title": "app/robots.ts", "language": "typescript",
         "why": "robots.txt on a Next.js site is generated by app/robots.ts. This version advertises "
                "your sitemap, which is the first place a crawler looks.",
         "code": _robots_snippet(base, robots, existing_disallow)},
        {"key": "sitemap", "title": "app/sitemap.ts", "language": "typescript",
         "why": "Adds a real lastModified to every entry — "
                f"{(cats.get('sitemap') or {}).get('summary', 'your sitemap')} currently reports "
                "dates on only some of them.",
         "code": _sitemap_snippet(base)},
        {"key": "redirects", "title": "next.config.mjs — redirects()", "language": "javascript",
         "why": ("Turns the 404s and redirect chains this audit found into 301s. Set each destination "
                 "to the closest live page — the placeholder \"/\" is deliberately not a guess."
                 if redirect_pairs else
                 "Where to add a 301 the next time a URL changes."),
         "code": _redirects_snippet(redirect_pairs[:25])},
        {"key": "metadata", "title": "generateMetadata / export const metadata", "language": "typescript",
         "why": "Canonical, noindex and the OG title/description are code, not bridge data — this is "
                "where they belong.",
         "code": _metadata_snippet(base, weak_meta)},
        {"key": "schema", "title": "JSON-LD structured data", "language": "typescript",
         "why": ("Missing site-wide types: " + ", ".join(missing_schema)) if missing_schema
                else "Your structured data already covers the site-wide types; use this as the pattern "
                     "for page-level types (Service, Article, FAQPage).",
         "code": _schema_snippet(base, missing_schema)},
        {"key": "security", "title": "next.config.mjs — headers()", "language": "javascript",
         "why": ("Missing on the live response: " + ", ".join(missing_headers)) if missing_headers
                else "All checked security headers are present.",
         "code": _security_headers_snippet(missing_headers)},
    ]
    return {"site_url": base, "audited_at": (doc or {}).get("created_at"),
            "snippets": snippets}
