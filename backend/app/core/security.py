import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any
import bcrypt
from jose import jwt, JWTError
from .config import get_settings

settings = get_settings()

ALGORITHM = "HS256"
ACCESS_EXPIRE_MINUTES = 30
REFRESH_EXPIRE_DAYS = 7
RESET_TOKEN_EXPIRE_MINUTES = 60


def _prehash(password: str) -> bytes:
    """SHA-256 → base64 (44 ASCII bytes) so bcrypt never sees > 72 bytes."""
    return base64.b64encode(hashlib.sha256(password.encode()).digest())


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_prehash(password), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(_prehash(plain), hashed.encode())


def create_access_token(user_id: int) -> str:
    exp = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_EXPIRE_MINUTES)
    return jwt.encode({"sub": str(user_id), "exp": exp, "type": "access"}, settings.secret_key, algorithm=ALGORITHM)


def create_refresh_token(user_id: int) -> str:
    exp = datetime.now(timezone.utc) + timedelta(days=REFRESH_EXPIRE_DAYS)
    return jwt.encode({"sub": str(user_id), "exp": exp, "type": "refresh"}, settings.secret_key, algorithm=ALGORITHM)


def decode_token(token: str) -> dict[str, Any]:
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except JWTError as exc:
        raise ValueError("Invalid token") from exc


def create_reset_token(user_id: int) -> tuple[str, datetime]:
    """Generate a secure random reset token and its expiry time.

    Returns (token, expires_at).  Store both in the DB; discard the token
    after use (one-time).
    """
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=RESET_TOKEN_EXPIRE_MINUTES)
    return token, expires_at


def verify_reset_token(token: str, stored_token: str | None, expires_at: datetime | None) -> bool:
    """Check a presented token matches the stored one and has not expired."""
    if not token or not stored_token or not expires_at:
        return False
    if token != stored_token:
        return False
    if datetime.now(timezone.utc) > expires_at:
        return False
    return True
