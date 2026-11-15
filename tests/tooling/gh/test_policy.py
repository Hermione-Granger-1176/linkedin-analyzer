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
        ("HTTP 500: Internal Server Error", "transient"),
        # 501 is classified as fatal, not transient.
        ("HTTP 501: Not Implemented", "fatal"),
        ("HTTP 429: Too Many Requests", "rate_limit"),
        ("429 Too Many Requests", "rate_limit"),
        (
            "HTTP 403: GitHub GraphQL is not available from Claude Code sessions; "
            "use the REST API (https://api.github.com/graphql)",
            "graphql_unavailable",
        ),
        # A plain 403 is fatal and does not select the REST path.
        ("HTTP 403: Forbidden", "fatal"),
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
        # A bare 429 inside other text is not a rate limit.
        "fatal: could not read object 429fe0c",
        "error: workflow run 429 was not found",
    ],
)
def test_classify_gh_failure_does_not_match_bare_status_lookalikes(message: str) -> None:
    """Digits that merely resemble an HTTP status stay fatal."""
    assert gh_policy.classify_gh_failure(message) == "fatal"


def test_rate_limit_rule_wins_when_message_mentions_http_403() -> None:
    """A rate limit message that also mentions HTTP 403 is classified as rate_limit."""
    assert gh_policy.classify_gh_failure("API rate limit exceeded (HTTP 403)") == "rate_limit"


def test_retry_backoff_seconds_is_exponential_jittered_and_capped() -> None:
    """The shared backoff has deterministic bounds when its random seam is injected."""
    assert gh_policy.DEFAULT_GH_RETRIES == 2
    # The base delay is 1.0s.
    assert gh_policy.retry_backoff_seconds(0, random_fn=lambda: 0) == 1.0
    assert gh_policy.retry_backoff_seconds(1, random_fn=lambda: 1) == 2.5
    assert (
        gh_policy.retry_backoff_seconds(10, random_fn=lambda: 1)
        == gh_policy.RETRY_BACKOFF_CAP_SECONDS
    )
