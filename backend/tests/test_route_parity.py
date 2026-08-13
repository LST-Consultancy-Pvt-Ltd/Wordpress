"""
Route-parity guard for the server.py → core/routers refactor (see REFACTOR_NOTES.md).

`route_baseline.json` is a frozen snapshot of every (path, methods) pair that
`app.routes` exposed on the FastAPI app *before* the module-split refactor began.
This test asserts the current app exposes exactly the same set. Any refactor PR
that changes this test's result (beyond regenerating the baseline for an
intentional, reviewed API change) should be treated as a bug, not a feature.

To regenerate the baseline after an intentional route change:
    python -c "
import json
from server import app
routes = sorted(
    (r.path, sorted(r.methods)) for r in app.routes if hasattr(r, 'methods')
)
json.dump(routes, open('tests/route_baseline.json', 'w'), indent=2)
"
"""
import json
from pathlib import Path

import pytest

BASELINE_PATH = Path(__file__).parent / "route_baseline.json"


def _current_routes():
    from server import app  # noqa: PLC0415 (import here so env vars are set first)
    out = []
    for r in app.routes:
        methods = getattr(r, "methods", None)
        path = getattr(r, "path", None)
        if methods is None or path is None:
            continue
        out.append((path, sorted(methods)))
    return sorted(out)


def test_route_count_matches_baseline():
    baseline = json.loads(BASELINE_PATH.read_text())
    current = _current_routes()
    assert len(current) == len(baseline), (
        f"Route count changed: baseline had {len(baseline)}, current has {len(current)}. "
        f"If this is an intentional API change, regenerate tests/route_baseline.json."
    )


def test_every_baseline_route_still_exists_with_same_methods():
    baseline_pairs = {(p, tuple(m)) for p, m in json.loads(BASELINE_PATH.read_text())}
    current_pairs = {(p, tuple(m)) for p, m in _current_routes()}

    missing = baseline_pairs - current_pairs
    added = current_pairs - baseline_pairs

    assert not missing, f"{len(missing)} route(s) from the pre-refactor baseline are gone: {sorted(missing)[:10]}"
    assert not added, f"{len(added)} unexpected new route(s) not in the pre-refactor baseline: {sorted(added)[:10]}"
