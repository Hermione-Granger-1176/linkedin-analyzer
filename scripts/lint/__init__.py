"""Shared constants and traversal helpers for lint scripts."""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterator

SKIP_DIRECTORIES = frozenset(
    {
        ".artifacts",
        ".agents",
        ".claude",
        ".codex",
        ".eggs",
        ".git",
        ".mypy_cache",
        ".playwright",
        ".pytest_cache",
        ".ruff_cache",
        ".venv",
        "__pycache__",
        "ENV",
        "build",
        "coverage",
        "data",
        "dist",
        "env",
        "htmlcov",
        "node_modules",
        "playwright-report",
        "test-results",
        "testing",
        "venv",
        "vendor",
    }
)


def contains_symlink(path: Path, root: Path) -> bool:
    """Return whether any repository-relative path component is a symbolic link."""
    current = root
    for part in path.relative_to(root).parts:
        current /= part
        if current.is_symlink():
            return True
    return False


def iter_lint_paths(root: Path) -> Iterator[Path]:
    """Yield sorted real files without descending into ignored or symlinked trees."""
    for current_root, directory_names, file_names in os.walk(
        root,
        topdown=True,
        followlinks=False,
    ):
        current_path = Path(current_root)
        directory_names[:] = sorted(
            name
            for name in directory_names
            if name not in SKIP_DIRECTORIES and not (current_path / name).is_symlink()
        )
        for file_name in sorted(file_names):
            path = current_path / file_name
            if path.is_file() and not path.is_symlink():
                yield path
