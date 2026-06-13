"""
SendGrid email service.

Handles transactional emails: password reset, welcome, etc.
"""

import httpx
from app.core.config import get_settings


async def send_email(to: str, subject: str, text: str, html: str | None = None) -> None:
    """Send a plain-text (and optional HTML) email via the SendGrid v3 mail send API.

    Raises httpx.HTTPError on failure — callers handle retries/logging as needed.
    """
    settings = get_settings()
    if not settings.sendgrid_api_key:
        raise RuntimeError("SENDGRID_API_KEY is not set")

    payload = {
        "personalizations": [{"to": [{"email": to}]}],
        "from": {"email": settings.email_from_address},
        "subject": subject,
        "content": [{"type": "text/plain", "value": text}] + (
            [{"type": "text/html", "value": html}] if html else []
        ),
    }

    async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0)) as client:
        r = await client.post(
            "https://api.sendgrid.com/v3/mail/send",
            json=payload,
            headers={
                "Authorization": f"Bearer {settings.sendgrid_api_key}",
                "Content-Type": "application/json",
            },
        )
        if r.status_code >= 400:
            raise httpx.HTTPError(f"SendGrid error {r.status_code}: {r.text}")
