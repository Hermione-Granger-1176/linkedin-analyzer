"""Tests for the shared GitHub CLI failure and retry policy."""

from __future__ import annotations

import pytest
from scripts.lib import gh_policy


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ("You have exceeded a secondary rate limit", "rate_limit"),
        ("Service unavailable (HTTP 503)", "transient"),
        ("Resource not accessible by integration (HTTP 403)", "forbidden"),
        ("Not Found (HTTP 404)", "fatal"),
        ("HTTP 502: Bad Gateway", "transient"),
        ("502 Bad Gateway", "transient"),
        ("504 Gateway Time-out", "transient"),
    ],
)
def test_classify_gh_failure_covers_each_shared_outcome(message: str, expected: str) -> None:
    """The ordered shared rules classify each supported GitHub failure kind."""
    assert gh_policy.classify_gh_failure(message) == expected


@pytest.mark.parametrize(
    "message",
    [
        "fatal: bad object 502abc1",
        "error: parse failure at line 503, column 12",
        "Validation failed: body is limited to 504 characters",
        "Not Found (HTTP 404): run 5021 does not exist",
    ],
)
def test_classify_gh_failure_does_not_retry_bare_5xx_lookalikes(message: str) -> None:
    """Digits that merely resemble a 5xx status stay fatal instead of being retried."""
    assert gh_policy.classify_gh_failure(message) == "fatal"


def test_rate_limit_rule_wins_when_message_mentions_http_403() -> None:
    """A rate limit remains fail-fast even when GitHub returns it as a 403."""
    assert gh_policy.classify_gh_failure("API rate limit exceeded (HTTP 403)") == "rate_limit"


def test_retry_backoff_seconds_is_exponential_jittered_and_capped() -> None:
    """The shared backoff has deterministic bounds when its random seam is injected."""
    assert gh_policy.DEFAULT_GH_RETRIES == 2
    assert gh_policy.retry_backoff_seconds(0, random_fn=lambda: 0) == 0.5
    assert gh_policy.retry_backoff_seconds(1, random_fn=lambda: 1) == 1.5
    assert (
        gh_policy.retry_backoff_seconds(10, random_fn=lambda: 1)
        == gh_policy.RETRY_BACKOFF_CAP_SECONDS
    )
