import uuid
from datetime import datetime, timezone

from pydantic import BaseModel, ConfigDict, Field

from core.db import db


class ActivityLog(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    site_id: str
    action: str
    details: str
    status: str = "success"
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


async def log_activity(site_id: str, action: str, details: str, status: str = "success", user_id: str = "global"):
    """Log an activity"""
    log = ActivityLog(site_id=site_id, action=action, details=details, status=status)
    log_dict = log.model_dump()
    log_dict["user_id"] = user_id
    await db.activity_logs.insert_one(log_dict)
