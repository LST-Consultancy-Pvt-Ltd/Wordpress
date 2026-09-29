"""Pydantic request/response/domain models used across server.py and routers/*.py.

This is a verbatim move of the original inline "Pydantic Models" block from
server.py (see REFACTOR_NOTES.md) — grouped by the original file's own comments,
not yet split into one-module-per-domain as the target architecture eventually
wants. Splitting further is safe follow-up work; nothing here has behavior.
"""
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field

# --- Auth Models ---
class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10)
    full_name: Optional[str] = None
    role: Literal["viewer", "editor", "deployer", "admin"] = "viewer"

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class UserResponse(BaseModel):
    id: str
    email: str
    full_name: Optional[str] = None
    role: str = "admin"
    created_at: str

class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse

# --- Scheduler Models ---
class ScheduledJob(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    site_id: str
    user_id: str
    job_type: Literal["content_freshness", "seo_health"]
    enabled: bool = True
    last_run: Optional[str] = None
    last_run_status: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class ScheduledJobCreate(BaseModel):
    """Read-only analysis jobs only. Nothing scheduled may write to a site;
    changes go through change sets and approval."""
    model_config = ConfigDict(extra="forbid")
    site_id: str
    job_type: Literal["content_freshness", "seo_health"]
    enabled: bool = True

# --- Agent Session Models ---
class AgentSession(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    site_id: str
    user_id: str
    title: str = "New Session"
    messages: List[Dict] = []
    status: str = "active"
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class AgentSessionCreate(BaseModel):
    site_id: str
    title: Optional[str] = "New Session"

class AgentTurnRequest(BaseModel):
    session_id: str
    message: str

# --- Bulk Operation Models ---
class BulkSEOAuditRequest(BaseModel):
    site_ids: List[str]

class BulkContentRefreshRequest(BaseModel):
    site_ids: List[str]

class AICommand(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    site_id: str
    command: str
    response: Optional[str] = None
    status: str = "pending"
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    completed_at: Optional[str] = None

class AICommandCreate(BaseModel):
    site_id: str
    command: str

class PostGenerate(BaseModel):
    site_id: str
    topic: str
    keywords: List[str] = []
    generate_image: bool = False
    target_languages: Optional[List[str]] = None  # e.g. ["es", "fr"]
    style_id: Optional[str] = None  # Writing style profile ID

# --- PageSpeed Models ---
class PageSpeedOpportunity(BaseModel):
    title: str
    description: str = ""
    savings_ms: float = 0.0

class PageSpeedDiagnostic(BaseModel):
    title: str
    description: str = ""

class PageSpeedAIRecommendation(BaseModel):
    recommendation: str
    priority: str = "medium"  # "high" | "medium" | "low"
    implementation_steps: List[str] = []

class PageSpeedResult(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    site_id: str
    url: str
    performance_score: float = 0.0
    fcp: float = 0.0
    lcp: float = 0.0
    tbt: float = 0.0
    cls: float = 0.0
    opportunities: List[PageSpeedOpportunity] = []
    diagnostics: List[PageSpeedDiagnostic] = []
    ai_recommendations: List[PageSpeedAIRecommendation] = []
    fetched_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class PageSpeedAnalyzeRequest(BaseModel):
    url: str

# --- Competitor / Bulk / Translate Models ---
class CompetitorInfo(BaseModel):
    domain: str
    title: str
    url: str
    estimated_position: int
    meta_description: str = ""

class CompetitorAnalysis(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    site_id: str
    target_keyword: str
    competitors: List[CompetitorInfo] = []
    our_position: Optional[int] = None
    analysis_text: str = ""
    recommendations: List[str] = []
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class CompetitorAnalyzeRequest(BaseModel):
    keyword: str

# ActivityLog now lives in core/activity.py (imported at top of this file)

class Settings(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = "global_settings"
    openai_api_key: Optional[str] = None
    anthropic_api_key: Optional[str] = None
    ai_provider: str = "openai"
    google_analytics_credentials: Optional[str] = None
    google_search_console_credentials: Optional[str] = None
    ga4_property_id: Optional[str] = None
    gsc_site_url: Optional[str] = None
    google_search_api_key: Optional[str] = None
    google_search_cx: Optional[str] = None
    pagespeed_api_key: Optional[str] = None
    dataforseo_login: Optional[str] = None
    dataforseo_password: Optional[str] = None
    smtp_host: Optional[str] = None
    smtp_port: Optional[int] = None
    smtp_username: Optional[str] = None
    smtp_password: Optional[str] = None
    smtp_from_email: Optional[str] = None
    smtp_use_tls: bool = True
    hunter_api_key: Optional[str] = None
    signalhire_api_key: Optional[str] = None
    semrush_api_key: Optional[str] = None
    google_trends_enabled: bool = True
    supported_languages: List[str] = ["en"]
    default_language: str = "en"
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class SettingsUpdate(BaseModel):
    openai_api_key: Optional[str] = None
    anthropic_api_key: Optional[str] = None
    ai_provider: Optional[str] = None
    google_analytics_credentials: Optional[str] = None
    google_search_console_credentials: Optional[str] = None
    ga4_property_id: Optional[str] = None
    gsc_site_url: Optional[str] = None
    google_search_api_key: Optional[str] = None
    google_search_cx: Optional[str] = None
    pagespeed_api_key: Optional[str] = None
    dataforseo_login: Optional[str] = None
    dataforseo_password: Optional[str] = None
    smtp_host: Optional[str] = None
    smtp_port: Optional[int] = None
    smtp_username: Optional[str] = None
    smtp_password: Optional[str] = None
    smtp_from_email: Optional[str] = None
    smtp_use_tls: Optional[bool] = None
    hunter_api_key: Optional[str] = None
    signalhire_api_key: Optional[str] = None
    semrush_api_key: Optional[str] = None
    google_trends_enabled: Optional[bool] = None
    supported_languages: Optional[List[str]] = None
    default_language: Optional[str] = None

class BrokenLink(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    site_id: str
    post_id: int
    post_title: str
    url: str
    status: str  # "ok" | "broken" | "timeout" | "blocked" (bot-protected target, may still be live)
    status_code: Optional[int] = None
    scanned_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class DuplicateContentResult(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    site_id: str
    post_a_id: int
    post_a_title: str
    post_b_id: int
    post_b_title: str
    similarity_score: float
    type: str  # "content" | "title"
    detected_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class InternalLinkSuggestion(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    site_id: str
    source_post_id: int
    source_post_title: str
    target_post_id: int
    target_post_title: str
    target_url: str
    anchor_text: str
    context_sentence: str
    applied: bool = False
    detected_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class ContentRefreshItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    site_id: str
    content_id: int
    collection: str
    slug: str
    title: str
    url: str
    last_modified: str
    age_days: int
    status: str = "needs_refresh"
    ctr: Optional[float] = None
    ranking_drop: Optional[int] = None
    recommended_action: str = ""
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

# --- Writing Style Model ---
class WritingStyle(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    tone: str
    instructions: str
    example_opening: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

# --- Content Brief Models ---
class ContentBrief(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    site_id: str
    topic: str
    target_keyword: str
    target_audience: str = ""
    recommended_word_count: int = 1200
    outline: List[Dict] = []
    lsi_keywords: List[str] = []
    competitor_angle: str = ""
    cta_suggestion: str = ""
    tone_recommendation: str = ""
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class BriefRequest(BaseModel):
    topic: str
    target_keyword: str

# --- Plugin Audit Model ---
# --- Rank Tracker Models (lightweight, stored as plain dicts) ---
class RankTrackRequest(BaseModel):
    keywords: List[str]

# --- Verified Company Knowledge Base (§12) ---
# A per-site source of truth for real-world facts about the business (NAP,
# description, categories, social profiles) so features like the Local
# Citations audit and Digital PR don't have to re-ask for the same facts on
# every call, and so there's a "verified" flag distinguishing operator-entered
# ground truth from anything a route might otherwise have had to guess.
class CompanyProfile(BaseModel):
    model_config = ConfigDict(extra="ignore")
    site_id: str
    business_name: str = ""
    address: str = ""
    phone: str = ""
    website: str = ""
    description: str = ""
    categories: List[str] = []
    social_profiles: Dict[str, str] = {}
    verified: bool = False
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_by: Optional[str] = None

class CompanyProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    business_name: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    description: Optional[str] = None
    categories: Optional[List[str]] = None
    social_profiles: Optional[Dict[str, str]] = None
    verified: Optional[bool] = None

