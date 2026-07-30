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
from typing import Any

import pytest
from scripts.gh import ci_status, cli, issues, pr_review, pr_watch
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
    assert calls == [((_THREAD, "ack"), {})]
    assert capsys.readouterr().out.strip() == f"Replied to {_THREAD}"


def test_resolve_reports_the_resolved_thread(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A resolve names the thread it closed."""
    calls = _record(monkeypatch, pr_review, "resolve_thread")

    assert cli.main(["resolve", "--thread", _THREAD]) == 0
    assert calls == [((_THREAD,), {})]
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
    assert calls == [((_THREAD, "fixed"), {})]
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
                "expected_checks": 15,
                "checks_only": False,
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
    assert calls == [((_THREAD, 'needs >=3.12\nand a "quote"\n'), {})]


def test_address_reads_the_body_from_stdin(monkeypatch: pytest.MonkeyPatch) -> None:
    """A body file of - is read from stdin, which is how a piped body arrives."""
    calls = _record(monkeypatch, pr_review, "address_thread")
    monkeypatch.setattr(cli.sys, "stdin", io.StringIO("piped body\n"))

    assert cli.main(["address", "--thread", _THREAD, "--body-file", "-"]) == 0
    assert calls == [((_THREAD, "piped body\n"), {})]


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
