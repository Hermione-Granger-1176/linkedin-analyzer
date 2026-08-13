"""Keep workflow inputs and the CI job graph aligned with the repository contract."""

from __future__ import annotations

import re
from pathlib import Path

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
LEGACY_APP_ID_INPUT = re.compile(r"^\s+app-id:\s+", re.MULTILINE)

# GitHub job ids allow underscores and uppercase too. Matching only the spelling
# this workflow happens to use would let a job named `security_scan` slip past
# the discovery below and never be checked for a guard at all.
CI_JOB_HEADER = re.compile(r"^  (?P<name>[A-Za-z0-9_-]+):$", re.MULTILINE)
CI_RESULT_NEED = re.compile(r"^      - (?P<name>[a-z0-9-]+)$", re.MULTILINE)
CI_RESULT_ENV_VARIABLE = re.compile(r"^          (?P<name>[A-Z0-9_]+): ", re.MULTILINE)

# quick-gates runs on every change because it is where documentation, Markdown,
# YAML, and formatting checks live; changes computes the areas; ci-result reads
# them back. Everything else has to earn its run.
UNGATED_CI_JOBS = {"changes", "quick-gates", "ci-result"}

# Spelled out rather than derived from the implementation, so that removing a job
# from both the truth table and the workflow at once still fails.
EXPECTED_RESULT_VARIABLES = {
    "CHANGES_RESULT",
    "QUICK_GATES_RESULT",
    "HEAVY_CHECKS_RESULT",
    "PYTHON_COMPATIBILITY_RESULT",
    "NODE_COMPATIBILITY_RESULT",
    "WEB_E2E_RESULT",
}

GATED_CI_JOBS = {
    "heavy-checks": "needs.changes.outputs.python == 'true' || needs.changes.outputs.web == 'true'",
    "python-compatibility": "needs.changes.outputs.python == 'true'",
    "node-compatibility": "needs.changes.outputs.web == 'true'",
    "web-e2e": "needs.changes.outputs.web == 'true'",
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
        assert not LEGACY_APP_ID_INPUT.search(step)

    for variable in ("APP_ID", "ESCALATION_APP_ID", "AUDIT_APP_ID"):
        assert f"vars.{variable}" in source


def _ci_jobs() -> dict[str, str]:
    """Return each job definition in the CI workflow, keyed by job id.

    Job ids are the only keys indented two spaces once the header is stripped,
    so splitting on them needs no YAML parser. This module already prefers text
    matching over a parse, and PyYAML reaches the environment only as a
    transitive dependency of yamllint.
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
    """Gate each expensive job on the areas a change touched, and on nothing else.

    A job added later without a guard shows up here rather than as a bill.
    """
    jobs = _ci_jobs()
    assert set(jobs) == UNGATED_CI_JOBS | set(GATED_CI_JOBS)

    for name, condition in GATED_CI_JOBS.items():
        assert f"\n    if: {condition}\n" in jobs[name], name
        assert "\n    needs: [changes, quick-gates]\n" in jobs[name], name


def test_the_ci_result_job_waits_for_every_other_job() -> None:
    """Aggregate every job, so a new one cannot merge unwatched."""
    jobs = _ci_jobs()
    needed = set(CI_RESULT_NEED.findall(jobs["ci-result"]))

    assert needed == set(jobs) - {"ci-result"}


def test_the_ci_result_job_passes_every_result_the_truth_table_reads() -> None:
    """Keep the workflow's environment block and the Python truth table in step.

    `check-results` compares each job against what the areas required. A result
    the workflow forgets to pass arrives as an empty string, and a variable the
    table stopped reading would quietly stop being checked at all. Both sides are
    compared against the literal list rather than against each other, because
    dropping a job from the table and from the workflow in one edit would satisfy
    any assertion that only checked the two for agreement.
    """
    environment = set(CI_RESULT_ENV_VARIABLE.findall(_ci_jobs()["ci-result"]))

    assert environment == EXPECTED_RESULT_VARIABLES | {"PYTHON_CHANGED", "WEB_CHANGED"}
    assert {job.variable for job in GATED_JOBS} == EXPECTED_RESULT_VARIABLES
