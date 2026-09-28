#!/usr/bin/env python3
"""Zero-WordPress-reference scanner for the Next.js migration.

Three modes:

  inventory   Write a machine-readable JSON inventory of every WordPress/WP/
              WooCommerce/XML-RPC/PHP-plugin reference in the repository
              (file, line, matched term, category).

  baseline    Write per-file hit counts to the ratchet baseline. Run this only
              when a commit intentionally REMOVES references, so the baseline
              shrinks; never to absorb new references.

  check       CI gate. Fails if any file has more hits than the baseline
              allows, or if a file that is absent from the baseline has any hit.
              Once the migration is complete the baseline is empty and this
              becomes a plain "zero references" check.

Paths listed in the allow-list file are skipped entirely. The allow-list is
meant only for historical migration notes that are excluded from shipping,
plus this scanner and its own test fixtures.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ALLOWLIST = REPO / "migration" / "legacy-scan-allowlist.txt"
BASELINE = REPO / "migration" / "legacy-scan-baseline.json"
INVENTORY = REPO / "migration" / "inventory" / "legacy-references.json"

SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "build", "dist",
    ".next", "out", "coverage", ".cache", ".pytest_cache", ".ruff_cache",
}
SKIP_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".woff", ".woff2",
    ".ttf", ".eot", ".zip", ".gz", ".tgz", ".pdf", ".xlsx", ".pyc", ".lock",
}
SKIP_NAMES = {".DS_Store", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "uv.lock"}

# (category, compiled pattern). Order matters only for reporting: the first
# category that matches a given span wins.
PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("woocommerce", re.compile(r"woo[-_ ]?commerce|(?<![a-z0-9])woo(?![a-z0-9])|/wc/v\d", re.I)),
    ("xmlrpc", re.compile(r"xml[-_ ]?rpc", re.I)),
    # Joined form anywhere (isWordPress, WordPressSite); separated forms only
    # at a word start, so "keyword press release" is not a hit.
    ("wordpress", re.compile(r"wordpress|(?<![a-z0-9])word[-_ ]press", re.I)),
    ("wp_api_path", re.compile(r"wp-json|wp-admin|wp-content|wp-includes|wp-login", re.I)),
    # wp as its own token: wp_token, wp-users, WP Users, "wp", get_wp_credentials
    ("wp_token", re.compile(r"(?<![a-z0-9])wp(?![a-z0-9])", re.I)),
    # wp as a camel/Pascal-case segment: WPUsers, wpAdminUrl, getWpPosts, WpAdmin
    ("wp_identifier", re.compile(r"(?<![A-Za-z0-9])(?:WP|Wp|wp)(?=[A-Z])|(?<=[a-z0-9])Wp(?=[A-Z_]|\b)")),
    ("wp_plugin_ecosystem", re.compile(r"yoast|rank[-_ ]?math|wpseo|contact-form-7|wpforms|application[-_ ]passwords?|app_password", re.I)),
    ("php", re.compile(r"\.php\b|<\?php", re.I)),
]


def load_allowlist() -> list[str]:
    if not ALLOWLIST.exists():
        return []
    out = []
    for line in ALLOWLIST.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            out.append(line)
    return out


def is_allowed(rel: str, allow: list[str]) -> bool:
    # fnmatch's `*` also matches `/`, so "migration/**" covers the whole tree.
    return any(fnmatch.fnmatch(rel, pat) for pat in allow)


def _git_files(root: Path) -> list[Path] | None:
    """Tracked plus untracked-but-not-ignored files: exactly what a commit or
    CI checkout could contain. Keeps local secrets (.env) and build output out
    of the scan without maintaining a second ignore list."""
    try:
        out = subprocess.run(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            cwd=root, capture_output=True, check=True,
        ).stdout.decode()
    except (OSError, subprocess.CalledProcessError):
        return None
    return sorted(root / p for p in out.split("\0") if p)


def iter_files(root: Path):
    candidates = _git_files(root)
    if candidates is None:
        candidates = sorted(root.rglob("*"))
    for path in candidates:
        if not path.is_file():
            continue
        rel_parts = path.relative_to(root).parts
        if any(p in SKIP_DIRS for p in rel_parts[:-1]):
            continue
        if path.name in SKIP_NAMES or path.suffix.lower() in SKIP_SUFFIXES:
            continue
        yield path


def scan_text(text: str) -> list[dict]:
    hits = []
    for lineno, line in enumerate(text.splitlines(), 1):
        taken: list[tuple[int, int]] = []
        for category, pat in PATTERNS:
            for m in pat.finditer(line):
                if any(s <= m.start() < e for s, e in taken):
                    continue
                taken.append((m.start(), m.end()))
                hits.append({"line": lineno, "category": category, "match": m.group(0)})
    return hits


def scan_repo(root: Path | None = None, allow: list[str] | None = None) -> dict[str, list[dict]]:
    root = REPO if root is None else root
    allow = load_allowlist() if allow is None else allow
    results: dict[str, list[dict]] = {}
    for path in iter_files(root):
        rel = path.relative_to(root).as_posix()
        # Path names count too: a file called WPUsers.jsx is itself a reference.
        name_hits = [dict(h, line=0) for h in scan_text(rel)]
        if is_allowed(rel, allow):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        hits = name_hits + scan_text(text)
        if hits:
            results[rel] = hits
    return results


def summarize(results: dict[str, list[dict]]) -> dict:
    by_cat = Counter(h["category"] for hits in results.values() for h in hits)
    by_top = Counter()
    for rel, hits in results.items():
        top = rel.split("/", 2)
        key = "/".join(top[:2]) if len(top) > 2 else top[0]
        by_top[key] += len(hits)
    return {
        "files": len(results),
        "hits": sum(len(h) for h in results.values()),
        "by_category": dict(by_cat.most_common()),
        "by_area": dict(by_top.most_common()),
    }


def cmd_inventory(out: Path) -> int:
    results = scan_repo()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summarize(results), "files": results}, indent=1) + "\n")
    s = summarize(results)
    print(f"{s['hits']} references in {s['files']} files -> {out.relative_to(REPO)}")
    return 0


def cmd_baseline() -> int:
    results = scan_repo()
    counts = {rel: len(h) for rel, h in sorted(results.items())}
    old = json.loads(BASELINE.read_text()) if BASELINE.exists() else None
    if old is not None:
        grown = {k: (old.get(k, 0), v) for k, v in counts.items() if v > old.get(k, 0)}
        if grown:
            print("Refusing to grow the baseline; these files gained references:", file=sys.stderr)
            for k, (a, b) in sorted(grown.items()):
                print(f"  {k}: {a} -> {b}", file=sys.stderr)
            return 1
    BASELINE.write_text(json.dumps(counts, indent=1, sort_keys=True) + "\n")
    print(f"Baseline: {sum(counts.values())} references in {len(counts)} files")
    return 0


def cmd_check(verbose: bool) -> int:
    results = scan_repo()
    baseline = json.loads(BASELINE.read_text()) if BASELINE.exists() else {}
    failures = []
    for rel, hits in sorted(results.items()):
        allowed = baseline.get(rel, 0)
        if len(hits) > allowed:
            failures.append((rel, allowed, hits))
    remaining = sum(len(h) for h in results.values())
    stale = sorted(k for k in baseline if k not in results)
    if failures:
        print("New WordPress references (the migration forbids adding any):", file=sys.stderr)
        for rel, allowed, hits in failures:
            print(f"  {rel}: {len(hits)} found, baseline allows {allowed}", file=sys.stderr)
            for h in hits[:10]:
                print(f"    L{h['line']}: {h['category']}: {h['match']!r}", file=sys.stderr)
        return 1
    print(f"OK: no new references. {remaining} legacy references remain in {len(results)} files.")
    if stale and verbose:
        print("Baseline entries now clean (run `baseline` to shrink): " + ", ".join(stale))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    inv = sub.add_parser("inventory")
    inv.add_argument("--out", type=Path, default=INVENTORY)
    sub.add_parser("baseline")
    chk = sub.add_parser("check")
    chk.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    if args.cmd == "inventory":
        return cmd_inventory(args.out)
    if args.cmd == "baseline":
        return cmd_baseline()
    return cmd_check(args.verbose)


if __name__ == "__main__":
    sys.exit(main())
