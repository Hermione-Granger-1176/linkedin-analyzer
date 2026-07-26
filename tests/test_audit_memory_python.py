"""Tests for the per-cleaner peak-RSS audit behind `make audit-memory-python`."""

from __future__ import annotations

import subprocess
import sys
from typing import TYPE_CHECKING

from scripts.checks import audit_memory_python as audit

from linkedin_analyzer.core.types import CleanerResult

if TYPE_CHECKING:
    from pathlib import Path

    import pytest


def _fake_types(
    monkeypatch: pytest.MonkeyPatch,
    *,
    success: bool = True,
    rows: int = 3,
) -> None:
    """Replace the real cleaners with an in-process stand-in of the same shape."""

    def cleaner(*, input_path: Path, output_path: Path) -> CleanerResult:
        output_path.write_text("workbook", encoding="utf-8")
        return CleanerResult(
            success=success,
            rows_processed=rows,
            input_path=input_path,
            output_path=output_path,
        )

    monkeypatch.setattr(
        audit,
        "TYPES",
        {name: (filename, cleaner) for name, (filename, _) in audit.TYPES.items()},
    )


def _export(tmp_path: Path) -> Path:
    """Create a directory holding every input filename the audit expects."""
    input_dir = tmp_path / "input"
    input_dir.mkdir()
    for filename, _ in audit.TYPES.values():
        (input_dir / filename).write_text("header\n", encoding="utf-8")
    return input_dir


def _fake_measure(
    monkeypatch: pytest.MonkeyPatch,
    result: tuple[int, int, str] | None,
) -> list[str]:
    """Record the measured types and return a fixed measurement for each."""
    seen: list[str] = []

    def measure(
        type_name: str,
        _input_path: Path,
        _output_dir: Path,
    ) -> tuple[int, int, str] | None:
        seen.append(type_name)
        return result

    monkeypatch.setattr(audit, "measure", measure)
    return seen


def test_run_child_reports_rows_and_peak_rss(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The isolated child prints one structured line the parent can parse."""
    _fake_types(monkeypatch)

    exit_code = audit.run_child("comments", str(tmp_path / "in.csv"), str(tmp_path / "out.xlsx"))

    assert exit_code == 0
    line = capsys.readouterr().out.strip()
    assert line.startswith("rows=3 peak_rss_kib=")
    assert line.endswith("status=OK")


def test_run_child_reports_a_failed_cleaner(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A cleaner failure becomes a nonzero child status and an ERROR line."""
    _fake_types(monkeypatch, success=False, rows=0)

    exit_code = audit.run_child("shares", str(tmp_path / "in.csv"), str(tmp_path / "out.xlsx"))

    assert exit_code == 1
    assert "status=ERROR" in capsys.readouterr().out


def test_run_child_normalizes_macos_peak_rss(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Normalize ru_maxrss to KiB on macOS, where it is reported in bytes."""
    _fake_types(monkeypatch)
    monkeypatch.setattr(sys, "platform", "darwin")

    audit.run_child("messages", str(tmp_path / "in.csv"), str(tmp_path / "out.xlsx"))
    darwin_line = capsys.readouterr().out.strip()

    monkeypatch.setattr(sys, "platform", "linux")
    audit.run_child("messages", str(tmp_path / "in.csv"), str(tmp_path / "out.xlsx"))
    linux_line = capsys.readouterr().out.strip()

    darwin_peak = int(darwin_line.split("peak_rss_kib=")[1].split()[0])
    linux_peak = int(linux_line.split("peak_rss_kib=")[1].split()[0])
    assert darwin_peak == linux_peak // 1024


def test_measure_parses_the_child_result_line(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only the structured line is read out of the child's output."""
    commands: list[list[str]] = []

    def fake_run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        return subprocess.CompletedProcess(
            command,
            0,
            "warming up\nrows=12 peak_rss_kib=2048 status=OK\n",
            "",
        )

    monkeypatch.setattr(audit.subprocess, "run", fake_run)

    measured = audit.measure("comments", tmp_path / "Comments.csv", tmp_path)

    assert measured == (12, 2048, "OK")
    assert commands[0][:3] == [sys.executable, str(audit.Path(audit.__file__).resolve()), "--child"]
    assert commands[0][3] == "comments"
    assert commands[0][5] == str(tmp_path / "comments.xlsx")


def test_measure_reports_a_child_without_a_result_line(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A child that crashed before printing yields no measurement."""

    def fake_run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(command, 1, "Traceback...\n", "boom")

    monkeypatch.setattr(audit.subprocess, "run", fake_run)

    assert audit.measure("shares", tmp_path / "Shares.csv", tmp_path) is None


def test_run_audit_skips_a_missing_export(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Without a private export the audit skips cleanly instead of failing."""
    exit_code = audit.run_audit(tmp_path / "absent", strict=False)

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "shares       MISSING    input-file-absent=1" in output
    assert "RESULT       SKIPPED    missing-inputs=4" in output


def test_run_audit_fails_a_missing_export_in_strict_mode(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Strict audit mode turns the same absent export into a failure."""
    exit_code = audit.run_audit(tmp_path / "absent", strict=True)

    assert exit_code == 1
    assert "RESULT       FAILED     missing-inputs=4" in capsys.readouterr().out


def test_run_audit_measures_every_type(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A complete export measures each cleaner and reports content-safe numbers."""
    input_dir = _export(tmp_path)
    seen = _fake_measure(monkeypatch, (12, 2048, "OK"))

    exit_code = audit.run_audit(input_dir, strict=False)

    output = capsys.readouterr().out
    assert exit_code == 0
    assert seen == list(audit.TYPES)
    assert "shares       OK         input-bytes=7 rows=12 peak-rss-kib=2048 peak-rss-mib=2.0" in (
        output
    )
    assert "RESULT       MEASURED   types=4 errors=0" in output


def test_run_audit_counts_unmeasurable_types(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A child that produced no measurement counts as an error for every type."""
    input_dir = _export(tmp_path)
    _fake_measure(monkeypatch, None)

    exit_code = audit.run_audit(input_dir, strict=False)

    output = capsys.readouterr().out
    assert exit_code == 1
    assert "shares       ERROR      input-bytes=7 measurement-failures=1" in output
    assert "RESULT       FAILED     types=4 errors=4" in output


def test_run_audit_counts_failed_cleaners(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A measured but failed cleaner is reported and fails the audit."""
    input_dir = _export(tmp_path)
    _fake_measure(monkeypatch, (0, 1024, "ERROR"))

    exit_code = audit.run_audit(input_dir, strict=False)

    assert exit_code == 1
    assert "RESULT       FAILED     types=4 errors=4" in capsys.readouterr().out


def test_parse_args_defaults_to_the_repository_export(tmp_path: Path) -> None:
    """The default input directory is the repository's ignored data/input."""
    del tmp_path
    args = audit.parse_args([])

    assert args.input_dir == audit.DEFAULT_INPUT_DIR
    assert args.strict is False
    assert args.child is None


def test_main_dispatches_to_the_parent_audit(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Without --child the entry point runs the parent audit over the export."""
    exit_code = audit.main(["--input-dir", str(tmp_path / "absent"), "--strict"])

    assert exit_code == 1
    assert "RESULT       FAILED" in capsys.readouterr().out


def test_main_dispatches_to_the_child_measurement(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The hidden --child interface runs exactly one cleaner in this process."""
    _fake_types(monkeypatch)

    exit_code = audit.main(
        ["--child", "connections", str(tmp_path / "in.csv"), str(tmp_path / "out.xlsx")]
    )

    assert exit_code == 0
    assert "status=OK" in capsys.readouterr().out
