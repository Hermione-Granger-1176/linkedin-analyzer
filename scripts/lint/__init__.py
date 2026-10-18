"""Shared constants and traversal helpers for lint scripts."""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

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


def resolve_repo_files(
    raw_paths: list[str],
    root: Path,
    *,
    reject: Callable[[Path], str | None] | None = None,
) -> tuple[list[Path], list[str]]:
    """Resolve safe repository-relative file paths and return validation errors.

    ``reject`` receives each requested path as a relative ``Path`` and returns the
    reason that kind of file is not accepted, or None to accept it. It runs before
    the filesystem is touched.
    """
    resolved_paths: list[Path] = []
    errors: list[str] = []
    resolved_root = root.resolve()

    for raw in raw_paths:
        relative = Path(raw)
        if relative.is_absolute() or ".." in relative.parts:
            errors.append(f"{raw}: path must stay within the repository")
            continue
        reason = reject(relative) if reject is not None else None
        if reason is not None:
            errors.append(f"{raw}: {reason}")
            continue

        candidate = root / relative
        if contains_symlink(candidate, root):
            errors.append(f"{raw}: symbolic links are not supported")
            continue

        try:
            resolved = candidate.resolve(strict=True)
        except FileNotFoundError:
            errors.append(f"{raw}: path does not exist")
            continue
        except OSError:
            errors.append(f"{raw}: path could not be accessed")
            continue

        try:
            resolved.relative_to(resolved_root)
        except ValueError:
            errors.append(f"{raw}: path resolves outside the repository")
            continue

        if not resolved.is_file():
            errors.append(f"{raw}: path does not exist or is not a file")
            continue
        resolved_paths.append(resolved)

    return resolved_paths, errors


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
