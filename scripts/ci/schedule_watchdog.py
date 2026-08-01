#!/usr/bin/env python3
"""Detect scheduled workflows that went stale or were auto-disabled.

GitHub disables a workflow's ``cron`` triggers after about 60 days without
repository activity, and a disabled schedule cannot open its own alert issue.
That makes schedule failure silent: the monitoring layer goes offline exactly
when nobody is looking. This watchdog runs from a push-triggered context, which
GitHub never auto-disables, and checks each scheduled workflow two ways:

- its workflow ``state`` is still ``active`` (an auto-disabled workflow reports
  ``disabled_inactivity``); and
- its most recent scheduled run is newer than the workflow's expected cadence
  plus a grace window, so a schedule that quietly stopped firing is caught even
  while its state still reads active.

The CLI prints a report and exits non-zero when any workflow looks stale or
disabled, so the calling workflow can open, update, or close one alert issue
through the shared ``ci-alert-issue`` path.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

from scripts.gh import gh_runner
from scripts.gh.gh_runner import GhError

if TYPE_CHECKING:
    from collections.abc import Mapping

DAY_SECONDS = 86_400

# Exit codes. They still distinguish the three outcomes for anyone running this
# module directly, but the workflow must not read the verdict off them: `make`
# collapses every non-zero recipe exit to 2 of its own, so "found stale
# schedules" and "could not check" reach a caller behind the Makefile as the
# same number. The `checked` output below is what carries that distinction.
EXIT_HEALTHY = 0
EXIT_PROBLEMS_FOUND = 1
EXIT_CHECK_FAILED = 2

# GitHub Actions reads step outputs from the file named by this variable. The
# watchdog writes its own verdict there because it is the only party that knows
# it: by the time the workflow shell sees an exit code, the one bit that picks
# between a stale-schedule alert and a setup-failure alert is already gone.
GITHUB_OUTPUT_ENV = "GITHUB_OUTPUT"
CHECKED_OUTPUT = "checked"

# Maximum expected gap between scheduled runs for each workflow, derived from
# its cron expression. `test_cadences_match_the_crons_declared_in_the_workflows`
# re-derives these from the crons actually declared in .github/workflows/ and
# compares names and values, so neither an unwatched schedule nor a cadence too
# loose to notice one stopping can reach main.
SCHEDULED_WORKFLOW_CADENCES: dict[str, int] = {
    "audit-repo-settings.yml": 7 * DAY_SECONDS,  # "23 8 * * 1" weekly
    "codeql.yml": 7 * DAY_SECONDS,  # "30 6 * * 1" weekly
    "dependency-audit.yml": 7 * DAY_SECONDS,  # "0 6 * * 1" weekly
    "refresh-action-shas.yml": 31 * DAY_SECONDS,  # "0 3 1 * *" monthly
    "web-smoke.yml": DAY_SECONDS // 2,  # "0 7,19 * * *" twice daily, so a 12h gap
}

# Absorb runner backlog, delayed scheduling, and month-length variance so a
# healthy schedule is never reported as stale.
GRACE_SECONDS = 3 * DAY_SECONDS


@dataclass(frozen=True)
class WorkflowRecency:
    """The state and latest scheduled-run age for one workflow."""

    workflow_file: str
    state: str
    latest_run_at: datetime | None


def _require_dict(value: object, message: str) -> dict[str, object]:
    """Return ``value`` as a dict or raise a contextual error."""
    if not isinstance(value, dict):
        raise GhError(message)
    return value


def _parse_timestamp(value: object, context: str) -> datetime:
    """Parse a GitHub ISO 8601 timestamp into an aware datetime.

    Fails closed. A run that exists but carries an unreadable timestamp is a
    broken answer, not a healthy one, and a watchdog that swallows it would
    report the schedule it cannot actually see as fine.
    """
    if not isinstance(value, str) or not value:
        raise GhError(f"{context} is missing a run timestamp.")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise GhError(f"{context} has a timestamp that is not valid ISO-8601: {value!r}.") from exc
    if parsed.tzinfo is None:
        raise GhError(f"{context} has a timestamp without timezone information: {value!r}.")
    return parsed


def _latest_scheduled_run_at(payload: object, workflow_file: str) -> datetime | None:
    """Return the created_at of the newest scheduled run, or None when there are none."""
    runs = _require_dict(
        payload, f"workflow runs response for {workflow_file} must be a JSON object"
    ).get("workflow_runs")
    if not isinstance(runs, list):
        raise GhError(f"workflow runs response for {workflow_file} must include a runs list.")
    if not runs:
        return None
    newest = runs[0]
    if not isinstance(newest, dict):
        raise GhError(f"scheduled run entry for {workflow_file} must be a JSON object.")
    return _parse_timestamp(newest.get("created_at"), f"scheduled run for {workflow_file}")


def fetch_workflow_recency(
    repo: str,
    workflow_file: str,
    *,
    run_fn: gh_runner.RunFunction | None = None,
) -> WorkflowRecency:
    """Fetch one workflow's active state and newest scheduled-run timestamp."""
    meta = _require_dict(
        gh_runner.gh_json(
            ["api", f"repos/{repo}/actions/workflows/{workflow_file}"],
            run_fn=run_fn,
        ),
        f"workflow metadata for {workflow_file} must be a JSON object",
    )
    state = meta.get("state")
    if not isinstance(state, str) or not state:
        raise GhError(f"workflow {workflow_file} metadata is missing a string state.")

    runs_payload = gh_runner.gh_json(
        ["api", f"repos/{repo}/actions/workflows/{workflow_file}/runs?event=schedule&per_page=1"],
        run_fn=run_fn,
    )
    return WorkflowRecency(
        workflow_file=workflow_file,
        state=state,
        latest_run_at=_latest_scheduled_run_at(runs_payload, workflow_file),
    )


def evaluate_recency(
    recency: WorkflowRecency, cadence_seconds: int, *, now: datetime
) -> str | None:
    """Return a problem description for one workflow, or None when healthy."""
    if recency.state != "active":
        return (
            f"{recency.workflow_file}: workflow state is {recency.state!r} "
            "(expected 'active'; an auto-disabled schedule cannot open its own alert)"
        )
    if recency.latest_run_at is None:
        # State is active but the API reports no scheduled runs at all. Treat
        # this as a soft signal rather than a hard failure, so a freshly added
        # schedule that has not fired once does not raise a false alarm.
        return None
    age_seconds = (now - recency.latest_run_at).total_seconds()
    allowed_seconds = cadence_seconds + GRACE_SECONDS
    if age_seconds > allowed_seconds:
        return (
            f"{recency.workflow_file}: last scheduled run was "
            f"{age_seconds / DAY_SECONDS:.1f} days ago "
            f"(expected within {allowed_seconds / DAY_SECONDS:.1f} days)"
        )
    return None


def check_scheduled_workflows(
    *,
    repo: str,
    now: datetime | None = None,
    cadences: Mapping[str, int] = SCHEDULED_WORKFLOW_CADENCES,
    run_fn: gh_runner.RunFunction | None = None,
) -> list[str]:
    """Return one problem string per workflow that looks stale or disabled."""
    current_time = now or datetime.now(UTC)
    problems: list[str] = []
    for workflow_file, cadence_seconds in sorted(cadences.items()):
        recency = fetch_workflow_recency(repo, workflow_file, run_fn=run_fn)
        problem = evaluate_recency(recency, cadence_seconds, now=current_time)
        if problem is not None:
            problems.append(problem)
    return problems


def report_checked(reached_verdict: bool, *, env: Mapping[str, str] | None = None) -> None:
    """Record whether the watchdog reached a verdict, for the calling workflow.

    The alert jobs pick between "schedules are stale" and "the watchdog itself
    broke" on this one bit, and it cannot travel as an exit code: `make`
    rewrites every failing recipe's status to 2, so both outcomes arrive
    identical to the workflow shell. Writing it here also keeps the shell thin,
    which is the same reason every other decision lives in Python.

    Outside GitHub Actions the variable is unset and nothing is written, so the
    everyday `make ci-schedule-watchdog` is unaffected.
    """
    path = (os.environ if env is None else env).get(GITHUB_OUTPUT_ENV)
    if not path:
        return
    value = "true" if reached_verdict else "false"
    with Path(path).open("a", encoding="utf-8") as handle:
        handle.write(f"{CHECKED_OUTPUT}={value}\n")


def _build_parser() -> argparse.ArgumentParser:
    """Build the watchdog command-line parser."""
    parser = argparse.ArgumentParser(description="Detect stale or disabled scheduled workflows")
    parser.add_argument("--repo", help="owner/name (default: current repository)")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the watchdog and return one of the EXIT_* codes.

    A failure to complete the check is reported as its own code, and as
    ``checked=false``, rather than reusing the stale-schedule code, so the
    caller cannot mistake an infrastructure failure for a verdict about the
    schedules.
    """
    args = _build_parser().parse_args(argv)
    try:
        repo = args.repo or gh_runner.resolve_repo()
        problems = check_scheduled_workflows(repo=repo)
    except GhError as exc:
        report_checked(False)
        print(f"Schedule watchdog could not complete its check: {exc}", file=sys.stderr)
        return EXIT_CHECK_FAILED

    report_checked(True)
    if not problems:
        print("All scheduled workflows are active and recent")
        return EXIT_HEALTHY

    print("Scheduled workflow watchdog found problems:")
    for problem in problems:
        print(f"- {problem}")
    return EXIT_PROBLEMS_FOUND


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
