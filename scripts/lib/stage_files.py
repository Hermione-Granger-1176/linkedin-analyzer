#!/usr/bin/env python3
"""Stage files for ``make stage`` without shell interpretation of paths.

Read paths from environment variables and pass each as a separate ``git add``
argument with ``shell=False``. Spaces and shell metacharacters remain literal.

``STAGE_FILE`` supplies one exact path. ``STAGE_FILES`` supplies a whitespace-
separated list, except when its complete value names one existing or tracked
path. That exception preserves legacy calls with spaces in one path.

If both inputs are empty, print usage and return a nonzero exit code.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

# A runner takes the git command vector and returns the completed process.
# Injectable so tests never touch a real repository.
GitRunner = Callable[[Sequence[str]], "subprocess.CompletedProcess[str]"]

USAGE = 'Usage: make stage [files="a.txt b.txt"] [file="one file with spaces.txt"]'


def collect_paths(
    environ: Mapping[str, str], *, is_exact_path: Callable[[str], bool] | None = None
) -> list[str]:
    """Return paths from the legacy multi-file input and the exact single-path input.

    ``STAGE_FILES`` normally keeps its whitespace-separated behavior. When it
    contains whitespace, no explicit ``STAGE_FILE`` is present, and its complete
    raw value names one existing or tracked path, that value is kept intact. This
    preserves both the legacy multi-file syntax and the original spaced-path
    acceptance case. ``STAGE_FILE`` is always appended verbatim when non-blank.
    """
    raw_files = environ.get("STAGE_FILES", "").strip()
    single = environ.get("STAGE_FILE", "")
    spaced_exact_path = (
        bool(raw_files.split())
        and not single.strip()
        and any(char.isspace() for char in raw_files)
        and is_exact_path is not None
        and is_exact_path(raw_files)
    )
    paths = [raw_files] if spaced_exact_path else raw_files.split()
    if single.strip():
        paths.append(single)
    return paths


def _default_run(cmd: Sequence[str]) -> subprocess.CompletedProcess[str]:
    """Run ``git`` without a shell, never raising on a non-zero exit."""
    return subprocess.run(list(cmd), check=False, shell=False, text=True)


def _default_probe(cmd: Sequence[str]) -> subprocess.CompletedProcess[str]:
    """Run a read-only git probe quietly, returning its status."""
    return subprocess.run(
        list(cmd),
        check=False,
        shell=False,
        stderr=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        text=True,
    )


def _is_existing_or_tracked(path: str, *, probe_fn: GitRunner) -> bool:
    """Return whether ``path`` exists or is tracked, with pathspec magic disabled."""
    if Path(path).exists():
        return True
    result = probe_fn(["git", "--literal-pathspecs", "ls-files", "--error-unmatch", "--", path])
    return result.returncode == 0


def stage_paths(paths: Sequence[str], *, run_fn: GitRunner | None = None) -> int:
    """Stage ``paths`` via ``git add -- <paths>`` and return git's exit code.

    The ``--`` stops option parsing so a leading-dash path is treated as a file,
    and passing each path as its own argv entry keeps spaces and shell
    metacharacters literal.
    """
    runner = run_fn or _default_run
    return runner(["git", "add", "--", *paths]).returncode


def main(
    *,
    environ: Mapping[str, str] | None = None,
    run_fn: GitRunner | None = None,
    probe_fn: GitRunner | None = None,
) -> int:
    """Collect paths from the environment and stage them, returning an exit code."""
    runner = run_fn or _default_run
    probe = probe_fn or _default_probe
    paths = collect_paths(
        os.environ if environ is None else environ,
        is_exact_path=lambda path: _is_existing_or_tracked(path, probe_fn=probe),
    )
    if not paths:
        print(USAGE, file=sys.stderr)
        return 1
    return stage_paths(paths, run_fn=runner)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
