from __future__ import annotations

import json
import subprocess
from typing import TYPE_CHECKING

import pytest
from scripts.gh import gh_runner, pr_review
from scripts.gh.gh_runner import GhError, GhRateLimitError
from scripts.lib import gh_policy

from tests.test_pr_review import completed_process

if TYPE_CHECKING:
    from collections.abc import Sequence


class SequenceRunner:
    """A fake runner that yields a fixed sequence of results or exceptions."""

    def __init__(self, outcomes: Sequence[object]) -> None:
        self.outcomes = list(outcomes)
        self.calls = 0

    def __call__(self, _cmd: Sequence[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        """Return (or raise) the next queued outcome and count the call."""
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        assert isinstance(outcome, subprocess.CompletedProcess)
        return outcome


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Replace backoff sleeps with a recorder so tests never actually wait."""
    waits: list[float] = []
    monkeypatch.setattr(gh_runner, "_sleep", waits.append)
    return waits


def test_classification_comes_from_the_shared_policy() -> None:
    """Rate-limit, transient, and fatal stderr are classified by scripts.lib.gh_policy."""
    assert gh_policy.classify_gh_failure("You have exceeded a secondary rate limit") == "rate_limit"
    assert gh_policy.classify_gh_failure("Server Error (HTTP 502)") == "transient"
    assert gh_policy.classify_gh_failure("Not Found (HTTP 404)") == "fatal"


def test_retry_budget_comes_from_the_shared_policy() -> None:
    """The runner keeps no private retry constants; the shared policy owns them."""
    assert gh_runner.DEFAULT_RETRIES == gh_policy.DEFAULT_GH_RETRIES
    assert not hasattr(gh_runner, "BACKOFF_CAP")
    assert not hasattr(gh_runner, "_classify")


def test_backoff_never_exceeds_cap() -> None:
    """Backoff stays within the shared cap at every attempt, jitter included."""
    for attempt in range(10):
        delay = gh_policy.retry_backoff_seconds(attempt)
        assert delay <= gh_policy.RETRY_BACKOFF_CAP_SECONDS


def test_run_retries_transient_then_succeeds(_no_sleep: list[float]) -> None:
    """A transient 5xx is retried with backoff until it succeeds."""
    runner = SequenceRunner(
        [
            completed_process(1, "", "Server Error (HTTP 502)"),
            completed_process(1, "", "Bad gateway (HTTP 502)"),
            completed_process(0, "ok"),
        ]
    )

    out = gh_runner.run_gh(["pr", "view"], run_fn=runner, retries=2)

    assert out == "ok"
    assert runner.calls == 3
    assert len(_no_sleep) == 2


def test_run_gives_up_after_exhausting_retries() -> None:
    """Transient failures raise GhError once retries are exhausted."""
    runner = SequenceRunner([completed_process(1, "", "(HTTP 503)")] * 3)

    with pytest.raises(GhError):
        gh_runner.run_gh(["pr", "view"], run_fn=runner, retries=2)

    assert runner.calls == 3


def test_run_fails_fast_on_rate_limit() -> None:
    """Rate limits raise GhRateLimitError without any retry."""
    runner = SequenceRunner(
        [
            completed_process(1, "", "API rate limit exceeded for user"),
            completed_process(0, "unused"),
        ]
    )

    with pytest.raises(GhRateLimitError):
        gh_runner.run_gh(["pr", "view"], run_fn=runner, retries=5)

    assert runner.calls == 1


def test_run_does_not_retry_fatal_errors() -> None:
    """A non-transient error (404) is not retried."""
    runner = SequenceRunner([completed_process(1, "", "Not Found (HTTP 404)")])

    with pytest.raises(GhError) as excinfo:
        gh_runner.run_gh(["pr", "view"], run_fn=runner, retries=3)

    assert not isinstance(excinfo.value, GhRateLimitError)
    assert runner.calls == 1


def test_run_retries_timeouts() -> None:
    """A subprocess timeout is retried within the budget."""
    runner = SequenceRunner(
        [
            subprocess.TimeoutExpired(cmd=["gh"], timeout=30),
            completed_process(0, "ok"),
        ]
    )

    out = gh_runner.run_gh(["pr", "view"], run_fn=runner, retries=1)

    assert out == "ok"
    assert runner.calls == 2


def test_run_timeout_message_after_exhaustion() -> None:
    """An exhausted timeout reports the budget in the error."""
    runner = SequenceRunner([subprocess.TimeoutExpired(cmd=["gh"], timeout=30)])

    with pytest.raises(GhError, match="timed out after 30s"):
        gh_runner.run_gh(["pr", "view"], run_fn=runner, retries=0)


def test_reply_mutation_does_not_retry() -> None:
    """A reply is non-idempotent and must not retry on a transient error."""
    runner = SequenceRunner([completed_process(1, "", "(HTTP 502)")])

    with pytest.raises(GhError):
        pr_review.reply_to_thread("PRRT_x", "hi", run_fn=runner)

    assert runner.calls == 1


def test_resolve_mutation_retries() -> None:
    """Resolving is idempotent, so a transient error is retried."""
    runner = SequenceRunner(
        [
            completed_process(1, "", "(HTTP 502)"),
            completed_process(0, '{"data": {}}'),
        ]
    )

    pr_review.resolve_thread("PRRT_x", run_fn=runner)

    assert runner.calls == 2


def test_graphql_detects_rate_limit_in_200_body() -> None:
    """A 200 response carrying a RATE_LIMITED error raises GhRateLimitError."""
    errors = [{"type": "RATE_LIMITED", "message": "API rate limit exceeded"}]
    body = json.dumps({"data": None, "errors": errors})
    runner = SequenceRunner([completed_process(0, body)])

    with pytest.raises(GhRateLimitError):
        gh_runner.graphql("query { viewer { login } }", run_fn=runner)


def test_graphql_trusts_rate_limited_type_without_marker_text() -> None:
    """A RATE_LIMITED type is honored even if the message lacks marker words."""
    errors = [{"type": "RATE_LIMITED", "message": "Please slow down."}]
    body = json.dumps({"data": None, "errors": errors})
    runner = SequenceRunner([completed_process(0, body)])

    with pytest.raises(GhRateLimitError):
        gh_runner.graphql("query { viewer { login } }", run_fn=runner)


def test_graphql_reports_other_errors_as_gh_error() -> None:
    """Non-rate-limit GraphQL errors raise a plain GhError."""
    errors = [{"type": "NOT_FOUND", "message": "Could not resolve to a node."}]
    body = json.dumps({"data": None, "errors": errors})
    runner = SequenceRunner([completed_process(0, body)])

    with pytest.raises(GhError) as excinfo:
        gh_runner.graphql("query { viewer { login } }", run_fn=runner)
    assert not isinstance(excinfo.value, GhRateLimitError)


def test_sleep_delegates_to_time_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    """The backoff indirection really sleeps when it is not stubbed out."""
    monkeypatch.undo()  # drop the autouse backoff stub for this one test
    recorded: list[float] = []
    monkeypatch.setattr(gh_runner.time, "sleep", recorded.append)

    gh_runner._sleep(1.5)

    assert recorded == [1.5]


def test_run_gh_retries_a_timeout_then_succeeds(_no_sleep: list[float]) -> None:
    """A timeout inside the retry budget is retried rather than surfaced."""
    runner = SequenceRunner([subprocess.TimeoutExpired(["gh"], 30), completed_process(0, "ok\n")])

    assert gh_runner.run_gh(["repo", "view"], run_fn=runner, retries=1) == "ok\n"
    assert runner.calls == 2
    assert _no_sleep


def test_run_gh_reports_a_missing_executable() -> None:
    """A missing gh binary names the command instead of leaking OSError."""
    runner = SequenceRunner([FileNotFoundError("gh")])

    with pytest.raises(GhError, match=r"Command not found: gh \(is it installed\?\)"):
        gh_runner.run_gh(["repo", "view"], run_fn=runner)


def test_run_gh_reports_a_spawn_failure() -> None:
    """A generic OS error is wrapped with the command label."""
    runner = SequenceRunner([OSError("permission denied")])

    with pytest.raises(GhError, match="Failed to run gh repo view: permission denied"):
        gh_runner.run_gh(["repo", "view"], run_fn=runner)


def test_gh_json_rejects_invalid_json() -> None:
    """Non-JSON stdout is reported as such."""
    runner = SequenceRunner([completed_process(0, "not json")])

    with pytest.raises(GhError, match="gh returned invalid JSON"):
        gh_runner.gh_json(["repo", "view"], run_fn=runner)


def test_graphql_rejects_a_non_mapping_response() -> None:
    """A GraphQL response that is not an object is rejected."""
    runner = SequenceRunner([completed_process(0, json.dumps(["nope"]))])

    with pytest.raises(GhError, match="Unexpected GraphQL response shape"):
        gh_runner.graphql("query {}", run_fn=runner)


def test_graphql_requires_a_data_key() -> None:
    """A response without errors but also without data is rejected."""
    runner = SequenceRunner([completed_process(0, json.dumps({"extensions": {}}))])

    with pytest.raises(GhError, match="GraphQL response missing data"):
        gh_runner.graphql("query {}", run_fn=runner)


def test_repo_from_remote_ignores_a_short_remote_path() -> None:
    """A remote URL without both an owner and a name yields no slug."""
    runner = SequenceRunner([completed_process(0, "https://github.com/solo\n")])

    assert gh_runner._repo_from_remote(run_fn=runner) == ""


def test_repo_from_remote_ignores_an_empty_remote_path() -> None:
    """A remote URL with no path at all yields no slug."""
    runner = SequenceRunner([completed_process(0, "https://github.com\n")])

    assert gh_runner._repo_from_remote(run_fn=runner) == ""


def test_current_pr_number_propagates_rate_limit_errors() -> None:
    """A rate-limit error keeps its type so callers can back off."""
    runner = SequenceRunner([completed_process(1, "", "You have exceeded a secondary rate limit")])

    with pytest.raises(GhRateLimitError):
        gh_runner.current_pr_number(run_fn=runner)


def test_current_pr_number_reports_a_missing_pull_request() -> None:
    """Gh's "no pull request" wording becomes a friendly message."""
    runner = SequenceRunner([completed_process(1, "", "no pull request found for branch")])

    with pytest.raises(GhError, match=r"No pull request found for the current branch\."):
        gh_runner.current_pr_number(run_fn=runner)


def test_current_pr_number_reraises_other_gh_errors() -> None:
    """An unrelated gh failure keeps its original message."""
    runner = SequenceRunner([completed_process(1, "", "Not Found (HTTP 404)")])

    with pytest.raises(GhError, match="Not Found"):
        gh_runner.current_pr_number(run_fn=runner)


def test_current_pr_number_rejects_an_unreadable_payload() -> None:
    """A payload without a usable number is reported."""
    runner = SequenceRunner([completed_process(0, json.dumps({"number": "abc"}))])

    with pytest.raises(GhError, match=r"Could not read PR number from gh output\."):
        gh_runner.current_pr_number(run_fn=runner)
