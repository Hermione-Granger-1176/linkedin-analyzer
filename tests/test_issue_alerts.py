from __future__ import annotations

import json
from pathlib import Path

import pytest
from scripts.ci import issue_alerts
from scripts.gh import gh_runner
from scripts.gh.gh_runner import GhError

from tests.gh_test_support import FakeGh, completed_process, has

_REPO = "octo/repo"
_TITLE = "Dependency audit failed"
_LABEL = "dependency-audit"
_RUN_URL = "https://github.com/octo/repo/actions/runs/42"


def _issue(number: int = 7, *, title: str = _TITLE, url: str = "https://x/7") -> dict[str, object]:
    """Build one issue list entry."""
    return {"number": number, "title": title, "url": url}


def _list_route(issues: list[dict[str, object]]) -> tuple[object, object]:
    """Route an issue list call to a serialized payload."""
    return (has("issue", "list"), completed_process(0, json.dumps(issues)))


@pytest.mark.parametrize(
    ("state", "expected"),
    [("open", True), ("setup-failure", True), ("close", False)],
)
def test_alert_should_exist_maps_each_state(state: str, expected: bool) -> None:
    """Only a recovery closes the alert issue."""
    assert issue_alerts.alert_should_exist(state) is expected


def test_alert_should_exist_rejects_unknown_state() -> None:
    """An unrecognized state fails rather than defaulting to a destructive close."""
    with pytest.raises(GhError, match="Unsupported alert state"):
        issue_alerts.alert_should_exist("resolved")


@pytest.mark.parametrize(
    ("state", "lead"),
    [
        ("open", "are failing"),
        ("close", "passing again"),
        ("setup-failure", "setup or infrastructure failure"),
    ],
)
def test_build_alert_body_leads_with_the_state(state: str, lead: str) -> None:
    """Each state explains itself before linking the run."""
    body = issue_alerts.build_alert_body(state=state, run_url=_RUN_URL)

    assert lead in body
    assert f"Workflow run: {_RUN_URL}" in body


def test_build_alert_body_appends_only_meaningful_detail() -> None:
    """Blank detail cannot leave trailing whitespace on the body."""
    assert issue_alerts.build_alert_body(state="open", run_url=_RUN_URL, detail="  ").endswith(
        _RUN_URL
    )
    assert issue_alerts.build_alert_body(
        state="open", run_url=_RUN_URL, detail=" check pip-audit "
    ).endswith("\n\ncheck pip-audit")


@pytest.mark.parametrize(
    ("run_url", "message"),
    [
        ("", "must not be empty"),
        ("http://github.com/o/r/actions/runs/1", "must be an https URL"),
        ("https://example.com/dashboard", "must reference an Actions run"),
        ("--repo=evil", "must not start with"),
    ],
)
def test_build_alert_body_rejects_unusable_run_urls(run_url: str, message: str) -> None:
    """A miswired workflow cannot point an alert at an arbitrary destination."""
    with pytest.raises(GhError, match=message):
        issue_alerts.build_alert_body(state="open", run_url=run_url)


def test_find_alert_issue_scopes_the_search_to_the_label_and_title() -> None:
    """Only an exact title inside the alert label counts as a match."""
    runner = FakeGh([_list_route([_issue(3, title="Unrelated"), _issue(9)])])

    match = issue_alerts.find_alert_issue(_REPO, _TITLE, _LABEL, run_fn=runner)

    assert match == _issue(9)
    command = runner.calls[0]
    assert "--label" in command
    assert _LABEL in command
    assert "--state" in command
    assert "open" in command


def test_find_alert_issue_returns_none_without_a_title_match() -> None:
    """A label with only unrelated issues opens a new alert rather than reusing one."""
    runner = FakeGh([_list_route([_issue(3, title="Unrelated")])])

    assert issue_alerts.find_alert_issue(_REPO, _TITLE, _LABEL, run_fn=runner) is None


def test_find_alert_issue_prefers_the_oldest_duplicate() -> None:
    """Repeated syncs converge on one issue when a duplicate was opened by hand."""
    runner = FakeGh([_list_route([_issue(31), _issue(12), _issue(20)])])

    match = issue_alerts.find_alert_issue(_REPO, _TITLE, _LABEL, run_fn=runner)

    assert match == _issue(12)


def test_find_alert_issue_fails_closed_when_results_may_be_truncated() -> None:
    """A saturated label cannot silently produce a duplicate alert issue."""
    saturated = [_issue(number, title="Unrelated") for number in range(1, 101)]
    runner = FakeGh([_list_route(saturated)])

    with pytest.raises(GhError, match="may be truncated"):
        issue_alerts.find_alert_issue(_REPO, _TITLE, _LABEL, run_fn=runner)


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ('{"issues": []}', "expected a JSON array"),
        ("[3]", "Unexpected issue entry shape"),
    ],
)
def test_find_alert_issue_validates_the_response_shape(payload: str, message: str) -> None:
    """Malformed issue payloads fail loudly instead of being treated as no match."""
    runner = FakeGh([(has("issue", "list"), completed_process(0, payload))])

    with pytest.raises(GhError, match=message):
        issue_alerts.find_alert_issue(_REPO, _TITLE, _LABEL, run_fn=runner)


def test_sync_alert_issue_creates_a_labelled_issue_when_none_exists() -> None:
    """The first failure creates the label and the alert issue together."""
    runner = FakeGh(
        [
            _list_route([]),
            (has("label", "create"), completed_process(0, "")),
            (has("issue", "create"), completed_process(0, "https://x/1\n")),
        ]
    )

    url = issue_alerts.sync_alert_issue(
        repo=_REPO,
        title=_TITLE,
        label=_LABEL,
        body="body",
        should_exist=True,
        run_fn=runner,
    )

    assert url == "https://x/1"
    create = next(call for call in runner.calls if "create" in call and "issue" in call)
    assert "--label" in create
    assert _LABEL in create
    assert "body" in create


def test_sync_alert_issue_comments_instead_of_rewriting_an_open_alert() -> None:
    """A repeat failure preserves the timeline rather than overwriting the body."""
    runner = FakeGh(
        [
            (has("label", "create"), completed_process(0, "")),
            _list_route([_issue(7)]),
            (has("issue", "comment"), completed_process(0, "")),
        ]
    )

    url = issue_alerts.sync_alert_issue(
        repo=_REPO,
        title=_TITLE,
        label=_LABEL,
        body="second failure",
        should_exist=True,
        run_fn=runner,
    )

    assert url == "https://x/7"
    comment = next(call for call in runner.calls if "comment" in call)
    assert "7" in comment
    assert "second failure" in comment
    assert not any("issue" in call and "create" in call for call in runner.calls)


def test_sync_alert_issue_closes_the_alert_on_recovery() -> None:
    """Recovery closes the issue and records why it closed."""
    runner = FakeGh(
        [
            (has("label", "create"), completed_process(0, "")),
            _list_route([_issue(7)]),
            (has("issue", "close"), completed_process(0, "")),
        ]
    )

    url = issue_alerts.sync_alert_issue(
        repo=_REPO,
        title=_TITLE,
        label=_LABEL,
        body="recovered",
        should_exist=False,
        run_fn=runner,
    )

    assert url == ""
    close = next(call for call in runner.calls if "close" in call)
    assert "--comment" in close
    assert "recovered" in close


def test_sync_alert_issue_is_a_noop_when_recovery_finds_no_issue() -> None:
    """A passing schedule with no open alert touches no issue."""
    runner = FakeGh(
        [
            (has("label", "create"), completed_process(0, "")),
            _list_route([]),
        ]
    )

    url = issue_alerts.sync_alert_issue(
        repo=_REPO,
        title=_TITLE,
        label=_LABEL,
        body="recovered",
        should_exist=False,
        run_fn=runner,
    )

    assert url == ""
    assert not any("issue" in call for call in runner.calls if "list" not in call)


def test_sync_alert_issue_ensures_the_label_before_looking_it_up() -> None:
    """Recovering a repository that never failed cannot trip over a missing label."""
    runner = FakeGh(
        [
            (has("label", "create"), completed_process(0, "")),
            _list_route([]),
        ]
    )

    issue_alerts.sync_alert_issue(
        repo=_REPO,
        title=_TITLE,
        label=_LABEL,
        body="recovered",
        should_exist=False,
        run_fn=runner,
    )

    assert [call[1] for call in runner.calls] == ["label", "issue"]


def test_sync_alert_issue_rejects_a_creation_without_a_url() -> None:
    """A silent create failure cannot be reported to the workflow as success."""
    runner = FakeGh(
        [
            _list_route([]),
            (has("label", "create"), completed_process(0, "")),
            (has("issue", "create"), completed_process(0, "  \n")),
        ]
    )

    with pytest.raises(GhError, match="returned no URL"):
        issue_alerts.sync_alert_issue(
            repo=_REPO,
            title=_TITLE,
            label=_LABEL,
            body="body",
            should_exist=True,
            run_fn=runner,
        )


@pytest.mark.parametrize(
    ("field", "value"),
    [("title", ""), ("title", "--repo"), ("label", ""), ("label", "-x")],
)
def test_sync_alert_issue_rejects_flag_like_identifiers(field: str, value: str) -> None:
    """Alert identifiers cannot smuggle a flag into the gh invocation."""
    kwargs: dict[str, object] = {"title": _TITLE, "label": _LABEL}
    kwargs[field] = value

    with pytest.raises(GhError, match="must not"):
        issue_alerts.sync_alert_issue(
            repo=_REPO,
            body="body",
            should_exist=True,
            run_fn=FakeGh([]),
            **kwargs,  # type: ignore[arg-type]
        )


@pytest.mark.parametrize(
    ("issue", "message"),
    [
        ({"number": "7", "title": _TITLE, "url": "https://x/7"}, "positive integer number"),
        ({"number": True, "title": _TITLE, "url": "https://x/7"}, "positive integer number"),
        ({"number": 0, "title": _TITLE, "url": "https://x/7"}, "positive integer number"),
        ({"number": 7, "title": _TITLE, "url": ""}, "non-empty url"),
    ],
)
def test_sync_alert_issue_validates_matched_issue_fields(
    issue: dict[str, object], message: str
) -> None:
    """A malformed match is rejected before any comment is posted."""
    runner = FakeGh(
        [
            (has("label", "create"), completed_process(0, "")),
            _list_route([issue]),
            (has("issue", "comment"), completed_process(0, "")),
        ]
    )

    with pytest.raises(GhError, match=message):
        issue_alerts.sync_alert_issue(
            repo=_REPO,
            title=_TITLE,
            label=_LABEL,
            body="body",
            should_exist=True,
            run_fn=runner,
        )

    assert not any("comment" in call for call in runner.calls)


def test_ensure_label_reports_a_failure_with_context() -> None:
    """A label failure names the label and repository it could not prepare."""
    runner = FakeGh([(has("label", "create"), completed_process(1, "", "denied"))])

    with pytest.raises(GhError, match=f"ensure alert label '{_LABEL}' on {_REPO}"):
        issue_alerts.ensure_label(_REPO, _LABEL, "desc", run_fn=runner)


def test_read_detail_prefers_a_file_and_rejects_both_sources(tmp_path: Path) -> None:
    """Detail comes from exactly one source."""
    detail_file = tmp_path / "detail.txt"
    detail_file.write_text("from file", encoding="utf-8")

    assert issue_alerts._read_detail("", str(detail_file)) == "from file"
    assert issue_alerts._read_detail("inline", None) == "inline"
    with pytest.raises(GhError, match="not both"):
        issue_alerts._read_detail("inline", str(detail_file))


def test_read_detail_rejects_a_non_utf8_file(tmp_path: Path) -> None:
    """A detail file that is not UTF-8 text fails with the path that could not decode."""
    detail_file = tmp_path / "detail.bin"
    detail_file.write_bytes(b"\xff\xfe not utf-8")

    with pytest.raises(GhError, match="must be UTF-8 text"):
        issue_alerts._read_detail("", str(detail_file))


def test_read_detail_reports_an_unreadable_file(tmp_path: Path) -> None:
    """A missing detail file fails with the path that could not be read."""
    with pytest.raises(GhError, match="Could not read alert detail file"):
        issue_alerts._read_detail("", str(tmp_path / "absent.txt"))


def test_main_resolves_the_repo_and_prints_the_issue_url(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Omitting --repo falls back to the detected repository."""
    monkeypatch.setattr(gh_runner, "resolve_repo", lambda **_kwargs: _REPO)
    monkeypatch.setattr(
        issue_alerts,
        "sync_alert_issue",
        lambda **kwargs: f"https://x/1?repo={kwargs['repo']}",
    )

    exit_code = issue_alerts.main(
        ["--title", _TITLE, "--label", _LABEL, "--run-url", _RUN_URL, "--state", "open"]
    )

    assert exit_code == 0
    assert capsys.readouterr().out.strip() == f"https://x/1?repo={_REPO}"


def test_main_prints_nothing_when_the_alert_is_closed(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A recovery sync produces no URL line for the workflow to capture."""
    monkeypatch.setattr(issue_alerts, "sync_alert_issue", lambda **_kwargs: "")

    exit_code = issue_alerts.main(
        [
            "--title",
            _TITLE,
            "--label",
            _LABEL,
            "--run-url",
            _RUN_URL,
            "--state",
            "close",
            "--repo",
            _REPO,
        ]
    )

    assert exit_code == 0
    assert capsys.readouterr().out == ""


def test_main_rejects_an_unsupported_state() -> None:
    """The parser constrains the state before any GitHub call happens."""
    with pytest.raises(SystemExit):
        issue_alerts.main(
            ["--title", _TITLE, "--label", _LABEL, "--run-url", _RUN_URL, "--state", "resolved"]
        )
