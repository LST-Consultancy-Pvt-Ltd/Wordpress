from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext

from core.config import ACCESS_TOKEN_EXPIRE_MINUTES, ALGORITHM, SECRET_KEY
from core.db import db

# Password hashing
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Security
bearer_scheme = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


async def get_current_user(credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme)):
    """Decode JWT and return user dict. Returns None if no valid token (for backward compat)."""
    if not credentials:
        return None
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload.get("sub")
        if not user_id or payload.get("typ") == "stream":
            return None
        user = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
        if user and "role" not in user:
            # Legacy user created before RBAC was added — default to admin
            user["role"] = "admin"
        return user
    except JWTError:
        return None


async def require_user(credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme)):
    """Strict auth — raises 401 if not authenticated."""
    user = await get_current_user(credentials)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return user


# Ascending privilege. `deployer` sits between editor and admin: it may
# approve, apply, deploy, roll back and restore, but not manage site
# connections, credentials, policies or users.
ROLE_ORDER = ("viewer", "editor", "deployer", "admin")


def role_rank(role: Optional[str]) -> int:
    try:
        return ROLE_ORDER.index(role or "viewer")
    except ValueError:
        return 0


def has_role(user: Optional[dict], minimum: str) -> bool:
    return bool(user) and role_rank(user.get("role")) >= role_rank(minimum)


async def require_deployer(current_user: dict = Depends(require_user)):
    """Allow deployer and admin roles."""
    if not has_role(current_user, "deployer"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Deployer or higher access required")
    return current_user


STREAM_TOKEN_TTL_SECONDS = 120


def create_stream_token(user_id: str, task_id: str) -> str:
    """Short-lived token bound to one task, for EventSource URLs. Browsers
    cannot set headers on EventSource, so the credential has to ride in the
    query string, where it ends up in proxy logs; this keeps the session JWT
    out of there."""
    return create_access_token({"sub": user_id, "typ": "stream", "task": task_id},
                               timedelta(seconds=STREAM_TOKEN_TTL_SECONDS))


def verify_stream_token(token: str, task_id: str) -> Optional[str]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None
    if payload.get("typ") != "stream" or payload.get("task") != task_id:
        return None
    return payload.get("sub")


async def require_admin(current_user: dict = Depends(require_user)):
    """Allow only users with role == 'admin'."""
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return current_user


async def require_editor(current_user: dict = Depends(require_user)):
    """Allow admin and editor roles."""
    if not has_role(current_user, "editor"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Editor or higher access required")
    return current_user
