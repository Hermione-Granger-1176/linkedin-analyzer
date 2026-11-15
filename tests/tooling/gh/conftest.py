"""Shared fixtures for the ``scripts.gh`` test suite."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from scripts.gh import gh_runner

if TYPE_CHECKING:
    from collections.abc import Iterator


@pytest.fixture(autouse=True)
def _fresh_graphql_verdict() -> Iterator[None]:
    """Reset the process-wide GraphQL availability before and after each test."""
    gh_runner.reset_graphql_availability()
    yield
    gh_runner.reset_graphql_availability()


@pytest.fixture(autouse=True)
def _no_repo_override(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unset GH_REPO so the shell environment does not redirect test calls."""
    monkeypatch.delenv("GH_REPO", raising=False)
