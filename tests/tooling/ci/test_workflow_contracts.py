"""Checks workflow inputs and the CI job graph against the repository contract."""

from __future__ import annotations

import re
from pathlib import Path

import yaml
from scripts.ci.job_gating import GATED_JOBS

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKFLOWS_DIR = REPO_ROOT / ".github" / "workflows"
ACTIONS_DIR = REPO_ROOT / ".github" / "actions"
TOKEN_ACTION_REFERENCE = re.compile(
    r"^\s*(?:-\s+)?uses:\s*actions/create-github-app-token@(?P<ref>\S+)(?:\s+#.*)?$",
    re.MULTILINE,
)
TOKEN_ACTION_SHA = re.compile(r"^[0-9a-f]{40}$")
LIST_ITEM = re.compile(r"^(?P<indent>[ \t]*)-\s+")
CLIENT_ID_INPUT = re.compile(
    r"^\s+client-id:\s+\$\{\{\s*vars\.(?:APP_ID|ESCALATION_APP_ID|AUDIT_APP_ID)\s*\}\}\s*$",
    re.MULTILINE,
)

# GitHub job IDs may contain underscores and uppercase letters, so the pattern
# accepts both.
CI_JOB_HEADER = re.compile(r"^  (?P<name>[A-Za-z0-9_-]+):$", re.MULTILINE)
# Same character class as CI_JOB_HEADER, so every job name in `needs` can match.
CI_RESULT_NEED = re.compile(r"^      - (?P<name>[A-Za-z0-9_-]+)$", re.MULTILINE)
CI_RESULT_ENV_VARIABLE = re.compile(r"^          (?P<name>[A-Z0-9_]+): ", re.MULTILINE)

# Jobs that run on every change. changes computes the areas, quick-gates runs
# the documentation, Markdown, YAML, and formatting checks, and ci-result reads
# the results. Every other job is gated.
UNGATED_CI_JOBS = {"changes", "quick-gates", "ci-result"}

# Listed literally, not derived from the implementation, so editing both the
# truth table and the workflow in one change still fails.
EXPECTED_RESULT_VARIABLES = {
    "CHANGES_RESULT",
    "QUICK_GATES_RESULT",
    "HEAVY_CHECKS_RESULT",
    "PYTHON_COMPATIBILITY_RESULT",
    "NODE_COMPATIBILITY_RESULT",
    "WEB_E2E_RESULT",
    "WEB_BENCHMARK_RESULT",
    "WEB_PAGE_SPEED_RESULT",
}

GATED_CI_JOBS = {
    "heavy-checks": "needs.changes.outputs.python == 'true' || needs.changes.outputs.web == 'true'",
    "python-compatibility": "needs.changes.outputs.python == 'true'",
    "node-compatibility": "needs.changes.outputs.web == 'true'",
    "web-e2e": "needs.changes.outputs.web == 'true'",
    "web-benchmark": "needs.changes.outputs.web == 'true'",
    "web-page-speed": "needs.changes.outputs.web == 'true'",
}


def _workflow_and_action_files() -> list[Path]:
    """Return every workflow and composite-action definition."""
    workflow_files = (*WORKFLOWS_DIR.glob("*.yml"), *WORKFLOWS_DIR.glob("*.yaml"))
    action_files = (*ACTIONS_DIR.rglob("*.yml"), *ACTIONS_DIR.rglob("*.yaml"))
    return sorted((*workflow_files, *action_files))


def _workflow_source() -> str:
    """Return the complete workflow corpus as one string."""
    return "\n".join(path.read_text(encoding="utf-8") for path in _workflow_and_action_files())


def _token_steps(source: str) -> list[str]:
    """Return workflow or action list items that mint GitHub App tokens."""
    lines = source.splitlines(keepends=True)
    token_indexes = [
        index for index, line in enumerate(lines) if TOKEN_ACTION_REFERENCE.match(line)
    ]
    blocks: list[str] = []
    for token_index in token_indexes:
        start = token_index
        list_item = LIST_ITEM.match(lines[token_index])
        if list_item:
            action_indent = len(list_item.group("indent"))
        else:
            action_indent = len(lines[token_index]) - len(lines[token_index].lstrip())
            while start > 0:
                previous = LIST_ITEM.match(lines[start - 1])
                if previous and len(previous.group("indent")) <= action_indent:
                    start -= 1
                    break
                start -= 1
        end = token_index + 1
        while end < len(lines):
            following = LIST_ITEM.match(lines[end])
            if following and len(following.group("indent")) <= action_indent:
                break
            end += 1
        blocks.append("".join(lines[start:end]))
    return blocks


def test_token_step_parser_handles_inline_uses_list_items() -> None:
    """Keep inline ``- uses`` steps inside their own YAML list item."""
    source = """\
jobs:
  token:
    steps:
      - uses: actions/create-github-app-token@0123456789abcdef0123456789abcdef01234567
        with:
          client-id: ${{ vars.APP_ID }}
      - name: Next step
        run: echo done
"""

    steps = _token_steps(source)
    assert len(steps) == 1
    assert CLIENT_ID_INPUT.search(steps[0])


def test_github_app_token_actions_use_client_id_without_renaming_repository_variables() -> None:
    """Use Client ID inputs while preserving every repository variable name."""
    source = _workflow_source()
    references = [match.group("ref") for match in TOKEN_ACTION_REFERENCE.finditer(source)]
    assert len(references) == 3
    assert all(TOKEN_ACTION_SHA.fullmatch(reference) for reference in references)

    steps = _token_steps(source)
    assert len(steps) == len(references)
    for step in steps:
        assert CLIENT_ID_INPUT.search(step)

    for variable in ("APP_ID", "ESCALATION_APP_ID", "AUDIT_APP_ID"):
        assert f"vars.{variable}" in source


def _ci_jobs() -> dict[str, str]:
    """Return each job definition in the CI workflow, keyed by job ID.

    Job IDs are the only keys indented two spaces under ``jobs:``, so the text
    is split on them without a YAML parser.
    """
    source = (WORKFLOWS_DIR / "ci.yml").read_text(encoding="utf-8")
    body = source.split("\njobs:\n", 1)[1]
    headers = list(CI_JOB_HEADER.finditer(body))
    return {
        header.group("name"): body[
            header.start() : (headers[index + 1].start() if index + 1 < len(headers) else len(body))
        ]
        for index, header in enumerate(headers)
    }


def test_every_expensive_ci_job_is_gated_on_the_detected_areas() -> None:
    """Each expensive job is gated on the detected areas and on nothing else."""
    jobs = _ci_jobs()
    assert set(jobs) == UNGATED_CI_JOBS | set(GATED_CI_JOBS)

    for name, condition in GATED_CI_JOBS.items():
        assert f"\n    if: {condition}\n" in jobs[name], name
        assert "\n    needs: [changes, quick-gates]\n" in jobs[name], name


def test_the_ungated_ci_jobs_carry_no_area_condition() -> None:
    """The ungated jobs have no job-level ``if:``, except ci-result, which runs always.

    The four-space prefix matches job-level conditions only, not step-level ones.
    """
    jobs = _ci_jobs()

    for name in ("changes", "quick-gates"):
        assert "\n    if: " not in jobs[name], name
    assert "\n    if: always()\n" in jobs["ci-result"]


def test_the_ci_result_job_waits_for_every_other_job() -> None:
    """ci-result needs every other job."""
    jobs = _ci_jobs()
    needed = set(CI_RESULT_NEED.findall(jobs["ci-result"]))

    assert needed == set(jobs) - {"ci-result"}


def test_the_ci_result_job_passes_every_result_the_truth_table_reads() -> None:
    """The ci-result environment block and the Python truth table both match a literal list.

    Both sides are compared to the list, not to each other.
    """
    environment = set(CI_RESULT_ENV_VARIABLE.findall(_ci_jobs()["ci-result"]))

    assert environment == EXPECTED_RESULT_VARIABLES | {"PYTHON_CHANGED", "WEB_CHANGED"}
    assert {job.variable for job in GATED_JOBS} == EXPECTED_RESULT_VARIABLES


def test_watchdog_alerts_distinguish_disabled_workflows_and_setup_failures():
    """Setup errors must alert even when the watchdog step never ran."""
    workflow = yaml.load(
        (WORKFLOWS_DIR / "schedule-watchdog.yml").read_text(), Loader=yaml.BaseLoader
    )
    assert set(workflow["on"]) == {"push", "workflow_dispatch"}
    assert workflow["on"]["push"]["branches"] == ["main"]
    jobs = workflow["jobs"]
    assert jobs["watchdog"]["outputs"]["checked"] == "${{ steps.watchdog.outputs.checked }}"
    assert jobs["report-failure"]["if"] == ("failure() && needs.watchdog.outputs.checked == 'true'")
    assert jobs["report-setup-failure"]["if"] == (
        "failure() && needs.watchdog.outputs.checked != 'true'"
    )
    assert jobs["report-recovery"]["if"] == "success()"
    for name, state in (
        ("report-failure", "open"),
        ("report-setup-failure", "setup-failure"),
        ("report-recovery", "close"),
    ):
        alert = jobs[name]
        assert alert["needs"] == "watchdog"
        assert alert["uses"] == "./.github/workflows/alert-issue.yml"
        assert alert["with"]["state"] == state
        assert alert["with"]["title"] == "Scheduled workflows are stale or disabled"
        assert alert["with"]["label"] == "schedule-watchdog"
