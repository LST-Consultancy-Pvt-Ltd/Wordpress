"""§1 EVIDENCE RULE regression tests (§7 of the follow-up work): verifies the
real-provider-first / labelled-estimate-fallback behavior in
routers/opportunities.py actually behaves as documented, using mocked
DataForSEO/Google CSE calls (no real credentials needed to run these).

No pytest-asyncio in this project's deps — tests are plain `def test_...()`
that drive async code through one shared, never-closed event loop (`_loop`
below). Motor's client binds to whichever loop is active the first time it's
used; `core.db.mongo_client` is a process-wide singleton, so calling
`asyncio.run()` (which creates AND closes a loop) more than once anywhere in
this test module breaks every test after the first with "Event loop is
closed". Reusing one loop for the whole module avoids that.

Uses the real MongoDB instance (same one server.py connects to for the
route-parity test) — each test uses a fresh uuid4 site_id and cleans up its
own documents in a `finally` block inside that single coroutine.
"""
import json
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import BackgroundTasks, HTTPException

from core.db import db
import routers.opportunities as opp
from routers.opportunities import (
    BacklinkOpportunityRequest,
    NAPAuditRequest,
    audit_local_citations,
    find_backlink_opportunities,
    generate_disavow,
    generate_outreach_email,
    _discover_competitor_domains,
    _real_backlink_opportunities,
)
from providers.hunter import _pick_best_email, hunter_domain_search
from providers.signalhire import _company_name_guess, _pick_best_contact, signalhire_domain_search
import routers.keyword_intelligence as kwintel
from routers.keyword_intelligence import KeywordResearchRequest, research_keyword
from providers.semrush import _parse_semrush_csv


from tests.loop import LOOP as _loop  # noqa: E402


def _run(coro):
    return _loop.run_until_complete(coro)


def _new_site_id():
    return f"test-{uuid.uuid4()}"


async def _cleanup(site_id):
    await db.backlink_outreach.delete_many({"site_id": site_id})
    await db.disavow_files.delete_many({"site_id": site_id})
    await db.local_citations.delete_many({"site_id": site_id})
    await db.company_profiles.delete_many({"site_id": site_id})


def test_find_backlink_opportunities_uses_real_dataforseo_data_when_available():
    site_id = _new_site_id()
    canned_backlinks = [{
        "items": [
            {"domain_from": "real-prospect.example", "url_from": "https://real-prospect.example/post",
             "domain_from_rank": 42, "anchor": "great resource", "dofollow": True},
        ]
    }]
    req = BacklinkOpportunityRequest(competitor_urls=["https://competitor.example"], your_domain="mysite.example")

    async def go():
        try:
            bg = BackgroundTasks()
            with patch.object(opp, "_dfs_available", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "_dfs_check_spend", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "dataforseo_post", new=AsyncMock(return_value=canned_backlinks)):
                await find_backlink_opportunities(site_id, req, bg, user={"id": "test-user"})
                await bg()  # actually run the scheduled background task
            docs = await db.backlink_outreach.find({"site_id": site_id}, {"_id": 0}).to_list(10)

            assert len(docs) == 1
            assert docs[0]["prospect_domain"] == "real-prospect.example"
            assert docs[0]["estimated_da"] == 42
            assert docs[0]["is_estimated"] is False
            assert docs[0]["data_source"] == "dataforseo"
        finally:
            await _cleanup(site_id)

    _run(go())


def test_find_backlink_opportunities_falls_back_to_labelled_ai_estimate_when_not_configured():
    site_id = _new_site_id()
    ai_json = '[{"prospect_domain": "guessed.example", "opportunity_type": "guest post", "relevance_score": 5, "estimated_da": 15, "reason": "AI guess"}]'
    req = BacklinkOpportunityRequest(competitor_urls=["https://competitor.example"], your_domain="mysite.example")

    async def go():
        try:
            bg = BackgroundTasks()
            with patch.object(opp, "_dfs_available", new=AsyncMock(return_value=False)), \
                 patch.object(opp, "get_ai_response", new=AsyncMock(return_value=ai_json)):
                await find_backlink_opportunities(site_id, req, bg, user={"id": "test-user"})
                await bg()
            docs = await db.backlink_outreach.find({"site_id": site_id}, {"_id": 0}).to_list(10)

            assert len(docs) == 1
            assert docs[0]["prospect_domain"] == "guessed.example"
            assert docs[0]["is_estimated"] is True
            assert docs[0]["data_source"] == "ai_estimate"
        finally:
            await _cleanup(site_id)

    _run(go())


def test_generate_disavow_refuses_domains_that_are_only_ai_estimated():
    site_id = _new_site_id()

    async def go():
        try:
            await db.backlink_outreach.insert_one({
                "site_id": site_id, "prospect_domain": "sketchy-guess.example",
                "estimated_da": 5, "is_estimated": True, "data_source": "ai_estimate",
            })
            with pytest.raises(HTTPException) as exc_info:
                await generate_disavow(site_id, user={"id": "test-user"})
            assert exc_info.value.status_code == 409
            assert "unverified" in exc_info.value.detail.lower()
        finally:
            await _cleanup(site_id)

    _run(go())


def test_generate_disavow_only_includes_real_verified_domains():
    site_id = _new_site_id()

    async def go():
        try:
            await db.backlink_outreach.insert_many([
                {"site_id": site_id, "prospect_domain": "real-toxic.example", "estimated_da": 3, "is_estimated": False, "data_source": "dataforseo"},
                {"site_id": site_id, "prospect_domain": "guessed-toxic.example", "estimated_da": 2, "is_estimated": True, "data_source": "ai_estimate"},
                {"site_id": site_id, "prospect_domain": "real-good.example", "estimated_da": 60, "is_estimated": False, "data_source": "dataforseo"},
            ])
            result = await generate_disavow(site_id, user={"id": "test-user"})

            assert "real-toxic.example" in result["content"]
            assert "guessed-toxic.example" not in result["content"]  # the whole point of the fix
            assert "real-good.example" not in result["content"]  # not low-DA, correctly excluded
            assert result["domain_count"] == 1
        finally:
            await _cleanup(site_id)

    _run(go())


def test_audit_local_citations_falls_back_to_verified_company_profile():
    site_id = _new_site_id()

    async def go():
        try:
            await db.company_profiles.insert_one({
                "site_id": site_id, "business_name": "Acme Plumbing", "address": "123 Main St",
                "phone": "555-1234", "website": "https://acme.example", "verified": True,
            })
            req = NAPAuditRequest()  # everything blank — must come from the profile
            with patch.object(opp, "cse_available", new=AsyncMock(return_value=False)), \
                 patch.object(opp, "get_ai_response", new=AsyncMock(return_value='[{"directory":"Yelp","url":"https://yelp.com","has_listing":true,"nap_consistent":true,"inconsistency_note":null,"is_top_priority":true}]')):
                result = await audit_local_citations(site_id, req, user={"id": "test-user"})

            assert result["total"] == 1
            stored = await db.local_citations.find_one({"site_id": site_id}, {"_id": 0})
            assert stored["canonical_nap"]["name"] == "Acme Plumbing"
        finally:
            await _cleanup(site_id)

    _run(go())


def test_audit_local_citations_400s_when_no_nap_available_anywhere():
    site_id = _new_site_id()
    req = NAPAuditRequest()  # blank, and no company profile exists for this fresh site_id

    async def go():
        try:
            with pytest.raises(HTTPException) as exc_info:
                await audit_local_citations(site_id, req, user={"id": "test-user"})
            assert exc_info.value.status_code == 400
        finally:
            await _cleanup(site_id)

    _run(go())


# --- Auto-draft + Hunter.io contact-suggestion tests (follow-up to §1) ---

def test_find_backlink_opportunities_auto_drafts_email_and_hunter_suggestion():
    site_id = _new_site_id()
    canned_backlinks = [{
        "items": [
            {"domain_from": "real-prospect.example", "url_from": "https://real-prospect.example/post",
             "domain_from_rank": 42, "anchor": "great resource", "dofollow": True},
        ]
    }]
    req = BacklinkOpportunityRequest(competitor_urls=["https://competitor.example"], your_domain="mysite.example")

    async def go():
        try:
            bg = BackgroundTasks()
            with patch.object(opp, "_dfs_available", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "_dfs_check_spend", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "dataforseo_post", new=AsyncMock(return_value=canned_backlinks)), \
                 patch.object(opp, "get_ai_response", new=AsyncMock(return_value='{"subject":"Hi there","body":"Loved your resource page."}')), \
                 patch.object(opp, "hunter_available", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "hunter_domain_search", new=AsyncMock(return_value={
                     "email": "jane@real-prospect.example", "confidence": 91, "type": "personal",
                     "first_name": "Jane", "last_name": "Doe", "position": "Editor",
                 })):
                await find_backlink_opportunities(site_id, req, bg, user={"id": "test-user"})
                await bg()
            docs = await db.backlink_outreach.find({"site_id": site_id}, {"_id": 0}).to_list(10)

            assert len(docs) == 1
            doc = docs[0]
            assert doc["email_drafted"] is True
            assert doc["email_content"] == {"subject": "Hi there", "body": "Loved your resource page."}
            assert doc["recipient_email"] == "jane@real-prospect.example"
            assert doc["recipient_email_source"] == "hunter_io_suggested"
            assert doc["recipient_email_confidence"] == 91
            # Key invariant: a Hunter suggestion must NOT auto-advance approval —
            # a human still has to review it via OutreachApprovals' "Save recipient".
            assert doc.get("approval_status") is None
        finally:
            await _cleanup(site_id)

    _run(go())


def test_find_backlink_opportunities_continues_when_hunter_returns_none():
    site_id = _new_site_id()
    canned_backlinks = [{
        "items": [
            {"domain_from": "no-contact.example", "url_from": "https://no-contact.example/post",
             "domain_from_rank": 30, "anchor": "link", "dofollow": True},
        ]
    }]
    req = BacklinkOpportunityRequest(competitor_urls=["https://competitor.example"], your_domain="mysite.example")

    async def go():
        try:
            bg = BackgroundTasks()
            with patch.object(opp, "_dfs_available", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "_dfs_check_spend", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "dataforseo_post", new=AsyncMock(return_value=canned_backlinks)), \
                 patch.object(opp, "get_ai_response", new=AsyncMock(return_value='{"subject":"Hi","body":"Body"}')), \
                 patch.object(opp, "hunter_available", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "hunter_domain_search", new=AsyncMock(return_value=None)), \
                 patch.object(opp, "signalhire_available", new=AsyncMock(return_value=False)):
                await find_backlink_opportunities(site_id, req, bg, user={"id": "test-user"})
                await bg()
            docs = await db.backlink_outreach.find({"site_id": site_id}, {"_id": 0}).to_list(10)

            assert len(docs) == 1
            doc = docs[0]
            assert "recipient_email" not in doc
            # The email draft step is independent of the Hunter step — still succeeds.
            assert doc["email_drafted"] is True
            assert doc["email_content"] == {"subject": "Hi", "body": "Body"}
        finally:
            await _cleanup(site_id)

    _run(go())


def test_find_backlink_opportunities_continues_when_email_draft_fails_for_one_opportunity():
    site_id = _new_site_id()
    canned_backlinks = [{
        "items": [
            {"domain_from": "first.example", "url_from": "https://first.example/a", "domain_from_rank": 20, "anchor": "a", "dofollow": True},
            {"domain_from": "second.example", "url_from": "https://second.example/b", "domain_from_rank": 25, "anchor": "b", "dofollow": True},
        ]
    }]
    req = BacklinkOpportunityRequest(competitor_urls=["https://competitor.example"], your_domain="mysite.example")

    async def go():
        try:
            bg = BackgroundTasks()
            with patch.object(opp, "_dfs_available", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "_dfs_check_spend", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "dataforseo_post", new=AsyncMock(return_value=canned_backlinks)), \
                 patch.object(opp, "get_ai_response", new=AsyncMock(side_effect=HTTPException(429, "Daily AI spend budget reached"))), \
                 patch.object(opp, "hunter_available", new=AsyncMock(return_value=False)), \
                 patch.object(opp, "signalhire_available", new=AsyncMock(return_value=False)):
                await find_backlink_opportunities(site_id, req, bg, user={"id": "test-user"})
                await bg()
            docs = await db.backlink_outreach.find({"site_id": site_id}, {"_id": 0}).to_list(10)

            # Both opportunities still inserted despite every drafting attempt failing —
            # proves skip-and-continue, not abort-the-whole-run-on-first-failure.
            assert len(docs) == 2
            for doc in docs:
                assert doc["email_drafted"] is False
                assert doc["email_content"] is None
        finally:
            await _cleanup(site_id)

    _run(go())


def test_pick_best_email_prefers_personal_over_higher_confidence_generic():
    emails = [
        {"value": "info@example.com", "type": "generic", "confidence": 95},
        {"value": "jane@example.com", "type": "personal", "confidence": 60},
    ]
    best = _pick_best_email(emails)
    assert best["value"] == "jane@example.com"


def test_hunter_domain_search_returns_none_when_not_configured():
    with patch("providers.hunter._hunter_credentials", new=AsyncMock(return_value="")):
        result = _run(hunter_domain_search("example.com"))
    assert result is None


# --- SignalHire fallback tests (used when Hunter.io finds nothing) ---

def test_find_backlink_opportunities_falls_back_to_signalhire_when_hunter_finds_nothing():
    site_id = _new_site_id()
    canned_backlinks = [{
        "items": [
            {"domain_from": "hunter-empty.example", "url_from": "https://hunter-empty.example/post",
             "domain_from_rank": 40, "anchor": "link", "dofollow": True},
        ]
    }]
    req = BacklinkOpportunityRequest(competitor_urls=["https://competitor.example"], your_domain="mysite.example")

    async def go():
        try:
            bg = BackgroundTasks()
            with patch.object(opp, "_dfs_available", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "_dfs_check_spend", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "dataforseo_post", new=AsyncMock(return_value=canned_backlinks)), \
                 patch.object(opp, "get_ai_response", new=AsyncMock(return_value='{"subject":"Hi","body":"Body"}')), \
                 patch.object(opp, "hunter_available", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "hunter_domain_search", new=AsyncMock(return_value=None)), \
                 patch.object(opp, "signalhire_available", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "signalhire_domain_search", new=AsyncMock(return_value={
                     "email": "sam@hunter-empty.example", "confidence": 100, "type": "work",
                     "first_name": "Sam", "last_name": "Lee", "position": "Marketing Lead",
                 })):
                await find_backlink_opportunities(site_id, req, bg, user={"id": "test-user"})
                await bg()
            docs = await db.backlink_outreach.find({"site_id": site_id}, {"_id": 0}).to_list(10)

            assert len(docs) == 1
            doc = docs[0]
            assert doc["recipient_email"] == "sam@hunter-empty.example"
            assert doc["recipient_email_source"] == "signalhire_suggested"
            assert doc["recipient_email_confidence"] == 100
            # Same enforced-review invariant as the Hunter path.
            assert doc.get("approval_status") is None
        finally:
            await _cleanup(site_id)

    _run(go())


def test_find_backlink_opportunities_tries_signalhire_when_hunter_not_configured():
    site_id = _new_site_id()
    canned_backlinks = [{
        "items": [
            {"domain_from": "no-hunter.example", "url_from": "https://no-hunter.example/post",
             "domain_from_rank": 33, "anchor": "link", "dofollow": True},
        ]
    }]
    req = BacklinkOpportunityRequest(competitor_urls=["https://competitor.example"], your_domain="mysite.example")

    async def go():
        try:
            bg = BackgroundTasks()
            with patch.object(opp, "_dfs_available", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "_dfs_check_spend", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "dataforseo_post", new=AsyncMock(return_value=canned_backlinks)), \
                 patch.object(opp, "get_ai_response", new=AsyncMock(return_value='{"subject":"Hi","body":"Body"}')), \
                 patch.object(opp, "hunter_available", new=AsyncMock(return_value=False)), \
                 patch.object(opp, "signalhire_available", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "signalhire_domain_search", new=AsyncMock(return_value={
                     "email": "alex@no-hunter.example", "confidence": 70, "type": "personal",
                     "first_name": "Alex", "last_name": "Kim", "position": None,
                 })) as mock_signalhire:
                await find_backlink_opportunities(site_id, req, bg, user={"id": "test-user"})
                await bg()
            docs = await db.backlink_outreach.find({"site_id": site_id}, {"_id": 0}).to_list(10)

            # Proves the fallback fires even when Hunter isn't configured at
            # all, not only when Hunter is configured but comes up empty.
            mock_signalhire.assert_awaited_once_with("no-hunter.example")
            assert len(docs) == 1
            assert docs[0]["recipient_email_source"] == "signalhire_suggested"
        finally:
            await _cleanup(site_id)

    _run(go())


def test_pick_best_contact_prefers_higher_rating_over_lower():
    contacts = [
        {"type": "email", "value": "guess@example.com", "rating": 70, "subType": None},
        {"type": "email", "value": "verified@example.com", "rating": 100, "subType": "personal"},
        {"type": "phone", "value": "+1234567890", "rating": 100, "subType": "mobile"},
    ]
    best = _pick_best_contact(contacts)
    assert best["value"] == "verified@example.com"


def test_pick_best_contact_prefers_work_email_on_rating_tie():
    contacts = [
        {"type": "email", "value": "personal@example.com", "rating": 100, "subType": "personal"},
        {"type": "email", "value": "work@example.com", "rating": 100, "subType": "work"},
    ]
    best = _pick_best_contact(contacts)
    assert best["value"] == "work@example.com"


def test_pick_best_contact_returns_none_without_email_contacts():
    contacts = [{"type": "phone", "value": "+1234567890", "rating": 100, "subType": "mobile"}]
    assert _pick_best_contact(contacts) is None


def test_company_name_guess_strips_scheme_www_and_tld():
    assert _company_name_guess("https://www.acme-corp.co.uk/") == "acme-corp"
    assert _company_name_guess("example.com") == "example"


def test_signalhire_domain_search_returns_none_when_not_configured():
    with patch("providers.signalhire._signalhire_credentials", new=AsyncMock(return_value="")):
        result = _run(signalhire_domain_search("example.com"))
    assert result is None


def test_generate_outreach_email_endpoint_still_works_after_refactor():
    site_id = _new_site_id()

    async def go():
        try:
            res = await db.backlink_outreach.insert_one({
                "site_id": site_id, "prospect_domain": "regression-check.example",
                "opportunity_type": "guest post", "reason": "existing prospect",
            })
            opportunity_id = str(res.inserted_id)
            with patch.object(opp, "get_ai_response", new=AsyncMock(return_value='{"subject":"Regression check","body":"Still works."}')):
                email = await generate_outreach_email(site_id, opportunity_id, user={"id": "test-user"})
            assert email == {"subject": "Regression check", "body": "Still works."}
            stored = await db.backlink_outreach.find_one({"site_id": site_id}, {"_id": 0})
            assert stored["email_drafted"] is True
            assert stored["email_content"] == email
        finally:
            await _cleanup(site_id)

    _run(go())


def test_find_backlink_opportunities_skips_domains_already_on_file():
    site_id = _new_site_id()
    canned_backlinks = [{
        "items": [
            {"domain_from": "already-known.example", "url_from": "https://already-known.example/x",
             "domain_from_rank": 50, "anchor": "a", "dofollow": True},
            {"domain_from": "brand-new.example", "url_from": "https://brand-new.example/y",
             "domain_from_rank": 33, "anchor": "b", "dofollow": True},
        ]
    }]
    req = BacklinkOpportunityRequest(competitor_urls=["https://competitor.example"], your_domain="mysite.example")

    async def go():
        try:
            # Pre-existing opportunity for one of the domains this "run" will
            # rediscover — carries real progress (status=contacted) that a
            # re-run must never overwrite or duplicate.
            await db.backlink_outreach.insert_one({
                "site_id": site_id, "prospect_domain": "already-known.example",
                "opportunity_type": "competitor_backlink", "estimated_da": 999,
                "status": "contacted", "email_drafted": True,
                "email_content": {"subject": "Original", "body": "Original body"},
                "is_estimated": False, "data_source": "dataforseo",
            })

            bg = BackgroundTasks()
            with patch.object(opp, "_dfs_available", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "_dfs_check_spend", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "dataforseo_post", new=AsyncMock(return_value=canned_backlinks)), \
                 patch.object(opp, "get_ai_response", new=AsyncMock(return_value='{"subject":"New","body":"New body"}')), \
                 patch.object(opp, "hunter_available", new=AsyncMock(return_value=False)), \
                 patch.object(opp, "signalhire_available", new=AsyncMock(return_value=False)):
                await find_backlink_opportunities(site_id, req, bg, user={"id": "test-user"})
                await bg()

            docs = await db.backlink_outreach.find({"site_id": site_id}, {"_id": 0}).to_list(10)

            # No duplicate row for the already-known domain.
            known = [d for d in docs if d["prospect_domain"] == "already-known.example"]
            assert len(known) == 1
            # Its existing progress was preserved untouched, not overwritten.
            assert known[0]["status"] == "contacted"
            assert known[0]["estimated_da"] == 999
            assert known[0]["email_content"] == {"subject": "Original", "body": "Original body"}

            # The genuinely new domain in the same batch was still processed normally.
            new = [d for d in docs if d["prospect_domain"] == "brand-new.example"]
            assert len(new) == 1
            assert new[0]["email_drafted"] is True
            assert new[0]["email_content"] == {"subject": "New", "body": "New body"}

            assert len(docs) == 2
        finally:
            await _cleanup(site_id)

    _run(go())


# --- Multi-competitor processing + auto-competitor-discovery tests ---

def test_real_backlink_opportunities_processes_every_competitor_not_just_the_first():
    site_id = _new_site_id()
    # First competitor alone returns 12 unique domains — a prior version
    # returned as soon as it hit 10 total, silently never querying the second
    # competitor at all. This proves that's fixed.
    first_competitor_items = {
        "items": [
            {"domain_from": f"first-{n}.example", "url_from": f"https://first-{n}.example/x",
             "domain_from_rank": 10, "anchor": "a", "dofollow": True}
            for n in range(12)
        ]
    }
    second_competitor_items = {
        "items": [
            {"domain_from": "second.example", "url_from": "https://second.example/y",
             "domain_from_rank": 20, "anchor": "b", "dofollow": True},
        ]
    }

    async def go():
        try:
            with patch.object(opp, "_dfs_available", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "_dfs_check_spend", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "dataforseo_post", new=AsyncMock(side_effect=[[first_competitor_items], [second_competitor_items]])):
                opps = await _real_backlink_opportunities(site_id, "mysite.example", ["https://first.example", "https://second.example"])

            domains = {o["prospect_domain"] for o in opps}
            assert len(opps) == 13  # 12 from the first competitor + 1 from the second
            assert "second.example" in domains  # proves the second competitor was actually queried

            # The real backlink URL (DataForSEO's url_from) must survive onto
            # the opportunity, not just be used-and-discarded for deriving
            # the domain.
            second_opp = next(o for o in opps if o["prospect_domain"] == "second.example")
            assert second_opp["backlink_url"] == "https://second.example/y"
        finally:
            await _cleanup(site_id)

    _run(go())


def test_find_backlink_opportunities_stores_real_backlink_url_on_opportunity():
    site_id = _new_site_id()
    canned_backlinks = [{
        "items": [
            {"domain_from": "evidence.example", "url_from": "https://evidence.example/resources/tools",
             "domain_from_rank": 40, "anchor": "great tool", "dofollow": True},
        ]
    }]
    req = BacklinkOpportunityRequest(competitor_urls=["https://competitor.example"], your_domain="mysite.example")

    async def go():
        try:
            bg = BackgroundTasks()
            with patch.object(opp, "_dfs_available", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "_dfs_check_spend", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "dataforseo_post", new=AsyncMock(return_value=canned_backlinks)), \
                 patch.object(opp, "get_ai_response", new=AsyncMock(return_value='{"subject":"Hi","body":"Body"}')), \
                 patch.object(opp, "hunter_available", new=AsyncMock(return_value=False)), \
                 patch.object(opp, "signalhire_available", new=AsyncMock(return_value=False)):
                await find_backlink_opportunities(site_id, req, bg, user={"id": "test-user"})
                await bg()
            docs = await db.backlink_outreach.find({"site_id": site_id}, {"_id": 0}).to_list(10)

            assert len(docs) == 1
            assert docs[0]["backlink_url"] == "https://evidence.example/resources/tools"
        finally:
            await _cleanup(site_id)

    _run(go())


def test_discover_competitor_domains_resolves_real_domains_via_cse():
    async def go():
        with patch.object(opp, "_scrape_site_text", new=AsyncMock(return_value="Title: Acme Rockets\nMeta description: We sell rockets.")), \
             patch.object(opp, "get_ai_response", new=AsyncMock(return_value='["SpaceCo", "RocketWorks"]')), \
             patch.object(opp, "cse_available", new=AsyncMock(return_value=True)), \
             patch.object(opp, "google_custom_search", new=AsyncMock(side_effect=[
                 [{"title": "SpaceCo", "url": "https://spaceco.example/", "snippet": "", "display_link": "spaceco.example"}],
                 [{"title": "RocketWorks", "url": "https://rocketworks.example/about", "snippet": "", "display_link": "rocketworks.example"}],
             ])):
            domains, data_meta = await _discover_competitor_domains("myrockets.example", "aerospace")

        assert domains == ["spaceco.example", "rocketworks.example"]
        assert data_meta["is_estimated"] is False
        assert data_meta["data_source"] == "google_cse"

    _run(go())


def test_discover_competitor_domains_falls_back_to_labelled_ai_estimate_without_cse():
    async def go():
        with patch.object(opp, "_scrape_site_text", new=AsyncMock(return_value="")), \
             patch.object(opp, "get_ai_response", new=AsyncMock(side_effect=[
                 '["SpaceCo"]',                 # names
                 '["spaceco-guessed.example"]',  # AI-guessed domain fallback
             ])), \
             patch.object(opp, "cse_available", new=AsyncMock(return_value=False)):
            domains, data_meta = await _discover_competitor_domains("myrockets.example", "aerospace")

        assert domains == ["spaceco-guessed.example"]
        assert data_meta["is_estimated"] is True
        assert data_meta["data_source"] == "ai_estimate"

    _run(go())


def test_find_backlink_opportunities_auto_discovers_competitors_when_none_given():
    site_id = _new_site_id()
    canned_backlinks = [{
        "items": [
            {"domain_from": "found-via-discovery.example", "url_from": "https://found-via-discovery.example/x",
             "domain_from_rank": 40, "anchor": "a", "dofollow": True},
        ]
    }]
    req = BacklinkOpportunityRequest(competitor_urls=[], your_domain="myrockets.example")

    async def go():
        try:
            bg = BackgroundTasks()
            with patch.object(opp, "_discover_competitor_domains", new=AsyncMock(
                     return_value=(["discovered-competitor.example"], {"data_source": "google_cse", "is_estimated": False}))), \
                 patch.object(opp, "_dfs_available", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "_dfs_check_spend", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "dataforseo_post", new=AsyncMock(return_value=canned_backlinks)), \
                 patch.object(opp, "get_ai_response", new=AsyncMock(return_value='{"subject":"Hi","body":"Body"}')), \
                 patch.object(opp, "hunter_available", new=AsyncMock(return_value=False)), \
                 patch.object(opp, "signalhire_available", new=AsyncMock(return_value=False)):
                await find_backlink_opportunities(site_id, req, bg, user={"id": "test-user"})
                await bg()

            docs = await db.backlink_outreach.find({"site_id": site_id}, {"_id": 0}).to_list(10)
            assert len(docs) == 1
            assert docs[0]["prospect_domain"] == "found-via-discovery.example"
        finally:
            await _cleanup(site_id)

    _run(go())


def test_find_backlink_opportunities_errors_cleanly_when_no_competitors_discoverable():
    site_id = _new_site_id()
    req = BacklinkOpportunityRequest(competitor_urls=[], your_domain="myrockets.example")

    async def go():
        try:
            bg = BackgroundTasks()
            with patch.object(opp, "_discover_competitor_domains", new=AsyncMock(
                     return_value=([], {"data_source": "ai_estimate", "is_estimated": True}))):
                await find_backlink_opportunities(site_id, req, bg, user={"id": "test-user"})
                await bg()

            docs = await db.backlink_outreach.find({"site_id": site_id}, {"_id": 0}).to_list(10)
            assert len(docs) == 0  # nothing silently inserted when discovery finds nothing
        finally:
            await _cleanup(site_id)

    _run(go())


def test_find_backlink_opportunities_processes_only_top_30_by_relevance_when_more_are_found():
    site_id = _new_site_id()
    # 40 unique domains with strictly increasing domain rank — the top 30 by
    # rank (domain-11.example .. domain-40.example) should be the ones
    # actually processed/inserted; the lowest-ranked 10 should not be.
    canned_backlinks = [{
        "items": [
            {"domain_from": f"domain-{i}.example", "url_from": f"https://domain-{i}.example/x",
             "domain_from_rank": i * 10, "anchor": "a", "dofollow": True}
            for i in range(1, 41)
        ]
    }]
    req = BacklinkOpportunityRequest(competitor_urls=["https://competitor.example"], your_domain="mysite.example")

    async def go():
        try:
            bg = BackgroundTasks()
            with patch.object(opp, "_dfs_available", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "_dfs_check_spend", new=AsyncMock(return_value=True)), \
                 patch.object(opp, "dataforseo_post", new=AsyncMock(return_value=canned_backlinks)), \
                 patch.object(opp, "get_ai_response", new=AsyncMock(return_value='{"subject":"Hi","body":"Body"}')), \
                 patch.object(opp, "hunter_available", new=AsyncMock(return_value=False)), \
                 patch.object(opp, "signalhire_available", new=AsyncMock(return_value=False)):
                await find_backlink_opportunities(site_id, req, bg, user={"id": "test-user"})
                await bg()

            docs = await db.backlink_outreach.find({"site_id": site_id}, {"_id": 0}).to_list(100)
            assert len(docs) == 30  # capped, even though 40 were discovered

            processed_domains = {d["prospect_domain"] for d in docs}
            top_30_expected = {f"domain-{i}.example" for i in range(11, 41)}
            lowest_10_excluded = {f"domain-{i}.example" for i in range(1, 11)}
            assert processed_domains == top_30_expected
            assert processed_domains.isdisjoint(lowest_10_excluded)
        finally:
            await _cleanup(site_id)

    _run(go())


# --- Keyword Research power-up tests: DataForSEO Labs, real PAA, Google
# Trends, GSC "already ranking", SEMrush cross-check ---

_AI_SEED_RESULT = {
    "primary": {"keyword": "seo tools", "volume": 10, "difficulty": "low",
                "cpc": 0.1, "competition": "low", "intent": "informational"},
    "related": [{"keyword": "ai guessed keyword", "volume": 5, "difficulty": "low", "cpc": 0.05, "competition": "low", "intent": "informational"}],
    "questions": [{"question": "ai guessed question?", "volume": 5}],
    "serp": [],
}


def _patched_research_keyword(**overrides):
    """Common patch set for research_keyword tests — every dependency
    defaults to a harmless/off state; pass overrides to exercise one path
    at a time, same spirit as the opportunities.py tests above."""
    defaults = dict(
        get_ai_response=AsyncMock(return_value=json.dumps(_AI_SEED_RESULT)),
        _dfs_available=AsyncMock(return_value=False),
        _cache_get=AsyncMock(return_value=None),
        _cache_set=AsyncMock(return_value=True),
        _dfs_check_spend=AsyncMock(return_value=True),
        dataforseo_post=AsyncMock(return_value=[]),
        get_serp_analysis=AsyncMock(return_value={"organic": [], "people_also_ask": []}),
        get_keyword_trends=AsyncMock(return_value={"trends": {}, "source": "ai_estimate"}),
        get_decrypted_settings=AsyncMock(return_value={}),
        fetch_gsc_metrics=AsyncMock(return_value=[]),
        semrush_available=AsyncMock(return_value=False),
    )
    defaults.update(overrides)
    return [patch.object(kwintel, name, new=mock) for name, mock in defaults.items()]


def test_research_keyword_uses_real_dataforseo_labs_related_keywords():
    keyword = "seo tools"
    labs_items = [
        {"keyword_data": {"keyword": keyword,
                           "keyword_info": {"search_volume": 1000, "cpc": 2.5, "competition_level": "MEDIUM", "keyword_difficulty": 42},
                           "search_intent_info": {"main_intent": "commercial"}}},
        {"keyword_data": {"keyword": "best seo tools",
                           "keyword_info": {"search_volume": 800, "cpc": 3.1, "competition_level": "HIGH", "keyword_difficulty": 55},
                           "search_intent_info": {"main_intent": "commercial"}}},
        {"keyword_data": {"keyword": "free seo tools",
                           "keyword_info": {"search_volume": 600, "cpc": 1.2, "competition_level": "LOW", "keyword_difficulty": 20},
                           "search_intent_info": {"main_intent": "informational"}}},
    ]

    async def dfs_side_effect(endpoint, payload):
        if "related_keywords" in endpoint:
            return [{"items": labs_items}]
        return []

    async def go():
        patches = _patched_research_keyword(
            _dfs_available=AsyncMock(return_value=True),
            dataforseo_post=AsyncMock(side_effect=dfs_side_effect),
        )
        with patches[0]:
            for p in patches[1:]:
                p.start()
            try:
                result = await research_keyword("site-1", KeywordResearchRequest(keyword=keyword), {"id": "test-user"})
            finally:
                for p in patches[1:]:
                    p.stop()

        assert result["related_data_source"] == "dataforseo_labs"
        assert {r["keyword"] for r in result["related"]} == {"best seo tools", "free seo tools"}
        # Real DataForSEO KD/intent replace the AI seed's guesses.
        assert result["primary"]["keyword_difficulty"] == 42
        assert result["primary"]["intent"] == "commercial"

    _run(go())


def test_research_keyword_falls_back_to_ai_related_when_labs_fails():
    keyword = "seo tools"

    async def dfs_side_effect(endpoint, payload):
        if "related_keywords" in endpoint:
            raise Exception("DataForSEO Labs unavailable")
        return []

    async def go():
        patches = _patched_research_keyword(
            _dfs_available=AsyncMock(return_value=True),
            dataforseo_post=AsyncMock(side_effect=dfs_side_effect),
        )
        with patches[0]:
            for p in patches[1:]:
                p.start()
            try:
                result = await research_keyword("site-1", KeywordResearchRequest(keyword=keyword), {"id": "test-user"})
            finally:
                for p in patches[1:]:
                    p.stop()

        # A Labs failure never takes down the whole request — the original
        # AI-generated related list survives untouched.
        assert result["related_data_source"] == "ai_estimate"
        assert result["related"] == _AI_SEED_RESULT["related"]

    _run(go())


def test_research_keyword_uses_real_people_also_ask_questions():
    keyword = "seo tools"

    async def go():
        patches = _patched_research_keyword(
            _dfs_available=AsyncMock(return_value=True),
            get_serp_analysis=AsyncMock(return_value={
                "organic": [],
                "people_also_ask": [{"question": "what is seo?"}, {"question": "how does seo work?"}],
            }),
        )
        with patches[0]:
            for p in patches[1:]:
                p.start()
            try:
                result = await research_keyword("site-1", KeywordResearchRequest(keyword=keyword), {"id": "test-user"})
            finally:
                for p in patches[1:]:
                    p.stop()

        assert result["questions_data_source"] == "dataforseo_paa"
        # Real PAA questions never carry a fabricated volume number.
        assert result["questions"] == [
            {"question": "what is seo?", "volume": None},
            {"question": "how does seo work?", "volume": None},
        ]

    _run(go())


def test_research_keyword_falls_back_to_ai_questions_when_no_paa():
    keyword = "seo tools"

    async def go():
        patches = _patched_research_keyword(
            _dfs_available=AsyncMock(return_value=True),
            get_serp_analysis=AsyncMock(return_value={"organic": [], "people_also_ask": []}),
        )
        with patches[0]:
            for p in patches[1:]:
                p.start()
            try:
                result = await research_keyword("site-1", KeywordResearchRequest(keyword=keyword), {"id": "test-user"})
            finally:
                for p in patches[1:]:
                    p.stop()

        assert result["questions_data_source"] == "ai_estimate"
        assert result["questions"] == _AI_SEED_RESULT["questions"]

    _run(go())


def test_research_keyword_adds_google_trends_momentum():
    keyword = "seo tools"

    async def go():
        patches = _patched_research_keyword(
            get_keyword_trends=AsyncMock(return_value={
                "trends": {keyword: {"trend": "rising", "values": [1, 2, 3]}},
                "source": "google_trends",
            }),
        )
        with patches[0]:
            for p in patches[1:]:
                p.start()
            try:
                result = await research_keyword("site-1", KeywordResearchRequest(keyword=keyword), {"id": "test-user"})
            finally:
                for p in patches[1:]:
                    p.stop()

        assert result["primary"]["trend"] == "rising"
        assert result["primary"]["trend_source"] == "google_trends"

    _run(go())


def test_research_keyword_adds_semrush_cross_check_without_overwriting_dataforseo():
    keyword = "seo tools"

    async def go():
        patches = _patched_research_keyword(
            _dfs_available=AsyncMock(return_value=True),
            dataforseo_post=AsyncMock(return_value=[{"items": [{
                "keyword": keyword, "search_volume": 1000, "cpc": 2.5,
                "competition": 0.4, "competition_level": "MEDIUM", "monthly_searches": [],
            }]}]),
            semrush_available=AsyncMock(return_value=True),
            semrush_keyword_difficulty=AsyncMock(return_value=37),
            semrush_keyword_overview=AsyncMock(return_value={"volume": 500, "cpc": 1.1, "competition": 0.3}),
        )
        with patches[0]:
            for p in patches[1:]:
                p.start()
            try:
                result = await research_keyword("site-1", KeywordResearchRequest(keyword=keyword), {"id": "test-user"})
            finally:
                for p in patches[1:]:
                    p.stop()

        assert result["primary"]["keyword_difficulty_semrush"] == 37
        assert result["primary"]["cross_check"] == {"source": "semrush", "volume": 500, "cpc": 1.1, "competition": 0.3}
        # Additive, not overwritten — the DataForSEO-sourced volume/difficulty survive.
        assert result["primary"]["volume"] == 1000

    _run(go())


def test_research_keyword_omits_semrush_fields_when_not_configured():
    keyword = "seo tools"

    async def go():
        patches = _patched_research_keyword(semrush_available=AsyncMock(return_value=False))
        with patches[0]:
            for p in patches[1:]:
                p.start()
            try:
                result = await research_keyword("site-1", KeywordResearchRequest(keyword=keyword), {"id": "test-user"})
            finally:
                for p in patches[1:]:
                    p.stop()

        assert "keyword_difficulty_semrush" not in result["primary"]
        assert "cross_check" not in result["primary"]

    _run(go())


def test_parse_semrush_csv_parses_header_and_rows():
    rows = _parse_semrush_csv("Ph;Nq;Cp\nseo tools;1000;2.5\nbest seo tools;800;3.1")
    assert rows == [
        {"Ph": "seo tools", "Nq": "1000", "Cp": "2.5"},
        {"Ph": "best seo tools", "Nq": "800", "Cp": "3.1"},
    ]


def test_parse_semrush_csv_returns_empty_on_error_body():
    assert _parse_semrush_csv("ERROR 50 :: NOTHING FOUND") == []
    assert _parse_semrush_csv("") == []


def test_semrush_check_spend_raises_once_daily_unit_budget_exceeded():
    from providers import semrush as semrush_provider

    async def go():
        site_id = f"semrush-budget-{uuid.uuid4()}"
        try:
            with patch.object(semrush_provider, "SEMRUSH_DAILY_UNIT_LIMIT", 10):
                await semrush_provider._semrush_check_spend(site_id, 5)
                await semrush_provider._semrush_check_spend(site_id, 5)
                with pytest.raises(Exception):
                    await semrush_provider._semrush_check_spend(site_id, 1)
        finally:
            await db.semrush_daily_spend.delete_many({"site_id": site_id})

    _run(go())


# --- Per-search grouping, filters, approach steps, and direct-posting
# directories (the Backlink Outreach rework) ---

def _canned(domain, rank=40):
    return [{"items": [{"domain_from": domain, "url_from": f"https://{domain}/page",
                        "domain_from_rank": rank, "anchor": "a", "dofollow": True}]}]


async def _run_search(site_id, niche, canned):
    """Drive one full find_backlink_opportunities run with everything mocked.

    Must await inside the patch context: find_backlink_opportunities is async,
    so merely calling it builds a coroutine whose body would otherwise not run
    until after the mocks were torn down."""
    req = BacklinkOpportunityRequest(competitor_urls=["https://competitor.example"],
                                     your_domain="mysite.example", niche=niche)
    bg = BackgroundTasks()
    with patch.object(opp, "_dfs_available", new=AsyncMock(return_value=True)), \
         patch.object(opp, "_dfs_check_spend", new=AsyncMock(return_value=True)), \
         patch.object(opp, "dataforseo_post", new=AsyncMock(return_value=canned)), \
         patch.object(opp, "get_ai_response", new=AsyncMock(return_value='{"subject":"Hi","body":"Body"}')), \
         patch.object(opp, "hunter_available", new=AsyncMock(return_value=False)), \
         patch.object(opp, "signalhire_available", new=AsyncMock(return_value=False)):
        result = await find_backlink_opportunities(site_id, req, bg, user={"id": "test-user"})
        await bg()  # run the scheduled background task while still mocked
    return result


def test_each_search_is_recorded_and_scoped_separately():
    site_id = _new_site_id()

    async def go():
        try:
            first = await _run_search(site_id, "netsuite", _canned("netsuite-prospect.example"))
            second = await _run_search(site_id, "salesforce", _canned("salesforce-prospect.example"))

            searches = await opp.list_backlink_searches(site_id, user={"id": "test-user"})
            assert {s["label"] for s in searches} == {"netsuite", "salesforce"}
            assert all(s["status"] == "completed" for s in searches)

            # Filtering by one search returns only that search's prospect.
            only_ns = await opp.list_backlink_opportunities(site_id, search_id=first["search_id"], user={"id": "u"})
            assert [o["prospect_domain"] for o in only_ns] == ["netsuite-prospect.example"]
            only_sf = await opp.list_backlink_opportunities(site_id, search_id=second["search_id"], user={"id": "u"})
            assert [o["prospect_domain"] for o in only_sf] == ["salesforce-prospect.example"]

            # Unfiltered still shows everything.
            everything = await opp.list_backlink_opportunities(site_id, user={"id": "u"})
            assert len(everything) == 2
        finally:
            await _cleanup(site_id)
            await db.backlink_searches.delete_many({"site_id": site_id})

    _run(go())


def test_domain_found_again_in_a_later_search_shows_under_both_searches():
    """The dedup skip must not make a prospect vanish from the newer search —
    that's exactly the confusion per-search grouping exists to remove."""
    site_id = _new_site_id()

    async def go():
        try:
            first = await _run_search(site_id, "netsuite", _canned("shared-prospect.example"))
            second = await _run_search(site_id, "salesforce", _canned("shared-prospect.example"))

            # Still exactly one row — no duplicate inserted.
            docs = await db.backlink_outreach.find({"site_id": site_id}, {"_id": 0}).to_list(10)
            assert len(docs) == 1
            assert sorted(docs[0]["search_ids"]) == sorted([first["search_id"], second["search_id"]])

            # ...and it is visible under BOTH searches.
            for sid in (first["search_id"], second["search_id"]):
                listed = await opp.list_backlink_opportunities(site_id, search_id=sid, user={"id": "u"})
                assert [o["prospect_domain"] for o in listed] == ["shared-prospect.example"]
        finally:
            await _cleanup(site_id)
            await db.backlink_searches.delete_many({"site_id": site_id})

    _run(go())


def test_opportunity_filters_and_approach_steps():
    site_id = _new_site_id()

    async def go():
        try:
            await _run_search(site_id, "netsuite", [{"items": [
                {"domain_from": "high-da.example", "url_from": "https://high-da.example/a",
                 "domain_from_rank": 90, "anchor": "a", "dofollow": True},
                {"domain_from": "low-da.example", "url_from": "https://low-da.example/b",
                 "domain_from_rank": 10, "anchor": "b", "dofollow": True},
            ]}])

            high_only = await opp.list_backlink_opportunities(site_id, min_da=50, user={"id": "u"})
            assert [o["prospect_domain"] for o in high_only] == ["high-da.example"]

            by_domain = await opp.list_backlink_opportunities(site_id, q="low-da", user={"id": "u"})
            assert [o["prospect_domain"] for o in by_domain] == ["low-da.example"]

            no_contact = await opp.list_backlink_opportunities(site_id, has_contact=False, user={"id": "u"})
            assert len(no_contact) == 2  # neither got a Hunter/SignalHire suggestion
            with_contact = await opp.list_backlink_opportunities(site_id, has_contact=True, user={"id": "u"})
            assert with_contact == []

            by_da = await opp.list_backlink_opportunities(site_id, sort="da_desc", user={"id": "u"})
            assert [o["prospect_domain"] for o in by_da] == ["high-da.example", "low-da.example"]

            # Every opportunity carries actionable steps, matched to its type.
            assert all(o["approach_steps"] for o in by_da)
            assert by_da[0]["approach_steps"] == opp._APPROACH_PLAYBOOKS["competitor_backlink"]
        finally:
            await _cleanup(site_id)
            await db.backlink_searches.delete_many({"site_id": site_id})

    _run(go())


def test_directory_listing_refuses_to_invent_copy_without_a_verified_profile():
    from fastapi import HTTPException as _HTTPExc
    import routers.directories as dirs

    site_id = _new_site_id()

    async def go():
        try:
            with pytest.raises(_HTTPExc) as exc:
                await dirs.prepare_directory_listing(site_id, "clutch", user={"id": "u"})
            assert exc.value.status_code == 400
            assert "company profile" in exc.value.detail.lower()
        finally:
            await db.directory_submissions.delete_many({"site_id": site_id})

    _run(go())


def test_directory_verification_reports_unknown_not_absent_without_google_cse():
    """A missing Google CSE key must never be reported as 'listing not found' —
    same evidence-rule discipline as every other provider fallback."""
    import routers.directories as dirs

    site_id = _new_site_id()

    async def go():
        with patch.object(dirs, "cse_available", new=AsyncMock(return_value=False)):
            result = await dirs._verify_one(site_id, "clutch", "Acme Ltd")
        assert result["found"] is None
        assert "couldn't be verified" in result["note"]

    _run(go())


# --- Content read cache (db.content_items, filled from the bridge) ---

def test_broken_link_scan_sees_markdown_links_not_just_html():
    """MDX content writes [text](url); without markdown extraction an MDX site
    would scan clean while actually carrying dead links."""
    import routers.broken_links as bl

    site_id = _new_site_id()

    async def go():
        try:
            await db.sites.insert_one({"id": site_id, "name": "NextSite", "base_url": "https://next.example"})
            await db.content_items.insert_one({
                "site_id": site_id, "collection": "posts", "slug": "post", "content_id": 1, "title": "Post",
                "body": 'Read [the guide](https://md.example/guide) or <https://auto.example/x> '
                        'or <a href="https://html.example/y">this</a>.',
            })
            with patch.object(bl, "push_event", new=AsyncMock()), \
                 patch.object(bl, "finish_task", new=AsyncMock()), \
                 patch.object(bl, "log_activity", new=AsyncMock()), \
                 patch.object(bl.httpx, "AsyncClient", lambda *a, **k: _FakeHTTP()):
                await bl._scan_broken_links("task-1", site_id)

            found = {d["url"] for d in await db.broken_links.find({"site_id": site_id}, {"_id": 0}).to_list(10)}
            assert found == {"https://md.example/guide", "https://auto.example/x", "https://html.example/y"}
        finally:
            await db.sites.delete_many({"id": site_id})
            await db.content_items.delete_many({"site_id": site_id})
            await db.broken_links.delete_many({"site_id": site_id})

    _run(go())


class _FakeResp:
    status_code = 200


class _FakeHTTP:
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False
    async def head(self, *a, **k): return _FakeResp()
    async def get(self, *a, **k): return _FakeResp()


# --- On-page SEO: signals come from rendered HTML, scores are
# deterministic (an AI-invented 0-100 would be unreproducible and worthless) ---

_GOOD_PAGE = """<html><head>
<title>NetSuite Implementation Partner for Mid-Market Manufacturers</title>
<meta name="description" content="We implement NetSuite ERP for mid-market manufacturers, covering discovery, data migration, integration and training, with fixed-fee delivery and post-launch support included.">
<link rel="canonical" href="https://ex.com/netsuite">
<meta property="og:title" content="NetSuite Implementation"><meta property="og:description" content="ERP delivery">
<meta property="og:image" content="https://ex.com/og.png">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Service"}</script>
</head><body><h1>NetSuite Implementation</h1><h2>What we do</h2>
<p>%s</p><img src="a.png" alt="chart"></body></html>""" % (" ".join(["word"] * 620))

_BAD_PAGE = """<html><head><title>Home</title>
<meta name="robots" content="noindex">
</head><body><h1>A</h1><h1>B</h1><p>Short.</p><img src="a.png"></body></html>"""


def test_onpage_scoring_is_deterministic_and_reads_rendered_html():
    from providers.onpage import extract_signals, score_page

    good = score_page(extract_signals(_GOOD_PAGE, "https://ex.com/netsuite"))
    bad = score_page(extract_signals(_BAD_PAGE, "https://ex.com/"))

    assert good["score"] > 90
    assert bad["score"] < 40
    # Same input, same score — reproducible, unlike an AI-assigned number.
    assert score_page(extract_signals(_GOOD_PAGE, "https://ex.com/netsuite"))["score"] == good["score"]

    sig = extract_signals(_GOOD_PAGE, "https://ex.com/netsuite")
    assert sig["h1_count"] == 1
    assert sig["schema_types"] == ["Service"]
    assert sig["word_count"] >= 600
    assert sig["images_missing_alt"] == 0

    factors = {i["factor"] for i in bad["issues"]}
    assert "indexable" in factors          # noindex is caught
    assert "h1" in factors                 # two H1s
    assert "description" in factors        # missing entirely
    assert bad["factor_scores"]["indexable"] == 0


def test_onpage_audit_reports_unreachable_pages_rather_than_scoring_them_zero():
    """A network failure must never be presented as bad SEO."""
    import providers.onpage as onpage

    async def go():
        with patch.object(onpage, "fetch_page", new=AsyncMock(return_value=(None, 403, "HTTP 403"))):
            result = await onpage.audit_url("https://blocked.example/")
        assert result["ok"] is False
        assert result["score"] is None      # not 0
        assert result["error"] == "HTTP 403"

    _run(go())


def test_onpage_scan_falls_back_to_synced_content_when_there_is_no_sitemap():
    import routers.onpage_seo as onpage_router

    site_id = _new_site_id()

    async def go():
        try:
            await db.content_items.insert_many([
                {"site_id": site_id, "collection": "posts", "slug": "a", "url": "https://next.example/blog/a", "title": "A"},
                {"site_id": site_id, "collection": "posts", "slug": "b", "url": "https://next.example/blog/b", "title": "B"},
            ])
            site = {"id": site_id, "base_url": "https://next.example"}

            import datetime as _dt

            class _Resp:
                status_code = 404
                text = ""
                content = b""
                headers = {}
                history = ()
                url = "https://next.example/"
                elapsed = _dt.timedelta(seconds=0.01)

            class _Client:
                async def __aenter__(self): return self
                async def __aexit__(self, *a): return False
                async def get(self, *a, **k): return _Resp()
                async def head(self, *a, **k): return _Resp()

            with patch.object(onpage_router.httpx, "AsyncClient", lambda *a, **k: _Client()):
                urls, source = await onpage_router._discover_urls(site, 50)
            assert source == "synced content"
            assert urls == ["https://next.example/blog/a", "https://next.example/blog/b"]
        finally:
            await db.content_items.delete_many({"site_id": site_id})

    _run(go())


def test_meta_path_is_always_reduced_to_a_route_path():
    """A full URL must never become the override key — the site reads overrides
    by route path, so "/https:/host/page" would be silently unreadable."""
    from routers.onpage_seo import _normalise_route

    for supplied in ("https://next.example/azure-data-migration/", "https://next.example/azure-data-migration",
                     "/azure-data-migration", "azure-data-migration"):
        assert _normalise_route(supplied) == "/azure-data-migration", supplied
