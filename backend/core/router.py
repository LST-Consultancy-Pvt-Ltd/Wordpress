from fastapi import APIRouter

# Shared across server.py and every routers/*.py module so that route
# registration (via @api_router decorators) accumulates onto one object
# regardless of which file executes first.
api_router = APIRouter(prefix="/api")
