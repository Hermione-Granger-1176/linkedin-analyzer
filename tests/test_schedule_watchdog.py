"""Cover the scheduled-workflow watchdog.

The watchdog exists because a disabled schedule fails silently: it cannot open
its own alert. So the tests care most about the two ways that silence can leak
back in, a payload the watchdog cannot read and a cadence table that drifts from
the crons actually declared in ``.github/workflows/``.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from scripts.ci import schedule_watchdog
from scripts.gh.gh_runner import GhError

from tests.gh_test_support import FakeGh, completed_process, has

WORKFLOW_ROOT = Path(__file__).parents[1] / ".github" / "workflows"
CRON_PATTERN = re.compile(r"""^\s*-\s*cron:\s*["']?([^"'\n]+)["']?""", re.MULTILINE)
DAY = schedule_watchdog.DAY_SECONDS
NOW = datetime(2026, 7, 27, 12, tzinfo=UTC)
WORKFLOW = "web-smoke.yml"


def _recency(
    *,
    state: str = "active",
    latest_run_at: datetime | None = NOW,
) -> schedule_watchdog.WorkflowRecency:
    """Build one workflow recency record."""
    return schedule_watchdog.WorkflowRecency(
        workflow_file=WORKFLOW,
        state=state,
        latest_run_at=latest_run_at,
    )


def _runner(
    *,
    state: object = "active",
    runs: object,
    workflow: str = WORKFLOW,
) -> FakeGh:
    """Return a fake gh runner answering both watchdog API calls for one workflow."""
    runs_path = f"repos/owner/name/actions/workflows/{workflow}/runs?event=schedule&per_page=1"
    return FakeGh(
        [
            (has(runs_path), completed_process(0, json.dumps(runs))),
            (
                has(f"repos/owner/name/actions/workflows/{workflow}"),
                completed_process(0, json.dumps({"state": state})),
            ),
        ]
    )


def _runs(created_at: object) -> dict[str, object]:
    """Build a workflow-runs payload carrying one scheduled run."""
    return {"workflow_runs": [{"created_at": created_at}]}


# ─── Cadence table drift ─────────────────────────────────────────────────────


def _max_gap_seconds(cron: str) -> int:
    """Return the longest gap between firings of one cron expression.

    Covers the shapes this repository actually uses: a day-of-month field pins a
    monthly run, a day-of-week field pins a weekly one, and otherwise the hour
    field's entries divide the day evenly.
    """
    minute, hour, day_of_month, _month, day_of_week = cron.split()
    if day_of_month != "*":
        return 31 * DAY  # longest month, so a healthy January is never stale
    if day_of_week != "*":
        return 7 * DAY
    assert minute.count(",") == 0, f"unsupported multi-minute cron: {cron}"
    return DAY // len(hour.split(","))


def _declared_schedules() -> dict[str, int]:
    """Return each workflow file that declares a cron, mapped to its longest gap."""
    schedules: dict[str, int] = {}
    for path in sorted(WORKFLOW_ROOT.glob("*.yml")):
        crons = CRON_PATTERN.findall(path.read_text(encoding="utf-8"))
        if crons:
            schedules[path.name] = min(_max_gap_seconds(cron.strip()) for cron in crons)
    return schedules


def test_cadences_match_the_crons_declared_in_the_workflows() -> None:
    """The cadence table must match the crons actually declared, in both name and value.

    A workflow missing from the table is invisible to the watchdog, which is the
    failure this module exists to prevent. A cadence that is merely too generous
    is the quieter version of the same bug: the schedule is watched, but a
    watchdog that allows twice the real gap will not notice it stop.
    """
    assert _declared_schedules() == schedule_watchdog.SCHEDULED_WORKFLOW_CADENCES


def test_the_gap_deriver_matches_each_cron_shape_in_use() -> None:
    """Pin the helper the drift test depends on, so a wrong table cannot look right."""
    assert _max_gap_seconds("0 3 1 * *") == 31 * DAY
    assert _max_gap_seconds("30 6 * * 1") == 7 * DAY
    assert _max_gap_seconds("0 7,19 * * *") == DAY // 2
    assert _max_gap_seconds("0 6 * * *") == DAY


def test_every_cadence_is_a_positive_duration() -> None:
    """A non-positive cadence would report a healthy schedule as stale forever."""
    assert all(seconds > 0 for seconds in schedule_watchdog.SCHEDULED_WORKFLOW_CADENCES.values())


# ─── Recency evaluation ──────────────────────────────────────────────────────


def test_an_active_and_recent_workflow_reports_no_problem() -> None:
    """A schedule that fired within its cadence is healthy."""
    assert schedule_watchdog.evaluate_recency(_recency(), 7 * 86_400, now=NOW) is None


@pytest.mark.parametrize("state", ["disabled_inactivity", "disabled_manually"])
def test_a_workflow_that_is_not_active_is_reported(state: str) -> None:
    """Any non-active state is reported, since it cannot raise its own alert."""
    problem = schedule_watchdog.evaluate_recency(_recency(state=state), 7 * 86_400, now=NOW)

    assert problem is not None
    assert state in problem
    assert "cannot open its own alert" in problem


def test_a_schedule_that_stopped_firing_is_reported() -> None:
    """A run older than the cadence plus grace is stale even while state reads active."""
    stale = _recency(latest_run_at=NOW - timedelta(days=11))

    problem = schedule_watchdog.evaluate_recency(stale, 7 * 86_400, now=NOW)

    assert problem is not None
    assert "11.0 days ago" in problem
    assert "expected within 10.0 days" in problem


def test_a_run_inside_the_grace_window_is_not_reported() -> None:
    """The grace window absorbs runner backlog rather than raising a false alarm."""
    delayed = _recency(latest_run_at=NOW - timedelta(days=9, hours=23))

    assert schedule_watchdog.evaluate_recency(delayed, 7 * 86_400, now=NOW) is None


def test_a_schedule_that_never_fired_is_not_reported() -> None:
    """A freshly added schedule with no runs yet is a soft signal, not a failure."""
    assert schedule_watchdog.evaluate_recency(_recency(latest_run_at=None), 86_400, now=NOW) is None


# ─── Fetching recency ────────────────────────────────────────────────────────


def test_fetch_reads_the_state_and_newest_scheduled_run() -> None:
    """Both API calls are made and their fields land on the record."""
    runner = _runner(runs=_runs("2026-07-26T12:00:00Z"))

    recency = schedule_watchdog.fetch_workflow_recency("owner/name", WORKFLOW, run_fn=runner)

    assert recency == schedule_watchdog.WorkflowRecency(
        workflow_file=WORKFLOW,
        state="active",
        latest_run_at=datetime(2026, 7, 26, 12, tzinfo=UTC),
    )


def test_fetch_reports_no_runs_when_the_schedule_never_fired() -> None:
    """An empty runs list means no scheduled run yet, not a broken payload."""
    runner = _runner(runs={"workflow_runs": []})

    recency = schedule_watchdog.fetch_workflow_recency("owner/name", WORKFLOW, run_fn=runner)

    assert recency.latest_run_at is None


def test_fetch_queries_only_scheduled_runs() -> None:
    """Filtering on event=schedule keeps a manual dispatch from masking a dead cron."""
    runner = _runner(runs=_runs("2026-07-26T12:00:00Z"))

    schedule_watchdog.fetch_workflow_recency("owner/name", WORKFLOW, run_fn=runner)

    runs_call = next(call for call in runner.calls if "runs?event=schedule" in " ".join(call))
    assert "event=schedule" in " ".join(runs_call)
    assert "per_page=1" in " ".join(runs_call)


@pytest.mark.parametrize("state", [None, "", 7])
def test_fetch_rejects_metadata_without_a_usable_state(state: object) -> None:
    """A metadata payload missing its state fails closed."""
    runner = _runner(state=state, runs=_runs("2026-07-26T12:00:00Z"))

    with pytest.raises(GhError, match="missing a string state"):
        schedule_watchdog.fetch_workflow_recency("owner/name", WORKFLOW, run_fn=runner)


def test_fetch_rejects_metadata_that_is_not_an_object() -> None:
    """A non-object metadata response cannot be trusted to describe the workflow."""
    runner = FakeGh(
        [
            (
                has(f"repos/owner/name/actions/workflows/{WORKFLOW}"),
                completed_process(0, json.dumps(["unexpected"])),
            ),
        ]
    )

    with pytest.raises(GhError, match="must be a JSON object"):
        schedule_watchdog.fetch_workflow_recency("owner/name", WORKFLOW, run_fn=runner)


@pytest.mark.parametrize(
    ("runs", "message"),
    [
        (["not-an-object"], "must be a JSON object"),
        ({"workflow_runs": "not-a-list"}, "must include a runs list"),
        ({"workflow_runs": ["not-an-object"]}, "run entry .* must be a JSON object"),
    ],
)
def test_fetch_rejects_malformed_run_payloads(runs: object, message: str) -> None:
    """A runs payload the watchdog cannot read fails closed instead of reading healthy."""
    runner = _runner(runs=runs)

    with pytest.raises(GhError, match=message):
        schedule_watchdog.fetch_workflow_recency("owner/name", WORKFLOW, run_fn=runner)


@pytest.mark.parametrize(
    ("created_at", "message"),
    [
        (None, "missing a run timestamp"),
        ("", "missing a run timestamp"),
        (17, "missing a run timestamp"),
        ("not-a-date", "not valid ISO-8601"),
        ("2026-07-26T12:00:00", "without timezone information"),
    ],
)
def test_a_run_with_an_unreadable_timestamp_fails_closed(created_at: object, message: str) -> None:
    """A run that exists but cannot be dated is a broken answer, not a healthy one.

    Reporting it as healthy would hide the very schedule the watchdog was asked
    to watch, so this is deliberately louder than the no-runs-at-all case.
    """
    runner = _runner(runs=_runs(created_at))

    with pytest.raises(GhError, match=message):
        schedule_watchdog.fetch_workflow_recency("owner/name", WORKFLOW, run_fn=runner)


def test_a_run_timestamp_keeps_its_offset_and_compares_as_an_instant() -> None:
    """Offsets are preserved; aware datetimes already order by instant."""
    runner = _runner(runs=_runs("2026-07-26T14:00:00+02:00"))

    recency = schedule_watchdog.fetch_workflow_recency("owner/name", WORKFLOW, run_fn=runner)

    assert recency.latest_run_at == datetime(2026, 7, 26, 12, tzinfo=UTC)


# ─── Checking every workflow ─────────────────────────────────────────────────


def test_check_reports_one_problem_per_unhealthy_workflow() -> None:
    """Each configured workflow is checked and only the unhealthy ones are reported."""
    healthy = json.dumps({"state": "active"})
    disabled = json.dumps({"state": "disabled_inactivity"})
    runs = json.dumps(_runs("2026-07-27T00:00:00Z"))
    codeql = has("repos/owner/name/actions/workflows/codeql.yml")
    runner = FakeGh(
        [
            (lambda cmd: "runs?event=schedule" in " ".join(cmd), completed_process(0, runs)),
            (codeql, completed_process(0, disabled)),
            (lambda cmd: "actions/workflows/" in " ".join(cmd), completed_process(0, healthy)),
        ]
    )

    problems = schedule_watchdog.check_scheduled_workflows(
        repo="owner/name", now=NOW, run_fn=runner
    )

    assert len(problems) == 1
    assert problems[0].startswith("codeql.yml: workflow state is 'disabled_inactivity'")


def _healthy_runner(created_at: str) -> FakeGh:
    """Return a fake runner reporting every workflow active with one run at ``created_at``."""
    return FakeGh(
        [
            (
                lambda cmd: "runs?event=schedule" in " ".join(cmd),
                completed_process(0, json.dumps(_runs(created_at))),
            ),
            (
                lambda cmd: "actions/workflows/" in " ".join(cmd),
                completed_process(0, json.dumps({"state": "active"})),
            ),
        ]
    )


def test_check_returns_nothing_when_every_schedule_is_healthy() -> None:
    """A healthy repository produces an empty problem list."""
    runner = _healthy_runner("2026-07-27T00:00:00Z")

    problems = schedule_watchdog.check_scheduled_workflows(
        repo="owner/name", now=NOW, run_fn=runner, cadences={WORKFLOW: 86_400}
    )

    assert problems == []


def test_check_defaults_to_the_current_time() -> None:
    """Omitting now uses the wall clock rather than leaving the comparison unset."""
    runner = _healthy_runner("2000-01-01T00:00:00Z")

    problems = schedule_watchdog.check_scheduled_workflows(
        repo="owner/name", run_fn=runner, cadences={WORKFLOW: 86_400}
    )

    assert len(problems) == 1
    assert "last scheduled run was" in problems[0]


# ─── Command line ────────────────────────────────────────────────────────────


def test_main_reports_success_for_a_healthy_repository(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A healthy check exits zero so the workflow closes the alert issue."""
    monkeypatch.setattr(schedule_watchdog, "check_scheduled_workflows", lambda **_kwargs: [])

    assert schedule_watchdog.main(["--repo", "owner/name"]) == schedule_watchdog.EXIT_HEALTHY
    assert capsys.readouterr().out.strip() == "All scheduled workflows are active and recent"


def test_a_check_that_cannot_complete_is_not_reported_as_a_verdict(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A watchdog that could not check exits with its own code, not the stale code.

    The workflow keys `checked` off this: exit 0 or 1 means a real verdict about
    the schedules, anything else is a setup failure. Collapsing the two would
    open a stale-schedule alert every time the API call merely failed.
    """

    def explode(**_kwargs: object) -> list[str]:
        raise GhError("gh api failed")

    monkeypatch.setattr(schedule_watchdog, "check_scheduled_workflows", explode)

    exit_code = schedule_watchdog.main(["--repo", "owner/name"])

    assert exit_code == schedule_watchdog.EXIT_CHECK_FAILED
    assert exit_code > schedule_watchdog.EXIT_PROBLEMS_FOUND
    assert "could not complete its check: gh api failed" in capsys.readouterr().err


def test_a_repository_that_cannot_be_resolved_is_a_check_failure(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Failing to resolve the repository is a setup failure, not a stale schedule."""

    def explode() -> str:
        raise GhError("not a git repository")

    monkeypatch.setattr(schedule_watchdog.gh_runner, "resolve_repo", explode)

    assert schedule_watchdog.main([]) == schedule_watchdog.EXIT_CHECK_FAILED
    assert "not a git repository" in capsys.readouterr().err


def test_main_lists_every_problem_and_exits_non_zero(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Each problem is printed so the alert issue body names what to fix."""
    monkeypatch.setattr(
        schedule_watchdog,
        "check_scheduled_workflows",
        lambda **_kwargs: ["codeql.yml: stale", "web-smoke.yml: disabled"],
    )

    exit_code = schedule_watchdog.main(["--repo", "owner/name"])

    assert exit_code == schedule_watchdog.EXIT_PROBLEMS_FOUND
    out = capsys.readouterr().out
    assert "Scheduled workflow watchdog found problems:" in out
    assert "- codeql.yml: stale" in out
    assert "- web-smoke.yml: disabled" in out


def test_main_defaults_to_the_current_repository(monkeypatch: pytest.MonkeyPatch) -> None:
    """Omitting --repo resolves the repository instead of failing."""
    seen: list[str] = []
    monkeypatch.setattr(schedule_watchdog.gh_runner, "resolve_repo", lambda: "owner/name")
    monkeypatch.setattr(
        schedule_watchdog,
        "check_scheduled_workflows",
        lambda *, repo: seen.append(repo) or [],
    )

    assert schedule_watchdog.main([]) == 0
    assert seen == ["owner/name"]
