from __future__ import annotations

import subprocess
from collections.abc import Sequence
from typing import TYPE_CHECKING

from scripts.lint import format_js_diff

if TYPE_CHECKING:
    from pathlib import Path

    import pytest


def formatter(
    outputs: dict[str, tuple[int, str, str]],
) -> tuple[list[list[str]], format_js_diff.Formatter]:
    """Return the commands Prettier receives, and a fake Prettier keyed by path."""
    commands: list[list[str]] = []

    def run(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
        commands.append(list(command))
        code, stdout, stderr = outputs[command[-1]]
        return subprocess.CompletedProcess(list(command), code, stdout, stderr)

    return commands, run


def test_prints_a_unified_diff_and_exits_zero_when_files_differ(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A difference is printed as a diff, and the exit code stays 0."""
    path = tmp_path / "app.js"
    path.write_text("const a=1\n", encoding="utf-8")
    commands, run = formatter({str(path): (0, "const a = 1;\n", "")})

    code = format_js_diff.main([str(path)], format_fn=run)

    assert code == 0
    output = capsys.readouterr().out
    assert f"--- {path}\n+++ {path} (formatted)\n" in output
    assert "-const a=1\n+const a = 1;\n" in output
    assert commands == [["npx", *format_js_diff.PRETTIER_ARGS, "--", str(path)]]


def test_prints_nothing_for_a_formatted_file(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A file Prettier would leave alone produces no output."""
    path = tmp_path / "clean.md"
    path.write_text("# Title\n", encoding="utf-8")
    _, run = formatter({str(path): (0, "# Title\n", "")})

    assert format_js_diff.main([str(path)], format_fn=run) == 0
    assert capsys.readouterr().out == ""


def test_shows_a_diff_for_line_endings_alone(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A CRLF file differs from Prettier's LF output even when the text matches."""
    path = tmp_path / "crlf.js"
    path.write_bytes(b"const a = 1;\r\n")
    _, run = formatter({str(path): (0, "const a = 1;\n", "")})

    assert format_js_diff.main([str(path)], format_fn=run) == 0
    assert "-const a = 1;\r\n+const a = 1;\n" in capsys.readouterr().out


def test_a_prettier_failure_stops_the_run_with_its_exit_code(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A Prettier failure stops the run and returns its exit code."""
    broken = tmp_path / "broken.js"
    broken.write_text("const =\n", encoding="utf-8")
    later = tmp_path / "later.js"
    later.write_text("x\n", encoding="utf-8")
    commands, run = formatter(
        {str(broken): (2, "", "SyntaxError: Unexpected token\n"), str(later): (0, "x\n", "")}
    )

    code = format_js_diff.main([str(broken), str(later)], format_fn=run)

    assert code == 2
    assert "SyntaxError" in capsys.readouterr().err
    assert len(commands) == 1


def test_runs_the_configured_npx_command(tmp_path: Path) -> None:
    """The Make target passes its NPX, which may carry its own arguments."""
    path = tmp_path / "a.css"
    path.write_text("a{}\n", encoding="utf-8")
    commands, run = formatter({str(path): (0, "a{}\n", "")})

    format_js_diff.main(["--npx", "npx --yes", str(path)], format_fn=run)

    assert commands[0][:3] == ["npx", "--yes", "prettier"]


def test_default_formatter_captures_output_without_a_shell(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The real formatter captures Prettier's output and never asks for a shell."""
    seen: dict[str, object] = {}

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        seen.update(kwargs)
        return subprocess.CompletedProcess(command, 2, b"out\r\n", b"bad \xff\n")

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = format_js_diff._default_format(["prettier", "a.js"])

    assert (result.returncode, result.stdout) == (2, "out\r\n")
    assert result.stderr == "bad \ufffd\n"
    assert seen["shell"] is False
    assert seen["capture_output"] is True
    assert "text" not in seen
