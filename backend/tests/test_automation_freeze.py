"""The migration freeze on unattended site writes (core/automation_policy.py).

Every background path that can publish to a site without a person clicking
must stay inert while the freeze is on, and the freeze must be on by default.
Scheduler interaction is checked against the real (unstarted) shared scheduler;
database and CMS calls are mocked, so no MongoDB is needed.
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch  # noqa: F401

import pytest

from core import automation_policy
from core import scheduled_jobs
from core.scheduler import scheduler
import routers.autopilot as autopilot

_loop = asyncio.new_event_loop()


def _run(coro):
    return _loop.run_until_complete(coro)


@pytest.fixture
def frozen(monkeypatch):
    monkeypatch.delenv("AUTOMATION_WRITES_FROZEN", raising=False)


@pytest.fixture
def unfrozen(monkeypatch):
    monkeypatch.setenv("AUTOMATION_WRITES_FROZEN", "0")


@pytest.fixture(autouse=True)
def _clean_scheduler():
    yield
    for job in scheduler.get_jobs():
        if job.id.startswith("freeze-test-") or job.id == "autopilot_freeze-site":
            scheduler.remove_job(job.id)


@pytest.mark.parametrize("value,expected", [
    (None, True), ("1", True), ("true", True), ("anything", True),
    ("0", False), ("false", False), ("NO", False), (" off ", False),
])
def test_freeze_defaults_on_and_only_explicit_false_lifts_it(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv("AUTOMATION_WRITES_FROZEN", raising=False)
    else:
        monkeypatch.setenv("AUTOMATION_WRITES_FROZEN", value)
    assert automation_policy.automatic_writes_frozen() is expected


@pytest.mark.parametrize("job_type", ["scheduled_publish", "publish", "deploy"])
def test_jobs_that_would_write_to_a_site_cannot_be_created(job_type):
    from pydantic import ValidationError
    from models.legacy import ScheduledJobCreate
    with pytest.raises(ValidationError):
        ScheduledJobCreate(site_id="s1", job_type=job_type)


def test_auto_apply_policy_is_ignored_while_frozen(monkeypatch):
    from core.changesets import auto_apply_allowed
    from models.sites import SitePolicy
    policy = SitePolicy(auto_apply={"enabled": True, "environments": ["staging"], "ops": ["metadata.set"]})
    site = {"environment": "staging", "writes_enabled": True}
    cs = {"operations": [{"op": "metadata.set"}], "source": "onpage-seo",
          "plan": {"valid": True, "warnings": [], "risk": {"level": "low"}}}
    monkeypatch.setenv("AUTOMATION_WRITES_FROZEN", "0")
    assert auto_apply_allowed(site, cs, policy) is True
    monkeypatch.delenv("AUTOMATION_WRITES_FROZEN")
    assert auto_apply_allowed(site, cs, policy) is False


def test_read_only_jobs_still_register_while_frozen(frozen):
    scheduled_jobs._schedule_job({"id": "freeze-test-seo", "site_id": "s1", "job_type": "seo_health"})
    assert scheduler.get_job("freeze-test-seo") is not None


def test_autopilot_schedule_is_not_registered_while_frozen(frozen):
    autopilot._schedule_autopilot_job("freeze-site", "daily")
    assert scheduler.get_job("autopilot_freeze-site") is None


def test_autopilot_schedule_uses_the_freeze_aware_entry_point(unfrozen):
    autopilot._schedule_autopilot_job("freeze-site", "daily")
    job = scheduler.get_job("autopilot_freeze-site")
    assert job is not None and job.func is autopilot._scheduled_autopilot_run


def test_autopilot_cron_run_is_skipped_if_it_fires_while_frozen(frozen):
    with patch.object(autopilot, "_autopilot_run_pipeline_bg", AsyncMock()) as pipeline:
        _run(autopilot._scheduled_autopilot_run("freeze-site"))
    pipeline.assert_not_called()


def test_autopilot_cron_run_proceeds_when_lifted(unfrozen):
    with patch.object(autopilot, "_autopilot_run_pipeline_bg", AsyncMock()) as pipeline:
        _run(autopilot._scheduled_autopilot_run("freeze-site"))
    pipeline.assert_awaited_once_with("freeze-site")


def _trigger_db(kind):
    """Fake db with one site whose tracked keyword dropped 3 -> 12, or one new keyword."""
    def cursor(docs):
        c = MagicMock()
        c.to_list = AsyncMock(return_value=docs)
        c.sort.return_value = c
        c.limit.return_value = c
        return c

    fake = MagicMock()
    if kind == "rank_drop":
        fake.autopilot_triggers.find.return_value = cursor([{"site_id": "s1", "rank_drop_threshold": 5}])
        fake.tracked_keywords.find.return_value = cursor([
            {"keywords": [{"keyword": "k", "position": 12}]},
            {"keywords": [{"keyword": "k", "position": 3}]},
        ])
    else:
        fake.autopilot_triggers.find.return_value = cursor([{"site_id": "s1"}])
        fake.keyword_tracking.find.return_value = cursor([{"keyword": "k"}])
    fake.autopilot_jobs.insert_one = AsyncMock()
    return fake


@pytest.mark.parametrize("kind,func", [
    ("rank_drop", "_check_rank_drop_triggers"),
    ("new_keyword", "_check_new_keyword_triggers"),
])
def test_trigger_watchers_record_but_do_not_queue_runs_while_frozen(frozen, kind, func):
    import routers.monitoring_triggers as mt
    fake = _trigger_db(kind)
    with patch.object(mt, "db", fake), patch.object(mt, "log_activity", AsyncMock()), \
         patch.object(mt, "_autopilot_run_pipeline_bg", MagicMock()) as pipeline, \
         patch.object(mt.asyncio, "create_task") as create_task:
        _run(getattr(mt, func)())
    create_task.assert_not_called()
    pipeline.assert_not_called()
    doc = fake.autopilot_jobs.insert_one.call_args.args[0]
    assert doc["status"].startswith("skipped") and doc["trigger"] == kind
