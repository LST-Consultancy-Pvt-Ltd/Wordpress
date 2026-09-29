"""Domain models for managed Next.js sites and the change-set pipeline.

Persistence (MongoDB collections):
  sites            ManagedSite (+ embedded SiteConnection, BridgeAgent snapshot)
  changesets       ChangeSet
  revisions        Revision (control-plane record of a bridge revision)
  deployments      Deployment
  backups          Backup (control-plane record of a bridge backup)
  site_policies    SitePolicy
  audit_events     see core/audit.py
"""
import re
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

SITE_KEY_RE = re.compile(r"^[a-z][a-z0-9-]{1,62}$")
KEY_ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")
SECRET_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")  # base64url(32 bytes), no padding


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Environment(str, Enum):
    production = "production"
    staging = "staging"
    development = "development"


class InstallMode(str, Enum):
    sidecar = "sidecar"
    in_app = "in-app"


class ConnectionStatus(str, Enum):
    unverified = "unverified"
    connected = "connected"
    degraded = "degraded"
    unreachable = "unreachable"
    revoked = "revoked"


class SiteConnection(BaseModel):
    """How the control plane reaches the bridge. The secret itself is stored
    encrypted in `secret_enc` and is never part of any response model."""
    model_config = ConfigDict(extra="ignore")
    status: ConnectionStatus = ConnectionStatus.unverified
    key_id: str = ""
    credential_rotated_at: Optional[str] = None
    last_handshake_at: Optional[str] = None
    last_error: Optional[str] = None
    private_network_http: bool = False


class BridgeAgent(BaseModel):
    """Snapshot of what the bridge reported in its handshake."""
    model_config = ConfigDict(extra="allow")
    protocol_version: str
    agent_version: str
    mode: Optional[str] = None
    capabilities: dict[str, bool] = Field(default_factory=dict)


class ManagedSite(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    base_url: str
    bridge_url: str
    environment: Environment = Environment.production
    site_key: str
    install_mode: InstallMode = InstallMode.sidecar
    connection: SiteConnection = Field(default_factory=SiteConnection)
    writes_enabled: bool = False
    write_verified_at: Optional[str] = None
    capabilities: Optional[dict[str, Any]] = None
    health: Optional[dict[str, Any]] = None
    user_id: Optional[str] = None
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


class SiteCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    base_url: str
    bridge_url: str
    environment: Environment = Environment.production
    site_key: str
    install_mode: InstallMode = InstallMode.sidecar
    key_id: str
    secret: str
    allow_private_http: bool = False

    @field_validator("site_key")
    @classmethod
    def _site_key(cls, v: str) -> str:
        if not SITE_KEY_RE.match(v):
            raise ValueError("site_key must be lowercase letters, digits and hyphens (2-63 chars, starting with a letter)")
        return v

    @field_validator("key_id")
    @classmethod
    def _key_id(cls, v: str) -> str:
        if not KEY_ID_RE.match(v):
            raise ValueError("key_id must be 4-64 chars of letters, digits, '_' or '-'")
        return v

    @field_validator("secret")
    @classmethod
    def _secret(cls, v: str) -> str:
        if not SECRET_RE.match(v):
            raise ValueError("secret must be the 43-character base64url value issued by the bridge")
        return v


class SiteUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    base_url: Optional[str] = None
    bridge_url: Optional[str] = None
    environment: Optional[Environment] = None
    allow_private_http: Optional[bool] = None


class Confirm(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm: str = ""


class WritesToggle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool
    confirm: str = ""


class CredentialReplace(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key_id: str
    secret: str

    _key_id = field_validator("key_id")(SiteCreate._key_id.__func__)
    _secret = field_validator("secret")(SiteCreate._secret.__func__)


# ---- Change sets ------------------------------------------------------------

class ChangeSetStatus(str, Enum):
    draft = "draft"
    planned = "planned"
    plan_failed = "plan_failed"
    validating = "validating"
    validated = "validated"
    validation_failed = "validation_failed"
    pending_approval = "pending_approval"
    approved = "approved"
    rejected = "rejected"
    applying = "applying"
    applied = "applied"
    apply_failed = "apply_failed"
    rolled_back = "rolled_back"
    cancelled = "cancelled"


EDITABLE_STATES = {ChangeSetStatus.draft, ChangeSetStatus.planned, ChangeSetStatus.plan_failed,
                   ChangeSetStatus.validation_failed, ChangeSetStatus.rejected}
TERMINAL_STATES = {ChangeSetStatus.applied, ChangeSetStatus.rolled_back, ChangeSetStatus.cancelled}

ChangeSetSource = Literal[
    "manual", "onpage-seo", "auto-seo", "autopilot", "blog-generation", "programmatic",
    "redirects", "ai-agent", "backup-restore", "content-refresh", "schema", "canonical",
]


class ChangeSetCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)
    operations: list[dict[str, Any]] = Field(min_length=1, max_length=200)
    source: Optional[ChangeSetSource] = None  # ignored: the server sets it


class ChangeSetUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = Field(default=None, max_length=4000)
    operations: Optional[list[dict[str, Any]]] = Field(default=None, min_length=1, max_length=200)


class ReviewDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    comment: str = Field(default="", max_length=2000)


class ApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm: str = ""


class RollbackRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm: str = ""
    reason: str = Field(min_length=1, max_length=2000)


class ValidateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    steps: Optional[list[Literal["format", "lint", "typecheck", "build", "test"]]] = None


# ---- Deployments / backups ---------------------------------------------------

PROFILE_RE = re.compile(r"^[a-z][a-z0-9-]{0,39}$")


class DeploymentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    profile: str
    reason: str = Field(min_length=1, max_length=2000)
    confirm: str = ""

    @field_validator("profile")
    @classmethod
    def _profile(cls, v: str) -> str:
        if not PROFILE_RE.match(v):
            raise ValueError("invalid profile name")
        return v


class DeploymentRollbackRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm: str = ""
    reason: str = Field(min_length=1, max_length=2000)


class BackupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["overrides", "content", "full"] = "overrides"


class RestoreRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm: str = ""
    confirm_site: str = ""
    dry_run: bool = True


# ---- Policy ------------------------------------------------------------------

AUTO_APPLY_SAFE_OPS = ("metadata.set", "metadata.clear", "image.alt.set", "image.alt.clear",
                       "block.set", "block.clear", "content.upsert")
RISK_ORDER = ("low", "medium", "high")


class AutoApplyPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    environments: list[Environment] = Field(default_factory=lambda: [Environment.staging])
    sources: list[str] = Field(default_factory=list)
    ops: list[str] = Field(default_factory=lambda: ["metadata.set", "metadata.clear", "image.alt.set"])
    max_risk: Literal["low", "medium"] = "low"

    @field_validator("ops")
    @classmethod
    def _ops(cls, v: list[str]) -> list[str]:
        bad = [o for o in v if o not in AUTO_APPLY_SAFE_OPS]
        if bad:
            raise ValueError(f"these operations can never be auto-applied: {', '.join(bad)}")
        return v


class PolicyLimits(BaseModel):
    model_config = ConfigDict(extra="forbid")
    max_changesets_per_day: int = Field(default=20, ge=1, le=1000)
    max_operations_per_changeset: int = Field(default=50, ge=1, le=200)
    ai_daily_budget_usd: float = Field(default=5, ge=0, le=1000)


class SitePolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    auto_apply: AutoApplyPolicy = Field(default_factory=AutoApplyPolicy)
    limits: PolicyLimits = Field(default_factory=PolicyLimits)
    require_validation_for_file_ops: bool = True
    allow_self_approval_nonprod: bool = True
