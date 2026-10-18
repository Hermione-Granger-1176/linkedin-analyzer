"""Dispatch the GitHub PR and CI helper commands used by Make targets.

Use ``make help-pr`` and ``make help-actions`` to find the supported commands.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

from . import ci_status, commit_message, issues, pr_review, pr_watch
from .gh_runner import GhError


def _add_body_options(parser: argparse.ArgumentParser, *, required: bool = True) -> None:
    """Add the shared body options (reply, comment, or PR body) to a subcommand parser.

    Free text reaches these commands through a file wherever it can be long or
    multi-line, so the Makefile never has to interpolate it into a recipe.
    """
    body_group = parser.add_mutually_exclusive_group(required=required)
    body_group.add_argument("--body", help="Body text")
    body_group.add_argument(
        "--body-file", help="Path to a file containing the body text (- reads stdin)"
    )


def _add_pr_option(parser: argparse.ArgumentParser) -> None:
    """Add ``--pr``, which defaults to the PR for the current branch."""
    parser.add_argument("--pr", type=int, help="PR number (default: current branch)")


def _add_thread_option(parser: argparse.ArgumentParser) -> None:
    """Add the required ``--thread`` id of a review thread."""
    parser.add_argument("--thread", required=True, help="Thread id (PRRT_...)")


def _add_json_option(parser: argparse.ArgumentParser) -> None:
    """Add ``--json``, which switches the output to machine-readable JSON."""
    parser.add_argument(
        "--json", action="store_true", dest="as_json", help="Emit machine-readable JSON"
    )


def _add_watch_options(parser: argparse.ArgumentParser) -> None:
    """Add the polling and Copilot options of the ``watch`` command."""
    _add_pr_option(parser)
    parser.add_argument("--interval", type=float, default=45.0, help="Poll interval in seconds")
    parser.add_argument("--max-polls", type=int, default=40, help="Maximum poll count")
    parser.add_argument(
        "--expected-checks",
        type=int,
        default=pr_watch.DEFAULT_EXPECTED_CHECKS,
        help="Minimum expected check count",
    )
    parser.add_argument(
        "--checks-only",
        action="store_true",
        help="Wait for checks without waiting for a Copilot review",
    )
    parser.add_argument(
        "--request-copilot",
        action="store_true",
        help="Request Copilot after capturing the review baseline",
    )


def _read_text_option(path: str, option: str) -> str:
    """Return the text in ``path``, or stdin when ``path`` is ``-``.

    Raises:
        GhError: If the file cannot be read. The message names ``option``.
    """
    if path == "-":
        return sys.stdin.read()
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise GhError(f"Could not read {option} {path}: {exc}") from exc


def _body_text(args: argparse.Namespace) -> str:
    """Return the body text from ``--body`` or ``--body-file`` (``-`` reads stdin).

    Raises:
        GhError: If the file cannot be read, or if neither option was supplied.
            Only commands that make the body optional can reach the second case,
            and they must forward the raw values rather than call this.
    """
    if args.body_file is not None:
        return _read_text_option(args.body_file, "--body-file")
    if args.body is None:
        raise GhError("Provide a body with --body or --body-file.")
    return str(args.body)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gh-helper", description="GitHub pull-request and CI helper commands"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list", help="List pull-request review threads")
    _add_pr_option(list_parser)
    list_parser.add_argument(
        "--all", action="store_true", dest="include_resolved", help="Include resolved threads"
    )
    _add_json_option(list_parser)

    reply_parser = subparsers.add_parser("reply", help="Reply to a review thread by id")
    _add_thread_option(reply_parser)
    _add_body_options(reply_parser)

    resolve_parser = subparsers.add_parser("resolve", help="Resolve a review thread by id")
    _add_thread_option(resolve_parser)

    address_parser = subparsers.add_parser(
        "address", help="Reply to and resolve a review thread in one step"
    )
    _add_thread_option(address_parser)
    _add_body_options(address_parser)

    list_comments_parser = subparsers.add_parser(
        "list-comments", help="List individual review comments with node ids"
    )
    _add_pr_option(list_comments_parser)
    _add_json_option(list_comments_parser)

    delete_comment_parser = subparsers.add_parser(
        "delete-comment", help="Delete a review comment by its node id"
    )
    delete_comment_parser.add_argument(
        "--comment", required=True, help="Comment node id (PRRC_...)"
    )

    comment_parser = subparsers.add_parser("comment", help="Add a PR-level comment")
    _add_pr_option(comment_parser)
    _add_body_options(comment_parser)

    edit_pr_parser = subparsers.add_parser("edit-pr", help="Edit a PR title and/or body")
    _add_pr_option(edit_pr_parser)
    edit_pr_parser.add_argument("--title", help="New PR title")
    _add_body_options(edit_pr_parser, required=False)

    copilot_parser = subparsers.add_parser(
        "copilot-review", help="Request a Copilot code review on the PR"
    )
    _add_pr_option(copilot_parser)

    summary_parser = subparsers.add_parser("summary", help="One-screen PR overview")
    _add_pr_option(summary_parser)

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
        help="Observe the Copilot review and successful checks",
    )
    _add_watch_options(watch_parser)

    ci_parser = subparsers.add_parser(
        "ci-failures", help="Show failed-step logs for the latest run"
    )
    ci_parser.add_argument("--run", type=int, help="Run id (default: latest for this branch)")

    subparsers.add_parser(
        "latest-run-id", help="Print the latest workflow run id for the current branch"
    )

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
    pr_review.reply_to_thread(args.thread, _body_text(args))
    print(f"Replied to {args.thread}")
    return 0


def _handle_resolve(args: argparse.Namespace) -> int:
    """Resolve a single review thread."""
    pr_review.resolve_thread(args.thread)
    print(f"Resolved {args.thread}")
    return 0


def _handle_address(args: argparse.Namespace) -> int:
    """Reply to and resolve a single review thread."""
    pr_review.address_thread(args.thread, _body_text(args))
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


def _handle_comment(args: argparse.Namespace) -> int:
    """Post a PR-level comment."""
    pr_review.comment_on_pr(args.pr, _body_text(args))
    print("Commented on the PR")
    return 0


def _handle_edit_pr(args: argparse.Namespace) -> int:
    """Edit a pull request's title, body, or both.

    Forward the body file to ``gh pr edit --body-file`` so large bodies do not need
    to fit in the argument list.
    """
    pr_review.edit_pr(args.pr, title=args.title, body=args.body, body_file=args.body_file)
    print("Edited the PR")
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
    message = _read_text_option(args.message_file, "--message-file")
    try:
        commit_message.validate_commit_message(message)
    except ValueError as exc:
        raise GhError(str(exc)) from exc
    return 0


def _handle_watch(args: argparse.Namespace) -> int:
    """Wait for the latest complete PR review state."""
    print(
        pr_watch.watch_pr(
            args.pr,
            interval=args.interval,
            max_polls=args.max_polls,
            expected_checks=args.expected_checks,
            checks_only=args.checks_only,
            request_copilot=args.request_copilot,
        )
    )
    return 0


def _handle_ci_failures(args: argparse.Namespace) -> int:
    """Print failed-step logs for a run."""
    print(ci_status.failure_digest(args.run))
    return 0


def _handle_latest_run_id(_args: argparse.Namespace) -> int:
    """Print the latest workflow run id for the current branch."""
    print(ci_status.latest_run().run_id)
    return 0


COMMAND_HANDLERS = {
    "list": _handle_list,
    "reply": _handle_reply,
    "resolve": _handle_resolve,
    "address": _handle_address,
    "list-comments": _handle_list_comments,
    "delete-comment": _handle_delete_comment,
    "comment": _handle_comment,
    "edit-pr": _handle_edit_pr,
    "copilot-review": _handle_copilot_review,
    "summary": _handle_summary,
    "issue-summary": _handle_issue_summary,
    "check-commit-message": _handle_check_commit_message,
    "watch": _handle_watch,
    "ci-failures": _handle_ci_failures,
    "latest-run-id": _handle_latest_run_id,
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
