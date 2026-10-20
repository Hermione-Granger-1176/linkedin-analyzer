"""Cover every ``scripts.gh.cli`` subcommand handler and output mode.

The handlers are thin, but they are the only place that decides which helper a
Makefile target reaches and whether it prints text or JSON. A wrong dispatch
here is invisible until someone runs the target, so each one is pinned.
"""

from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from scripts.gh import (
    ci_status,
    cli,
    gh_runner,
    issue_commands,
    issues,
    pr_commands,
    pr_review,
    pr_watch,
)
from scripts.gh.gh_runner import GhError

_THREAD = "PRRT_x"
_COMMENT = "PRRC_x"


def _thread(thread_id: str = _THREAD) -> pr_review.ReviewThread:
    """Build one review thread."""
    return pr_review.ReviewThread(
        thread_id,
        "open",
        "scripts/gh/cli.py",
        7,
        "copilot",
        "body",
        "https://x/1",
    )


def _record(
    monkeypatch: pytest.MonkeyPatch,
    module: object,
    name: str,
    result: object = None,
) -> list[tuple[tuple[Any, ...], dict[str, Any]]]:
    """Replace an attribute with a recorder and return its call log."""
    calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    def fake(*args: Any, **kwargs: Any) -> object:
        calls.append((args, kwargs))
        return result

    monkeypatch.setattr(module, name, fake)
    return calls


def test_list_prints_formatted_threads(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Without --json the text formatter renders the threads."""
    monkeypatch.setattr(pr_review, "list_threads", lambda *_a, **_k: [_thread()])
    monkeypatch.setattr(pr_review, "format_threads", lambda threads: f"{len(threads)} thread(s)")

    assert cli.main(["list"]) == 0
    assert capsys.readouterr().out.strip() == "1 thread(s)"


def test_list_forwards_pr_and_resolved_selection(monkeypatch: pytest.MonkeyPatch) -> None:
    """--pr and --all reach the thread lookup rather than being dropped."""
    calls = _record(monkeypatch, pr_review, "list_threads", [])
    monkeypatch.setattr(pr_review, "format_threads", lambda _threads: "")

    assert cli.main(["list", "--pr", "9", "--all"]) == 0
    assert calls == [((9,), {"include_resolved": True})]


def test_reply_reports_the_addressed_thread(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A reply names the thread it answered."""
    calls = _record(monkeypatch, pr_review, "reply_to_thread")

    assert cli.main(["reply", "--thread", _THREAD, "--body", "ack"]) == 0
    assert calls == [((_THREAD, "ack"), {"pr": None})]
    assert capsys.readouterr().out.strip() == f"Replied to {_THREAD}"


def test_resolve_reports_the_resolved_thread(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A resolve names the thread it closed."""
    calls = _record(monkeypatch, pr_review, "resolve_thread")

    assert cli.main(["resolve", "--thread", _THREAD]) == 0
    assert calls == [((_THREAD,), {"pr": None})]
    assert capsys.readouterr().out.strip() == f"Resolved {_THREAD}"


def test_address_replies_and_resolves_in_one_step(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The address command reaches the combined helper, not reply followed by resolve."""
    calls = _record(monkeypatch, pr_review, "address_thread")
    monkeypatch.setattr(
        pr_review,
        "reply_to_thread",
        lambda *_a, **_k: pytest.fail("address must not call reply_to_thread"),
    )

    assert cli.main(["address", "--thread", _THREAD, "--body", "fixed"]) == 0
    assert calls == [((_THREAD, "fixed"), {"pr": None})]
    assert capsys.readouterr().out.strip() == f"Replied to and resolved {_THREAD}"


def test_list_comments_prints_formatted_comments(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Without --json the comment text formatter is used."""
    monkeypatch.setattr(pr_review, "list_comments", lambda *_a, **_k: [])
    monkeypatch.setattr(pr_review, "format_comments", lambda _comments: "no comments")

    assert cli.main(["list-comments"]) == 0
    assert capsys.readouterr().out.strip() == "no comments"


def test_summary_prints_the_overview(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The summary command forwards the PR number and prints the rendered overview."""
    calls = _record(monkeypatch, pr_review, "pr_summary", "PR #9 [OPEN]")

    assert cli.main(["summary", "--pr", "9"]) == 0
    assert calls == [((9,), {})]
    assert capsys.readouterr().out.strip() == "PR #9 [OPEN]"


def test_ci_failures_prints_the_digest(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """ci-failures forwards the run id and prints the failure digest."""
    calls = _record(monkeypatch, ci_status, "failure_digest", "step failed")

    assert cli.main(["ci-failures", "--run", "42"]) == 0
    assert calls == [((42,), {})]
    assert capsys.readouterr().out.strip() == "step failed"


def test_ci_failures_defaults_to_the_latest_run(monkeypatch: pytest.MonkeyPatch) -> None:
    """Omitting --run leaves run selection to the helper."""
    calls = _record(monkeypatch, ci_status, "failure_digest", "")

    assert cli.main(["ci-failures"]) == 0
    assert calls == [((None,), {})]


def test_latest_run_id_prints_the_branch_run_id(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """latest-run-id prints only the id of the branch's newest run."""
    run = ci_status.RunInfo(
        run_id=4242,
        status="completed",
        conclusion="success",
        workflow="CI",
        branch="feature",
        url="https://example.com/runs/4242",
    )
    calls = _record(monkeypatch, ci_status, "latest_run", run)

    assert cli.main(["latest-run-id"]) == 0
    assert calls == [((), {})]
    assert capsys.readouterr().out.strip() == "4242"


def test_list_json_emits_parseable_threads(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """--json emits objects a caller can parse rather than formatted text."""
    monkeypatch.setattr(pr_review, "list_threads", lambda *_a, **_k: [_thread()])

    assert cli.main(["list", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert [item["thread_id"] for item in payload] == [_THREAD]


def test_watch_defaults_match_the_documented_options(monkeypatch: pytest.MonkeyPatch) -> None:
    """Omitted watch options fall back to the documented defaults."""
    calls = _record(monkeypatch, pr_watch, "watch_pr", "")

    assert cli.main(["watch"]) == 0
    assert calls == [
        (
            (None,),
            {
                "interval": 45.0,
                "max_polls": 40,
                "expected_checks": pr_watch.DEFAULT_EXPECTED_CHECKS,
                "checks_only": False,
                "request_copilot": False,
            },
        )
    ]


def test_delete_comment_reports_the_deleted_id(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """delete-comment names the comment it removed."""
    calls = _record(monkeypatch, pr_review, "delete_review_comment")

    assert cli.main(["delete-comment", "--comment", _COMMENT]) == 0
    assert calls == [((_COMMENT,), {})]
    assert _COMMENT in capsys.readouterr().out


def test_issue_summary_prints_the_overview(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """issue-summary forwards the issue number and prints the rendered overview."""
    calls = _record(monkeypatch, issues, "issue_summary", "Issue #4 [OPEN] Title")

    assert cli.main(["issue-summary", "--issue", "4"]) == 0
    assert calls == [((4,), {})]
    assert capsys.readouterr().out.strip() == "Issue #4 [OPEN] Title"


def test_check_commit_message_accepts_a_clean_file(tmp_path: Path) -> None:
    """A message file without shell fragments exits zero."""
    message_file = tmp_path / "COMMIT_EDITMSG"
    message_file.write_text("Add a helper\n\n- Detail\n", encoding="utf-8")

    assert cli.main(["check-commit-message", "--message-file", str(message_file)]) == 0


def test_check_commit_message_rejects_a_leaked_file(tmp_path: Path) -> None:
    """A leaked heredoc terminator is re-raised as a GhError so the target fails."""
    message_file = tmp_path / "COMMIT_EDITMSG"
    message_file.write_text("Subject\n\nEOF && make push 2>&1 | tail -3\n", encoding="utf-8")

    with pytest.raises(GhError, match="leaked shell text"):
        cli.main(["check-commit-message", "--message-file", str(message_file)])


def test_check_commit_message_reads_stdin(monkeypatch: pytest.MonkeyPatch) -> None:
    """A message file of - is read from stdin, which is how the heredoc form arrives."""
    monkeypatch.setattr(cli.sys, "stdin", io.StringIO("Subject\n\n- Detail\n"))

    assert cli.main(["check-commit-message", "--message-file", "-"]) == 0


def test_check_commit_message_reports_an_unreadable_file(tmp_path: Path) -> None:
    """A missing message file names the path instead of surfacing a bare OSError."""
    missing = tmp_path / "nope"

    with pytest.raises(GhError, match=str(missing)):
        cli.main(["check-commit-message", "--message-file", str(missing)])


@pytest.mark.parametrize(
    "argv",
    [
        ["reply", "--thread", _THREAD],
        ["address", "--thread", _THREAD],
        ["comment"],
    ],
)
def test_posting_commands_need_exactly_one_body_form(argv: list[str]) -> None:
    """Every posting command requires one of --body and --body-file, never both."""
    with pytest.raises(SystemExit):
        cli.main(argv)
    with pytest.raises(SystemExit):
        cli.main([*argv, "--body", "inline", "--body-file", "body.md"])


def test_reply_reads_the_body_from_a_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """--body-file carries text a command line would mangle, newlines included."""
    calls = _record(monkeypatch, pr_review, "reply_to_thread")
    body_file = tmp_path / "body.md"
    body_file.write_text('needs >=3.12\nand a "quote"\n', encoding="utf-8")

    assert cli.main(["reply", "--thread", _THREAD, "--body-file", str(body_file)]) == 0
    assert calls == [((_THREAD, 'needs >=3.12\nand a "quote"\n'), {"pr": None})]


def test_address_reads_the_body_from_stdin(monkeypatch: pytest.MonkeyPatch) -> None:
    """A body file of - is read from stdin, which is how a piped body arrives."""
    calls = _record(monkeypatch, pr_review, "address_thread")
    monkeypatch.setattr(cli.sys, "stdin", io.StringIO("piped body\n"))

    assert cli.main(["address", "--thread", _THREAD, "--body-file", "-"]) == 0
    assert calls == [((_THREAD, "piped body\n"), {"pr": None})]


def test_body_file_reports_an_unreadable_path(tmp_path: Path) -> None:
    """A missing body file names the path instead of surfacing a bare OSError."""
    missing = tmp_path / "nope"

    with pytest.raises(GhError, match=str(missing)):
        cli.main(["reply", "--thread", _THREAD, "--body-file", str(missing)])


def test_body_text_refuses_an_absent_body() -> None:
    """An optional-body command must never post the string "None" as a body.

    edit-pr forwards its raw values rather than calling this, so the guard is the
    backstop for whichever optional-body subcommand comes next.
    """
    with pytest.raises(GhError, match="--body or --body-file"):
        cli._body_text(argparse.Namespace(body=None, body_file=None))


def test_comment_posts_to_the_named_pr(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The comment command forwards the PR number and body, then confirms."""
    calls = _record(monkeypatch, pr_review, "comment_on_pr")

    assert cli.main(["comment", "--pr", "9", "--body", "looks good"]) == 0
    assert calls == [((9, "looks good"), {})]
    assert capsys.readouterr().out.strip() == "Commented on the PR"


def test_comment_defaults_to_the_current_pr(monkeypatch: pytest.MonkeyPatch) -> None:
    """Omitting --pr leaves PR detection to the helper."""
    calls = _record(monkeypatch, pr_review, "comment_on_pr")

    assert cli.main(["comment", "--body", "ack"]) == 0
    assert calls == [((None, "ack"), {})]


def test_edit_pr_forwards_the_body_file_unread(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    """The path reaches gh itself, so a large body never enters the argument list."""
    calls = _record(monkeypatch, pr_review, "edit_pr")
    body_file = tmp_path / "body.md"
    body_file.write_text("never read here\n", encoding="utf-8")

    assert cli.main(["edit-pr", "--pr", "9", "--title", "T", "--body-file", str(body_file)]) == 0
    assert calls == [((9,), {"title": "T", "body": None, "body_file": str(body_file)})]
    assert capsys.readouterr().out.strip() == "Edited the PR"


def test_edit_pr_accepts_a_title_without_a_body(monkeypatch: pytest.MonkeyPatch) -> None:
    """The body is optional for edit-pr, unlike the posting commands."""
    calls = _record(monkeypatch, pr_review, "edit_pr")

    assert cli.main(["edit-pr", "--title", "Just the title"]) == 0
    assert calls == [((None,), {"title": "Just the title", "body": None, "body_file": None})]


def test_edit_pr_rejects_both_body_forms() -> None:
    """An optional body is still one body form at most."""
    with pytest.raises(SystemExit):
        cli.main(["edit-pr", "--body", "inline", "--body-file", "body.md"])


def test_parser_exposes_a_handler_for_every_subcommand() -> None:
    """The parser and the dispatch table cannot drift apart.

    A subcommand the parser accepts but the table does not know would raise a
    KeyError at dispatch, after the user's arguments already validated.
    """
    subparsers = next(
        action
        for action in cli._build_parser()._actions
        if isinstance(action, argparse._SubParsersAction)
    )

    assert set(subparsers.choices) == set(cli.COMMAND_HANDLERS)


def test_main_rejects_an_unknown_subcommand() -> None:
    """An unknown subcommand fails at parse time rather than dispatching."""
    with pytest.raises(SystemExit):
        cli.main(["not-a-command"])


def _spy(
    monkeypatch: pytest.MonkeyPatch, module: ModuleType, name: str, result: int = 0
) -> list[tuple[tuple[object, ...], dict[str, object]]]:
    """Replace ``module.name`` with a recorder that returns ``result``."""
    calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    def record(*args: object, **kwargs: object) -> int:
        """Record the call."""
        calls.append((args, kwargs))
        return result

    monkeypatch.setattr(module, name, record)
    return calls


@pytest.mark.parametrize(
    ("argv", "function", "args", "kwargs"),
    [
        (["pr-list"], "list_prs", (), {}),
        (["pr-status"], "pr_checks_status", (None,), {}),
        (["pr-status", "--pr", "7"], "pr_checks_status", (7,), {}),
        (
            ["pr-checks", "--pr", "7", "--interval", "2", "--max-polls", "3"],
            "watch_pr_checks",
            (7,),
            {"interval": 2.0, "max_polls": 3},
        ),
        (
            ["pr-checks"],
            "watch_pr_checks",
            (None,),
            {
                "interval": pr_commands.CHECKS_INTERVAL_SECONDS,
                "max_polls": pr_commands.CHECKS_MAX_POLLS,
            },
        ),
        (["pr-diff"], "show_diff", (None,), {}),
        (["pr-checkout", "--pr", "7"], "checkout_pr", (7,), {}),
        (["pr-comments", "--pr", "7"], "view_comments", (7,), {}),
        (["pr-merge"], "merge_pr", (None,), {"admin": False}),
        (["pr-merge", "--pr", "7", "--admin"], "merge_pr", (7,), {"admin": True}),
        (["pr-reviewers", "--users", "a,b"], "add_reviewers", ("a,b", None), {}),
        (["pr-label", "--labels", "bug", "--pr", "7"], "add_labels", ("bug", 7), {}),
        (["pr-close", "--pr", "7"], "close_pr", (7,), {}),
        (["pr-create", "--base", "dev"], "create_pr", (), {"base": "dev"}),
        (
            ["pr-create", "--title", "T", "--body", "B"],
            "create_pr",
            (),
            {"title": "T", "base": None, "body": "B"},
        ),
        (
            ["pr-create", "--title", "T"],
            "create_pr",
            (),
            {"title": "T", "base": None, "body": ""},
        ),
    ],
)
def test_pr_subcommands_dispatch_to_pr_commands(
    monkeypatch: pytest.MonkeyPatch,
    argv: list[str],
    function: str,
    args: tuple[object, ...],
    kwargs: dict[str, object],
) -> None:
    """Each pr-* subcommand forwards its parsed options and returns the exit code."""
    calls = _spy(monkeypatch, pr_commands, function, result=3)

    assert cli.main(argv) == 3

    assert calls == [(args, kwargs)]


def test_pr_create_rejects_a_body_without_a_title() -> None:
    """A body only makes sense with a title; otherwise the text is filled from commits."""
    with pytest.raises(GhError, match="needs a --title"):
        cli.main(["pr-create", "--body", "B"])


def test_pr_create_reads_the_body_from_standard_input(monkeypatch: pytest.MonkeyPatch) -> None:
    """--body-file - supplies the body text."""
    calls = _spy(monkeypatch, pr_commands, "create_pr")
    monkeypatch.setattr("sys.stdin", io.StringIO("from stdin"))

    assert cli.main(["pr-create", "--title", "T", "--body-file", "-"]) == 0

    assert calls == [((), {"title": "T", "base": None, "body": "from stdin"})]


@pytest.mark.parametrize(
    ("argv", "function", "args", "kwargs"),
    [
        (
            ["issue-list"],
            "list_issues",
            (),
            {
                "state": None,
                "labels": None,
                "assignees": None,
                "author": None,
                "limit": None,
                "search": None,
            },
        ),
        (
            [
                "issue-list",
                "--state",
                "all",
                "--label",
                "bug",
                "--assignee",
                "a",
                "--assignee",
                "@me",
                "--author",
                "o",
                "--limit",
                "5",
                "--search",
                "x",
            ],
            "list_issues",
            (),
            {
                "state": "all",
                "labels": "bug",
                "assignees": ["a", "@me"],
                "author": "o",
                "limit": 5,
                "search": "x",
            },
        ),
        (["issue-view", "--issue", "5"], "view_issue", (5,), {}),
        (
            ["issue-create", "--title", "T", "--labels", "bug", "--assignee", "@me", "--body", "B"],
            "create_issue",
            ("T", "B"),
            {"labels": "bug", "assignee": "@me"},
        ),
        (["issue-comment", "--issue", "5", "--body", "B"], "comment_issue", (5, "B"), {}),
        (
            ["issue-edit", "--issue", "5", "--title", "T", "--body", "B"],
            "edit_issue",
            (5,),
            {"title": "T", "body": "B"},
        ),
        (
            ["issue-edit", "--issue", "5", "--title", "T"],
            "edit_issue",
            (5,),
            {"title": "T", "body": None},
        ),
        (["issue-label", "--issue", "5", "--labels", "bug"], "label_issue", (5, "bug"), {}),
        (
            ["issue-unlabel", "--issue", "5", "--labels", "bug"],
            "label_issue",
            (5, "bug"),
            {"remove": True},
        ),
        (
            ["issue-assign", "--issue", "5", "--users", "a", "--mine"],
            "assign_issue",
            (5,),
            {"users": "a", "mine": True},
        ),
        (
            ["issue-unassign", "--issue", "5", "--users", "a"],
            "assign_issue",
            (5,),
            {"users": "a", "mine": False, "remove": True},
        ),
        (
            ["issue-close", "--issue", "5", "--reason", "completed", "--comment", "Done"],
            "close_issue",
            (5,),
            {"reason": "completed", "comment": "Done"},
        ),
        (["issue-reopen", "--issue", "5"], "reopen_issue", (5,), {"comment": None}),
        (
            ["issue-develop", "--issue", "5", "--base", "dev", "--name", "n"],
            "develop_issue",
            (5,),
            {"base": "dev", "name": "n"},
        ),
    ],
)
def test_issue_subcommands_dispatch_to_issue_commands(
    monkeypatch: pytest.MonkeyPatch,
    argv: list[str],
    function: str,
    args: tuple[object, ...],
    kwargs: dict[str, object],
) -> None:
    """Each issue-* subcommand forwards its parsed options and returns the exit code."""
    calls = _spy(monkeypatch, issue_commands, function, result=2)

    assert cli.main(argv) == 2

    assert calls == [(args, kwargs)]


def test_current_pr_subcommand_prints_the_number(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """current-pr prints just the number, for the Makefile's PR_NUM."""
    monkeypatch.setattr(gh_runner, "current_pr_number", lambda: 42)

    assert cli.main(["current-pr"]) == 0
    assert capsys.readouterr().out == "42\n"


@pytest.mark.parametrize(
    ("argv", "attribute", "value"),
    [
        (["issue-list", "--search=-label:bug"], "search", "-label:bug"),
        (["issue-create", "--title=-1 off", "--body", "b"], "title", "-1 off"),
        (["issue-create", "--title=-fix", "--body", "b"], "title", "-fix"),
        (["issue-close", "--issue", "7", "--comment=-not planned"], "comment", "-not planned"),
    ],
)
def test_option_equals_value_keeps_a_leading_dash(
    argv: list[str], attribute: str, value: str
) -> None:
    """The Makefile passes free text as --option=value, so a leading dash survives parsing."""
    args = cli._build_parser().parse_args(argv)

    assert getattr(args, attribute) == value


@pytest.mark.parametrize(
    "argv",
    [["issue-list", "--search", "-label:bug"], ["issue-create", "--title", "-fix", "--body", "b"]],
)
def test_separate_value_with_a_leading_dash_is_read_as_an_option(argv: list[str]) -> None:
    """The separate-word form fails, which is why the Makefile never uses it for free text."""
    with pytest.raises(SystemExit):
        cli._build_parser().parse_args(argv)
