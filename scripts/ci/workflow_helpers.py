#!/usr/bin/env python3
"""Small, tested helpers for GitHub Actions workflows.

The workflow shell should stay thin: trust-boundary decisions and downloaded
artifact validation live here so automated writebacks can be reused safely.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

LOCK_ARTIFACT_REQUIRED_FILES = {"uv-lock": Path("uv.lock")}
PULL_REQUEST_NUMBER_PATTERN = re.compile(r"[1-9][0-9]*")
COMMIT_SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
DEPENDABOT_UV_REF_PATTERN = re.compile(r"dependabot/uv/[A-Za-z0-9._/-]+")


def reject_unsafe_entries(root: Path) -> None:
    """Reject symlinks and special files inside an artifact tree before copying files out."""
    if not root.exists():
        raise ValueError(f"Artifact root does not exist: {root}")
    if root.is_symlink():
        raise ValueError(f"Artifact root is a symlink: {root}")

    for walk_root, dirnames, filenames in os.walk(root, followlinks=False):
        current_root = Path(walk_root)
        for name in [*dirnames, *filenames]:
            path = current_root / name
            if path.is_symlink():
                raise ValueError(f"Artifact contains a symlink: {path}")
        for name in filenames:
            path = current_root / name
            if not path.is_file():
                raise ValueError(f"Artifact contains a non-regular file: {path}")


def _artifact_files(root: Path) -> set[Path]:
    """Return all regular files in an artifact tree, relative to the root."""
    files: set[Path] = set()
    for walk_root, _dirnames, filenames in os.walk(root, followlinks=False):
        current_root = Path(walk_root)
        for name in filenames:
            path = current_root / name
            if path.is_file():
                files.add(path.relative_to(root))
    return files


def _artifact_directories(root: Path) -> set[Path]:
    """Return all directories in an artifact tree, relative to the root."""
    directories: set[Path] = set()
    for walk_root, dirnames, _filenames in os.walk(root, followlinks=False):
        current_root = Path(walk_root)
        directories.update((current_root / name).relative_to(root) for name in dirnames)
    return directories


def validate_lock_refresh_artifact(root: Path) -> None:
    """Validate a downloaded Python lock-refresh artifact tree."""
    reject_unsafe_entries(root)

    for relative_path in LOCK_ARTIFACT_REQUIRED_FILES.values():
        path = root / relative_path
        if not path.is_file():
            raise ValueError(f"Required artifact file missing or not a regular file: {path}")

    allowed_files = set(LOCK_ARTIFACT_REQUIRED_FILES.values())
    unexpected = sorted(_artifact_files(root) - allowed_files)
    if unexpected:
        formatted = ", ".join(path.as_posix() for path in unexpected)
        raise ValueError(f"Unexpected file(s) in lock artifact: {formatted}")

    unexpected_directories = sorted(_artifact_directories(root))
    if unexpected_directories:
        formatted = ", ".join(path.as_posix() for path in unexpected_directories)
        raise ValueError(f"Unexpected directory(ies) in lock artifact: {formatted}")


def validate_lock_refresh_context(pr_number: str, head_sha: str, head_ref: str) -> None:
    """Validate trusted workflow-run values before a lockfile writeback."""
    if PULL_REQUEST_NUMBER_PATTERN.fullmatch(pr_number) is None:
        raise ValueError("Lock refresh pull request number must be a positive decimal integer")
    if COMMIT_SHA_PATTERN.fullmatch(head_sha) is None:
        raise ValueError("Lock refresh head SHA must be a 40-character lowercase hexadecimal SHA")
    if DEPENDABOT_UV_REF_PATTERN.fullmatch(head_ref) is None:
        raise ValueError("Lock refresh head ref must be a dependabot/uv branch name")
    if ".." in head_ref or "//" in head_ref or head_ref.endswith((".", "/")):
        raise ValueError("Lock refresh head ref must be a valid Git branch name")
    if any(part.startswith(".") or part.endswith(".") for part in head_ref.split("/")):
        raise ValueError("Lock refresh head ref must be a valid Git branch name")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Workflow helper commands")
    subparsers = parser.add_subparsers(dest="command", required=True)

    artifact_parser = subparsers.add_parser(
        "validate-lock-artifact", help="Validate a downloaded lock refresh artifact"
    )
    artifact_parser.add_argument("--root", required=True)

    context_parser = subparsers.add_parser(
        "validate-lock-context", help="Validate trusted lock refresh workflow context"
    )
    context_parser.add_argument("--pr-number", required=True)
    context_parser.add_argument("--head-sha", required=True)
    context_parser.add_argument("--head-ref", required=True)

    return parser


def _handle_validate_lock_artifact(args: argparse.Namespace) -> int:
    """Validate a downloaded lock refresh artifact tree."""
    validate_lock_refresh_artifact(Path(args.root))
    return 0


def _handle_validate_lock_context(args: argparse.Namespace) -> int:
    """Validate trusted workflow-run values for a lockfile writeback."""
    validate_lock_refresh_context(args.pr_number, args.head_sha, args.head_ref)
    return 0


COMMAND_HANDLERS = {
    "validate-lock-artifact": _handle_validate_lock_artifact,
    "validate-lock-context": _handle_validate_lock_context,
}


def main(argv: list[str] | None = None) -> int:
    """Run a workflow helper command."""
    args = _build_parser().parse_args(argv)
    handler = COMMAND_HANDLERS[args.command]
    return handler(args)


if __name__ == "__main__":  # pragma: no cover
    try:
        raise SystemExit(main())
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1) from exc
