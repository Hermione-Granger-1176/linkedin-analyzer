from __future__ import annotations

import io
import os
import subprocess
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import TYPE_CHECKING

from scripts.lib import workspace_status

if TYPE_CHECKING:
    import pytest

Predicate = Callable[[list[str]], bool]


class FakeRun:
    """Dispatch injected subprocess calls to scripted responses."""

    def __init__(self, responses: list[tuple[Predicate, object]]) -> None:
        self.responses = responses
        self.calls: list[list[str]] = []

    def __call__(self, cmd: Sequence[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        """Return the first matching scripted response, or raise it."""
        command = list(cmd)
        self.calls.append(command)
        for predicate, response in self.responses:
            if predicate(command):
                if isinstance(response, Exception):
                    raise response
                assert isinstance(response, subprocess.CompletedProcess)
                return response
        raise AssertionError(f"unexpected command: {command}")


def _proc(returncode: int, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess[str]:
    """Build a completed process for the fake runner."""
    return subprocess.CompletedProcess(
        args=["x"], returncode=returncode, stdout=stdout, stderr=stderr
    )


def _first(name: str) -> Predicate:
    """Match commands whose executable is ``name``."""
    return lambda cmd: cmd[0] == name


def _make_venv(root: Path) -> str:
    """Create an executable stub interpreter under ``root/.venv`` and return its path."""
    venv_python = root / ".venv/bin/python"
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("#!/bin/sh\n", encoding="utf-8")
    venv_python.chmod(0o755)
    return ".venv/bin/python"


def _render(root: Path, run: FakeRun, venv_python: str = ".venv/bin/python") -> str:
    """Render the status report for ``root`` with an injected runner."""
    out = io.StringIO()
    workspace_status.write_status(
        out, root=root, venv_python=venv_python, uv="uv", npm="npm", run_fn=run
    )
    return out.getvalue()


def test_makefile_status_target_runs_on_the_system_interpreter() -> None:
    """``make status`` must work before ``make setup`` exists to report on.

    Running the report through the venv interpreter would fail to launch on the
    exact workspace the report is meant to diagnose, so the target has to use the
    system interpreter and forward the venv path as data.
    """
    makefile = (workspace_status.REPO_ROOT / "Makefile").read_text(encoding="utf-8")
    recipe = makefile[makefile.index("\nstatus: ") :].split("\n\n", 1)[0]

    assert "$(SYSTEM_PYTHON) -m scripts.lib.workspace_status" in recipe
    assert '--venv-python "$(VENV_PYTHON)"' in recipe
    assert "$(VENV_PYTHON) -m scripts.lib.workspace_status" not in recipe


def test_healthy_workspace_reports_every_section_ok(tmp_path: Path) -> None:
    """A provisioned workspace reports OK for python, node, and the web build."""
    venv_python = _make_venv(tmp_path)
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "web/dist").mkdir(parents=True)
    run = FakeRun(
        [
            (_first("git"), _proc(0, "## main...origin/main\n")),
            (_first("uv"), _proc(0)),
            (_first("npm"), _proc(0)),
            (_first(venv_python), _proc(0, "PR #1 [OPEN] Title\n")),
        ]
    )

    report = _render(tmp_path, run, venv_python)

    assert "=== Git ===" in report
    assert "## main...origin/main" in report
    assert f"OK: {venv_python} exists" in report
    assert "OK: uv.lock is current" in report
    assert "OK: node_modules exists" in report
    assert "OK: package-lock.json is current" in report
    assert "OK: web/dist exists" in report
    assert "PR #1 [OPEN] Title" in report


def test_unprovisioned_workspace_reports_each_remedy(tmp_path: Path) -> None:
    """Missing venv, deps, locks, and build each name the Make target that fixes them."""
    run = FakeRun(
        [
            (_first("git"), _proc(0, "## main\n")),
            (_first("uv"), _proc(1)),
            (_first("npm"), _proc(1)),
        ]
    )

    report = _render(tmp_path, run)

    assert "MISSING: run make setup" in report
    assert "STALE: run make lock" in report
    assert "STALE: run make lock-node" in report
    assert "NOT BUILT: run make web-build" in report
    assert "SKIPPED: venv missing, run make setup" in report


def test_pr_summary_is_skipped_without_a_venv(tmp_path: Path) -> None:
    """The PR overview never shells out to a missing interpreter."""
    run = FakeRun(
        [
            (_first("git"), _proc(0, "")),
            (_first("uv"), _proc(0)),
            (_first("npm"), _proc(0)),
        ]
    )

    _render(tmp_path, run)

    assert all(call[0] in {"git", "uv", "npm"} for call in run.calls)


def test_pr_summary_failure_never_fails_the_report(tmp_path: Path) -> None:
    """A failing gh summary is reported inline, mirroring the old `|| true` recipe."""
    venv_python = _make_venv(tmp_path)
    run = FakeRun(
        [
            (_first("git"), _proc(0, "")),
            (_first("uv"), _proc(0)),
            (_first("npm"), _proc(0)),
            (_first(venv_python), _proc(1, "", "No pull request found.\n")),
        ]
    )

    report = _render(tmp_path, run, venv_python)

    assert "No pull request found." in report


def test_a_tool_that_cannot_launch_is_treated_as_a_plain_failure(tmp_path: Path) -> None:
    """An OSError from any subprocess degrades to the failure branch, never a crash.

    Degrading must stay visible: a section that prints its header and nothing
    else is the least useful thing a health report can do on the exact
    workstation it is meant to diagnose.
    """
    venv_python = _make_venv(tmp_path)
    run = FakeRun(
        [
            (_first("git"), FileNotFoundError("git")),
            (_first("uv"), FileNotFoundError("uv")),
            (_first("npm"), FileNotFoundError("npm")),
            (_first(venv_python), FileNotFoundError("python")),
        ]
    )

    report = _render(tmp_path, run, venv_python)

    assert "UNAVAILABLE: git could not be launched" in report
    assert "STALE: run make lock" in report
    assert "STALE: run make lock-node" in report
    assert f"UNAVAILABLE: {venv_python} could not be launched" in report


def test_child_env_prepends_the_root_without_dropping_an_existing_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A PYTHONPATH the developer set survives; the repository root goes first."""
    monkeypatch.setenv("PYTHONPATH", f"/their/tools{os.pathsep}/more")

    assert workspace_status._child_env(tmp_path)["PYTHONPATH"] == os.pathsep.join(
        [str(tmp_path), "/their/tools", "/more"]
    )


def test_child_env_without_an_existing_path_has_only_the_root(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """An unset or empty PYTHONPATH does not leave an empty entry behind.

    An empty entry means the current directory, which would silently widen the
    import path of every child process.
    """
    monkeypatch.setenv("PYTHONPATH", "")

    assert workspace_status._child_env(tmp_path)["PYTHONPATH"] == str(tmp_path)

    monkeypatch.delenv("PYTHONPATH")

    assert workspace_status._child_env(tmp_path)["PYTHONPATH"] == str(tmp_path)


def test_absolute_venv_python_is_not_rejoined_to_the_root(tmp_path: Path) -> None:
    """An absolute --venv-python is used as given rather than resolved under the root."""
    _make_venv(tmp_path)
    absolute = str(tmp_path / ".venv/bin/python")
    run = FakeRun(
        [
            (_first("git"), _proc(0, "")),
            (_first("uv"), _proc(0)),
            (_first("npm"), _proc(0)),
            (_first(absolute), _proc(0, "summary\n")),
        ]
    )

    report = _render(tmp_path, run, absolute)

    assert f"OK: {absolute} exists" in report


def test_main_writes_the_report_for_the_repository(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The CLI entry point reports on the real repository root and exits zero.

    The runner is stubbed rather than left real: ``uv lock --check`` and the npm
    lock probe are slow and can reach the network, so a hermetic fake keeps this
    a test of the entry point's wiring instead of a test of the local toolchain.
    """
    monkeypatch.setattr(
        workspace_status, "_default_run", lambda cmd, **_kwargs: _proc(0, f"ran {cmd[0]}\n")
    )

    assert workspace_status.main(["--venv-python", "definitely/missing/python"]) == 0

    captured = capsys.readouterr()
    assert "=== Git ===" in captured.out
    assert "ran git" in captured.out
    assert "MISSING: run make setup" in captured.out


def test_default_run_captures_output(tmp_path: Path) -> None:
    """The real runner captures text output and never raises on a non-zero exit."""
    result = workspace_status._default_run(
        ["sh", "-c", "printf hello; exit 3"], cwd=tmp_path, env=None
    )

    assert result.returncode == 3
    assert result.stdout == "hello"


def test_repo_root_points_at_the_repository() -> None:
    """REPO_ROOT resolves to the checkout that owns the Makefile."""
    assert (workspace_status.REPO_ROOT / "Makefile").is_file()
