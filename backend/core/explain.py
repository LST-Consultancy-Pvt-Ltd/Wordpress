"""Explainability convention (§17): a tiny, deliberately unopinionated helper
plus a documented pattern, not a framework — retrofitting a heavyweight
"explainability system" onto ~40 already-verified router modules would be a
lot of risk for little value. The actual convention:

Any AI-driven or rule-based recommendation/flag should carry a short,
specific "why" — not a generic label. This already happens in several
places in this codebase and predates this module:
  - `routers/opportunities.py`: `reason` (backlink opportunities),
    `inconsistency_note` (NAP audit), `redirect_reason` (link reclamation),
    and `offpage_priority_actions`'s per-action `why` field.
  - `routers/auto_blog_generation.py`: `why` on each suggested external link.

`with_reason()` below exists so new code has a one-line way to attach the
same convention consistently, not to replace the ad-hoc fields above.
"""


def with_reason(data: dict, reason: str) -> dict:
    """Merge a short, specific explanation into a dict about to be returned
    or stored. `reason` should name the concrete signal that drove the
    decision (e.g. "site returned HTTP 500 on the last health check"), not a
    generic restatement of the flag (e.g. NOT "this needs attention")."""
    return {**data, "why": reason}
