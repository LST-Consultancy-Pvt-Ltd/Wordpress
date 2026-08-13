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
import asyncio
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


_loop = asyncio.new_event_loop()


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
                 patch.object(opp, "hunter_domain_search", new=AsyncMock(return_value=None)):
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
                 patch.object(opp, "hunter_available", new=AsyncMock(return_value=False)):
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
                 patch.object(opp, "hunter_available", new=AsyncMock(return_value=False)):
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
                 patch.object(opp, "hunter_available", new=AsyncMock(return_value=False)):
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
                 patch.object(opp, "hunter_available", new=AsyncMock(return_value=False)):
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
