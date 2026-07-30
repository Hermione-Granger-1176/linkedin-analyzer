"""Tests for the ad-hoc export explorer behind `make explore`.

The explorer is a top-level script: importing it runs the whole report. Every
test therefore loads it from its real path with a redirected repository root so
it reads a synthetic export from ``tmp_path`` instead of the private one in
``data/input``.
"""

from __future__ import annotations

import csv
import importlib.util
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

if TYPE_CHECKING:
    from types import ModuleType

MODULE_PATH = Path(__file__).parents[3] / "scripts" / "checks" / "li_explore.py"
# Bound before any test can patch it: the explorer raises the csv field-size
# limit process-wide, and that must not leak into the rest of the suite.
SET_FIELD_SIZE_LIMIT = csv.field_size_limit
OWNER = "Test Owner"

SHARES_ROWS = [
    {
        "Date": "2024-01-15 10:00:00",
        "ShareCommentary": "Shipping notes on #Python and #Data",
        "Visibility": "MEMBER_NETWORK",
        "MediaUrl": "https://example.invalid/image.png",
    },
    {
        "Date": "2024-02-20 09:00:00",
        "ShareCommentary": "",
        "Visibility": "",
        "MediaUrl": "",
    },
    {"Date": "", "ShareCommentary": "Draft never dated", "Visibility": "", "MediaUrl": ""},
]

COMMENTS_ROWS = [
    {"Date": "2024-01-16 08:00:00", "Link": "https://example.invalid/activity/1"},
    {"Date": "2024-01-17 08:00:00", "Link": "https://example.invalid/activity/1"},
    {"Date": "", "Link": ""},
]

CONNECTIONS_ROWS = [
    {
        "First Name": "Ada",
        "Last Name": "Lovelace",
        "Email Address": "ada@example.invalid",
        "Company": "Analytical Engines",
        "Position": "Engineer",
        "Connected On": "15 Jan 2024",
    },
    {
        "First Name": "Grace",
        "Last Name": "Hopper",
        "Email Address": "",
        "Company": "",
        "Position": "",
        "Connected On": "not a date",
    },
    {
        "First Name": "Alan",
        "Last Name": "Turing",
        "Email Address": "",
        "Company": "Bletchley",
        "Position": "Cryptanalyst",
        "Connected On": "",
    },
]


def _message(
    conversation: str,
    sender: str,
    recipient: str,
    date: str,
    folder: str,
) -> dict[str, str]:
    """Build one message row in the export's own column names."""
    return {
        "CONVERSATION ID": conversation,
        "FROM": sender,
        "TO": recipient,
        "DATE": date,
        "FOLDER": folder,
    }


MESSAGE_ROWS = [
    _message("c1", OWNER, "Alice", "2024-01-05", "INBOX"),
    _message("c1", "Alice", OWNER, "2024-01-04", "INBOX"),
    _message("c2", OWNER, "Carol", "2024-02-01", ""),
    _message("c3", "Bob", OWNER, "", "ARCHIVE"),
    _message("c4", "", "", "2024-03-01", "INBOX"),
    _message("c5", OWNER, "Alice,Bob", "2024-03-02", "INBOX"),
]


def _write_csv(path: Path, rows: list[dict[str, str]], *, preamble: str = "") -> None:
    """Write a synthetic export file, optionally behind an export preamble."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        handle.write(preamble)
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def _write_export(repo_root: Path) -> Path:
    """Create a complete synthetic export below a fake repository root."""
    base = repo_root / "data" / "input"
    _write_csv(base / "Shares.csv", SHARES_ROWS)
    _write_csv(base / "Comments.csv", COMMENTS_ROWS)
    _write_csv(
        base / "Connections.csv",
        CONNECTIONS_ROWS,
        preamble='Notes:\n"Connection data export."\n\n',
    )
    _write_csv(base / "messages.csv", MESSAGE_ROWS)
    return base


def _load_explorer(monkeypatch: pytest.MonkeyPatch, repo_root: Path) -> ModuleType:
    """Run the explorer script against a fake repository root and return its module."""
    fake_module_path = repo_root / "scripts" / "checks" / "li_explore.py"
    original_resolve = Path.resolve

    def resolve(self: Path, strict: bool = False) -> Path:
        if self == MODULE_PATH:
            return fake_module_path
        return original_resolve(self, strict=strict)

    monkeypatch.setattr(Path, "resolve", resolve)
    spec = importlib.util.spec_from_file_location("li_explore_test_module", MODULE_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    original_limit = SET_FIELD_SIZE_LIMIT()
    try:
        spec.loader.exec_module(module)
    finally:
        SET_FIELD_SIZE_LIMIT(original_limit)
    return module


def test_explorer_skips_a_repository_without_an_export(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A missing private export skips cleanly instead of raising."""
    monkeypatch.setenv("LIA_ME", OWNER)

    with pytest.raises(SystemExit) as exit_info:
        _load_explorer(monkeypatch, tmp_path)

    assert exit_info.value.code == 0
    assert "SKIP: no local export in data/input" in capsys.readouterr().out


def test_explorer_reports_every_section_of_a_synthetic_export(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Summarize shares, comments, connections, and messages without echoing content."""
    monkeypatch.setenv("LIA_ME", OWNER)
    _write_export(tmp_path)

    module = _load_explorer(monkeypatch, tmp_path)
    output = capsys.readouterr().out

    assert module.ME == OWNER
    assert "posts=3 range=2024-01-15..2024-02-20" in output
    assert "with_media=1" in output
    assert "'python', 1" in output
    assert "comments=3 distinct_posts_commented=1" in output
    assert "max_comments_on_one_post=2" in output
    assert "connections=3 email_visible=1 (33%)" in output
    assert "growth_last_8_months: [('2024-01', 1)]" in output
    assert f"me={OWNER!r} messages=6 sent=3 recv=3 conversations=5" in output
    assert "conversations_initiated_by_me=2/5" in output
    assert "'?': 1" in output
    assert "messaged_but_no_reply=1 inbound_never_replied_by_me=1" in output


def test_explorer_handles_an_export_without_links_or_dated_comments(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """An export whose comments carry no links reports a zero busiest-post count."""
    monkeypatch.setenv("LIA_ME", OWNER)
    base = _write_export(tmp_path)
    _write_csv(base / "Comments.csv", [{"Date": "", "Link": ""}])

    _load_explorer(monkeypatch, tmp_path)

    assert "max_comments_on_one_post=0" in capsys.readouterr().out


def test_explorer_shrinks_the_csv_field_limit_until_it_is_accepted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A platform whose C long is narrower than sys.maxsize still gets a limit."""
    monkeypatch.setenv("LIA_ME", OWNER)
    accepted: list[int] = []
    original_limit = csv.field_size_limit()

    def field_size_limit(limit: int = 0) -> int:
        if limit > 2**31 - 1:
            raise OverflowError("Python int too large to convert to C long")
        accepted.append(limit)
        return original_limit

    monkeypatch.setattr(csv, "field_size_limit", field_size_limit)

    with pytest.raises(SystemExit):
        _load_explorer(monkeypatch, tmp_path)

    assert accepted and accepted[-1] <= 2**31 - 1


def test_detect_me_falls_back_to_the_git_identity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without the override the owner name comes from git's configured user."""
    monkeypatch.setenv("LIA_ME", OWNER)
    _write_export(tmp_path)
    module = _load_explorer(monkeypatch, tmp_path)

    monkeypatch.delenv("LIA_ME", raising=False)

    def fake_run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        assert command == ["git", "config", "user.name"]
        return subprocess.CompletedProcess(command, 0, "Git Identity\n", "")

    monkeypatch.setattr(subprocess, "run", fake_run)

    assert module.detect_me() == "Git Identity"


def test_detect_me_tolerates_an_unavailable_git(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A missing or unconfigured git leaves the owner name empty rather than failing."""
    monkeypatch.setenv("LIA_ME", OWNER)
    _write_export(tmp_path)
    module = _load_explorer(monkeypatch, tmp_path)

    monkeypatch.delenv("LIA_ME", raising=False)

    def fake_run(command: list[str], **_kwargs: object) -> Any:
        raise subprocess.CalledProcessError(1, command)

    monkeypatch.setattr(subprocess, "run", fake_run)

    assert module.detect_me() == ""


def test_month_helpers_reject_unusable_values(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Short, empty, and unparseable dates yield no month rather than a crash."""
    monkeypatch.setenv("LIA_ME", OWNER)
    _write_export(tmp_path)
    module = _load_explorer(monkeypatch, tmp_path)

    assert module.month("2024-01-15") == "2024-01"
    assert module.month("2024") is None
    assert module.month("") is None
    assert module.conn_month({"Connected On": "15 Jan 2024"}) == "2024-01"
    assert module.conn_month({"Connected On": "not a date"}) is None
    assert module.conn_month({}) is None
