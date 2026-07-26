from __future__ import annotations

import json

import pytest
from scripts.gh import ci_status
from scripts.gh.gh_runner import GhError

from tests.test_pr_review import FakeGh, completed_process, has


def _run(database_id: int, *, status: str, conclusion: str) -> str:
    """Render a one-run ``gh run list`` JSON payload."""
    return json.dumps(
        [
            {
                "databaseId": database_id,
                "status": status,
                "conclusion": conclusion,
                "workflowName": "CI",
                "headBranch": "feature",
                "url": "https://example/run",
            }
        ]
    )


def _run_list(database_id: int, *, status: str, conclusion: str) -> FakeGh:
    """Build a runner that answers ``gh run list`` with one run."""
    payload = _run(database_id, status=status, conclusion=conclusion)
    return FakeGh(
        [
            (has("rev-parse"), completed_process(0, "feature\n")),
            (has("run", "list"), completed_process(0, payload)),
        ]
    )


def test_latest_run_reads_first_entry() -> None:
    """Return the newest run for the current branch."""
    runner = _run_list(123, status="completed", conclusion="failure")

    info = ci_status.latest_run(run_fn=runner)

    assert info.run_id == 123
    assert info.conclusion == "failure"


def test_latest_run_raises_without_runs() -> None:
    """Raise when the branch has no runs."""
    runner = FakeGh([(has("run", "list"), completed_process(0, "[]"))])

    with pytest.raises(GhError):
        ci_status.latest_run("feature", run_fn=runner)


def test_failure_digest_short_circuits_on_success() -> None:
    """Succeeded runs report success without fetching logs."""
    runner = _run_list(1, status="completed", conclusion="success")

    digest = ci_status.failure_digest(branch="feature", run_fn=runner)

    assert "Run succeeded" in digest
    assert all("--log-failed" not in arg for cmd in runner.calls for arg in cmd)


def test_failure_digest_reports_in_progress() -> None:
    """In-progress runs report status without logs."""
    runner = _run_list(1, status="in_progress", conclusion="")

    digest = ci_status.failure_digest(branch="feature", run_fn=runner)

    assert "in_progress" in digest


def test_failure_digest_includes_failed_logs() -> None:
    """Failed runs include the failed-step logs."""
    runner = _run_list(7, status="completed", conclusion="failure")
    runner.routes.append((has("--log-failed"), completed_process(0, "pytest exploded\n")))

    digest = ci_status.failure_digest(branch="feature", run_fn=runner)

    assert "Run 7" in digest
    assert "pytest exploded" in digest


def test_failure_digest_with_explicit_run() -> None:
    """An explicit run id fetches logs directly."""
    runner = FakeGh([(has("--log-failed"), completed_process(0, "boom"))])

    digest = ci_status.failure_digest(99, run_fn=runner)

    assert "Run 99" in digest
    assert "boom" in digest


def test_failure_digest_empty_logs() -> None:
    """Report a placeholder when no failed-step logs are returned."""
    runner = FakeGh([(has("--log-failed"), completed_process(0, ""))])

    digest = ci_status.failure_digest(99, run_fn=runner)

    assert "(no failed-step logs returned)" in digest


def test_latest_run_rejects_a_non_list_payload() -> None:
    """A malformed `gh run list` payload is reported rather than indexed into."""
    runner = FakeGh([(has("run"), completed_process(0, json.dumps({"not": "a list"})))])

    with pytest.raises(GhError, match="No workflow runs found for branch 'feature'"):
        ci_status.latest_run("feature", run_fn=runner)


def test_latest_run_rejects_a_non_mapping_run_entry() -> None:
    """A run entry that is not an object is reported by branch."""
    runner = FakeGh([(has("run"), completed_process(0, json.dumps(["nope"])))])

    with pytest.raises(GhError, match="Unexpected workflow run payload for branch 'feature'"):
        ci_status.latest_run("feature", run_fn=runner)


def test_latest_run_requires_a_database_id() -> None:
    """A run without a databaseId cannot be addressed later, so it fails loudly."""
    payload = json.dumps([{"status": "completed", "conclusion": "success"}])
    runner = FakeGh([(has("run"), completed_process(0, payload))])

    with pytest.raises(GhError, match="missing databaseId"):
        ci_status.latest_run("feature", run_fn=runner)


def test_latest_run_rejects_a_non_integer_database_id() -> None:
    """A non-numeric databaseId names the offending value."""
    payload = json.dumps([{"databaseId": "not-a-number", "status": "completed"}])
    runner = FakeGh([(has("run"), completed_process(0, payload))])

    with pytest.raises(GhError, match="databaseId is not an integer"):
        ci_status.latest_run("feature", run_fn=runner)
