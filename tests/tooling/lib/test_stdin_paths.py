from __future__ import annotations

import io
import subprocess
from collections.abc import Sequence
from typing import TYPE_CHECKING

import pytest
from scripts.lib import stdin_paths

if TYPE_CHECKING:
    from pathlib import Path


class TerminalInput(io.StringIO):
    """A stdin that reports itself as an interactive terminal."""

    def isatty(self) -> bool:
        """Report a terminal."""
        return True


def recorder() -> tuple[list[list[str]], stdin_paths.CommandRunner]:
    """Return the commands a runner receives, and the runner."""
    commands: list[list[str]] = []

    def run(command: Sequence[str]) -> int:
        commands.append(list(command))
        return 0

    return commands, run


def test_runs_the_command_with_one_argument_per_stdin_line() -> None:
    """Spaces and quotes inside a line stay part of one path."""
    commands, run = recorder()

    code = stdin_paths.main(
        ["--", "git", "add", "--"],
        stdin=io.StringIO('My Notes.md\nsrc/app.py\ndocs/a "quoted" name.md\n'),
        run_fn=run,
    )

    assert code == 0
    assert commands == [
        ["git", "add", "--", "My Notes.md", "src/app.py", 'docs/a "quoted" name.md']
    ]


def test_skips_blank_lines_and_strips_only_line_endings() -> None:
    """Blank lines are ignored, and a path keeps its own leading or trailing spaces."""
    commands, run = recorder()

    stdin_paths.main(
        ["--", "lint"], stdin=io.StringIO("\n  spaced.md \r\n\n   \nlast.md"), run_fn=run
    )

    assert commands == [["lint", "  spaced.md ", "last.md"]]


def test_falls_back_to_the_defaults_without_paths() -> None:
    """An empty stdin runs the command on its default scope."""
    commands, run = recorder()

    stdin_paths.main([".", "--", "yamllint"], stdin=io.StringIO(""), run_fn=run)

    assert commands == [["yamllint", "."]]


def test_treats_a_terminal_as_no_paths_without_reading_it() -> None:
    """An optional list never waits for typing."""
    commands, run = recorder()

    stdin_paths.main(["src/", "--", "ruff"], stdin=TerminalInput("ignored.md\n"), run_fn=run)

    assert commands == [["ruff", "src/"]]


def test_prefixes_a_leading_dash_so_it_cannot_read_as_an_option() -> None:
    """A file named like an option stays a file."""
    commands, run = recorder()

    stdin_paths.main(["--", "git", "add", "--"], stdin=io.StringIO("-rf\n"), run_fn=run)

    assert commands == [["git", "add", "--", "./-rf"]]


def test_a_required_list_without_paths_prints_usage_and_runs_nothing(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Running `make stage` with nothing to stage is a usage error."""
    commands, run = recorder()

    code = stdin_paths.main(
        ["--require", "--name", "make stage", "--", "git", "add", "--"],
        stdin=TerminalInput(""),
        run_fn=run,
    )

    assert code == 2
    assert commands == []
    assert "make stage needs paths on stdin, one per line" in capsys.readouterr().err


def test_returns_the_command_exit_code() -> None:
    """A failing command fails the target."""
    code = stdin_paths.main(["--", "lint"], stdin=io.StringIO("a.md\n"), run_fn=lambda _: 3)

    assert code == 3


@pytest.mark.parametrize(
    ("argv", "message"),
    [
        (["lint"], "missing -- before the command"),
        (["--"], "missing command after --"),
        (["--name"], "missing -- before the command"),
        (["--name", "--", "lint"], "--name needs a value"),
    ],
)
def test_rejects_a_malformed_invocation(
    argv: list[str], message: str, capsys: pytest.CaptureFixture[str]
) -> None:
    """A recipe mistake fails loudly instead of running the wrong command."""
    code = stdin_paths.main(argv, stdin=io.StringIO(""), run_fn=lambda _: 0)

    assert code == 2
    assert message in capsys.readouterr().err


def test_reads_the_process_stdin_and_arguments_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without injected streams, the real stdin and argv are used."""
    commands, run = recorder()
    monkeypatch.setattr("sys.argv", ["stdin_paths", "--", "lint"])
    monkeypatch.setattr("sys.stdin", io.StringIO("a.md\n"))

    stdin_paths.main(run_fn=run)

    assert commands == [["lint", "a.md"]]


def test_default_runner_executes_without_a_shell(tmp_path: Path) -> None:
    """The real runner passes each path as one argument and returns the exit code."""
    target = tmp_path / "name with $(spaces).txt"

    code = stdin_paths._default_run(["touch", str(target)])

    assert code == 0
    assert target.exists()
    assert stdin_paths._default_run(["false"]) == 1


def test_default_runner_uses_subprocess_without_a_shell(monkeypatch: pytest.MonkeyPatch) -> None:
    """The runner never asks for a shell."""
    seen: dict[str, object] = {}

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        seen.update(kwargs)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)

    assert stdin_paths._default_run(["lint"]) == 0
    assert seen["shell"] is False
