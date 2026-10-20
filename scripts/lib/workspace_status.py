#!/usr/bin/env python3
"""Report workspace health for ``make status``.

Use the standard library so the command works before environment setup.
Check tool availability before invoking Git, uv, npm, or the PR helper.
Report Git state, Python and Node dependencies and locks, the web build,
and the current pull request.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import TextIO

REPO_ROOT = Path(__file__).resolve().parents[2]

# A runner takes a command vector plus a working directory and optional env, and
# returns the completed process. Injectable so tests never touch real tooling.
Runner = Callable[..., "subprocess.CompletedProcess[str]"]


def _default_run(
    cmd: Sequence[str],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run a command with captured output, never raising on a non-zero exit."""
    return subprocess.run(
        list(cmd),
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def _succeeds(
    cmd: Sequence[str],
    *,
    cwd: Path,
    run_fn: Runner,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str] | None:
    """Return the completed process, or None if the tool cannot launch.

    Catch OSError so missing, non-executable, or invalid executables become status
    results rather than exceptions that stop the workspace report.
    """
    try:
        return run_fn(cmd, cwd=cwd, env=env)
    except OSError:
        return None


def _ok(result: subprocess.CompletedProcess[str] | None) -> bool:
    """Return whether a lock-currency check ran and reported no drift."""
    return result is not None and result.returncode == 0


def _child_env(root: Path) -> dict[str, str]:
    """Return the child environment with the repository root on the import path.

    Prepends rather than replaces. A developer may have set ``PYTHONPATH`` for
    their own tooling, and this only needs the repository root importable so
    ``python -m scripts.gh.cli`` resolves.
    """
    inherited = os.environ.get("PYTHONPATH", "")
    entries = [str(root), *(entry for entry in inherited.split(os.pathsep) if entry)]
    return {**os.environ, "PYTHONPATH": os.pathsep.join(entries)}


def _venv_python_path(venv_python: str, root: Path) -> Path:
    """Resolve the interpreter path used for the executable check."""
    candidate = Path(venv_python)
    return candidate if candidate.is_absolute() else root / candidate


def _emit(out: TextIO, line: str = "") -> None:
    """Write one line to ``out``."""
    print(line, file=out)


def _write_git_section(out: TextIO, *, root: Path, run_fn: Runner) -> None:
    """Write the ``git status -sb`` output."""
    _emit(out, "=== Git ===")
    git = _succeeds(["git", "status", "-sb"], cwd=root, run_fn=run_fn)
    if git is None:
        # A launch failure must not fail the target, but printing the section
        # header and nothing else is the least actionable thing a health report
        # can do on the workstation it exists to diagnose.
        _emit(out, "UNAVAILABLE: git could not be launched")
    else:
        out.write(git.stdout)
        out.write(git.stderr)


def _write_python_section(
    out: TextIO, *, root: Path, venv_python: str, venv_ok: bool, uv: str, run_fn: Runner
) -> None:
    """Write whether the virtual environment exists and ``uv.lock`` is current."""
    _emit(out, "=== Python ===")
    _emit(out, f"OK: {venv_python} exists" if venv_ok else "MISSING: run make setup")
    uv_check = _succeeds([uv, "lock", "--check"], cwd=root, run_fn=run_fn)
    _emit(out, "OK: uv.lock is current" if _ok(uv_check) else "STALE: run make lock")


def _write_node_section(out: TextIO, *, root: Path, npm: str, run_fn: Runner) -> None:
    """Write whether ``node_modules`` exists and ``package-lock.json`` is current."""
    _emit(out, "=== Node ===")
    node_ok = (root / "node_modules").is_dir()
    _emit(out, "OK: node_modules exists" if node_ok else "MISSING: run make setup")
    npm_check = _succeeds(
        [npm, "install", "--package-lock-only", "--ignore-scripts", "--dry-run"],
        cwd=root,
        run_fn=run_fn,
    )
    _emit(
        out,
        "OK: package-lock.json is current" if _ok(npm_check) else "STALE: run make lock-node",
    )


def _write_web_build_section(out: TextIO, *, root: Path) -> None:
    """Write whether ``web/dist`` exists."""
    _emit(out, "=== Web build ===")
    built = (root / "web/dist").is_dir()
    _emit(out, "OK: web/dist exists" if built else "NOT BUILT: run make web-build")


def _write_pull_request_section(
    out: TextIO, *, root: Path, venv_python: str, venv_ok: bool, run_fn: Runner
) -> None:
    """Write the PR summary, which needs the virtual environment's interpreter."""
    _emit(out, "=== Pull request ===")
    if not venv_ok:
        _emit(out, "SKIPPED: venv missing, run make setup")
        return
    summary = _succeeds(
        [venv_python, "-m", "scripts.gh.cli", "summary"],
        cwd=root,
        run_fn=run_fn,
        env=_child_env(root),
    )
    # Old shell ran ``$(GH) summary || true``: any failure, including a
    # launch failure, is swallowed and the target still succeeds. The
    # swallowing is about the exit status, not about staying quiet, so a
    # launch failure still says so.
    if summary is None:
        _emit(out, f"UNAVAILABLE: {venv_python} could not be launched")
    else:
        out.write(summary.stdout)
        out.write(summary.stderr)


def write_status(
    out: TextIO,
    *,
    root: Path,
    venv_python: str,
    uv: str,
    npm: str,
    run_fn: Runner | None = None,
) -> None:
    """Write the full workspace status report to ``out``."""
    run = run_fn or _default_run
    venv_ok = os.access(_venv_python_path(venv_python, root), os.X_OK)

    _write_git_section(out, root=root, run_fn=run)
    _emit(out)
    _write_python_section(
        out, root=root, venv_python=venv_python, venv_ok=venv_ok, uv=uv, run_fn=run
    )
    _emit(out)
    _write_node_section(out, root=root, npm=npm, run_fn=run)
    _emit(out)
    _write_web_build_section(out, root=root)
    _emit(out)
    _write_pull_request_section(
        out, root=root, venv_python=venv_python, venv_ok=venv_ok, run_fn=run
    )


def main(argv: list[str] | None = None) -> int:
    """Parse arguments and print the workspace status report."""
    parser = argparse.ArgumentParser(description="Report workspace health for make status.")
    parser.add_argument("--venv-python", default=".venv/bin/python")
    parser.add_argument("--uv", default="uv")
    parser.add_argument("--npm", default="npm")
    args = parser.parse_args(argv)
    write_status(
        sys.stdout,
        root=REPO_ROOT,
        venv_python=args.venv_python,
        uv=args.uv,
        npm=args.npm,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
