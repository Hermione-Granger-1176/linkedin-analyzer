"""Shared constants for lint scripts."""

from __future__ import annotations

SKIP_DIRECTORIES = frozenset(
    {
        ".artifacts",
        ".git",
        ".mypy_cache",
        ".playwright",
        ".pytest_cache",
        ".ruff_cache",
        ".venv",
        "__pycache__",
        "build",
        "coverage",
        "data",
        "dist",
        "htmlcov",
        "node_modules",
        "playwright-report",
        "test-results",
        "testing",
        "vendor",
    }
)
