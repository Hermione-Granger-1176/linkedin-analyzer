from __future__ import annotations

import subprocess

import pytest
from scripts.lib import gh_api


class FakeSubprocess:
    """Subprocess-module seam that replays queued results or raises them in order."""

    def __init__(self, results: list[object]) -> None:
        self._results = list(results)
        self.commands: list[list[str]] = []
        self.timeouts: list[float] = []

    def run(
        self,
        args: list[str],
        *,
        capture_output: bool,
        text: bool,
        check: bool,
        timeout: float,
    ) -> subprocess.CompletedProcess[str]:
        """Record the invocation and replay the next queued result."""
        del capture_output, text, check
        self.commands.append(list(args))
        self.timeouts.append(timeout)
        result = self._results.pop(0)
        if isinstance(result, BaseException):
            raise result
        assert isinstance(result, subprocess.CompletedProcess)
        return result


def _proc(returncode: int, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess[str]:
    """Build a completed process for the fake subprocess module."""
    return subprocess.CompletedProcess(
        args=["gh"], returncode=returncode, stdout=stdout, stderr=stderr
    )


def test_failure_predicates_delegate_to_the_shared_policy() -> None:
    """Each predicate reports exactly one shared failure kind."""
    assert gh_api.is_rate_limited_gh_api_failure("API rate limit exceeded")
    assert not gh_api.is_rate_limited_gh_api_failure("Not Found (HTTP 404)")
    assert gh_api.is_retryable_gh_api_failure("Bad gateway (HTTP 502)")
    assert not gh_api.is_retryable_gh_api_failure("API rate limit exceeded")
    assert gh_api.is_forbidden_gh_api_failure("Resource not accessible by integration")
    assert not gh_api.is_forbidden_gh_api_failure("Not Found (HTTP 404)")


def test_run_gh_api_builds_a_paginated_jq_command_and_returns_stdout() -> None:
    """The endpoint, pagination flags, and jq expression reach gh in order."""
    fake = FakeSubprocess([_proc(0, '{"ok":true}')])

    output = gh_api.run_gh_api(
        "repos/o/n/issues",
        paginate=["--paginate"],
        jq_expr=".[].number",
        description="listing issues",
        subprocess_module=fake,
    )

    assert output == '{"ok":true}'
    assert fake.commands == [["gh", "api", "repos/o/n/issues", "--paginate", "--jq", ".[].number"]]
    assert fake.timeouts == [gh_api.GH_API_TIMEOUT_SECONDS]


def test_run_gh_api_retries_a_transient_failure_then_succeeds() -> None:
    """A 5xx is retried with the shared backoff before succeeding."""
    fake = FakeSubprocess([_proc(1, "", "Bad gateway (HTTP 502)"), _proc(0, "done")])
    slept: list[float] = []

    output = gh_api.run_gh_api(
        "repos/o/n",
        paginate=[],
        jq_expr=".",
        description="reading repo",
        sleep_fn=slept.append,
        subprocess_module=fake,
    )

    assert output == "done"
    assert len(fake.commands) == 2
    assert len(slept) == 1


def test_run_gh_api_fails_fast_on_a_rate_limit() -> None:
    """A rate limit is never retried; it raises immediately."""
    fake = FakeSubprocess([_proc(1, "", "API rate limit exceeded")])

    with pytest.raises(RuntimeError, match="GitHub rate limit hit"):
        gh_api.run_gh_api(
            "repos/o/n",
            paginate=[],
            jq_expr=".",
            description="reading repo",
            sleep_fn=lambda _s: None,
            subprocess_module=fake,
        )
    assert len(fake.commands) == 1


def test_run_gh_api_names_the_missing_permission_on_a_403() -> None:
    """A forbidden failure surfaces the permission the endpoint needs."""
    fake = FakeSubprocess([_proc(1, "", "Resource not accessible by integration")])

    with pytest.raises(RuntimeError, match="lacks permission 'administration: read'"):
        gh_api.run_gh_api(
            "repos/o/n",
            paginate=[],
            jq_expr=".",
            description="reading settings",
            subprocess_module=fake,
            required_permission="administration: read",
        )


def test_run_gh_api_reports_a_generic_403_without_a_named_permission() -> None:
    """Without a declared permission the 403 still explains itself."""
    fake = FakeSubprocess([_proc(1, "", "Resource not accessible by integration")])

    with pytest.raises(RuntimeError, match="Token likely lacks required permission"):
        gh_api.run_gh_api(
            "repos/o/n",
            paginate=[],
            jq_expr=".",
            description="reading settings",
            subprocess_module=fake,
        )


def test_run_gh_api_retries_a_timeout_then_raises_with_context() -> None:
    """An exhausted timeout budget names the description and the timeout."""
    fake = FakeSubprocess(
        [
            subprocess.TimeoutExpired(cmd="gh", timeout=15),
            subprocess.TimeoutExpired(cmd="gh", timeout=15),
            subprocess.TimeoutExpired(cmd="gh", timeout=15),
        ]
    )

    with pytest.raises(RuntimeError, match="timed out after 15 seconds while reading repo"):
        gh_api.run_gh_api(
            "repos/o/n",
            paginate=[],
            jq_expr=".",
            description="reading repo",
            sleep_fn=lambda _s: None,
            subprocess_module=fake,
        )
    assert len(fake.commands) == gh_api.GH_API_MAX_ATTEMPTS


def test_run_gh_api_reports_a_fatal_failure_without_retrying() -> None:
    """A 404 is final: one attempt, and the raw stderr is preserved."""
    fake = FakeSubprocess([_proc(1, "", "Not Found (HTTP 404)")])

    with pytest.raises(RuntimeError, match=r"gh api reading repo failed: Not Found \(HTTP 404\)"):
        gh_api.run_gh_api(
            "repos/o/n",
            paginate=[],
            jq_expr=".",
            description="reading repo",
            subprocess_module=fake,
        )
    assert len(fake.commands) == 1


def test_run_gh_api_falls_back_to_stdout_then_a_placeholder_for_the_error() -> None:
    """An empty stderr degrades to stdout, then to a placeholder message."""
    fake = FakeSubprocess([_proc(1, "stdout detail", "")])
    with pytest.raises(RuntimeError, match="stdout detail"):
        gh_api.run_gh_api("e", paginate=[], jq_expr=".", description="d", subprocess_module=fake)

    fake = FakeSubprocess([_proc(1, "", "")])
    with pytest.raises(RuntimeError, match="unknown gh api error"):
        gh_api.run_gh_api("e", paginate=[], jq_expr=".", description="d", subprocess_module=fake)


def test_run_gh_api_raises_when_no_attempts_are_configured() -> None:
    """A zero attempt budget cannot silently return nothing."""
    fake = FakeSubprocess([])

    with pytest.raises(RuntimeError, match="gh api reading repo failed: unknown error"):
        gh_api.run_gh_api(
            "repos/o/n",
            paginate=[],
            jq_expr=".",
            description="reading repo",
            max_attempts=0,
            subprocess_module=fake,
        )
    assert fake.commands == []


def test_run_gh_api_json_parses_the_response() -> None:
    """JSON is parsed with the endpoint's jq expression left as a passthrough."""
    captured: dict[str, object] = {}

    def fake_run_gh_api(endpoint: str, **kwargs: object) -> str:
        captured["endpoint"] = endpoint
        captured.update(kwargs)
        return '{"number": 7}'

    assert gh_api.run_gh_api_json(
        "repos/o/n/issues/7", description="reading issue", run_gh_api_fn=fake_run_gh_api
    ) == {"number": 7}
    assert captured["endpoint"] == "repos/o/n/issues/7"
    assert captured["jq_expr"] == "."


def test_run_gh_api_json_rejects_invalid_json() -> None:
    """A non-JSON body is reported against the described call."""
    with pytest.raises(RuntimeError, match="gh api reading issue returned invalid JSON"):
        gh_api.run_gh_api_json(
            "repos/o/n/issues/7",
            description="reading issue",
            run_gh_api_fn=lambda *_a, **_k: "not json",
        )


def test_gh_escape_data_value_only_escapes_a_leading_at() -> None:
    """A leading @ is escaped so gh does not read the value as a file path."""
    assert gh_api.gh_escape_data_value("@everyone") == "\\@everyone"
    assert gh_api.gh_escape_data_value("plain @mention") == "plain @mention"


def test_run_gh_api_form_builds_method_fields_and_optional_jq() -> None:
    """Form fields are escaped and the jq expression is only added when given."""
    fake = FakeSubprocess([_proc(0, "ok")])

    assert (
        gh_api.run_gh_api_form(
            "repos/o/n/issues",
            method="POST",
            fields=[("title", "Fix"), ("body", "@file")],
            description="creating issue",
            jq_expr=".number",
            subprocess_module=fake,
        )
        == "ok"
    )
    assert fake.commands == [
        [
            "gh",
            "api",
            "-X",
            "POST",
            "repos/o/n/issues",
            "-f",
            "title=Fix",
            "-f",
            "body=\\@file",
            "--jq",
            ".number",
        ]
    ]


def test_run_gh_api_form_omits_the_jq_flag_by_default() -> None:
    """Without a jq expression the mutation command carries no --jq."""
    fake = FakeSubprocess([_proc(0, "")])

    gh_api.run_gh_api_form(
        "repos/o/n/issues/7",
        method="PATCH",
        fields=[("state", "closed")],
        description="closing issue",
        subprocess_module=fake,
    )

    assert "--jq" not in fake.commands[0]
