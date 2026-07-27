#!/usr/bin/env python3
"""Sync one monitored alert issue for a scheduled workflow.

Scheduled workflows need a single, stable place to report that they are
failing, and they need it to go away once they recover. Each monitored
workflow owns one label and one issue title. Syncing an alert either opens
that issue, adds a fresh failure comment to it, or closes it, so operators
see one issue per monitored workflow instead of one per failing run.

The workflow shell stays thin: state selection lives in the workflow, and
every decision about issue identity, wording, and GitHub calls lives here
where it is tested.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from scripts.gh import gh_runner
from scripts.gh.gh_runner import GhError

ALERT_BODY_LEADS = {
    "open": "Scheduled checks behind this alert are failing.",
    "close": "Scheduled checks behind this alert are passing again.",
    "setup-failure": (
        "The scheduled workflow failed before its checks could report a status, "
        "so this is likely a setup or infrastructure failure rather than a check "
        "regression. Inspect the failed run logs to find the failing setup step."
    ),
}
ALERT_STATES = frozenset(ALERT_BODY_LEADS)

# `gh issue list` caps at this many results. Alert issues are addressed by an
# exact title within a single label, so reaching the cap means the label has
# been reused for unrelated issues and the match can no longer be trusted.
ISSUE_MATCH_LIMIT = 100

LABEL_COLOR = "B60205"


def _require_state(state: str) -> str:
    """Return ``state`` when it names a supported alert state."""
    if state not in ALERT_STATES:
        supported = ", ".join(sorted(ALERT_STATES))
        raise GhError(f"Unsupported alert state: {state!r}. Expected one of: {supported}.")
    return state


def alert_should_exist(state: str) -> bool:
    """Return whether the alert issue should be open after syncing ``state``."""
    return _require_state(state) != "close"


def _require_argument(value: str, name: str) -> str:
    """Return a non-empty argument that cannot be mistaken for a ``gh`` flag."""
    if not value or not value.strip():
        raise GhError(f"Alert {name} must not be empty.")
    if value.startswith("-"):
        raise GhError(f"Alert {name} must not start with '-': {value!r}.")
    return value


def _require_run_url(run_url: str) -> str:
    """Return a run URL that points at a GitHub Actions run."""
    _require_argument(run_url, "run URL")
    if not run_url.startswith("https://"):
        raise GhError(f"Alert run URL must be an https URL: {run_url!r}.")
    if "/actions/runs/" not in run_url:
        raise GhError(f"Alert run URL must reference an Actions run: {run_url!r}.")
    return run_url


def build_alert_body(*, state: str, run_url: str, detail: str = "") -> str:
    """Build the alert issue body for one monitored workflow state."""
    lead = ALERT_BODY_LEADS[_require_state(state)]
    body = f"{lead}\n\nWorkflow run: {_require_run_url(run_url)}"
    if detail.strip():
        body = f"{body}\n\n{detail.strip()}"
    return body


def find_alert_issue(
    repo: str,
    title: str,
    label: str,
    *,
    run_fn: gh_runner.RunFunction | None = None,
) -> dict[str, object] | None:
    """Return the open issue that exactly matches ``title`` within ``label``.

    Filtering by label first keeps the search bounded to issues this alert
    owns. `gh issue list` never returns pull requests, so no extra filtering
    is needed to keep a same-titled pull request from being mistaken for the
    alert issue.
    """
    payload = gh_runner.gh_json(
        [
            "issue",
            "list",
            "--repo",
            repo,
            "--state",
            "open",
            "--label",
            label,
            "--limit",
            str(ISSUE_MATCH_LIMIT),
            "--json",
            "number,title,url",
        ],
        run_fn=run_fn,
    )
    if not isinstance(payload, list):
        raise GhError("Unexpected issue list response shape; expected a JSON array.")
    if len(payload) >= ISSUE_MATCH_LIMIT:
        raise GhError(
            f"Refusing to sync alert {title!r}: label {label!r} has at least "
            f"{ISSUE_MATCH_LIMIT} open issues, so the matching issue may be truncated "
            "out of the results. Reserve this label for its alert issue."
        )

    matches = []
    for issue in payload:
        if not isinstance(issue, dict):
            raise GhError("Unexpected issue entry shape in issue list response.")
        if issue.get("title") == title:
            matches.append(issue)
    if not matches:
        return None
    # Oldest issue wins so repeated syncs converge on one issue even if a
    # duplicate was opened by hand.
    return min(matches, key=_issue_number)


def _issue_number(issue: dict[str, object]) -> int:
    """Return the validated issue number from an issue payload."""
    number = issue.get("number")
    if not isinstance(number, int) or isinstance(number, bool) or number < 1:
        raise GhError("Matched alert issue is missing a positive integer number.")
    return number


def _issue_url(issue: dict[str, object]) -> str:
    """Return the validated web URL from an issue payload."""
    url = issue.get("url")
    if not isinstance(url, str) or not url:
        raise GhError("Matched alert issue is missing a non-empty url.")
    return url


def ensure_label(
    repo: str,
    label: str,
    description: str,
    *,
    run_fn: gh_runner.RunFunction | None = None,
) -> None:
    """Create the alert label, tolerating an existing one."""
    try:
        gh_runner.run_gh(
            [
                "label",
                "create",
                label,
                "--repo",
                repo,
                "--color",
                LABEL_COLOR,
                "--description",
                description,
                "--force",
            ],
            run_fn=run_fn,
        )
    except GhError as exc:
        raise GhError(f"Failed to ensure alert label {label!r} on {repo}: {exc}") from exc


def sync_alert_issue(
    *,
    repo: str,
    title: str,
    label: str,
    body: str,
    should_exist: bool,
    run_fn: gh_runner.RunFunction | None = None,
) -> str:
    """Open, comment on, or close one alert issue addressed by exact title.

    Returns the issue URL while the alert should exist, and an empty string
    once it should not. An existing issue is commented on rather than
    rewritten so the failure timeline survives across runs.
    """
    _require_argument(title, "title")
    _require_argument(label, "label")
    # Ensured before the lookup, not just before a create, so that syncing a
    # recovery on a repository that has never failed cannot fail on a label
    # that does not exist yet.
    ensure_label(repo, label, f"Alerts for: {title}", run_fn=run_fn)
    existing = find_alert_issue(repo, title, label, run_fn=run_fn)

    if existing is None:
        if not should_exist:
            return ""
        url = gh_runner.run_gh(
            [
                "issue",
                "create",
                "--repo",
                repo,
                "--title",
                title,
                "--label",
                label,
                "--body",
                body,
            ],
            run_fn=run_fn,
        ).strip()
        if not url:
            raise GhError(f"Creating alert issue {title!r} on {repo} returned no URL.")
        return url

    number = _issue_number(existing)
    if not should_exist:
        gh_runner.run_gh(
            ["issue", "close", str(number), "--repo", repo, "--comment", body],
            run_fn=run_fn,
        )
        return ""

    # Validated before commenting so a malformed payload cannot leave a comment
    # behind on an issue this call then fails to report.
    url = _issue_url(existing)
    gh_runner.run_gh(
        ["issue", "comment", str(number), "--repo", repo, "--body", body],
        run_fn=run_fn,
    )
    return url


def _read_detail(detail: str, detail_file: str | None) -> str:
    """Return the alert detail from an inline value or a file."""
    if detail_file is None:
        return detail
    if detail:
        raise GhError("Pass either --detail or --detail-file, not both.")
    path = Path(detail_file)
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        raise GhError(f"Could not read alert detail file {detail_file}: {exc}") from exc
    except UnicodeDecodeError as exc:
        raise GhError(f"Alert detail file {detail_file} must be UTF-8 text: {exc}") from exc


def sync_from_args(args: argparse.Namespace) -> str:
    """Sync one alert issue from parsed command-line arguments."""
    state = _require_state(args.state)
    repo = args.repo or gh_runner.resolve_repo()
    body = build_alert_body(
        state=state,
        run_url=args.run_url,
        detail=_read_detail(args.detail, args.detail_file),
    )
    return sync_alert_issue(
        repo=repo,
        title=args.title,
        label=args.label,
        body=body,
        should_exist=alert_should_exist(state),
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Sync a monitored alert issue")
    parser.add_argument("--title", required=True, help="Exact alert issue title")
    parser.add_argument("--label", required=True, help="Label that scopes this alert")
    parser.add_argument("--run-url", required=True, help="URL of the workflow run")
    parser.add_argument(
        "--state",
        required=True,
        choices=sorted(ALERT_STATES),
        help="Alert state to sync",
    )
    parser.add_argument("--repo", help="owner/name (default: current repository)")
    parser.add_argument("--detail", default="", help="Extra body text")
    parser.add_argument("--detail-file", help="Read extra body text from a UTF-8 file")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Sync one alert issue and print its URL, when it has one."""
    url = sync_from_args(_build_parser().parse_args(argv))
    if url:
        print(url)
    return 0


if __name__ == "__main__":  # pragma: no cover
    try:
        raise SystemExit(main())
    except GhError as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1) from exc
