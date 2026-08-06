"""Keep GitHub App token workflow inputs aligned with the repository contract."""

from __future__ import annotations

import re
from pathlib import Path

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
