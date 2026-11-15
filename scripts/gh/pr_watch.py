"""Conservatively watch PR checks and an optionally requested Copilot review."""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

from . import gh_runner, pr_rest, pr_review
from .gh_runner import GhError, RunFunction

if TYPE_CHECKING:
    from collections.abc import Callable

_COPILOT_LOGIN = "copilot-pull-request-reviewer"
# Fields read from ``gh pr view --json``, and from the REST fallback in the same shape.
_WATCH_FIELDS = "statusCheckRollup,reviews"
_PENDING_STATES = {"EXPECTED", "PENDING"}
_SUCCESSFUL_CHECK_OUTCOMES = {"NEUTRAL", "SKIPPED", "SUCCESS"}
# A floor on how many checks must exist before a rollup can settle. It is not a
# prediction of the total. ``watch_pr`` establishes completeness by observing the
# check set repeat across consecutive settled polls, so this only rules out
# settling against an empty rollup.
DEFAULT_EXPECTED_CHECKS = 1

# Delay before re-reading when only the check-set stability confirmation is
# outstanding. It is a confirmation read, not a wait for work to finish.
CONFIRM_DELAY_SECONDS = 5.0
# Copilot writes "generated no comments" on a first review and "generated no new
# comments" on a re-review, so "new" is optional in the pattern.
_COMMENT_COUNT_PATTERN = re.compile(
    r"\bgenerated (?:(no(?: new)?)|(\d+)) comments?\b",
    re.IGNORECASE,
)
# Copilot's v2 overview omits the "generated N comments" sentence. It opens with a
# verdict heading such as "### 🟢 Approval recommended" and puts its detail in
# collapsible sections. Two layouts are recognized:
#
# - Older layout: a "## Copilot review overview" heading above the verdict, a
#   "**Findings:** None" line when clean, sections headed "<Label> (N)", and open
#   findings linked as "(#discussion_r<id>)".
# - Current layout: no "##" heading, a "**No open issues**" line when clean, sections
#   headed "N <label>" such as "1 open issue", full thread URLs ending in
#   "#discussion_r<id>", and an uncounted "What changed in this PR" section.
#
# An open section links each finding still open, including ones from earlier
# rounds, to its thread. The "discussion_r<id>" anchor also ends the thread's URL.
#
# A clean line is not sufficient. A review can describe a finding in a
# "Previously missed (N)" section without opening a thread, so a clean review needs
# the approval verdict and no counted section other than the resolved list.
_V2_OVERVIEW_MARKER = "<!-- ccr-overview-v2 -->"
_V2_APPROVAL_VERDICT = "Approval recommended"
_V2_CLEAN_SECTIONS = frozenset({"resolved since last review"})
# The verdict is the first "###" heading of the overview. Later "###" headings do not match.
_V2_VERDICT_PATTERN = re.compile(
    re.escape(_V2_OVERVIEW_MARKER)
    + r"\s*(?:^## Copilot review overview\s*)?^### (?:\W+\s)?(.+?)\s*$",
    re.MULTILINE,
)
_V2_CLEAN_PATTERN = re.compile(
    r"^(?:\*\*Findings:\*\* None|\*\*No open issues\*\*\W*)\s*$", re.MULTILINE
)
_V2_SECTION_PATTERN = re.compile(r"<summary><strong>(.+?)</strong></summary>")
_V2_SUFFIX_COUNT_PATTERN = re.compile(r"^(.+?) \(\d+\)$")
_V2_PREFIX_COUNT_PATTERN = re.compile(r"^\d+ (.+)$")
_V2_OPEN_HEADING_PATTERN = re.compile(
    r"<summary><strong>(?:Open \((\d+)\)|(\d+) open issues?)</strong></summary>"
)
# Open items are plain list lines. The section must close before another <details>
# opens, so an unclosed section cannot match a later block's close.
_V2_OPEN_SECTION_PATTERN = re.compile(
    _V2_OPEN_HEADING_PATTERN.pattern + r"((?:(?!<details).)*?)</details>", re.DOTALL
)
_DISCUSSION_LINK_PATTERN = re.compile(r"#(discussion_r\d+)\)")


@dataclass(frozen=True)
class CopilotReview:
    """One validated Copilot pull-request review."""

    review_id: str
    submitted_at: datetime
    body: str
    generated_comment_count: int | None
    state: str = ""

    @property
    def is_v2_overview(self) -> bool:
        """Return whether the review uses Copilot's v2 overview format."""
        return _V2_OVERVIEW_MARKER in self.body

    @property
    def verdict(self) -> str:
        """Return a v2 overview's verdict heading without its emoji, or an empty string."""
        match = _V2_VERDICT_PATTERN.search(self.body)
        return "" if match is None else match.group(1)

    @property
    def open_discussions(self) -> frozenset[str]:
        """Return the thread anchors linked from a v2 overview's open section."""
        return frozenset(_open_discussion_links(self.body))

    @property
    def is_explicitly_clean(self) -> bool:
        """Return whether the review reports nothing to address.

        The review state field is not used. A first review must say "generated no
        comments", and a re-review must say "generated no new comments". A v2
        overview must recommend approval, have a "**Findings:** None" or
        "**No open issues**" line, and have no counted section other than the
        resolved list. A numeric "generated 0 comments" does not count, so
        unexpected wording fails closed.
        """
        if self.is_v2_overview:
            sections = _v2_counted_sections(self.body)
            return (
                self.verdict == _V2_APPROVAL_VERDICT
                and _V2_CLEAN_PATTERN.search(self.body) is not None
                and sections <= _V2_CLEAN_SECTIONS
            )
        match = _COMMENT_COUNT_PATTERN.search(self.body)
        return match is not None and match.group(1) is not None


@dataclass(frozen=True)
class PollStatus:
    """The current checks and fresh-review state for a pull request."""

    checks_settled: bool
    checks_successful: bool
    check_count: int
    rollup_tally: str
    fresh_review: CopilotReview | None
    check_ids: frozenset[str] = frozenset()


@dataclass(frozen=True)
class WatchBaseline:
    """Copilot review and thread ids seen before an explicit request.

    ``thread_ids`` includes resolved threads, so a thread resolved between polls
    is not counted as newly generated.
    """

    review_ids: frozenset[str]
    thread_ids: frozenset[str]


def _parse_timestamp(value: str, context: str) -> datetime:
    """Parse an ISO-8601 timestamp and require timezone information."""
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise GhError(f"{context} is not a valid ISO-8601 timestamp: {value!r}.") from exc
    if parsed.tzinfo is None:
        raise GhError(f"{context} must include timezone information: {value!r}.")
    return parsed


def _v2_counted_sections(body: str) -> set[str]:
    """Return a v2 overview's counted section labels, lowercased and without counts.

    "Resolved since last review (1)" and "1 resolved since last review" both
    become "resolved since last review". A heading without a count, such as
    "What changed in this PR", describes the change rather than findings.
    """
    labels: set[str] = set()
    for heading in _V2_SECTION_PATTERN.findall(body):
        match = _V2_SUFFIX_COUNT_PATTERN.match(heading) or _V2_PREFIX_COUNT_PATTERN.match(heading)
        if match is not None:
            labels.add(match.group(1).lower())
    return labels


def _open_discussion_links(body: str) -> list[str]:
    """Return the thread anchors linked from a v2 open section, in order."""
    section = _V2_OPEN_SECTION_PATTERN.search(body)
    return [] if section is None else _DISCUSSION_LINK_PATTERN.findall(section.group(3))


def _generated_comment_count(body: str) -> int | None:
    """Return the comment count from a Copilot overview, when recognized."""
    if _V2_OVERVIEW_MARKER in body:
        heading = _V2_OPEN_HEADING_PATTERN.search(body)
        if heading is None:
            return 0 if _V2_CLEAN_PATTERN.search(body) is not None else None
        # Each open finding must link its thread. A count without matching links,
        # or a section that never closes, returns None (unclassified).
        count = int(heading.group(1) or heading.group(2))
        complete = _V2_OPEN_SECTION_PATTERN.search(body) is not None
        return count if complete and len(set(_open_discussion_links(body))) == count else None
    match = _COMMENT_COUNT_PATTERN.search(body)
    if match is None:
        return None
    if match.group(1) is not None:
        return 0
    return int(match.group(2))


def _copilot_reviews(reviews: object) -> tuple[CopilotReview, ...]:
    """Validate and return Copilot reviews from a PR view payload."""
    if not isinstance(reviews, list):
        raise GhError("Unexpected reviews shape in PR view response.")

    parsed: list[CopilotReview] = []
    for review in reviews:
        if not isinstance(review, dict):
            raise GhError("Unexpected review entry shape in PR view response.")
        author = review.get("author")
        if author is not None and not isinstance(author, dict):
            raise GhError("Unexpected review author shape in PR view response.")
        if not isinstance(author, dict) or author.get("login") != _COPILOT_LOGIN:
            continue
        parsed.append(_parse_copilot_review(review))
    return tuple(parsed)


def _parse_copilot_review(review: dict[str, Any]) -> CopilotReview:
    """Validate the fields of one Copilot review and return it."""
    review_id = review.get("id")
    if not isinstance(review_id, str) or not review_id.strip():
        raise GhError("A Copilot review is missing a non-empty string id.")
    submitted_at = review.get("submittedAt")
    if not isinstance(submitted_at, str) or not submitted_at:
        raise GhError("A Copilot review is missing a string submittedAt.")
    body = review.get("body")
    if not isinstance(body, str):
        raise GhError("A Copilot review is missing a string body.")
    state = review.get("state")
    if not isinstance(state, str):
        raise GhError("A Copilot review is missing a string state.")
    return CopilotReview(
        review_id=review_id,
        submitted_at=_parse_timestamp(submitted_at, f"Copilot review {review_id} submittedAt"),
        body=body,
        generated_comment_count=_generated_comment_count(body),
        state=state,
    )


def _review_payload(pr: int, *, run_fn: RunFunction | None = None) -> dict[str, object]:
    """Return the validated PR fields needed by the watcher."""
    payload = gh_runner.with_rest_fallback(
        lambda: gh_runner.gh_json(["pr", "view", str(pr), "--json", _WATCH_FIELDS], run_fn=run_fn),
        lambda: pr_rest.pr_view(pr, _WATCH_FIELDS.split(","), run_fn=run_fn),
    )
    if not isinstance(payload, dict):
        raise GhError(f"Unexpected PR view response shape for PR {pr}.")
    return payload


def watch_baseline(pr: int, *, run_fn: RunFunction | None = None) -> WatchBaseline:
    """Capture existing Copilot reviews and every review thread before a request.

    Resolved threads are captured alongside open ones so that later polls only
    wait on threads the requested review actually created.
    """
    payload = _review_payload(pr, run_fn=run_fn)
    review_ids = frozenset(review.review_id for review in _copilot_reviews(payload.get("reviews")))
    thread_ids = frozenset(
        thread.thread_id
        for thread in pr_review.list_threads(pr, include_resolved=True, run_fn=run_fn)
    )
    return WatchBaseline(review_ids, thread_ids)


def _check_status(
    rollup: object,
    *,
    expected_checks: int,
) -> tuple[bool, bool, int, str, frozenset[str]]:
    """Return settled, successful, count, summary, and identities for a rollup."""
    if not isinstance(rollup, list):
        raise GhError("Unexpected statusCheckRollup shape in PR view response.")
    if expected_checks < 1:
        raise GhError("expected_checks must be at least 1.")

    outcomes: list[tuple[bool, bool]] = []
    identities: set[str] = set()
    for ordinal, entry in enumerate(rollup):
        if not isinstance(entry, dict):
            raise GhError("Unexpected check entry shape in PR view response.")
        identities.add(_check_identity(entry, ordinal))
        outcomes.append(_entry_outcome(entry))

    enough_checks = len(rollup) >= expected_checks
    return (
        enough_checks and all(finished for finished, _ in outcomes),
        enough_checks and all(succeeded for _, succeeded in outcomes),
        len(rollup),
        pr_review.rollup_summary(rollup),
        frozenset(identities),
    )


def _entry_outcome(entry: dict[str, Any]) -> tuple[bool, bool]:
    """Return whether one rollup entry has finished and whether it succeeded.

    Check runs report ``status`` and ``conclusion``. Legacy status contexts
    report ``state``. A pending entry has neither finished nor succeeded.
    """
    if "status" in entry:
        status = entry.get("status")
        if not isinstance(status, str):
            raise GhError("A check run is missing a string status.")
        if status != "COMPLETED":
            return False, False
        conclusion = entry.get("conclusion")
        if not isinstance(conclusion, str):
            raise GhError("A completed check run is missing a string conclusion.")
        return True, conclusion in _SUCCESSFUL_CHECK_OUTCOMES

    state = entry.get("state")
    if not isinstance(state, str):
        raise GhError("A status context is missing a string state.")
    if state in _PENDING_STATES:
        return False, False
    return True, state == "SUCCESS"


def _check_identity(entry: dict[str, Any], ordinal: int) -> str:
    """Return a stable identity for one rollup entry.

    Check runs carry ``name`` and status contexts carry ``context``. Anything
    without either falls back to its index in the rollup. The ordinal is the
    entry's real index, not the count of identities collected so far, so
    duplicate names cannot make unnamed entries collide.
    """
    for key in ("name", "context"):
        value = entry.get(key)
        if isinstance(value, str) and value:
            return f"{key}:{value}"
    return f"index:{ordinal}"


def poll_once(
    pr: int,
    baseline_ids: frozenset[str],
    *,
    expected_checks: int = DEFAULT_EXPECTED_CHECKS,
    checks_only: bool = False,
    run_fn: RunFunction | None = None,
) -> PollStatus:
    """Return one current poll result relative to a captured review baseline."""
    payload = _review_payload(pr, run_fn=run_fn)
    settled, successful, check_count, tally, check_ids = _check_status(
        payload.get("statusCheckRollup"),
        expected_checks=expected_checks,
    )
    reviews = _copilot_reviews(payload.get("reviews"))
    fresh_reviews = tuple(review for review in reviews if review.review_id not in baseline_ids)
    fresh_review = (
        max(
            enumerate(fresh_reviews),
            key=lambda item: (item[1].submitted_at, item[0]),
        )[1]
        if fresh_reviews
        else None
    )
    if checks_only:
        fresh_review = None
    return PollStatus(
        checks_settled=settled,
        checks_successful=successful,
        check_count=check_count,
        rollup_tally=tally,
        fresh_review=fresh_review,
        check_ids=check_ids,
    )


def _review_summary(review: CopilotReview | None, *, requested: bool) -> str:
    """Return a compact classification for the latest fresh review."""
    if review is None:
        return "no new review yet" if requested else "not requested"
    if review.generated_comment_count is None:
        return "unrecognized Copilot overview"
    if review.is_explicitly_clean:
        return "generated no comments"
    if review.is_v2_overview and review.generated_comment_count == 0:
        verdict = (review.verdict or "no verdict").lower()
        return f"{verdict} with no open threads; read the overview with `make pr-comments`"
    return f"generated {review.generated_comment_count} comment(s)"


def _watch_report(
    *,
    pr: int,
    poll_count: int,
    status: PollStatus,
    threads: list[pr_review.ReviewThread],
    requested: bool,
) -> str:
    """Render the bounded final state from a completed watch."""
    merge_ready = (
        status.checks_successful
        and status.fresh_review is not None
        and status.fresh_review.is_explicitly_clean
        and not threads
    )
    return "\n".join(
        [
            f"PR #{pr} settled after {poll_count} poll(s)",
            f"checks: {status.rollup_tally} ({status.check_count} total)",
            f"latest Copilot review: {_review_summary(status.fresh_review, requested=requested)}",
            f"open review threads: {len(threads)}",
            f"merge ready: {'yes' if merge_ready else 'no'}",
            "",
            pr_review.format_threads(threads),
        ]
    )


def _validate_watch_options(interval: float, max_polls: int, expected_checks: int) -> None:
    """Reject watch options that could never settle or would spin without waiting."""
    if interval < 0:
        raise GhError("interval must not be negative.")
    if max_polls < 1:
        raise GhError("max_polls must be at least 1.")
    if expected_checks < 1:
        raise GhError("expected_checks must be at least 1.")


def _track_rollup_stability(
    previous_check_ids: frozenset[str] | None,
    status: PollStatus,
) -> tuple[bool, frozenset[str] | None]:
    """Return whether the check set repeated, and the ids to compare on the next poll.

    Stability counts only across consecutive settled polls. Ids from an unsettled
    poll are not carried over, so the first settled poll is never stable on its
    own. Jobs gated on an earlier job may not be registered yet at that point.
    """
    if not status.checks_settled:
        return False, None
    return previous_check_ids == status.check_ids, status.check_ids


def _awaiting_review_threads(
    review: CopilotReview | None,
    all_threads: list[pr_review.ReviewThread],
    baseline_thread_ids: frozenset[str],
) -> bool:
    """Return whether threads the fresh review announced have not all arrived yet."""
    if review is not None and review.is_v2_overview and review.generated_comment_count is not None:
        # A v2 overview links the threads it lists. Wait for exactly those,
        # regardless of state, author, or age.
        anchors = {thread.url.rpartition("#")[2] for thread in all_threads}
        return not review.open_discussions <= anchors
    review_count = review.generated_comment_count if review is not None else 0
    fresh_thread_count = sum(thread.thread_id not in baseline_thread_ids for thread in all_threads)
    return review_count is not None and review_count > fresh_thread_count


def _settled_report(
    *,
    pr: int,
    poll_count: int,
    status: PollStatus,
    all_threads: list[pr_review.ReviewThread],
    requested: bool,
) -> str:
    """Render the final report once checks, review, and threads have all settled."""
    review = status.fresh_review
    if review is not None and review.generated_comment_count is None:
        raise GhError(
            "The fresh Copilot review overview could not be classified; "
            "read it with `make pr-comments` and inspect "
            "`make pr-review-comments` before merging."
        )
    return _watch_report(
        pr=pr,
        poll_count=poll_count,
        status=status,
        threads=[thread for thread in all_threads if thread.state == "open"],
        requested=requested,
    )


def watch_pr(
    pr: int | None = None,
    *,
    interval: float = 45.0,
    max_polls: int = 40,
    expected_checks: int = DEFAULT_EXPECTED_CHECKS,
    checks_only: bool = False,
    request_copilot: bool = False,
    run_fn: RunFunction | None = None,
    sleep_fn: Callable[[float], None] | None = None,
) -> str:
    """Wait for settled successful checks and the latest available Copilot review.

    The default mode observes the latest available review without changing
    reviewer state. Set ``request_copilot`` to capture a baseline and request a
    new review. With ``checks_only`` no Copilot review is requested or awaited.
    """
    _validate_watch_options(interval, max_polls, expected_checks)

    pr = gh_runner.resolve_pr_number(pr, run_fn=run_fn)
    baseline = WatchBaseline(frozenset(), frozenset())
    if request_copilot and not checks_only:
        baseline = watch_baseline(pr, run_fn=run_fn)
        pr_review.request_copilot_review(pr, run_fn=run_fn)
    sleeper = sleep_fn or time.sleep
    # GitHub registers check runs progressively, so a rollup can be briefly small
    # and entirely terminal. Success requires the check set to repeat across
    # settled polls, so completeness is established by observation rather than by
    # a fixed total.
    previous_check_ids: frozenset[str] | None = None

    for poll_count in range(1, max_polls + 1):
        status = poll_once(
            pr,
            baseline.review_ids,
            expected_checks=expected_checks,
            checks_only=checks_only,
            run_fn=run_fn,
        )
        if status.checks_settled and not status.checks_successful:
            raise GhError(f"PR #{pr} checks settled unsuccessfully: {status.rollup_tally}.")

        rollup_stable, previous_check_ids = _track_rollup_stability(previous_check_ids, status)
        checks_and_review_ready = status.checks_settled and (
            checks_only or status.fresh_review is not None
        )
        if checks_and_review_ready and rollup_stable:
            all_threads = pr_review.list_threads(pr, include_resolved=True, run_fn=run_fn)
            if not _awaiting_review_threads(status.fresh_review, all_threads, baseline.thread_ids):
                return _settled_report(
                    pr=pr,
                    poll_count=poll_count,
                    status=status,
                    all_threads=all_threads,
                    requested=not checks_only,
                )

        if poll_count < max_polls:
            # When only the stability confirmation is outstanding, re-read after the
            # short confirmation delay instead of a full interval. A late-registering
            # check gets a chance to appear before success is declared.
            confirming = checks_and_review_ready and not rollup_stable
            sleeper(min(interval, CONFIRM_DELAY_SECONDS) if confirming else interval)

    raise GhError(
        f"PR #{pr} did not settle after {max_polls} polls: "
        f"checks: {status.rollup_tally} ({status.check_count} total); "
        f"latest Copilot review: "
        f"{_review_summary(status.fresh_review, requested=not checks_only)}."
    )
