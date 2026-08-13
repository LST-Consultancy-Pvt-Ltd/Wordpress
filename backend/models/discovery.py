"""Typed domain models (§4) for the discovery entities `routers/opportunities.py`
produces and stores. These document the actual shape of what's returned/stored
today — they are NOT attached as `response_model=` on any route, deliberately:
doing so would make FastAPI silently drop any field not listed here, which is
exactly the kind of subtle regression risk not worth taking on already-verified
routes. Use these for documentation, for new code (e.g. agent tools, a future
TS client generator) that wants a typed contract, or as the basis for adding
`response_model=` deliberately later with its own verification pass.

Every one of these carries `data_source`/`is_estimated` — the provenance pair
`providers/dataforseo.py::_data_meta()` established — because every entity
here can come from either a real provider or an explicitly-labelled AI
estimate (see REFACTOR_NOTES.md's "§1 EVIDENCE RULE fix" section).
"""
from typing import Optional

from pydantic import BaseModel, ConfigDict


class _Provenance(BaseModel):
    model_config = ConfigDict(extra="ignore")
    data_source: Optional[str] = None
    data_freshness: Optional[str] = None
    is_estimated: Optional[bool] = None


class BacklinkOpportunity(_Provenance):
    id: Optional[str] = None
    site_id: str
    prospect_domain: str
    opportunity_type: str
    relevance_score: Optional[int] = None
    estimated_da: Optional[int] = None
    reason: str
    status: str = "new"
    email_drafted: bool = False
    email_content: Optional[dict] = None
    recipient_email: Optional[str] = None
    approval_status: Optional[str] = None


class GuestPostProspect(_Provenance):
    id: Optional[str] = None
    site_id: str
    site_name: str
    url: str
    domain_authority: Optional[int] = None
    contact_email: Optional[str] = None
    submission_page_url: Optional[str] = None
    audience_size_estimate: Optional[int] = None
    notes: Optional[str] = None
    status: str = "prospect"
    pitch_drafted: bool = False
    article_drafted: bool = False


class BrandMention(_Provenance):
    id: Optional[str] = None
    site_id: str
    brand_name: str
    source_url: str
    headline: Optional[str] = None
    snippet: Optional[str] = None
    sentiment: str = "neutral"
    has_link: bool = False
    is_unlinked_mention: bool = True
    estimated_da: Optional[int] = None
    published_date: Optional[str] = None
    outreach_sent: bool = False


class InfluencerProfile(_Provenance):
    id: Optional[str] = None
    site_id: str
    niche: str
    name: str
    platform: str
    profile_url: str
    estimated_monthly_reach: Optional[int] = None
    relevance_score: Optional[int] = None
    engagement_rate_estimate: Optional[str] = None
    contact_email: Optional[str] = None
    specialty: Optional[str] = None
    status: str = "new"


class PodcastProspect(_Provenance):
    id: Optional[str] = None
    site_id: str
    niche: str
    podcast_name: str
    host_name: Optional[str] = None
    show_url: str
    estimated_monthly_listeners: Optional[int] = None
    episode_count_estimate: Optional[int] = None
    accepts_guests: Optional[bool] = None
    contact_method: Optional[str] = None
    relevance_score: Optional[int] = None
    status: str = "new"


class CommunityOpportunity(_Provenance):
    site_id: str
    platform: str
    name: str
    url: str
    member_count_estimate: Optional[int] = None
    activity_level: Optional[str] = None
    topic_relevance: Optional[int] = None
    posting_guidelines_notes: Optional[str] = None


class ReclaimedLink(_Provenance):
    id: Optional[str] = None
    site_id: str
    broken_url: str
    linking_domain: str
    linking_page_url: str
    estimated_link_value: Optional[int] = None
    anchor_text: Optional[str] = None
    suggested_redirect_url: Optional[str] = None
    redirect_reason: Optional[str] = None
    status: str = "found"
    redirect_created: bool = False
