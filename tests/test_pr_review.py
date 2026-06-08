from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import pytest
from scripts.gh import cli, gh_runner, pr_review
from scripts.gh.gh_runner import GhError

if TYPE_CHECKING:
    from collections.abc import Sequence


def completed_process(
    returncode: int, stdout: str = "", stderr: str = ""
) -> subprocess.CompletedProcess[str]:
    """Create a subprocess result for injected runners."""
    return subprocess.CompletedProcess(
        args=["gh"], returncode=returncode, stdout=stdout, stderr=stderr
    )


class FakeGh:
    """A dispatching fake subprocess runner that records its calls."""

    def __init__(self, routes: list[tuple[Callable[[list[str]], bool], Any]]) -> None:
        self.routes = routes
        self.calls: list[list[str]] = []

    def __call__(self, cmd: Sequence[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        """Return the response whose predicate matches, or fail the test."""
        command = list(cmd)
        self.calls.append(command)
        for predicate, response in self.routes:
            if predicate(command):
                if isinstance(response, Exception):
                    raise response
                return response
        raise AssertionError(f"unexpected command: {command}")


def has(*needles: str) -> Callable[[list[str]], bool]:
    """Build a predicate matching commands that contain all needles as arguments."""
    return lambda cmd: all(needle in cmd for needle in needles)


def _query_arg(cmd: list[str]) -> str:
    """Return the ``query=`` argument from a gh graphql command."""
    return next(part for part in cmd if part.startswith("query="))


THREADS_PAYLOAD = {
    "data": {
        "repository": {
            "pullRequest": {
                "reviewThreads": {
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                    "nodes": [
                        {
                            "id": "PRRT_open1",
                            "isResolved": False,
                            "path": "src/foo.py",
                            "line": 42,
                            "comments": {
                                "nodes": [
                                    {
                                        "body": "Please rename this\nsecond line",
                                        "url": "https://example/1",
                                        "author": {"login": "reviewer"},
                                    }
                                ]
                            },
                        },
                        {
                            "id": "PRRT_done1",
                            "isResolved": True,
                            "path": "src/bar.py",
                            "line": None,
                            "comments": {"nodes": []},
                        },
                    ],
                }
            }
        }
    }
}


def test_parse_threads_maps_fields() -> None:
    """Map a GraphQL payload into ReviewThread objects."""
    threads = pr_review.parse_threads(THREADS_PAYLOAD["data"])

    assert [thread.thread_id for thread in threads] == ["PRRT_open1", "PRRT_done1"]
    first = threads[0]
    assert first.state == "open"
    assert first.author == "reviewer"
    assert first.body.startswith("Please rename")
    assert threads[1].state == "resolved"
    assert threads[1].author == "unknown"


def _threads_page(
    thread_id: str, *, has_next: bool, end_cursor: str | None = None
) -> dict[str, Any]:
    """Build a one-node reviewThreads page with the given pagination state."""
    return {
        "repository": {
            "pullRequest": {
                "reviewThreads": {
                    "pageInfo": {"hasNextPage": has_next, "endCursor": end_cursor},
                    "nodes": [
                        {
                            "id": thread_id,
                            "isResolved": False,
                            "path": "f.py",
                            "line": 1,
                            "comments": {
                                "nodes": [{"body": "x", "url": "u", "author": {"login": "r"}}]
                            },
                        }
                    ],
                }
            }
        }
    }


def test_list_threads_follows_pagination() -> None:
    """list_threads pages through reviewThreads until hasNextPage is false."""
    pages = iter(
        [
            _threads_page("PRRT_a", has_next=True, end_cursor="CURSOR1"),
            _threads_page("PRRT_b", has_next=False),
        ]
    )
    calls: list[list[str]] = []

    def runner(cmd: Sequence[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        command = list(cmd)
        calls.append(command)
        if has("repo", "view")(command):
            return completed_process(0, json.dumps({"nameWithOwner": "o/r"}))
        if has("graphql")(command):
            return completed_process(0, json.dumps({"data": next(pages)}))
        raise AssertionError(command)

    threads = pr_review.list_threads(7, include_resolved=True, run_fn=runner)

    assert [thread.thread_id for thread in threads] == ["PRRT_a", "PRRT_b"]
    # The second page request carries the first page's endCursor.
    graphql_calls = [command for command in calls if has("graphql")(command)]
    assert len(graphql_calls) == 2
    assert any("after=CURSOR1" in command for command in graphql_calls)


def test_parse_threads_raises_on_missing_pull_request() -> None:
    """A null/absent repository or pull request raises a clear GhError."""
    for payload in ({}, {"repository": None}, {"repository": {"pullRequest": None}}):
        with pytest.raises(GhError):
            pr_review.parse_threads(payload)


def test_list_threads_filters_resolved_by_default() -> None:
    """Drop resolved threads unless include_resolved is set."""
    runner = FakeGh(
        [
            (has("repo", "view"), completed_process(0, json.dumps({"nameWithOwner": "o/r"}))),
            (has("graphql"), completed_process(0, json.dumps(THREADS_PAYLOAD))),
        ]
    )

    open_only = pr_review.list_threads(7, run_fn=runner)
    everything = pr_review.list_threads(7, include_resolved=True, run_fn=runner)

    assert [thread.thread_id for thread in open_only] == ["PRRT_open1"]
    assert len(everything) == 2


def test_format_threads_is_greppable() -> None:
    """Render each open thread with its id and state."""
    threads = pr_review.parse_threads(THREADS_PAYLOAD["data"])
    text = pr_review.format_threads(threads)

    assert "thread=PRRT_open1" in text
    assert "state=open" in text
    assert "src/foo.py:42" in text
    assert "second line" not in text  # only the first body line is shown


def test_format_threads_empty() -> None:
    """Report when there are no matching threads."""
    assert pr_review.format_threads([]) == "No matching review threads."


def test_reply_uses_thread_id_without_database_id() -> None:
    """Reply via addPullRequestReviewThreadReply keyed on the thread id."""
    runner = FakeGh([(has("graphql"), completed_process(0, json.dumps({"data": {}})))])

    pr_review.reply_to_thread("PRRT_open1", "Fixed", run_fn=runner)

    (cmd,) = runner.calls
    assert "addPullRequestReviewThreadReply" in _query_arg(cmd)
    assert "thread=PRRT_open1" in cmd
    assert "body=Fixed" in cmd


def test_graphql_serializes_variables_by_type() -> None:
    """Bools become JSON true/false via -F, ints stay typed, strings use -f."""
    runner = FakeGh([(has("graphql"), completed_process(0, json.dumps({"data": {}})))])

    gh_runner.graphql(
        "query($flag: Boolean!, $count: Int!, $name: String!) { x }",
        variables={"flag": True, "count": 3, "name": "abc"},
        run_fn=runner,
    )

    (cmd,) = runner.calls
    assert "flag=true" in cmd  # not Python's "True"
    assert "count=3" in cmd
    assert "name=abc" in cmd
    # The bool and int are typed (-F); the string is plain (-f).
    assert cmd[cmd.index("flag=true") - 1] == "-F"
    assert cmd[cmd.index("name=abc") - 1] == "-f"


def test_address_replies_then_resolves() -> None:
    """Address a thread by replying first and resolving second."""
    runner = FakeGh([(has("graphql"), completed_process(0, json.dumps({"data": {}})))])

    pr_review.address_thread("PRRT_open1", "done", run_fn=runner)

    mutations = [_query_arg(cmd) for cmd in runner.calls]
    assert "addPullRequestReviewThreadReply" in mutations[0]
    assert "resolveReviewThread" in mutations[1]


def test_address_short_circuits_when_reply_fails() -> None:
    """Do not resolve a thread if the reply failed."""
    runner = FakeGh([(has("graphql"), completed_process(1, "", "boom"))])

    with pytest.raises(GhError):
        pr_review.address_thread("PRRT_open1", "done", run_fn=runner)

    assert len(runner.calls) == 1  # reply attempted, resolve skipped


def test_pr_summary_includes_meta_and_threads() -> None:
    """Summaries show PR state, a checks tally, and open threads."""
    meta = {
        "number": 7,
        "title": "Add feature",
        "state": "OPEN",
        "url": "https://example/pr/7",
        "statusCheckRollup": [{"conclusion": "SUCCESS"}, {"conclusion": "FAILURE"}],
    }
    runner = FakeGh(
        [
            (has("pr", "view"), completed_process(0, json.dumps(meta))),
            (has("repo", "view"), completed_process(0, json.dumps({"nameWithOwner": "o/r"}))),
            (has("graphql"), completed_process(0, json.dumps(THREADS_PAYLOAD))),
        ]
    )

    text = pr_review.pr_summary(7, run_fn=runner)

    assert "PR #7 [OPEN] Add feature" in text
    assert "1 failure" in text and "1 success" in text
    assert "open review threads: 1" in text
    assert "thread=PRRT_open1" in text


def test_resolve_repo_falls_back_to_remote() -> None:
    """Parse owner/name from the git remote when gh repo view fails."""
    runner = FakeGh(
        [
            (has("repo", "view"), completed_process(1, "", "no repo")),
            (has("remote"), completed_process(0, "git@github.com:octo/Hello.git\n")),
        ]
    )

    assert gh_runner.resolve_repo(run_fn=runner) == "octo/Hello"


def test_resolve_repo_handles_ssh_remote_with_port() -> None:
    """An SSH remote URL with an explicit port still yields owner/name."""
    runner = FakeGh(
        [
            (has("repo", "view"), completed_process(1, "", "no repo")),
            (has("remote"), completed_process(0, "ssh://git@github.com:22/octo/Hello.git\n")),
        ]
    )

    assert gh_runner.resolve_repo(run_fn=runner) == "octo/Hello"


def test_resolve_repo_falls_back_when_key_missing() -> None:
    """A repo-view payload without nameWithOwner still falls back to the remote."""
    runner = FakeGh(
        [
            (has("repo", "view"), completed_process(0, json.dumps({}))),
            (has("remote"), completed_process(0, "git@github.com:octo/Hello.git\n")),
        ]
    )

    assert gh_runner.resolve_repo(run_fn=runner) == "octo/Hello"


def test_resolve_repo_raises_when_unresolvable() -> None:
    """Raise a clear error when neither source yields a slug."""
    runner = FakeGh(
        [
            (has("repo", "view"), completed_process(1, "", "no repo")),
            (has("remote"), completed_process(1, "", "no remote")),
        ]
    )

    with pytest.raises(GhError):
        gh_runner.resolve_repo(run_fn=runner)


def test_current_pr_number_parses_gh_output() -> None:
    """Read the PR number for the current branch."""
    runner = FakeGh([(has("pr", "view"), completed_process(0, json.dumps({"number": 19})))])

    assert gh_runner.current_pr_number(run_fn=runner) == 19


def test_current_pr_number_raises_without_pr() -> None:
    """Raise a friendly error when the branch has no PR."""
    runner = FakeGh([(has("pr", "view"), completed_process(1, "", "no pull requests found"))])

    with pytest.raises(GhError):
        gh_runner.current_pr_number(run_fn=runner)


def test_main_requires_body_for_reply() -> None:
    """Reject a reply that is missing a body via argparse."""
    with pytest.raises(SystemExit) as excinfo:
        cli.main(["reply", "--thread", "PRRT_x"])

    assert excinfo.value.code == 2


def test_main_list_json(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The list command emits JSON when asked."""
    thread = pr_review.ReviewThread("PRRT_x", "open", "f.py", 1, "me", "hi", "u")
    monkeypatch.setattr(pr_review, "list_threads", lambda *_a, **_k: [thread])

    exit_code = cli.main(["list", "--json"])

    captured = json.loads(capsys.readouterr().out)
    assert exit_code == 0
    assert captured[0]["thread_id"] == "PRRT_x"
