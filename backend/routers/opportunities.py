"""Off-Page / Authority Outreach: Backlink Outreach, Guest Posting Manager,
Brand Mention Monitor, Digital PR, Local Citations, Influencer Outreach,
Community Engagement, Podcast Outreach, Link Reclamation, and the Off-Page
Autopilot Dashboard that scores/aggregates across all of the above.

EVIDENCE RULE: routes that discover real-world entities (backlink prospects,
brand mentions, guest-post/influencer/podcast/community sites) now prefer a
real data provider — DataForSEO for backlink data, Google Custom Search (CSE)
for anything that's fundamentally a web-search problem — and every stored
document carries `_data_meta()` provenance (`data_source`, `is_estimated`).
When no real provider is configured, routes fall back to an LLM estimate
that is explicitly labelled `is_estimated: True` rather than presented as
fact; nothing here silently invents data and calls it real. The one
exception is Local Citations (NAP audit): no citations-checking API
(BrightLocal/Whitespark/Moz Local etc.) is configured, so that route always
returns `is_estimated: True` results and should not be treated as ground
truth for outreach decisions until a real provider is wired in.
`generate_disavow` refuses to run on estimated data — see that function.
"""
import logging
import re
import uuid
from datetime import datetime
from typing import List, Optional
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup
from fastapi import BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from core.activity import log_activity
from core.ai import get_ai_response
from core.changesets import create_changeset
from core.db import db
from core.http_headers import BROWSER_HEADERS, INCONCLUSIVE_STATUSES
from core.prompts import HUMANIZE_DIRECTIVE
from core.router import api_router
from core.safe_fetch import SSRF_GUARD
from core.security import require_editor, require_user
from core.tasks import create_task_queue, finish_task, make_task_id, push_event
from providers.dataforseo import (
    _data_meta,
    _dfs_available,
    _dfs_check_spend,
    dataforseo_post,
)
from providers.google_cse import cse_available, google_custom_search
from providers.hunter import hunter_available, hunter_domain_search
from providers.signalhire import signalhire_available, signalhire_domain_search
from providers.sites import get_site
from routers.company_profile import get_verified_nap

logger = logging.getLogger(__name__)


def _domain_of(url: str) -> str:
    url = (url or "").strip()
    if not url:
        return ""
    if "://" not in url:
        url = "https://" + url
    return (urlparse(url).netloc or "").lower().removeprefix("www.")


async def _scrape_site_text(url: str) -> str:
    """Fetch the real content of `url` (the user's own site) and return a
    short plain-text summary for AI to read — never fabricated, just the
    site's own title/meta description/visible body text. Returns "" on any
    failure; callers must treat that as "no content available", not stall."""
    if "://" not in url:
        url = "https://" + url
    try:
        async with httpx.AsyncClient(event_hooks=SSRF_GUARD, timeout=15.0, follow_redirects=True, headers=BROWSER_HEADERS) as client:
            resp = await client.get(url)
        if resp.status_code != 200:
            # A non-200 (e.g. a WAF block page, 403/429) is not real site
            # content — feeding it to the AI would mean discovering
            # "competitors" from a block page's text. Treat as no content.
            logger.warning(f"Could not scrape {url} for competitor discovery: HTTP {resp.status_code}")
            return ""
        soup = BeautifulSoup(resp.text, "html.parser")
        title = soup.title.string.strip() if soup.title and soup.title.string else ""
        meta_tag = soup.find("meta", attrs={"name": "description"})
        meta_desc = (meta_tag.get("content", "") if meta_tag else "").strip()
        for tag in soup(["script", "style", "nav", "footer", "header"]):
            tag.decompose()
        body_text = " ".join(soup.get_text(separator=" ", strip=True).split())[:2000]
        return f"Title: {title}\nMeta description: {meta_desc}\nPage content: {body_text}"
    except Exception as e:
        logger.warning(f"Could not scrape {url} for competitor discovery: {e}")
        return ""


async def _discover_competitor_domains(your_domain: str, niche: str) -> tuple:
    """Auto-discover real competitor domains from the user's OWN website
    content instead of requiring manual entry: (1) scrape the real site,
    (2) ask AI which real, well-known companies compete in that space —
    by NAME, since an AI-invented domain would violate the evidence rule,
    (3) resolve each name to its real domain via Google CSE. If CSE isn't
    configured, falls back to asking AI for domains directly — clearly
    labelled `is_estimated: True` in the returned data_meta, same convention
    as every other discovery route in this module.

    Returns (domains: list[str], data_meta: dict). `domains` may be [] if
    nothing could be determined — caller must surface that, not silently
    proceed with zero competitors."""
    site_text = await _scrape_site_text(your_domain)
    prompt = [{"role": "user", "content": f"""Based on this real website's own content, identify its business niche and name 8 real, well-known companies that are direct competitors in the same space.
Website: {your_domain}
{"Niche: " + niche if niche else ""}
{("Website content:\n" + site_text) if site_text else "(Could not fetch the website's content — use the domain name and niche alone.)"}
Return ONLY a valid JSON array of real company names, e.g. ["Company A", "Company B"]."""}]
    raw = await get_ai_response(prompt, max_tokens=400)
    import json as _json
    try:
        names = _json.loads(raw[raw.find("["):raw.rfind("]")+1])
    except Exception:
        names = []
    names = [n for n in names if isinstance(n, str) and n.strip()][:8]

    if await cse_available():
        domains = []
        for name in names:
            results = await google_custom_search(f"{name} official website", num=1)
            if results:
                dom = _domain_of(results[0]["url"])
                if dom and dom not in domains:
                    domains.append(dom)
        return domains, _data_meta("google_cse", is_estimated=False)

    # No CSE configured — fall back to an explicitly-labelled AI guess at
    # each company's domain, rather than leaving competitors undiscoverable.
    if not names:
        return [], _data_meta("ai_estimate", is_estimated=True)
    prompt2 = [{"role": "user", "content": f"""For each of these real companies, guess their most likely official website domain (just the bare domain, e.g. example.com). This is an estimate — no web search was available to verify it.
Companies: {names}
Return ONLY a JSON array of domains, same order, one per company."""}]
    raw2 = await get_ai_response(prompt2, max_tokens=300)
    try:
        domains = _json.loads(raw2[raw2.find("["):raw2.rfind("]")+1])
        domains = [_domain_of(d) for d in domains if isinstance(d, str) and d.strip()]
    except Exception:
        domains = []
    return domains, _data_meta("ai_estimate", is_estimated=True)

# ─────────────────────────────────────────────────────────────
# MODULE 1 — BACKLINK OUTREACH
# ─────────────────────────────────────────────────────────────

# Discovery itself is uncapped (see _real_backlink_opportunities), but only
# this many get auto-drafted + Hunter-looked-up + inserted per run — the
# rest are simply left for the next run (dedup-skip means a re-run picks up
# where this one left off, never repeating what's already on file).
MAX_OPPORTUNITIES_PER_RUN = 30


class BacklinkOpportunityRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    competitor_urls: List[str] = []  # optional — if blank, competitors are auto-discovered from your_domain
    your_domain: str
    niche: str = ""

class BacklinkStatusUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    status: str  # contacted / replied / acquired / rejected

async def _real_backlink_opportunities(site_id: str, your_domain_raw: str, competitor_urls: list) -> list:
    """Real backlink-gap opportunities from DataForSEO: for each competitor
    domain, find the real domains linking to it (with real domain rank) that
    don't already link to `your_domain`. Returns [] if DataForSEO isn't
    configured or every lookup fails — caller must fall back explicitly,
    never silently treat [] as "no opportunities found".

    Processes EVERY competitor supplied (no artificial cap on competitor
    count or total opportunities) — the real cost guard is `_dfs_check_spend`
    (the site's daily DataForSEO budget), not an arbitrary UX limit. A
    previous version stopped after the first competitor that alone produced
    10 results and silently ignored the rest — fixed."""
    if not await _dfs_available():
        return []
    your_domain = _domain_of(your_domain_raw)
    seen_domains = {your_domain} if your_domain else set()
    opps = []
    for comp_url in competitor_urls:
        comp_domain = _domain_of(comp_url)
        if not comp_domain:
            continue
        try:
            await _dfs_check_spend(site_id, 0.002)
            list_data = await dataforseo_post("/v3/backlinks/backlinks/live", [{
                "target": comp_domain, "limit": 20, "mode": "as_is",
                "filters": [["dofollow", "=", True]],
            }])
        except HTTPException:
            continue
        except Exception as e:
            logger.warning(f"DataForSEO backlink lookup failed for {comp_domain}: {e}")
            continue
        items = (list_data[0].get("items") if list_data else None) or []
        for bl in items:
            dom = (bl.get("domain_from") or _domain_of(bl.get("url_from", ""))).lower()
            if not dom or dom in seen_domains:
                continue
            seen_domains.add(dom)
            rank = bl.get("domain_from_rank", 0) or 0
            opps.append({
                "prospect_domain": dom,
                "opportunity_type": "competitor_backlink",
                "relevance_score": max(1, min(10, round(rank / 10))),
                "estimated_da": rank,
                "reason": f"Currently links to competitor {comp_domain}",
                "backlink_url": bl.get("url_from", ""),
            })
    return opps

@api_router.post("/backlink-outreach/{site_id}/find-opportunities")
async def find_backlink_opportunities(site_id: str, req: BacklinkOpportunityRequest, background_tasks: BackgroundTasks, user=Depends(require_editor)):
    task_id = make_task_id()
    await create_task_queue(task_id)

    # Every click of "Find Opportunities" is its own search run. Without this,
    # a "netsuite" search and a later "salesforce" search pile into one
    # undifferentiated list with no way to tell which run surfaced what.
    search_id = str(uuid.uuid4())
    await db.backlink_searches.insert_one({
        "id": search_id,
        "site_id": site_id,
        "user_id": user.get("id", ""),
        "label": (req.niche or req.your_domain or "Backlink search").strip(),
        "niche": req.niche,
        "your_domain": req.your_domain,
        "competitor_urls": req.competitor_urls,
        "task_id": task_id,
        "status": "running",
        "created_at": datetime.utcnow(),
        "discovered_count": 0,
        "processed_count": 0,
        "new_count": 0,
        "duplicate_count": 0,
    })

    async def _fail_search(message: str):
        await db.backlink_searches.update_one({"id": search_id}, {"$set": {
            "status": "failed", "error": message, "completed_at": datetime.utcnow(),
        }})

    async def run(tid):
        try:
            competitor_urls = req.competitor_urls
            if not competitor_urls:
                await push_event(tid, "progress", {"message": f"No competitors given — scanning {req.your_domain} to identify them…"})
                competitor_urls, discovery_meta = await _discover_competitor_domains(req.your_domain, req.niche)
                if not competitor_urls:
                    msg = "Could not automatically identify competitors from your website — try entering competitor URLs manually."
                    await _fail_search(msg)
                    await push_event(tid, "error", {"message": msg})
                    return
                await log_activity(site_id, "competitor_discovery",
                                    f"Auto-discovered {len(competitor_urls)} competitor(s) for {req.your_domain} "
                                    f"({'real, via Google CSE' if not discovery_meta['is_estimated'] else 'AI estimate — no Google CSE configured'})")
                await push_event(tid, "progress", {"message": f"Found {len(competitor_urls)} competitors: {', '.join(competitor_urls)}"})

            await push_event(tid, "progress", {"message": "Analysing competitor backlink profiles…"})
            opps = await _real_backlink_opportunities(site_id, req.your_domain, competitor_urls)
            if opps:
                data_meta = _data_meta("dataforseo", is_estimated=False)
                await log_activity(site_id, "dataforseo_call", "DataForSEO backlink-gap lookup for backlink outreach")
            else:
                prompt = [{"role": "user", "content": f"""Analyse these competitor URLs for backlink opportunities for the domain '{req.your_domain}' in the '{req.niche}' niche.
Competitor URLs: {', '.join(competitor_urls)}
Return a JSON array of up to 30 backlink opportunities. Each item must have:
- prospect_domain (string): domain that could link to us
- opportunity_type (string): one of resource page / broken link / skyscraper / guest post
- relevance_score (integer 1-10)
- estimated_da (integer 1-100)
- reason (string): why this is a good link opportunity
Return ONLY valid JSON array."""}]
                raw = await get_ai_response(prompt, max_tokens=2500)
                import json as _json
                try:
                    opps = _json.loads(raw[raw.find("["):raw.rfind("]")+1])
                except Exception:
                    opps = []
                data_meta = _data_meta("ai_estimate", is_estimated=True)

            # Discovery itself stays uncapped (real backlink-gap data across
            # every competitor), but auto-drafting an email + Hunter lookup
            # for every single one in one run gets slow/expensive fast.
            # Process the best 30 per run — highest relevance/DA first — and
            # rely on the dedup-skip above so re-running picks up the next
            # batch of previously-undiscovered ones rather than repeating.
            discovered_count = len(opps)
            if discovered_count > MAX_OPPORTUNITIES_PER_RUN:
                opps = sorted(
                    opps,
                    key=lambda o: (o.get("relevance_score", 0) or 0, o.get("estimated_da", 0) or 0),
                    reverse=True,
                )[:MAX_OPPORTUNITIES_PER_RUN]
                await push_event(tid, "progress", {
                    "message": f"Found {discovered_count} opportunities — processing the top {MAX_OPPORTUNITIES_PER_RUN} by relevance this run. Re-run to process the rest.",
                })

            now = datetime.utcnow()
            docs = []
            total = len(opps)
            hunter_hits = 0
            signalhire_hits = 0
            skipped_duplicates = 0
            for i, o in enumerate(opps, start=1):
                domain = o.get("prospect_domain", "")

                # Dedup across runs: _real_backlink_opportunities/the AI-estimate
                # prompt only dedupe WITHIN one call — re-running "Find
                # Opportunities" against the same/overlapping competitors will
                # keep rediscovering the same domains. Skip anything already on
                # file for this site rather than inserting a duplicate row, and
                # never touch the existing doc — it may already carry real
                # progress (status, approval, a sent email) that a re-run must
                # not silently overwrite.
                if domain:
                    existing = await db.backlink_outreach.find_one({"site_id": site_id, "prospect_domain": domain})
                    if existing:
                        # Don't insert a second row (that would duplicate the
                        # prospect and risk clobbering real progress), but DO
                        # record that this search also surfaced it — otherwise
                        # a domain first found under an earlier search would
                        # silently vanish from this one's results, which is
                        # exactly the confusion per-search grouping is meant
                        # to remove.
                        await db.backlink_outreach.update_one(
                            {"_id": existing["_id"]},
                            {"$addToSet": {"search_ids": search_id}},
                        )
                        existing["id"] = str(existing.pop("_id"))
                        existing["search_ids"] = sorted(set(existing.get("search_ids") or []) | {search_id})
                        docs.append(existing)
                        skipped_duplicates += 1
                        await push_event(tid, "progress", {
                            "message": f"Already tracking {domain} — linked to this search ({i}/{total})",
                            "current": i, "total": total,
                        })
                        continue

                await push_event(tid, "progress", {
                    "message": f"Drafting outreach email for {domain or 'prospect'} ({i}/{total})…",
                    "current": i, "total": total,
                })
                try:
                    email_content = await _draft_outreach_email_content(o)
                    email_drafted = True
                except Exception as e:
                    logger.warning(f"Email draft failed for {domain}: {e}")
                    email_content, email_drafted = None, False

                doc = {**o, "site_id": site_id, "user_id": user.get("id", ""),
                       "status": "new", "created_at": now, "updated_at": now,
                       "search_id": search_id, "search_ids": [search_id],
                       "niche": req.niche,
                       "email_drafted": email_drafted, "email_content": email_content, **data_meta}

                if domain:
                    contact_result, contact_source = None, None
                    if await hunter_available():
                        await push_event(tid, "progress", {
                            "message": f"Looking up a contact for {domain} via Hunter.io ({i}/{total})…",
                            "current": i, "total": total,
                        })
                        try:
                            contact_result = await hunter_domain_search(domain)
                            if contact_result:
                                contact_source = "hunter_io_suggested"
                        except Exception as e:
                            logger.warning(f"Hunter.io lookup failed for {domain}: {e}")

                    # Fall back to SignalHire whenever Hunter didn't produce a
                    # suggestion — whether Hunter isn't configured at all, or
                    # it's configured but came up empty for this domain.
                    if not contact_result and await signalhire_available():
                        await push_event(tid, "progress", {
                            "message": f"Trying SignalHire for a contact at {domain} ({i}/{total})…",
                            "current": i, "total": total,
                        })
                        try:
                            contact_result = await signalhire_domain_search(domain)
                            if contact_result:
                                contact_source = "signalhire_suggested"
                        except Exception as e:
                            logger.warning(f"SignalHire lookup failed for {domain}: {e}")

                    if contact_result:
                        doc["recipient_email"] = contact_result["email"]
                        doc["recipient_email_source"] = contact_source
                        doc["recipient_email_confidence"] = contact_result["confidence"]
                        if contact_source == "hunter_io_suggested":
                            hunter_hits += 1
                        else:
                            signalhire_hits += 1
                    # NOTE: approval_status is deliberately left unset even
                    # when a suggestion is found — OutreachApprovals.jsx only
                    # renders the editable recipient-email field when
                    # approval_status is absent/"draft"/"rejected", so a
                    # human still has to review the suggestion and click
                    # "Save recipient" before Approve/Send become reachable.
                    # That's what turns this into an enforced review step,
                    # not cosmetic metadata.

                res = await db.backlink_outreach.insert_one(doc)
                doc["id"] = str(res.inserted_id)
                doc.pop("_id", None)
                docs.append(doc)

            if hunter_hits:
                await log_activity(site_id, "hunter_io_lookup",
                                    f"Found a suggested contact for {hunter_hits}/{total} backlink prospects")
            if signalhire_hits:
                await log_activity(site_id, "signalhire_lookup",
                                    f"Found a suggested contact via SignalHire (Hunter.io fallback) for {signalhire_hits}/{total} backlink prospects")
            if skipped_duplicates:
                await log_activity(site_id, "backlink_dedup",
                                    f"Linked {skipped_duplicates}/{total} already-known prospect domain(s) to this search "
                                    f"instead of duplicating them")
            await db.backlink_searches.update_one({"id": search_id}, {"$set": {
                "status": "completed",
                "completed_at": datetime.utcnow(),
                "competitor_urls": competitor_urls,
                "discovered_count": discovered_count,
                "processed_count": total,
                "new_count": total - skipped_duplicates,
                "duplicate_count": skipped_duplicates,
                **data_meta,
            }})
            await push_event(tid, "complete", {
                "opportunities": docs, "count": len(docs), "search_id": search_id, **data_meta,
            })
        except Exception as e:
            await _fail_search(str(e))
            await push_event(tid, "error", {"message": str(e)})
        finally:
            await finish_task(tid)
    background_tasks.add_task(run, task_id)
    return {"task_id": task_id, "search_id": search_id}


@api_router.get("/backlink-outreach/{site_id}/searches")
async def list_backlink_searches(site_id: str, user=Depends(require_user)):
    """Every past "Find Opportunities" run for this site, newest first, so the
    UI can show one search's results at a time instead of one merged list."""
    cursor = db.backlink_searches.find({"site_id": site_id}, {"_id": 0}).sort("created_at", -1).limit(100)
    return await cursor.to_list(100)


# How to actually work each kind of opportunity. Deterministic per
# opportunity_type — no AI call, nothing invented: these are the real steps,
# and the page-specific evidence (the backlink URL, the anchor, the contact)
# is already on the opportunity itself.
_APPROACH_PLAYBOOKS = {
    "competitor_backlink": [
        "Open the backlink URL on this opportunity and read the page that links to your competitor — note the section it sits in, the anchor text, and why the link is there (listicle, resource list, review, partner page, case study).",
        "Decide what you're actually asking for: on a listicle or resource list you want to be added alongside them; on a review or case study you want your own equivalent piece, not an edit to theirs.",
        "Identify the right person — the post's author byline first, then an editor or marketing contact. Any suggested contact shown here is a starting point from Hunter.io/SignalHire, not a confirmed owner of that page.",
        "Write the email about THAT page, not about you: name the exact page title, say precisely what you'd add and where, and why their reader is better off for it.",
        "Hand them the finished asset — exact anchor text, the URL, and a 1–2 sentence blurb they can paste in without writing anything themselves.",
        "Send it, then set the status to Contacted. Follow up once after ~7 days and once more after ~14, then stop and mark Rejected.",
    ],
    "resource page": [
        "Open the resource page and check it's genuinely curated and still maintained (recent additions, no dead links) — an abandoned page passes little value.",
        "Confirm you actually fit one of its existing categories. If nothing fits, skip it; forcing a fit is what gets outreach ignored.",
        "Pick the single best page of yours to pitch — usually a genuinely useful guide or tool, not your homepage or a sales page.",
        "Find the page maintainer (author byline, 'suggest a resource' link, or site contact) and use their submission form if one exists — that beats cold email.",
        "Keep the email to three sentences: which page you mean, which section your link belongs in, and one line on what it gives their readers.",
        "Set the status to Contacted, then follow up once after ~10 days.",
    ],
    "broken link": [
        "Verify the broken link is still broken — check it yourself before emailing; nothing kills credibility faster than reporting a working link.",
        "Note exactly where it sits on the page (section heading, anchor text) so your email points to a precise spot.",
        "Confirm you have a genuinely equivalent replacement — same topic and depth as the dead resource, not a loose approximation.",
        "Lead with the favour: tell them the link is dead and where, and only then offer yours as one possible replacement.",
        "Send to the page author or webmaster, set the status to Contacted, and follow up once after ~7 days.",
    ],
    "skyscraper": [
        "Read the piece that's currently ranking and be honest about whether you can genuinely beat it — more depth, fresher data, better examples, or clearer structure.",
        "Build the better asset first. Reaching out before it exists wastes the one chance you get with each prospect.",
        "Pull the list of sites already linking to the original — those are your outreach targets, since they've already proven they link to this topic.",
        "Email each linking site referencing the specific page of theirs that carries the old link, and what's materially better in yours.",
        "Expect a low hit rate; work it in batches and set each to Contacted as you go.",
    ],
    "guest post": [
        "Read the site's existing posts and their guest-post or 'write for us' guidelines before pitching anything.",
        "Pitch 2–3 specific headlines that fit gaps in what they've already published — never a generic 'I'd like to write for you'.",
        "Send to the editor named in the guidelines; use their submission form when one exists.",
        "Agree the topic and the link placement (usually contextual in-body, or an author bio) before you write the draft.",
        "Write it, submit it, then set the status to Contacted and follow up once after ~10 days.",
    ],
}

_DEFAULT_PLAYBOOK = [
    "Open the prospect's site and confirm it's a real, maintained site in a relevant space — skip anything thin, expired, or off-topic.",
    "Find the specific page where a link to you would genuinely belong, and decide what you'd be asking them to add.",
    "Identify the right person to contact; any suggested email here is a starting point, not a confirmed owner.",
    "Write a short, page-specific email — what you'd add, where, and why their reader benefits.",
    "Send it, set the status to Contacted, and follow up at most twice before stopping.",
]


def _approach_steps(opp: dict) -> list:
    key = (opp.get("opportunity_type") or "").strip().lower()
    return _APPROACH_PLAYBOOKS.get(key, _DEFAULT_PLAYBOOK)


@api_router.get("/backlink-outreach/{site_id}/opportunities")
async def list_backlink_opportunities(
    site_id: str,
    search_id: Optional[str] = None,
    status: Optional[str] = None,
    opportunity_type: Optional[str] = None,
    approval_status: Optional[str] = None,
    min_da: Optional[int] = None,
    max_da: Optional[int] = None,
    min_relevance: Optional[int] = None,
    has_contact: Optional[bool] = None,
    q: Optional[str] = None,
    sort: str = "created_desc",
    limit: int = 200,
    user=Depends(require_user),
):
    query: dict = {"site_id": site_id}
    and_clauses: list = []

    if search_id:
        # Match both the search that first created the opportunity and any
        # later search that re-surfaced it (see the dedup branch above).
        and_clauses.append({"$or": [{"search_ids": search_id}, {"search_id": search_id}]})
    if status:
        query["status"] = status
    if opportunity_type:
        query["opportunity_type"] = opportunity_type
    if approval_status:
        query["approval_status"] = approval_status
    if min_relevance is not None:
        query["relevance_score"] = {"$gte": min_relevance}
    if q:
        query["prospect_domain"] = {"$regex": re.escape(q), "$options": "i"}

    da_range = {}
    if min_da is not None:
        da_range["$gte"] = min_da
    if max_da is not None:
        da_range["$lte"] = max_da
    if da_range:
        query["estimated_da"] = da_range

    if has_contact is True:
        and_clauses.append({"recipient_email": {"$nin": [None, ""]}})
    elif has_contact is False:
        and_clauses.append({"$or": [{"recipient_email": None}, {"recipient_email": ""}]})

    if and_clauses:
        query["$and"] = and_clauses

    sort_spec = {
        "created_desc": [("created_at", -1)],
        "created_asc": [("created_at", 1)],
        "da_desc": [("estimated_da", -1)],
        "da_asc": [("estimated_da", 1)],
        "relevance_desc": [("relevance_score", -1), ("estimated_da", -1)],
        "domain_asc": [("prospect_domain", 1)],
    }.get(sort, [("created_at", -1)])

    cursor = db.backlink_outreach.find(query).sort(sort_spec).limit(max(1, min(limit, 1000)))
    docs = []
    async for d in cursor:
        d["id"] = str(d.pop("_id"))
        # Computed on read rather than stored, so opportunities discovered
        # before this existed get the guidance too and edits to the playbooks
        # apply immediately without a migration.
        d["approach_steps"] = _approach_steps(d)
        docs.append(d)
    return docs

async def _draft_outreach_email_content(opp: dict) -> dict:
    """Shared prompt/parse logic for drafting a backlink outreach email —
    used both by the single-opportunity endpoint below and the bulk
    auto-draft loop in find_backlink_opportunities, so there's exactly one
    prompt to maintain, not two copies that can drift."""
    prompt = [{"role": "user", "content": f"""Write a personalised outreach email for a {opp.get('opportunity_type','link')} opportunity.
Target domain: {opp.get('prospect_domain')}
Reason it's relevant: {opp.get('reason','')}
Technique: {opp.get('opportunity_type','')}
Write a concise, friendly, non-spammy outreach email with subject line and body. Return JSON: {{"subject": "...", "body": "..."}}"""}]
    raw = await get_ai_response(prompt, max_tokens=800)
    import json as _json
    try:
        return _json.loads(raw[raw.find("{"):raw.rfind("}")+1])
    except Exception:
        return {"subject": "Link opportunity", "body": raw}

@api_router.post("/backlink-outreach/{site_id}/generate-email/{opportunity_id}")
async def generate_outreach_email(site_id: str, opportunity_id: str, user=Depends(require_editor)):
    from bson import ObjectId
    opp = await db.backlink_outreach.find_one({"_id": ObjectId(opportunity_id), "site_id": site_id})
    if not opp:
        raise HTTPException(404, "Opportunity not found")
    email = await _draft_outreach_email_content(opp)
    await db.backlink_outreach.update_one({"_id": ObjectId(opportunity_id)}, {"$set": {"email_content": email, "email_drafted": True, "updated_at": datetime.utcnow()}})
    return email

@api_router.patch("/backlink-outreach/{site_id}/opportunity/{opportunity_id}/status")
async def update_backlink_status(site_id: str, opportunity_id: str, body: BacklinkStatusUpdate, user=Depends(require_editor)):
    from bson import ObjectId
    await db.backlink_outreach.update_one({"_id": ObjectId(opportunity_id), "site_id": site_id}, {"$set": {"status": body.status, "updated_at": datetime.utcnow()}})
    return {"ok": True}

@api_router.post("/backlink-outreach/{site_id}/generate-disavow")
async def generate_disavow(site_id: str, user=Depends(require_editor)):
    """Build a Google disavow file from LOW-AUTHORITY REAL domains only.

    A disavow file is a real, consequential action against your own backlink
    profile — it must never be built from an LLM-estimated `estimated_da`.
    Any opportunity stored with `is_estimated: True` (no DataForSEO configured
    at discovery time) is excluded; if that leaves nothing verified, this
    returns a 409 rather than silently disavowing guessed domains.
    """
    cursor = db.backlink_outreach.find({
        "site_id": site_id, "estimated_da": {"$lt": 20}, "is_estimated": False,
    })
    toxic = []
    async for d in cursor:
        toxic.append(d.get("prospect_domain", ""))
    if not toxic:
        estimated_only = await db.backlink_outreach.count_documents(
            {"site_id": site_id, "estimated_da": {"$lt": 20}, "is_estimated": True}
        )
        if estimated_only:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"{estimated_only} low-authority domain(s) found, but only from an AI "
                    "estimate (DataForSEO isn't configured) — refusing to disavow unverified "
                    "domains. Configure DataForSEO credentials and re-run find-opportunities."
                ),
            )
    lines = ["# Disavow file generated by LST Platform", f"# Date: {datetime.utcnow().date()}", ""]
    for dom in toxic:
        if dom:
            lines.append(f"domain:{dom}")
    content = "\n".join(lines)
    doc = {"site_id": site_id, "user_id": user.get("id", ""), "content": content, "domains": toxic,
           "created_at": datetime.utcnow(), **_data_meta("dataforseo", is_estimated=False)}
    await db.disavow_files.insert_one(doc)
    return {"content": content, "domain_count": len(toxic)}

@api_router.get("/backlink-outreach/{site_id}/disavow")
async def get_disavow(site_id: str, user=Depends(require_user)):
    doc = await db.disavow_files.find_one({"site_id": site_id}, sort=[("created_at", -1)])
    if not doc:
        return {"content": "", "domain_count": 0}
    doc.pop("_id", None)
    return doc


@api_router.post("/backlink-outreach/{site_id}/export-excel")
async def export_backlink_outreach_excel(site_id: str, user=Depends(require_user)):
    """On-demand .xlsx report of this site's backlink outreach data — mirrors
    the io.BytesIO -> StreamingResponse pattern routers/indexing_revenue.py's
    export_revenue_pdf already uses for the Revenue Dashboard's PDF export."""
    import io

    from fastapi.responses import StreamingResponse
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    docs = await db.backlink_outreach.find({"site_id": site_id}, {"_id": 0}).sort("created_at", -1).to_list(10000)

    columns = [
        ("Prospect Domain", "prospect_domain"),
        ("Opportunity Type", "opportunity_type"),
        ("Relevance Score", "relevance_score"),
        ("Estimated DA", "estimated_da"),
        ("Reason", "reason"),
        ("Backlink URL", "backlink_url"),
        ("Status", "status"),
        ("Approval Status", "approval_status"),
        ("Recipient Email", "recipient_email"),
        ("Recipient Source", "recipient_email_source"),
        ("Recipient Confidence", "recipient_email_confidence"),
        ("Email Drafted", "email_drafted"),
        ("Email Subject", None),
        ("Email Body", None),
        ("Data Source", "data_source"),
        ("Is Estimated", "is_estimated"),
        ("Sent At", "sent_at"),
        ("Created At", "created_at"),
        ("Updated At", "updated_at"),
    ]

    wb = Workbook()
    ws = wb.active
    ws.title = "Backlink Outreach"
    ws.append([label for label, _ in columns])
    header_fill = PatternFill(start_color="16213E", end_color="16213E", fill_type="solid")
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = header_fill
    ws.freeze_panes = "A2"

    for d in docs:
        email = d.get("email_content") or {}
        row = []
        for label, field in columns:
            if label == "Email Subject":
                row.append(email.get("subject", ""))
            elif label == "Email Body":
                row.append(email.get("body", ""))
            elif label in ("Email Drafted", "Is Estimated"):
                row.append("Yes" if d.get(field) else "No")
            elif label == "Approval Status":
                row.append(d.get(field) or "draft")
            else:
                value = d.get(field)
                row.append(str(value) if value is not None else "")
        ws.append(row)

    for col_cells in ws.columns:
        length = max((len(str(c.value)) for c in col_cells if c.value), default=10)
        ws.column_dimensions[col_cells[0].column_letter].width = min(max(length + 2, 12), 60)

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=backlink-outreach-{site_id[:8]}.xlsx"},
    )


# ─────────────────────────────────────────────────────────────
# MODULE 2 — GUEST POSTING MANAGER
# ─────────────────────────────────────────────────────────────
class GuestPostFindRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    niche: str
    target_domain: str = ""
    keywords: List[str] = []

class GuestPostProspectUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    status: Optional[str] = None
    notes: Optional[str] = None
    published_url: Optional[str] = None

@api_router.post("/guest-posts/{site_id}/find-sites")
async def find_guest_post_sites(site_id: str, req: GuestPostFindRequest, user=Depends(require_editor)):
    if await cse_available():
        query = f'"{req.niche}" ("write for us" OR "guest post guidelines" OR "guest post by")'
        results = await google_custom_search(query, num=10)
        data_meta = _data_meta("google_cse", is_estimated=False)
        sites = [{
            "site_name": r["display_link"] or _domain_of(r["url"]),
            "url": r["url"],
            "domain_authority": None,  # no DA signal without DataForSEO — never guessed
            "contact_email": None,     # not reliably extractable from search snippets
            "submission_page_url": r["url"],  # the page CSE actually found
            "audience_size_estimate": None,
            "notes": r["snippet"],
        } for r in results]
    else:
        sites = []
        data_meta = _data_meta("ai_estimate", is_estimated=True)
    if not sites:
        prompt = [{"role": "user", "content": f"""Find 10 websites that accept guest posts in the '{req.niche}' niche.
For each site return a JSON object with: site_name, url, domain_authority (estimate 1-100), contact_email (guess or null), submission_page_url (guess), audience_size_estimate, notes.
Return ONLY a valid JSON array."""}]
        raw = await get_ai_response(prompt, max_tokens=1200)
        import json as _json
        try:
            sites = _json.loads(raw[raw.find("["):raw.rfind("]")+1])
        except Exception:
            sites = []
        data_meta = _data_meta("ai_estimate", is_estimated=True)
    now = datetime.utcnow()
    docs = []
    for s in sites:
        doc = {**s, "site_id": site_id, "user_id": user.get("id", ""), "niche": req.niche,
               "status": "prospect", "pitch_drafted": False, "article_drafted": False,
               "created_at": now, "updated_at": now, **data_meta}
        res = await db.guest_posts.insert_one(doc)
        doc["id"] = str(res.inserted_id)
        doc.pop("_id", None)
        docs.append(doc)
    return {"prospects": docs, "count": len(docs), **data_meta}

@api_router.get("/guest-posts/{site_id}/prospects")
async def list_guest_post_prospects(site_id: str, user=Depends(require_user)):
    cursor = db.guest_posts.find({"site_id": site_id}).sort("created_at", -1).limit(200)
    docs = []
    async for d in cursor:
        d["id"] = str(d.pop("_id"))
        docs.append(d)
    return docs

@api_router.post("/guest-posts/{site_id}/generate-pitch/{prospect_id}")
async def generate_guest_pitch(site_id: str, prospect_id: str, user=Depends(require_editor)):
    from bson import ObjectId
    prospect = await db.guest_posts.find_one({"_id": ObjectId(prospect_id), "site_id": site_id})
    if not prospect:
        raise HTTPException(404, "Prospect not found")
    prompt = [{"role": "user", "content": f"""Write a personalized guest post pitch email to {prospect.get('site_name','this site')} ({prospect.get('url','')}).
Niche: {prospect.get('niche','')}
Their audience: {prospect.get('audience_size_estimate','')}
Write a warm, professional pitch. Include 3 potential article title ideas. Return JSON: {{"subject":"...","body":"...","title_ideas":["...","...","..."]}}"""}]
    raw = await get_ai_response(prompt, max_tokens=800)
    import json as _json
    try:
        pitch = _json.loads(raw[raw.find("{"):raw.rfind("}")+1])
    except Exception:
        pitch = {"subject": "Guest Post Pitch", "body": raw, "title_ideas": []}
    await db.guest_posts.update_one({"_id": ObjectId(prospect_id)}, {"$set": {"pitch": pitch, "pitch_drafted": True, "updated_at": datetime.utcnow()}})
    return pitch

@api_router.post("/guest-posts/{site_id}/generate-article/{prospect_id}")
async def generate_guest_article(site_id: str, prospect_id: str, user=Depends(require_editor)):
    from bson import ObjectId
    prospect = await db.guest_posts.find_one({"_id": ObjectId(prospect_id), "site_id": site_id})
    if not prospect:
        raise HTTPException(404, "Prospect not found")
    titles = prospect.get("pitch", {}).get("title_ideas", [])
    title = titles[0] if titles else f"Expert Guide to {prospect.get('niche','the topic')}"
    prompt = [{"role": "system", "content": f"You are an expert guest blog writer.\n\n{HUMANIZE_DIRECTIVE}"}, {"role": "user", "content": f"""Write a full 1000-word guest post article for '{prospect.get('site_name','')}' titled: '{title}'.
Niche: {prospect.get('niche','')}
Include: introduction, 4 main sections with H2 headings, conclusion, and a 2-sentence author bio.
Return JSON: {{"title":"...","content":"...","author_bio":"...","word_count":0}}"""}]
    raw = await get_ai_response(prompt, max_tokens=2000)
    import json as _json
    try:
        article = _json.loads(raw[raw.find("{"):raw.rfind("}")+1])
    except Exception:
        article = {"title": title, "content": raw, "author_bio": "", "word_count": len(raw.split())}
    await db.guest_posts.update_one({"_id": ObjectId(prospect_id)}, {"$set": {"article": article, "article_drafted": True, "updated_at": datetime.utcnow()}})
    return article

@api_router.patch("/guest-posts/{site_id}/prospect/{prospect_id}")
async def update_guest_prospect(site_id: str, prospect_id: str, body: GuestPostProspectUpdate, user=Depends(require_editor)):
    from bson import ObjectId
    update = {k: v for k, v in body.model_dump().items() if v is not None}
    update["updated_at"] = datetime.utcnow()
    await db.guest_posts.update_one({"_id": ObjectId(prospect_id), "site_id": site_id}, {"$set": update})
    return {"ok": True}

@api_router.post("/guest-posts/{site_id}/check-live-links")
async def check_guest_post_links(site_id: str, user=Depends(require_editor)):
    cursor = db.guest_posts.find({"site_id": site_id, "status": "published", "published_url": {"$ne": None}})
    results = []
    async with httpx.AsyncClient(event_hooks=SSRF_GUARD, timeout=10, headers=BROWSER_HEADERS) as client:
        async for d in cursor:
            url = d.get("published_url", "")
            live = False
            try:
                r = await client.head(url, follow_redirects=True)
                if r.status_code in INCONCLUSIVE_STATUSES:
                    # HEAD blocked or not allowed — retry with GET before
                    # concluding the published link isn't live.
                    r = await client.get(url, follow_redirects=True)
                live = r.status_code < 400
            except Exception:
                pass
            results.append({"id": str(d["_id"]), "url": url, "live": live})
            await db.guest_posts.update_one({"_id": d["_id"]}, {"$set": {"link_live": live, "updated_at": datetime.utcnow()}})
    return results


# ─────────────────────────────────────────────────────────────
# MODULE 5 — LOCAL CITATIONS
# ─────────────────────────────────────────────────────────────
class NAPAuditRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    business_name: str = ""  # falls back to the verified CompanyProfile (§12) if blank
    address: str = ""
    phone: str = ""
    website: str = ""
    niche: str = ""
    city: str = ""

class NAPUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    business_name: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None

_NAP_DIRECTORIES = [
    ("Google Business Profile", "google.com/business", True),
    ("Yelp", "yelp.com", True),
    ("Bing Places", "bing.com/maps", False),
    ("Apple Maps", "maps.apple.com", False),
    ("Yellow Pages", "yellowpages.com", False),
    ("BBB", "bbb.org", True),
    ("Foursquare", "foursquare.com", False),
    ("Manta", "manta.com", False),
    ("Angi", "angi.com", False),
    ("HomeAdvisor", "homeadvisor.com", False),
    ("Houzz", "houzz.com", False),
    ("Thumbtack", "thumbtack.com", False),
]


async def _check_directory_listing(domain: str, business_name: str, address: str, phone: str) -> dict:
    """Real check via Google CSE: does a search actually find this business listed
    on `domain`? If a listing page is found, fetch it and check whether the phone
    number / street address actually appear on it — `nap_consistent` is left `None`
    (unknown) rather than guessed if the page can't be fetched/parsed."""
    import re as _re
    results = await google_custom_search(f'site:{domain} "{business_name}"', num=1)
    if not results:
        return {"has_listing": False, "nap_consistent": None, "inconsistency_note": None}
    listing_url = results[0]["url"]
    nap_consistent = None
    inconsistency_note = None
    try:
        async with httpx.AsyncClient(event_hooks=SSRF_GUARD, timeout=10, follow_redirects=True, headers=BROWSER_HEADERS) as client:
            resp = await client.get(listing_url)
        text = resp.text
        phone_digits = _re.sub(r"\D", "", phone or "")
        phone_match = bool(phone_digits) and phone_digits in _re.sub(r"\D", "", text)
        addr_number = (address or "").split()[0] if address else ""
        addr_match = bool(addr_number) and addr_number in text
        nap_consistent = phone_match and addr_match
        if not nap_consistent:
            missing = [n for n, ok in (("phone", phone_match), ("address", addr_match)) if not ok]
            inconsistency_note = f"Could not confirm {' and '.join(missing)} on the listing page"
    except Exception:
        pass  # couldn't fetch/parse — leave nap_consistent as None (unknown), never guessed
    return {"has_listing": True, "nap_consistent": nap_consistent, "inconsistency_note": inconsistency_note}


@api_router.post("/local-citations/{site_id}/audit")
async def audit_local_citations(site_id: str, req: NAPAuditRequest, user=Depends(require_editor)):
    """NOTE: no dedicated NAP/citations API (BrightLocal, Whitespark, Moz Local, etc.)
    is configured for this platform. When Google CSE is available this does a REAL
    presence + NAP-text check per directory (see `_check_directory_listing`); when it
    isn't, it falls back to an explicitly-labelled AI estimate. Either way, treat
    `is_estimated: True` results as needing manual verification before acting on them."""
    if not (req.business_name and req.address and req.phone):
        verified = await get_verified_nap(site_id)
        req.business_name = req.business_name or verified.get("business_name", "")
        req.address = req.address or verified.get("address", "")
        req.phone = req.phone or verified.get("phone", "")
        req.website = req.website or verified.get("website", "")
        if not (req.business_name and req.address and req.phone):
            raise HTTPException(
                status_code=400,
                detail="business_name, address, and phone are required — either pass them directly "
                       "or set up a verified Company Profile for this site first (POST /company-profile/{site_id}).",
            )
    if await cse_available():
        citations = []
        for name, domain, top_priority in _NAP_DIRECTORIES:
            check = await _check_directory_listing(domain, req.business_name, req.address, req.phone)
            citations.append({
                "directory": name, "url": f"https://{domain}",
                "has_listing": check["has_listing"], "nap_consistent": check["nap_consistent"],
                "inconsistency_note": check["inconsistency_note"], "is_top_priority": top_priority,
            })
        data_meta = _data_meta("google_cse", is_estimated=False)
    else:
        citations = []
        data_meta = _data_meta("ai_estimate", is_estimated=True)
    if not citations:
        prompt = [{"role": "user", "content": f"""No web-search provider is configured, so ESTIMATE a plausible NAP (Name, Address, Phone) citation audit for this business — these are placeholders, not verified listings:
Name: {req.business_name}
Address: {req.address}
Phone: {req.phone}
Niche: {req.niche}, City: {req.city}
List 12 major directories (Google Business, Yelp, Bing Places, Apple Maps, Yellow Pages, BBB, Foursquare, Manta, Angi, HomeAdvisor, Houzz, Thumbtack). For each return:
- directory (name)
- url (their URL)
- has_listing (boolean, your best guess)
- nap_consistent (boolean, your best guess)
- inconsistency_note (string or null)
- is_top_priority (boolean)
Return ONLY valid JSON array."""}]
        raw = await get_ai_response(prompt, max_tokens=1500)
        import json as _json
        try:
            citations = _json.loads(raw[raw.find("["):raw.rfind("]")+1])
        except Exception:
            citations = []
        data_meta = _data_meta("ai_estimate", is_estimated=True)
    now = datetime.utcnow()
    await db.local_citations.delete_many({"site_id": site_id, "type": "audit_entry"})
    docs = []
    for c in citations:
        doc = {**c, "site_id": site_id, "user_id": user.get("id", ""),
               "type": "audit_entry",
               "canonical_nap": {"name": req.business_name, "address": req.address, "phone": req.phone, "website": req.website},
               "created_at": now, "updated_at": now, **data_meta}
        res = await db.local_citations.insert_one(doc)
        doc["id"] = str(res.inserted_id)
        doc.pop("_id", None)
        docs.append(doc)
    return {"citations": docs, "total": len(docs), **data_meta,
            "consistent": sum(1 for c in citations if c.get("nap_consistent")),
            "has_listing": sum(1 for c in citations if c.get("has_listing"))}

@api_router.get("/local-citations/{site_id}/citations")
async def list_citations(site_id: str, user=Depends(require_user)):
    cursor = db.local_citations.find({"site_id": site_id}).sort("is_top_priority", -1).limit(200)
    docs = []
    async for d in cursor:
        d["id"] = str(d.pop("_id"))
        docs.append(d)
    return docs

@api_router.post("/local-citations/{site_id}/generate-description/{directory}")
async def generate_citation_description(site_id: str, directory: str, user=Depends(require_editor)):
    sample = await db.local_citations.find_one({"site_id": site_id, "type": "audit_entry"})
    nap = sample.get("canonical_nap", {}) if sample else {}
    prompt = [{"role": "user", "content": f"""Write an optimised business description for the '{directory}' directory listing.
Business: {nap.get('name','')}
Address: {nap.get('address','')}
Phone: {nap.get('phone','')}
Write 150-200 words, naturally keyword-rich, highlighting unique value. Return as plain text only."""}]
    raw = await get_ai_response(prompt, max_tokens=400)
    return {"directory": directory, "description": raw}

@api_router.get("/local-citations/{site_id}/gaps")
async def citation_gaps(site_id: str, user=Depends(require_user)):
    cursor = db.local_citations.find({"site_id": site_id, "has_listing": False})
    gaps = []
    async for d in cursor:
        d["id"] = str(d.pop("_id"))
        gaps.append(d)
    return gaps

@api_router.post("/local-citations/{site_id}/update-nap")
async def update_canonical_nap(site_id: str, body: NAPUpdateRequest, user=Depends(require_editor)):
    update = {k: v for k, v in body.model_dump().items() if v is not None}
    await db.local_citations.update_many({"site_id": site_id}, {"$set": {f"canonical_nap.{k}": v for k, v in update.items()}})
    return {"ok": True, "updated_fields": list(update.keys())}

# ─────────────────────────────────────────────────────────────
# MODULE 9 — LINK RECLAMATION
# ─────────────────────────────────────────────────────────────
class BulkRedirectItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    from_url: str
    to_url: str

class BulkRedirectRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    redirects: List[BulkRedirectItem]

async def _real_inbound_404s(site_id: str, site_url: str) -> list:
    """Real 404 reclamation candidates: pull our OWN domain's real backlinks from
    DataForSEO, then make a real HTTP request to each linked-to page on our own
    site to check whether it actually 404s. No fabrication — a backlink is only
    listed if DataForSEO reports it AND our own server confirms it's broken."""
    our_domain = _domain_of(site_url)
    if not our_domain or not await _dfs_available():
        return []
    try:
        await _dfs_check_spend(site_id, 0.002)
        list_data = await dataforseo_post("/v3/backlinks/backlinks/live", [{
            "target": our_domain, "limit": 50, "mode": "as_is",
        }])
    except HTTPException:
        return []
    except Exception as e:
        logger.warning(f"DataForSEO backlink lookup failed for {our_domain}: {e}")
        return []
    items = (list_data[0].get("items") if list_data else None) or []
    links = []
    seen_targets = set()
    async with httpx.AsyncClient(event_hooks=SSRF_GUARD, timeout=10, follow_redirects=False, headers=BROWSER_HEADERS) as client:
        for bl in items:
            target_url = bl.get("url_to", "")
            if not target_url or target_url in seen_targets:
                continue
            seen_targets.add(target_url)
            try:
                resp = await client.head(target_url)
                if resp.status_code in INCONCLUSIVE_STATUSES:  # some servers reject/block HEAD
                    resp = await client.get(target_url)
            except Exception:
                continue
            if resp.status_code != 404:
                continue
            links.append({
                "broken_url": target_url,
                "linking_domain": bl.get("domain_from") or _domain_of(bl.get("url_from", "")),
                "linking_page_url": bl.get("url_from", ""),
                "estimated_link_value": bl.get("domain_from_rank", 0) or 0,
                "anchor_text": bl.get("anchor", ""),
                "suggested_redirect_url": site_url,
                "redirect_reason": "Defaulted to the homepage — review and point at a more specific matching page if one exists.",
            })
            if len(links) >= 8:
                break
    return links

@api_router.post("/link-reclamation/{site_id}/scan-inbound-404s")
async def scan_inbound_404s(site_id: str, background_tasks: BackgroundTasks, user=Depends(require_editor)):
    task_id = make_task_id()
    await create_task_queue(task_id)
    async def run(tid):
        try:
            await push_event(tid, "progress", {"message": "Scanning for inbound links pointing to 404 pages…"})
            site = await db.sites.find_one({"_id": __import__("bson").ObjectId(site_id)})
            site_url = site.get("base_url","https://example.com") if site else "https://example.com"
            links = await _real_inbound_404s(site_id, site_url)
            if links:
                data_meta = _data_meta("dataforseo", is_estimated=False)
                await log_activity(site_id, "dataforseo_call", "DataForSEO backlinks lookup for link reclamation")
            else:
                prompt = [{"role": "user", "content": f"""No DataForSEO credentials are configured, so ESTIMATE 8 plausible inbound 404 broken links for the website {site_url} — these are placeholders, not verified real broken links.
For each return: broken_url (the 404 page on our site), linking_domain (external site linking to it), linking_page_url, estimated_link_value (integer 1-100), anchor_text, suggested_redirect_url (best matching live page on same domain), redirect_reason.
Return ONLY valid JSON array."""}]
                raw = await get_ai_response(prompt, max_tokens=1200)
                import json as _json
                try:
                    links = _json.loads(raw[raw.find("["):raw.rfind("]")+1])
                except Exception:
                    links = []
                data_meta = _data_meta("ai_estimate", is_estimated=True)
            now = datetime.utcnow()
            docs = []
            for l in links:
                doc = {**l, "site_id": site_id, "user_id": user.get("id", ""),
                       "status": "found", "redirect_created": False,
                       "outreach_sent": False, "created_at": now, **data_meta}
                res = await db.link_reclamation.insert_one(doc)
                doc["id"] = str(res.inserted_id)
                doc.pop("_id", None)
                docs.append(doc)
            await push_event(tid, "complete", {"links": docs, "count": len(docs), **data_meta})
        except Exception as e:
            await push_event(tid, "error", {"message": str(e)})
        finally:
            await finish_task(tid)
    background_tasks.add_task(run, task_id)
    return {"task_id": task_id}

@api_router.get("/link-reclamation/{site_id}/report")
async def get_reclamation_report(site_id: str, user=Depends(require_user)):
    cursor = db.link_reclamation.find({"site_id": site_id}).sort("estimated_link_value", -1).limit(200)
    docs = []
    async for d in cursor:
        d["id"] = str(d.pop("_id"))
        docs.append(d)
    total_value = sum(d.get("estimated_link_value", 0) for d in docs)
    return {"links": docs, "total": len(docs), "total_link_value": total_value,
            "reclaimed": sum(1 for d in docs if d.get("redirect_created"))}

@api_router.post("/link-reclamation/{site_id}/generate-reclaim-email/{link_id}")
async def generate_reclaim_email(site_id: str, link_id: str, user=Depends(require_editor)):
    from bson import ObjectId
    link = await db.link_reclamation.find_one({"_id": ObjectId(link_id), "site_id": site_id})
    if not link:
        raise HTTPException(404, "Link not found")
    prompt = [{"role": "user", "content": f"""Write a polite email asking a webmaster to update a broken link on their site.
Their site: {link.get('linking_page_url','')}
Broken link on their page pointing to: {link.get('broken_url','')}
Suggested replacement URL: {link.get('suggested_redirect_url','')}
Keep it short, friendly, and helpful. Return JSON: {{"subject":"...","body":"..."}}"""}]
    raw = await get_ai_response(prompt, max_tokens=500)
    import json as _json
    try:
        email = _json.loads(raw[raw.find("{"):raw.rfind("}")+1])
    except Exception:
        email = {"subject": "Broken link on your site", "body": raw}
    await db.link_reclamation.update_one({"_id": ObjectId(link_id)}, {"$set": {"outreach_email": email, "updated_at": datetime.utcnow()}})
    return email

@api_router.post("/link-reclamation/{site_id}/bulk-redirect")
async def bulk_create_redirects(site_id: str, req: BulkRedirectRequest, user=Depends(require_editor)):
    """Propose 301 redirects for reclaimed broken URLs as one change set."""
    from urllib.parse import urlsplit
    site = await get_site(site_id)
    own_host = urlsplit(site["base_url"]).hostname
    ops, skipped = [], []
    for item in req.redirects:
        src = urlsplit(item.from_url)
        if src.hostname and src.hostname != own_host:
            skipped.append({"from": item.from_url, "reason": "not a URL on this site"})
            continue
        ops.append({"op": "redirect.upsert", "source": src.path or "/", "destination": item.to_url, "permanent": True})
    if not ops:
        return {"changeset": None, "skipped": skipped}
    cs = await create_changeset(site_id, title=f"{len(ops)} reclamation redirect(s)", source="redirects",
                                actor=user, operations=ops)
    for item in req.redirects:
        await db.link_reclamation.update_one({"site_id": site_id, "broken_url": item.from_url},
                                             {"$set": {"redirect_changeset_id": cs["id"], "updated_at": datetime.utcnow()}})
    return {"changeset": cs, "skipped": skipped}


# ─────────────────────────────────────────────────────────────
# MODULE 10 — OFF-PAGE AUTOPILOT DASHBOARD
# ─────────────────────────────────────────────────────────────
@api_router.get("/offpage-autopilot/{site_id}/score")
async def offpage_score(site_id: str, user=Depends(require_user)):
    backlinks = await db.backlink_outreach.count_documents({"site_id": site_id, "status": "acquired"})
    citations_ok = await db.local_citations.count_documents({"site_id": site_id, "nap_consistent": True})
    guest_posts = await db.guest_posts.count_documents({"site_id": site_id, "status": "published"})

    score = min(100, (
        min(backlinks * 10, 40) +
        min(citations_ok * 4, 30) +
        min(guest_posts * 10, 30)
    ))
    return {
        "score": score,
        "breakdown": {
            "backlinks_acquired": backlinks,
            "citations_consistent": citations_ok,
            "guest_posts_published": guest_posts,
        }
    }

@api_router.get("/offpage-autopilot/{site_id}/priority-actions")
async def offpage_priority_actions(site_id: str, user=Depends(require_user)):
    score_data = await offpage_score(site_id, user)
    breakdown = score_data["breakdown"]
    prompt = [{"role": "user", "content": f"""Given this off-page SEO status for a website, generate the top 5 priority actions:
- Backlinks acquired: {breakdown['backlinks_acquired']}
- Citations consistent: {breakdown['citations_consistent']}
- Guest posts published: {breakdown['guest_posts_published']}
Off-page SEO score: {score_data['score']}/100

Return a JSON array of 5 action items, each with: action (string), module (string), priority (high/medium/low), estimated_impact (string), why (string).
Return ONLY valid JSON array."""}]
    raw = await get_ai_response(prompt, max_tokens=800)
    import json as _json
    try:
        actions = _json.loads(raw[raw.find("["):raw.rfind("]")+1])
    except Exception:
        actions = []
    return {"actions": actions, "score": score_data["score"]}

@api_router.post("/offpage-autopilot/{site_id}/generate-strategy")
async def generate_offpage_strategy(site_id: str, user=Depends(require_editor)):
    score_data = await offpage_score(site_id, user)
    prompt = [{"role": "user", "content": f"""Create a 90-day off-page SEO strategy for a website with score {score_data['score']}/100.
Current status: {score_data['breakdown']}
Include: Month 1 focus areas, Month 2 focus areas, Month 3 focus areas, expected outcomes.
Return JSON: {{"title":"...","month_1":{{"focus":"...","tasks":["..."]}},"month_2":{{"focus":"...","tasks":["..."]}},"month_3":{{"focus":"...","tasks":["..."]}},"expected_outcomes":["..."]}}"""}]
    raw = await get_ai_response(prompt, max_tokens=1200)
    import json as _json
    try:
        strategy = _json.loads(raw[raw.find("{"):raw.rfind("}")+1])
    except Exception:
        strategy = {"title": "Off-Page SEO Strategy", "month_1": {}, "month_2": {}, "month_3": {}, "expected_outcomes": []}
    now = datetime.utcnow()
    doc = {**strategy, "site_id": site_id, "user_id": user.get("id", ""), "score_at_creation": score_data["score"], "created_at": now}
    await db.offpage_strategies.insert_one(doc)
    doc.pop("_id", None)
    return doc

@api_router.get("/offpage-autopilot/{site_id}/digest")
async def offpage_digest(site_id: str, user=Depends(require_user)):
    score_data = await offpage_score(site_id, user)
    new_backlinks = await db.backlink_outreach.count_documents({"site_id": site_id, "status": "acquired", "updated_at": {"$gte": datetime.utcnow().replace(day=1)}})
    return {
        "score": score_data["score"],
        "this_month": {"new_backlinks": new_backlinks},
        "breakdown": score_data["breakdown"],
        "generated_at": datetime.utcnow().isoformat(),
    }
