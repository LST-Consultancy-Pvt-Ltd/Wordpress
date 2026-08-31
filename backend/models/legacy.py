"""Pydantic request/response/domain models used across server.py and routers/*.py.

This is a verbatim move of the original inline "Pydantic Models" block from
server.py (see REFACTOR_NOTES.md) — grouped by the original file's own comments,
not yet split into one-module-per-domain as the target architecture eventually
wants. Splitting further is safe follow-up work; nothing here has behavior.
"""
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field

# --- Auth Models ---
class UserCreate(BaseModel):
    email: EmailStr
    password: str
    full_name: Optional[str] = None
    role: str = "admin"

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
    job_type: str  # "content_freshness" | "seo_health" | "scheduled_publish"
    enabled: bool = True
    cron_expression: Optional[str] = None  # for scheduled_publish
    publish_post_id: Optional[str] = None
    publish_at: Optional[str] = None
    last_run: Optional[str] = None
    last_run_status: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class ScheduledJobCreate(BaseModel):
    site_id: str
    job_type: str
    enabled: bool = True
    cron_expression: Optional[str] = None
    publish_post_id: Optional[str] = None
    publish_at: Optional[str] = None

# --- Agent Session Models ---
class AgentMessage(BaseModel):
    role: str  # "user" | "assistant" | "tool"
    content: str
    tool_calls: Optional[List[Dict]] = None
    tool_call_id: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

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

class BulkPublishRequest(BaseModel):
    site_id: str
    item_ids: List[str]  # wp_ids as strings
    content_type: str  # "post" | "page"
    action: str  # "publish" | "draft"

class WordPressSite(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    url: str
    # "wordpress" drives content through the WP REST API (the original and
    # default behaviour). Any other platform is tracked by URL only: the
    # domain-level SEO features (backlinks, keywords, citations, indexing,
    # directories, PageSpeed) all work, while WP-specific content management
    # is refused with a clear message instead of a confusing gateway error.
    platform: str = "wordpress"       # "wordpress" | "nextjs"
    username: str = ""
    app_password: str = ""
    auth_type: str = "app_password"   # "app_password" | "jwt"
    jwt_token: str = ""               # Bearer token for JWT auth
    status: str = "pending"
    user_id: str = "global"
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    last_sync: Optional[str] = None

class WordPressSiteCreate(BaseModel):
    name: str
    url: str
    platform: str = "wordpress"       # "wordpress" | "nextjs"
    username: str = ""
    app_password: str = ""
    auth_type: str = "app_password"   # "app_password" | "jwt"
    jwt_token: str = ""               # pre-generated JWT Bearer token (optional)
    wp_password: str = ""             # plain WP password used ONLY to auto-generate JWT token; never stored

class WordPressSiteResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str
    url: str
    platform: str = "wordpress"
    username: str = ""
    app_password: str = "••••••••"
    auth_type: str = "app_password"
    status: str
    created_at: str
    last_sync: Optional[str] = None

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

class PageCreate(BaseModel):
    site_id: str
    title: str
    content: str
    status: str = "draft"

class PostCreate(BaseModel):
    site_id: str
    title: str
    content: str
    status: str = "draft"
    categories: List[int] = []
    tags: List[int] = []

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

class BulkMetaUpdate(BaseModel):
    site_id: str
    item_ids: List[int]
    content_type: str = "post"  # "post" | "page"
    meta_title: Optional[str] = None
    meta_description: Optional[str] = None

class BulkTaxonomyUpdate(BaseModel):
    site_id: str
    item_ids: List[int]
    categories: Optional[List[int]] = None
    tags: Optional[List[str]] = None

class PostTranslateRequest(BaseModel):
    target_languages: List[str]

class SEOMetrics(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    site_id: str
    page_url: str
    keyword: str
    ranking: Optional[int] = None
    impressions: int = 0
    clicks: int = 0
    ctr: float = 0.0
    recorded_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

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

class NavigationMenu(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    site_id: str
    wp_menu_id: int
    name: str
    items: List[Dict[str, Any]] = []
    synced_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

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
    post_id: int
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
class PluginAuditResult(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    site_id: str
    plugins: List[Dict] = []
    issues: List[Dict] = []
    total_plugins: int = 0
    high_issues: int = 0
    medium_issues: int = 0
    audited_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

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

