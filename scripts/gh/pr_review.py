"""Pull-request review-thread operations built on the GraphQL API.

The listing prints each thread's node id (``PRRT_…``), and replies/resolves key
off that id via ``addPullRequestReviewThreadReply`` and ``resolveReviewThread``.
This avoids the extra lookup the old REST flow needed to turn a thread into a
numeric comment ``databaseId``.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Any

from . import gh_runner
from .gh_runner import GhError, RunFunction

_THREADS_QUERY = """
query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          path
          line
          comments(first: 1) {
            nodes { body url author { login } }
          }
        }
      }
    }
  }
}
"""

_REPLY_MUTATION = """
mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(
    input: { pullRequestReviewThreadId: $thread, body: $body }
  ) {
    comment { url }
  }
}
"""

_RESOLVE_MUTATION = """
mutation($thread: ID!) {
  resolveReviewThread(input: { threadId: $thread }) {
    thread { id isResolved }
  }
}
"""


@dataclass(frozen=True)
class ReviewThread:
    """One review thread on a pull request."""

    thread_id: str
    state: str
    path: str
    line: int | None
    author: str
    body: str
    url: str


def parse_threads(data: Any) -> list[ReviewThread]:
    """Convert a GraphQL ``reviewThreads`` payload into ``ReviewThread`` objects.

    Raises:
        GhError: If the payload has no repository or pull request. An invalid or
            inaccessible PR returns ``pullRequest: null`` (with no ``errors``
            array), which would otherwise surface as an opaque ``TypeError``.
    """
    repository = data.get("repository") if isinstance(data, dict) else None
    pull_request = repository.get("pullRequest") if isinstance(repository, dict) else None
    if not isinstance(pull_request, dict):
        raise GhError("No pull request in GraphQL response (invalid or inaccessible PR?).")
    nodes = pull_request["reviewThreads"]["nodes"]
    threads: list[ReviewThread] = []
    for node in nodes:
        comments = node.get("comments", {}).get("nodes", [])
        first = comments[0] if comments else {}
        author = first.get("author") or {}
        threads.append(
            ReviewThread(
                thread_id=str(node["id"]),
                state="resolved" if node.get("isResolved") else "open",
                path=str(node.get("path") or ""),
                line=node.get("line"),
                author=str(author.get("login") or "unknown"),
                body=str(first.get("body") or ""),
                url=str(first.get("url") or ""),
            )
        )
    return threads


def list_threads(
    pr: int | None = None,
    *,
    include_resolved: bool = False,
    run_fn: RunFunction | None = None,
) -> list[ReviewThread]:
    """Return the review threads for ``pr`` (auto-detected when omitted)."""
    owner, name = _owner_name(run_fn=run_fn)
    pr = pr if pr is not None else gh_runner.current_pr_number(run_fn=run_fn)
    data = gh_runner.graphql(
        _THREADS_QUERY,
        variables={"owner": owner, "name": name, "pr": pr},
        run_fn=run_fn,
    )
    threads = parse_threads(data)
    if include_resolved:
        return threads
    return [thread for thread in threads if thread.state == "open"]


def reply_to_thread(thread_id: str, body: str, *, run_fn: RunFunction | None = None) -> None:
    """Reply to a review thread by its node id.

    Posting a reply is not idempotent, so it does not auto-retry: a lost
    response after a successful write would otherwise double-post the comment.
    """
    gh_runner.graphql(
        _REPLY_MUTATION,
        variables={"thread": thread_id, "body": body},
        run_fn=run_fn,
        retries=0,
    )


def resolve_thread(thread_id: str, *, run_fn: RunFunction | None = None) -> None:
    """Resolve a review thread by its node id (idempotent, so retries apply)."""
    gh_runner.graphql(
        _RESOLVE_MUTATION,
        variables={"thread": thread_id},
        run_fn=run_fn,
    )


def address_thread(thread_id: str, body: str, *, run_fn: RunFunction | None = None) -> None:
    """Reply to a review thread and then resolve it, in that order."""
    reply_to_thread(thread_id, body, run_fn=run_fn)
    resolve_thread(thread_id, run_fn=run_fn)


def format_threads(threads: list[ReviewThread]) -> str:
    """Render threads as stable, greppable, one-block-per-thread text."""
    if not threads:
        return "No matching review threads."
    blocks: list[str] = []
    for thread in threads:
        location = thread.path or "(no path)"
        if thread.line is not None:
            location = f"{location}:{thread.line}"
        first_line = thread.body.splitlines()[0] if thread.body else ""
        blocks.append(
            f"thread={thread.thread_id}  state={thread.state}  path={location}\n"
            f"  @{thread.author}: {first_line}"
        )
    return "\n".join(blocks)


def pr_summary(pr: int | None = None, *, run_fn: RunFunction | None = None) -> str:
    """Return a one-screen overview: PR meta, CI rollup, and open threads."""
    pr = pr if pr is not None else gh_runner.current_pr_number(run_fn=run_fn)
    meta = gh_runner.gh_json(
        ["pr", "view", str(pr), "--json", "number,title,state,url,statusCheckRollup"],
        run_fn=run_fn,
    )
    open_threads = list_threads(pr, include_resolved=False, run_fn=run_fn)
    lines = [
        f"PR #{meta.get('number')} [{meta.get('state')}] {meta.get('title')}",
        f"  {meta.get('url')}",
        f"  checks: {_rollup_summary(meta.get('statusCheckRollup') or [])}",
        f"  open review threads: {len(open_threads)}",
    ]
    if open_threads:
        lines.append("")
        lines.append(format_threads(open_threads))
    return "\n".join(lines)


def _rollup_summary(rollup: list[dict[str, Any]]) -> str:
    """Summarize a ``statusCheckRollup`` list as a conclusion tally."""
    if not rollup:
        return "none"
    counts: Counter[str] = Counter()
    for check in rollup:
        outcome = check.get("conclusion") or check.get("state") or "PENDING"
        counts[str(outcome).lower()] += 1
    return ", ".join(f"{count} {label}" for label, count in sorted(counts.items()))


def _owner_name(*, run_fn: RunFunction | None = None) -> tuple[str, str]:
    """Return the ``(owner, name)`` pair for the current repository."""
    slug = gh_runner.resolve_repo(run_fn=run_fn)
    owner, name = slug.split("/", 1)
    if not owner or not name:
        raise GhError(f"Invalid repository slug: {slug}")
    return owner, name
