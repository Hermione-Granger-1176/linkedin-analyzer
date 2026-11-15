"""Shared failure classification and retry backoff for GitHub CLI calls.

Every ``gh`` wrapper uses the same rules: rate limits fail fast, transient
infrastructure failures retry, and all other errors are final. A blocked GraphQL
endpoint has its own failure kind, so interactive wrappers switch to REST instead
of retrying. ``scripts.gh.gh_runner`` uses this module, and CI workflow helpers
can use it for a ``gh api`` wrapper.
"""

from __future__ import annotations

import random
import re
from collections.abc import Callable
from typing import Literal

GhFailureKind = Literal["graphql_unavailable", "rate_limit", "transient", "forbidden", "fatal"]
RandomFunction = Callable[[], float]

# Rules are checked in order. A blocked GraphQL endpoint returns HTTP 403 with
# text that names the REST routes to use, so the GraphQL rule matches that text
# first. A rate-limit message can also mention HTTP 403, so the rate-limit rule
# matches before the forbidden rule.
GH_FAILURE_CLASSIFIERS: tuple[tuple[GhFailureKind, re.Pattern[str]], ...] = (
    ("graphql_unavailable", re.compile(r"GraphQL is not available", re.IGNORECASE)),
    (
        "rate_limit",
        re.compile(
            # 429 matches only in its HTTP-anchored forms, like the server codes
            # below. A bare 429 also appears in run and line numbers.
            r"rate limit|submitted too quickly|abuse detection|secondary rate|"
            r"\bHTTP 429\b|\b429 too many requests\b",
            re.IGNORECASE,
        ),
    ),
    (
        "transient",
        re.compile(
            # Retries 500, 502, 503, and 504, which GitHub returns for overloaded
            # or proxy-layer failures. 501 is not retried. Status codes match only
            # when the message marks them as an HTTP status or pairs them with
            # their reason phrase, so bare numbers in line numbers, object ids, and
            # byte counts do not match.
            r"\bHTTP 50[0234]\b|"
            r"\b50[0234] (?:internal server error|bad gateway|"
            r"service unavailable|gateway time-?out)\b|"
            r"timed out|timeout|ECONNRESET|connection reset|"
            r"connection refused|could not resolve host|no such host|network|"
            r"tls handshake|i/o timeout|temporary failure|unexpected eof",
            re.IGNORECASE,
        ),
    ),
    ("forbidden", re.compile(r"Resource not accessible by integration", re.IGNORECASE)),
)

# Idempotent GitHub calls get two retries. The delay grows exponentially and
# includes bounded jitter. The first retry waits at least one second.
DEFAULT_GH_RETRIES = 2
RETRY_BACKOFF_BASE_SECONDS = 1.0
RETRY_BACKOFF_CAP_SECONDS = 8.0
RETRY_BACKOFF_JITTER_SECONDS = 0.5


def classify_gh_failure(message: str) -> GhFailureKind:
    """Classify a GitHub CLI failure.

    The kinds are GraphQL-unavailable, rate-limited, transient, forbidden, or fatal.
    """
    for kind, pattern in GH_FAILURE_CLASSIFIERS:
        if pattern.search(message):
            return kind
    return "fatal"


def retry_backoff_seconds(attempt: int, *, random_fn: RandomFunction = random.random) -> float:
    """Return a capped exponential retry delay for a zero-based retry ``attempt``."""
    delay = RETRY_BACKOFF_BASE_SECONDS * (2.0**attempt)
    return min(RETRY_BACKOFF_CAP_SECONDS, delay + random_fn() * RETRY_BACKOFF_JITTER_SECONDS)
