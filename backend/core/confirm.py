"""Typed confirmation for destructive / production actions: the caller must
send the site's exact name, the same barrier the UI shows."""
from fastapi import HTTPException


def require_site_confirmation(site: dict, confirm: str, action: str) -> None:
    if (confirm or "") != site.get("name"):
        raise HTTPException(status_code=400, detail={
            "code": "CONFIRMATION_REQUIRED",
            "message": f"To {action}, type the site name exactly as shown ('{site.get('name')}') to confirm.",
        })


def require_production_confirmation(site: dict, confirm: str, action: str) -> None:
    if site.get("environment") == "production":
        require_site_confirmation(site, confirm, action)
