"""Kill switch for unattended writes to managed sites.

During the Next.js migration nothing may publish, edit or deploy to a site
without a person initiating it: the old write paths target the CMS being
removed, and the replacement (change set -> approval -> bridge apply) does not
exist yet. Background jobs check `automatic_writes_frozen()` before they
register or run; user-initiated requests are unaffected.

The freeze is ON unless AUTOMATION_WRITES_FROZEN is explicitly set to a false
value, so a missing env var fails safe. It is read on every call, not cached
at import, so an operator can lift it with a restart and tests can toggle it.
"""
import logging
import os

logger = logging.getLogger(__name__)

_FALSE_VALUES = {"0", "false", "no", "off"}


def automatic_writes_frozen() -> bool:
    return os.environ.get("AUTOMATION_WRITES_FROZEN", "1").strip().lower() not in _FALSE_VALUES


def skip_if_frozen(what: str) -> bool:
    """Return True (and log why) when `what` must not run because of the freeze."""
    if automatic_writes_frozen():
        logger.warning("Automatic site writes are frozen; skipping %s", what)
        return True
    return False
