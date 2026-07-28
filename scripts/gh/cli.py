"""Command-line dispatcher for the GitHub PR/CI helpers.

Run as ``python -m scripts.gh.cli <command>``. The Makefile wraps each command
in a thin target, and ``<command> --help`` documents its options, so an agent
can discover the full surface without re-deriving any ``gh`` plumbing.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

from . import ci_status, commit_message, issues, pr_review, pr_watch
from .gh_runner import GhError


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gh-helper", description="GitHub pull-request and CI helper commands"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list", help="List pull-request review threads")
    list_parser.add_argument("--pr", type=int, help="PR number (default: current branch)")
    list_parser.add_argument(
        "--all", action="store_true", dest="include_resolved", help="Include resolved threads"
    )
    list_parser.add_argument(
        "--json", action="store_true", dest="as_json", help="Emit machine-readable JSON"
    )

    reply_parser = subparsers.add_parser("reply", help="Reply to a review thread by id")
    reply_parser.add_argument("--thread", required=True, help="Thread id (PRRT_...)")
    reply_parser.add_argument("--body", required=True, help="Reply text")

    resolve_parser = subparsers.add_parser("resolve", help="Resolve a review thread by id")
    resolve_parser.add_argument("--thread", required=True, help="Thread id (PRRT_...)")

    address_parser = subparsers.add_parser(
        "address", help="Reply to and resolve a review thread in one step"
    )
    address_parser.add_argument("--thread", required=True, help="Thread id (PRRT_...)")
    address_parser.add_argument("--body", required=True, help="Reply text")

    list_comments_parser = subparsers.add_parser(
        "list-comments", help="List individual review comments with node ids"
    )
    list_comments_parser.add_argument("--pr", type=int, help="PR number (default: current branch)")
    list_comments_parser.add_argument(
        "--json", action="store_true", dest="as_json", help="Emit machine-readable JSON"
    )

    delete_comment_parser = subparsers.add_parser(
        "delete-comment", help="Delete a review comment by its node id"
    )
    delete_comment_parser.add_argument(
        "--comment", required=True, help="Comment node id (PRRC_...)"
    )

    copilot_parser = subparsers.add_parser(
        "copilot-review", help="Request a Copilot code review on the PR"
    )
    copilot_parser.add_argument("--pr", type=int, help="PR number (default: current branch)")

    summary_parser = subparsers.add_parser("summary", help="One-screen PR overview")
    summary_parser.add_argument("--pr", type=int, help="PR number (default: current branch)")

    issue_summary_parser = subparsers.add_parser("issue-summary", help="One-screen issue overview")
    issue_summary_parser.add_argument("--issue", type=int, required=True, help="Issue number")

    check_commit_parser = subparsers.add_parser(
        "check-commit-message",
        help="Reject a commit message that leaked shell text (heredoc fragments)",
    )
    check_commit_parser.add_argument(
        "--message-file",
        required=True,
        help="Path to the commit message (- reads stdin)",
    )

    watch_parser = subparsers.add_parser(
        "watch",
        help="Request and wait for a fresh Copilot review and successful checks",
    )
    watch_parser.add_argument("--pr", type=int, help="PR number (default: current branch)")
    watch_parser.add_argument(
        "--interval",
        type=float,
        default=45.0,
        help="Poll interval in seconds",
    )
    watch_parser.add_argument(
        "--max-polls",
        type=int,
        default=40,
        help="Maximum poll count",
    )
    watch_parser.add_argument(
        "--expected-checks",
        type=int,
        default=15,
        help="Minimum expected check count",
    )
    watch_parser.add_argument(
        "--checks-only",
        action="store_true",
        help="Wait for checks without requesting a Copilot review",
    )

    ci_parser = subparsers.add_parser(
        "ci-failures", help="Show failed-step logs for the latest run"
    )
    ci_parser.add_argument("--run", type=int, help="Run id (default: latest for this branch)")

    return parser


def _handle_list(args: argparse.Namespace) -> int:
    """List review threads as text or JSON."""
    threads = pr_review.list_threads(args.pr, include_resolved=args.include_resolved)
    if args.as_json:
        print(json.dumps([asdict(thread) for thread in threads]))
    else:
        print(pr_review.format_threads(threads))
    return 0


def _handle_reply(args: argparse.Namespace) -> int:
    """Reply to a single review thread."""
    pr_review.reply_to_thread(args.thread, args.body)
    print(f"Replied to {args.thread}")
    return 0


def _handle_resolve(args: argparse.Namespace) -> int:
    """Resolve a single review thread."""
    pr_review.resolve_thread(args.thread)
    print(f"Resolved {args.thread}")
    return 0


def _handle_address(args: argparse.Namespace) -> int:
    """Reply to and resolve a single review thread."""
    pr_review.address_thread(args.thread, args.body)
    print(f"Replied to and resolved {args.thread}")
    return 0


def _handle_list_comments(args: argparse.Namespace) -> int:
    """List individual review comments as text or JSON."""
    comments = pr_review.list_comments(args.pr)
    if args.as_json:
        print(json.dumps([asdict(comment) for comment in comments]))
    else:
        print(pr_review.format_comments(comments))
    return 0


def _handle_delete_comment(args: argparse.Namespace) -> int:
    """Delete a single review comment by node id."""
    pr_review.delete_review_comment(args.comment)
    print(f"Deleted {args.comment}")
    return 0


def _handle_copilot_review(args: argparse.Namespace) -> int:
    """Request a Copilot code review on the PR."""
    pr_review.request_copilot_review(args.pr)
    print("Requested Copilot review")
    return 0


def _handle_summary(args: argparse.Namespace) -> int:
    """Print the PR overview."""
    print(pr_review.pr_summary(args.pr))
    return 0


def _handle_issue_summary(args: argparse.Namespace) -> int:
    """Print the issue overview."""
    print(issues.issue_summary(args.issue))
    return 0


def _handle_check_commit_message(args: argparse.Namespace) -> int:
    """Validate a commit message and reject leaked shell fragments.

    The ``ValueError`` from the validator is re-raised as a ``GhError`` so the
    module entry point prints it as a plain message and exits non-zero, the same
    way every other command reports a refusal.
    """
    if args.message_file == "-":
        message = sys.stdin.read()
    else:
        try:
            message = Path(args.message_file).read_text(encoding="utf-8")
        except OSError as exc:
            raise GhError(f"Could not read --message-file {args.message_file}: {exc}") from exc
    try:
        commit_message.validate_commit_message(message)
    except ValueError as exc:
        raise GhError(str(exc)) from exc
    return 0


def _handle_watch(args: argparse.Namespace) -> int:
    """Request and wait for the latest complete PR review state."""
    print(
        pr_watch.watch_pr(
            args.pr,
            interval=args.interval,
            max_polls=args.max_polls,
            expected_checks=args.expected_checks,
            checks_only=args.checks_only,
        )
    )
    return 0


def _handle_ci_failures(args: argparse.Namespace) -> int:
    """Print failed-step logs for a run."""
    print(ci_status.failure_digest(args.run))
    return 0


COMMAND_HANDLERS = {
    "list": _handle_list,
    "reply": _handle_reply,
    "resolve": _handle_resolve,
    "address": _handle_address,
    "list-comments": _handle_list_comments,
    "delete-comment": _handle_delete_comment,
    "copilot-review": _handle_copilot_review,
    "summary": _handle_summary,
    "issue-summary": _handle_issue_summary,
    "check-commit-message": _handle_check_commit_message,
    "watch": _handle_watch,
    "ci-failures": _handle_ci_failures,
}


def main(argv: list[str] | None = None) -> int:
    """Run a GitHub helper command."""
    args = _build_parser().parse_args(argv)
    handler = COMMAND_HANDLERS[args.command]
    return handler(args)


if __name__ == "__main__":  # pragma: no cover
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError) as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1) from exc
