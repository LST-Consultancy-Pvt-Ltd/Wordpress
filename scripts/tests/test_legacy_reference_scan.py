import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import legacy_reference_scan as scan  # noqa: E402


@pytest.mark.parametrize("text", [
    "WordPress", "wordpress", "Word Press", "word-press",
    "localStorage.getItem('wp_token')", "/wp-users/1", "WP Autopilot",
    "get_wp_credentials", "WPUsers", "wpAdminUrl", "getWpPosts",
    "/wp-json/wp/v2/posts", "/wp-admin/nav-menus.php",
    "XML-RPC", "xmlrpc", "WooCommerce", "/wc/v3/products", "woo_request",
    "Yoast", "RankMath", "rank_math", "app_password", "Application Passwords",
    "<?php", "tools.php",
])
def test_flags_wordpress_references(text):
    assert scan.scan_text(text), text


@pytest.mark.parametrize("text", [
    "swap", "wpm", "newspaper", "Wrapper", "keyword press release",
    "the wood worker", "NextJS bridge", "sweep", "upward",
])
def test_ignores_ordinary_words(text):
    assert scan.scan_text(text) == [], text


def test_overlapping_patterns_count_once():
    # "wp-json" should be reported once, not also as a bare "wp" token.
    hits = scan.scan_text("/wp-json/")
    assert [h["category"] for h in hits] == ["wp_api_path"]


def _git_repo(tmp_path: Path, files: dict[str, str]) -> Path:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    for rel, body in files.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
    return tmp_path


def test_scan_respects_gitignore_allowlist_and_filenames(tmp_path):
    repo = _git_repo(tmp_path, {
        ".gitignore": ".env\n",
        ".env": "DB_NAME=wordpress\n",
        "notes/history.md": "WordPress was removed",
        "src/WPUsers.jsx": "export default 1;\n",
        "src/clean.js": "const ok = true;\n",
    })
    results = scan.scan_repo(repo, allow=["notes/**"])
    assert set(results) == {"src/WPUsers.jsx"}  # flagged for its name alone
    assert results["src/WPUsers.jsx"][0]["line"] == 0


def test_check_fails_only_when_a_file_exceeds_its_baseline(tmp_path, monkeypatch, capsys):
    repo = _git_repo(tmp_path, {"a.py": "wp_token = 1\n", "b.py": "x = 1\n"})
    baseline = tmp_path / "baseline.json"
    monkeypatch.setattr(scan, "REPO", repo)
    monkeypatch.setattr(scan, "BASELINE", baseline)
    monkeypatch.setattr(scan, "ALLOWLIST", tmp_path / "none.txt")

    baseline.write_text(json.dumps({"a.py": 1}))
    assert scan.cmd_check(verbose=False) == 0

    (repo / "b.py").write_text("url = '/wp-json/'\n")
    assert scan.cmd_check(verbose=False) == 1
    assert "b.py" in capsys.readouterr().err


def test_baseline_refuses_to_grow(tmp_path, monkeypatch):
    repo = _git_repo(tmp_path, {"a.py": "wp_token = 1\n"})
    baseline = tmp_path / "baseline.json"
    monkeypatch.setattr(scan, "REPO", repo)
    monkeypatch.setattr(scan, "BASELINE", baseline)
    monkeypatch.setattr(scan, "ALLOWLIST", tmp_path / "none.txt")

    baseline.write_text(json.dumps({"a.py": 1}))
    (repo / "a.py").write_text("wp_token = 1\nwp_user = 2\n")
    assert scan.cmd_baseline() == 1
    assert json.loads(baseline.read_text()) == {"a.py": 1}

    (repo / "a.py").write_text("token = 1\n")
    assert scan.cmd_baseline() == 0
    assert json.loads(baseline.read_text()) == {}
