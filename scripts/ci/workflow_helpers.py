#!/usr/bin/env python3
"""Small, tested helpers for GitHub Actions workflows.

The workflow shell should stay thin: trust-boundary decisions and downloaded
artifact validation live here so automated writebacks can be reused safely.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

LOCK_ARTIFACT_FILES = {
    "pr-number": Path(".artifacts/pr-number.txt"),
    "head-sha": Path(".artifacts/head-sha.txt"),
    "head-ref": Path(".artifacts/head-ref.txt"),
}
LOCK_ARTIFACT_REQUIRED_FILES = {
    "uv-lock": Path("uv.lock"),
    **LOCK_ARTIFACT_FILES,
}


def reject_symlinks(root: Path) -> None:
    """Reject any symlink inside an artifact tree before copying files out."""
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


def read_lock_refresh_metadata(root: Path) -> dict[str, str]:
    """Read lock-refresh metadata values from a downloaded artifact tree."""
    validate_lock_refresh_artifact(root)
    return {
        key: (root / relative_path).read_text(encoding="utf-8").strip()
        for key, relative_path in LOCK_ARTIFACT_FILES.items()
    }


def validate_lock_refresh_artifact(root: Path) -> None:
    """Validate a downloaded Python lock-refresh artifact tree."""
    reject_symlinks(root)

    for relative_path in LOCK_ARTIFACT_REQUIRED_FILES.values():
        path = root / relative_path
        if not path.is_file():
            raise ValueError(f"Required artifact file missing or not a regular file: {path}")

    allowed_files = set(LOCK_ARTIFACT_REQUIRED_FILES.values())
    unexpected = sorted(_artifact_files(root) - allowed_files)
    if unexpected:
        formatted = ", ".join(path.as_posix() for path in unexpected)
        raise ValueError(f"Unexpected file(s) in lock artifact: {formatted}")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Workflow helper commands")
    subparsers = parser.add_subparsers(dest="command", required=True)

    metadata_parser = subparsers.add_parser(
        "read-lock-metadata", help="Read lock refresh metadata from an artifact tree"
    )
    metadata_parser.add_argument("--root", required=True)

    artifact_parser = subparsers.add_parser(
        "validate-lock-artifact", help="Validate a downloaded lock refresh artifact"
    )
    artifact_parser.add_argument("--root", required=True)

    return parser


def _handle_read_lock_metadata(args: argparse.Namespace) -> int:
    """Print lock refresh metadata as JSON."""
    print(json.dumps(read_lock_refresh_metadata(Path(args.root)), sort_keys=True))
    return 0


def _handle_validate_lock_artifact(args: argparse.Namespace) -> int:
    """Validate a downloaded lock refresh artifact tree."""
    validate_lock_refresh_artifact(Path(args.root))
    return 0


COMMAND_HANDLERS = {
    "read-lock-metadata": _handle_read_lock_metadata,
    "validate-lock-artifact": _handle_validate_lock_artifact,
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
