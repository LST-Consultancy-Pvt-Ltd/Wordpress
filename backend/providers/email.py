"""Generic SMTP email sender (§11 outreach sending) — vendor-neutral: works
with any provider that speaks standard SMTP (Gmail, SendGrid, Mailgun, AWS
SES, a self-hosted mail server, etc.), so this doesn't hard-code a choice of
vendor the operator may not have an account with. Credentials come from
Settings (smtp_host/port/username/password/from_email/use_tls) or SMTP_*
env vars.

Nothing in this module fires automatically — see routers/outreach_gate.py
for the approval gate that must pass before send_email() is ever called.
"""
import asyncio
import os
import smtplib
from email.mime.text import MIMEText

from core.crypto import get_decrypted_settings


async def _smtp_credentials() -> dict:
    settings = await get_decrypted_settings()
    return {
        "host": settings.get("smtp_host") or os.environ.get("SMTP_HOST", ""),
        "port": int(settings.get("smtp_port") or os.environ.get("SMTP_PORT", "587") or 587),
        "username": settings.get("smtp_username") or os.environ.get("SMTP_USERNAME", ""),
        "password": settings.get("smtp_password") or os.environ.get("SMTP_PASSWORD", ""),
        "from_email": settings.get("smtp_from_email") or os.environ.get("SMTP_FROM_EMAIL", ""),
        "use_tls": settings.get("smtp_use_tls", True),
    }


async def smtp_available() -> bool:
    creds = await _smtp_credentials()
    return bool(creds["host"] and creds["username"] and creds["password"] and creds["from_email"])


def _send_sync(creds: dict, to_email: str, subject: str, body: str) -> None:
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = creds["from_email"]
    msg["To"] = to_email
    if creds["port"] == 465:
        # Port 465 is implicit TLS (SMTPS) — the socket must be SSL-wrapped
        # from the first byte. Opening a plain SMTP() connection and calling
        # starttls() (the port-587 protocol) here just hangs talking
        # plaintext to a TLS socket until it times out.
        with smtplib.SMTP_SSL(creds["host"], creds["port"], timeout=20) as server:
            server.login(creds["username"], creds["password"])
            server.sendmail(creds["from_email"], [to_email], msg.as_string())
    else:
        with smtplib.SMTP(creds["host"], creds["port"], timeout=20) as server:
            if creds["use_tls"]:
                server.starttls()
            server.login(creds["username"], creds["password"])
            server.sendmail(creds["from_email"], [to_email], msg.as_string())


async def send_email(to_email: str, subject: str, body: str) -> None:
    """Send a real email over SMTP. Raises RuntimeError if not configured, or
    whatever smtplib raises if the send itself fails — callers must propagate
    this, never swallow it into a fake "sent" status."""
    creds = await _smtp_credentials()
    if not (creds["host"] and creds["username"] and creds["password"] and creds["from_email"]):
        raise RuntimeError("SMTP is not configured — set smtp_host/username/password/from_email in Settings.")
    await asyncio.to_thread(_send_sync, creds, to_email, subject, body)
