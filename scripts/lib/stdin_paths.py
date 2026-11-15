#!/usr/bin/env python3
"""Run a command with paths read from stdin, one per line.

Every Make target that takes files reads them this way, so a path can hold
spaces, quotes, or shell metacharacters without any quoting rules::

    make stage <<'EOF'
    My Notes.md
    src/app.py
    EOF

Usage: ``python -m scripts.lib.stdin_paths [--require] [--name NAME] [DEFAULT ...] -- COMMAND ...``

Each non-blank stdin line is one path, kept exactly, apart from a trailing
carriage return. A terminal on stdin counts as no paths, so an optional list
never waits for typing. With no paths, ``COMMAND`` runs with the ``DEFAULT``
arguments instead, or, with ``--require``, the usage message is printed and the
exit code is 2. A relative path that starts with ``-`` gets a ``./`` prefix so
the command cannot read it as an option. The command runs without a shell, each
path as its own argument, and its exit code is returned.
"""

from __future__ import annotations

import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import TextIO

# A runner takes the command vector and returns its exit code.
# Injectable so tests never start a real process.
CommandRunner = Callable[[Sequence[str]], int]

USAGE = (
    "Usage: python -m scripts.lib.stdin_paths [--require] [--name NAME] [DEFAULT ...] "
    "-- COMMAND ..."
)


@dataclass(frozen=True)
class Invocation:
    """A parsed command line: what to run, and what to do without paths."""

    command: list[str]
    defaults: list[str]
    require: bool
    name: str


def parse_invocation(argv: Sequence[str]) -> Invocation:
    """Split options and defaults from the command after ``--``.

    Raises:
        ValueError: If ``--`` or the command after it is missing, or ``--name``
            has no value.
    """
    if "--" not in argv:
        raise ValueError("missing -- before the command")
    split = list(argv).index("--")
    before, command = list(argv[:split]), list(argv[split + 1 :])
    if not command:
        raise ValueError("missing command after --")
    require = False
    name = "this target"
    defaults: list[str] = []
    index = 0
    while index < len(before):
        argument = before[index]
        if argument == "--require":
            require = True
        elif argument == "--name":
            if index + 1 >= len(before):
                raise ValueError("--name needs a value")
            index += 1
            name = before[index]
        else:
            defaults.append(argument)
        index += 1
    return Invocation(command=command, defaults=defaults, require=require, name=name)


def read_paths(stream: TextIO) -> list[str]:
    """Return one path per non-blank line, or none when ``stream`` is a terminal."""
    if stream.isatty():
        return []
    paths = []
    for line in stream.read().split("\n"):
        path = line.removesuffix("\r")
        if path.strip():
            paths.append(path)
    return paths


def as_argument(path: str) -> str:
    """Keep a relative path that starts with ``-`` from reading as an option."""
    return f"./{path}" if path.startswith("-") else path


def _default_run(command: Sequence[str]) -> int:
    """Run ``command`` without a shell and return its exit code."""
    return subprocess.run(list(command), check=False, shell=False).returncode


def main(
    argv: Sequence[str] | None = None,
    *,
    stdin: TextIO | None = None,
    run_fn: CommandRunner | None = None,
) -> int:
    """Run the command on the stdin paths, or on its defaults, and return its exit code."""
    try:
        invocation = parse_invocation(sys.argv[1:] if argv is None else argv)
    except ValueError as error:
        print(f"stdin_paths: {error}\n{USAGE}", file=sys.stderr)
        return 2
    paths = read_paths(sys.stdin if stdin is None else stdin)
    if not paths and invocation.require:
        print(
            f"{invocation.name} needs paths on stdin, one per line:\n\n"
            f"    {invocation.name} <<'EOF'\n    path/one.txt\n    path with spaces.md\n    EOF",
            file=sys.stderr,
        )
        return 2
    arguments = [as_argument(path) for path in paths] if paths else invocation.defaults
    runner = run_fn or _default_run
    return runner([*invocation.command, *arguments])


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
