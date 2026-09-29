"""The shared `/api` router, with a baseline access policy applied to every
route registered on it.

Individual routes still declare their own, usually stricter, dependencies
(`require_deployer`, `require_admin`, ...). The baseline guarantees that a
route which forgets to declare one is neither public nor writable by a
viewer:

- every route requires an authenticated user, except the explicit PUBLIC set;
- every mutating method (POST/PUT/PATCH/DELETE) requires editor or higher,
  except the explicit VIEWER_MUTATIONS set.
"""
import re

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials

from core.security import bearer_scheme, get_current_user, has_role

# (method, path regex relative to /api)
PUBLIC = [
    ("GET", r"/"),
    ("GET", r"/health"),
    ("POST", r"/auth/login"),
    ("POST", r"/auth/register"),        # first user only; later ones require an admin token (checked in the route)
    ("GET", r"/stream/[^/]+"),           # authenticated by a task-bound stream token in the route
    ("GET", r"/autopilot/[^/]+/stream"),  # same, token bound to "autopilot:{site_id}"
    ("POST", r"/newsletter/[^/]+/subscribe"),  # public signup form
]
VIEWER_MUTATIONS = [
    ("POST", r"/stream-token"),
    ("POST", r"/notifications/[^/]+/mark-read/[^/]+"),
    ("POST", r"/notifications/[^/]+/mark-all-read"),
]
MUTATING = {"POST", "PUT", "PATCH", "DELETE"}


def _match(rules, method: str, path: str) -> bool:
    return any(m == method and re.fullmatch(p, path) for m, p in rules)


async def baseline_access(request: Request, credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme)):
    method = request.method.upper()
    path = request.url.path[len("/api"):] or "/"
    if _match(PUBLIC, method, path):
        return
    user = await get_current_user(credentials)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    if method in MUTATING and not has_role(user, "editor") and not _match(VIEWER_MUTATIONS, method, path):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="Your role is read-only; editor or higher access is required")


api_router = APIRouter(prefix="/api", dependencies=[Depends(baseline_access)])
