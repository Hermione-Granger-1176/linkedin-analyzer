"""Cover every ``scripts.gh.cli`` subcommand handler and output mode.

The handlers are thin, but they are the only place that decides which helper a
Makefile target reaches and whether it prints text or JSON. A wrong dispatch
here is invisible until someone runs the target, so each one is pinned.
"""

from __future__ import annotations

import argparse
import json
from typing import Any

import pytest
from scripts.gh import ci_status, cli, pr_review, pr_watch

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
