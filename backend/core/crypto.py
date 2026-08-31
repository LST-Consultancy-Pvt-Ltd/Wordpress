import os

from cryptography.fernet import Fernet

from core.db import db

# Fernet encryption (for sensitive DB fields)
_fernet = Fernet(os.environ["ENCRYPTION_KEY"].encode()) if os.environ.get("ENCRYPTION_KEY") else None


def encrypt_field(value: str) -> str:
    if not _fernet or not value:
        return value
    return _fernet.encrypt(value.encode()).decode()


def decrypt_field(value: str) -> str:
    if not _fernet or not value:
        return value
    try:
        return _fernet.decrypt(value.encode()).decode()
    except Exception:
        return value  # Already plaintext (pre-migration data)


_SENSITIVE_SETTINGS_FIELDS = (
    "openai_api_key", "anthropic_api_key",
    "google_analytics_credentials", "google_search_console_credentials",
    "pagespeed_api_key", "zerogpt_api_key",
    "dataforseo_login", "dataforseo_password",
    "google_search_api_key",  # §16: was stored in plaintext — added for encryption-at-rest
    "smtp_username", "smtp_password",  # §11: SMTP credentials for outreach sending
    "hunter_api_key",  # Hunter.io contact-finder credential for backlink outreach
    "signalhire_api_key",  # SignalHire contact-finder fallback credential for backlink outreach
    "semrush_api_key",  # SEMrush keyword-research cross-check credential
)


async def get_decrypted_settings() -> dict:
    """Fetch global settings from DB and decrypt all sensitive fields."""
    s = await db.settings.find_one({"id": "global_settings"}, {"_id": 0}) or {}
    for key in _SENSITIVE_SETTINGS_FIELDS:
        if s.get(key):
            s[key] = decrypt_field(s[key])
    return s
