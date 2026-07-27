from __future__ import annotations

import subprocess
from collections.abc import Sequence
from typing import TYPE_CHECKING

from scripts.ci import run_parallel_checks

from tests.test_pr_review import completed_process

if TYPE_CHECKING:
    import pytest


def test_run_check_reports_success_output() -> None:
    """Capture successful make output."""
    result = run_parallel_checks.run_check(
        "lint",
        run_fn=lambda *_args, **_kwargs: completed_process(0, "ok\n", "done\n"),
    )

    assert result.name == "lint"
    assert result.passed
    assert result.output == "ok\ndone"


def test_run_check_reports_failed_output() -> None:
    """Capture failed make output."""
    result = run_parallel_checks.run_check(
        "test",
        run_fn=lambda *_args, **_kwargs: completed_process(2, "", "failed\n"),
    )

    assert not result.passed
    assert result.output == "failed"


def test_run_check_reports_timeout() -> None:
    """Convert subprocess timeouts into failed check results."""

    def timeout_runner(*_args: object, **_kwargs: object) -> subprocess.CompletedProcess[str]:
        raise subprocess.TimeoutExpired(cmd=["make", "slow"], timeout=7)

    result = run_parallel_checks.run_check("slow", timeout=7, run_fn=timeout_runner)

    assert not result.passed
    assert result.output == "Timed out after 7s"


def test_run_check_reports_unlaunchable_target() -> None:
    """Convert a process that never starts into a failed check instead of an exception."""

    def failing_runner(*_args: object, **_kwargs: object) -> subprocess.CompletedProcess[str]:
        raise OSError("make is not installed")

    result = run_parallel_checks.run_check("lint", run_fn=failing_runner)

    assert not result.passed
    assert result.output == "Failed to run: make is not installed"


def test_format_results_groups_success_and_expands_failures() -> None:
    """Format CI output with grouped passing logs and visible failures."""
    results = (
        run_parallel_checks.CheckResult("lint", True, 1.2, "ok"),
        run_parallel_checks.CheckResult("test", False, 2.5, "boom"),
    )

    formatted = run_parallel_checks.format_results(results)

    assert "✓ lint (1.2s)" in formatted
    assert "✗ test (2.5s)" in formatted
    assert "::group::lint" in formatted
    assert "--- test (failed) ---" in formatted
    assert "::error::Failed: test" in formatted


def test_run_checks_sorts_results_by_target_name() -> None:
    """Return parallel check results sorted by target name."""

    def runner(args: Sequence[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        return completed_process(0, stdout=f"{args[-1]}\n")

    results = run_parallel_checks.run_checks(["zeta", "alpha"], run_fn=runner)

    assert [result.name for result in results] == ["alpha", "zeta"]


def test_main_rejects_invalid_timeout(capsys: pytest.CaptureFixture[str]) -> None:
    """Reject non-integer timeout values before running checks."""
    exit_code = run_parallel_checks.main(["--timeout", "nope", "lint"])

    captured = capsys.readouterr()
    assert exit_code == 1
    assert "invalid timeout value" in captured.out


def test_main_rejects_timeout_without_a_value(capsys: pytest.CaptureFixture[str]) -> None:
    """Reject a trailing --timeout flag rather than treating it as a target."""
    exit_code = run_parallel_checks.main(["lint", "--timeout"])

    captured = capsys.readouterr()
    assert exit_code == 1
    assert "--timeout requires an integer value" in captured.out
    assert "Usage:" in captured.out


def test_main_rejects_non_positive_timeout(capsys: pytest.CaptureFixture[str]) -> None:
    """Reject timeouts that would abort every check before it can run."""
    exit_code = run_parallel_checks.main(["--timeout", "0", "lint"])

    captured = capsys.readouterr()
    assert exit_code == 1
    assert "timeout must be positive, got 0" in captured.out


def test_main_requires_at_least_one_target(capsys: pytest.CaptureFixture[str]) -> None:
    """Print usage and fail when no Make targets are given."""
    exit_code = run_parallel_checks.main([])

    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.out.strip() == (
        "Usage: run_parallel_checks.py [--timeout N] target1 target2 ..."
    )


def test_main_uses_timeout_for_targets(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Parse timeout values and pass them to run_checks."""
    calls: list[tuple[list[str], int]] = []

    def fake_run_checks(
        targets: list[str],
        *,
        timeout: int = run_parallel_checks.DEFAULT_TIMEOUT,
        _run_fn=None,
    ) -> tuple[run_parallel_checks.CheckResult, ...]:
        calls.append((targets, timeout))
        return (run_parallel_checks.CheckResult("lint", True, 0.1, "ok"),)

    monkeypatch.setattr(run_parallel_checks, "run_checks", fake_run_checks)

    exit_code = run_parallel_checks.main(["--timeout", "42", "lint"])

    captured = capsys.readouterr()
    assert exit_code == 0
    assert calls == [(["lint"], 42)]
    assert "✓ lint" in captured.out
