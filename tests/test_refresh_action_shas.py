from __future__ import annotations

from pathlib import Path

import pytest
from scripts.ci import refresh_action_shas as ras

SHA_A = "a" * 40
SHA_B = "b" * 40


def fixed_resolver(sha: str = SHA_A) -> ras.ResolveSha:
    """Return a resolver that always yields the same SHA."""
    return lambda _action, _ref: sha


def test_is_pinnable_skips_local_docker_and_templated() -> None:
    """Local, Docker, and templated action refs are never pinned."""
    assert not ras.is_pinnable("./.github/actions/ci-setup", "main")
    assert not ras.is_pinnable("docker://alpine", "3.20")
    assert not ras.is_pinnable("${{ matrix.action }}", "v1")


def test_is_pinnable_skips_existing_sha() -> None:
    """A ref that is already a 40-hex SHA needs no change; a tag does."""
    assert not ras.is_pinnable("actions/checkout", SHA_A)
    assert ras.is_pinnable("actions/checkout", "v4")


def test_update_line_rewrites_tag_and_adds_comment() -> None:
    """A tag ref is rewritten to a SHA with the tag preserved as a comment."""
    line, changed = ras.update_line("  - uses: actions/checkout@v4", fixed_resolver())
    assert changed
    assert line == f"  - uses: actions/checkout@{SHA_A} # v4"


def test_update_line_preserves_existing_comment() -> None:
    """An existing trailing comment is kept rather than replaced."""
    line, changed = ras.update_line("      uses: actions/setup-node@v6  # pinned", fixed_resolver())
    assert changed
    assert line == f"      uses: actions/setup-node@{SHA_A}  # pinned"


def test_update_line_ignores_non_uses_and_local() -> None:
    """Non-`uses` lines and local action refs pass through untouched."""
    assert ras.update_line("name: CI", fixed_resolver()) == ("name: CI", False)
    local = "      uses: ./.github/actions/ci-setup"
    assert ras.update_line(local, fixed_resolver()) == (local, False)


def test_update_text_reports_no_change_when_all_pinned() -> None:
    """Text with only pinned refs is returned unchanged."""
    text = f"jobs:\n  uses: actions/checkout@{SHA_A}\n"
    assert ras.update_text(text, fixed_resolver()) == (text, False)


def test_update_text_rewrites_and_terminates_with_newline() -> None:
    """Rewritten text keeps untouched lines and ends with a newline."""
    text = "  - uses: actions/checkout@v4\n  - run: echo hi\n"
    new_text, changed = ras.update_text(text, fixed_resolver())
    assert changed
    assert new_text == f"  - uses: actions/checkout@{SHA_A} # v4\n  - run: echo hi\n"


def test_iter_workflow_files_sorted_and_skips_missing(tmp_path: Path) -> None:
    """YAML files are returned sorted; missing roots are skipped."""
    root = tmp_path / "workflows"
    root.mkdir()
    (root / "b.yml").write_text("", encoding="utf-8")
    (root / "a.yaml").write_text("", encoding="utf-8")
    (root / "ignore.txt").write_text("", encoding="utf-8")

    files = ras.iter_workflow_files([root, tmp_path / "missing"])

    assert files == [root / "a.yaml", root / "b.yml"]


def test_refresh_files_writes_only_changed(tmp_path: Path) -> None:
    """Only files with a rewritten ref are written back."""
    root = tmp_path / "workflows"
    root.mkdir()
    changed_file = root / "ci.yml"
    changed_file.write_text("  - uses: actions/checkout@v4\n", encoding="utf-8")
    pinned_file = root / "pinned.yml"
    pinned_file.write_text(f"  - uses: actions/checkout@{SHA_A}\n", encoding="utf-8")

    changed = ras.refresh_files([root], fixed_resolver(SHA_B))

    assert changed == [changed_file]
    assert changed_file.read_text(encoding="utf-8") == (
        f"  - uses: actions/checkout@{SHA_B} # v4\n"
    )


def test_make_resolver_caches_per_repo_ref() -> None:
    """A repo+ref pair is fetched once and reused for the same repo."""
    calls: list[tuple[str, str]] = []

    def fetch(repo: str, ref: str) -> str:
        calls.append((repo, ref))
        return SHA_A

    resolve = ras.make_resolver(fetch)
    assert resolve("actions/checkout", "v4") == SHA_A
    assert resolve("actions/checkout/sub", "v4") == SHA_A  # same repo+ref, cached
    assert calls == [("actions/checkout", "v4")]


def test_make_resolver_retries_then_succeeds() -> None:
    """A transient failure is retried after a backoff sleep."""
    attempts = {"n": 0}
    slept: list[float] = []

    def fetch(_repo: str, _ref: str) -> str:
        attempts["n"] += 1
        if attempts["n"] < 2:
            raise RuntimeError("transient")
        return SHA_A

    resolve = ras.make_resolver(fetch, sleep=slept.append)
    assert resolve("actions/checkout", "v4") == SHA_A
    assert attempts["n"] == 2
    assert slept == [0.25]


def test_make_resolver_raises_after_max_attempts() -> None:
    """The last error is raised once all attempts are exhausted."""

    def fetch(_repo: str, _ref: str) -> str:
        raise RuntimeError("always fails")

    resolve = ras.make_resolver(fetch, max_attempts=2, sleep=lambda _s: None)
    with pytest.raises(RuntimeError, match="always fails"):
        resolve("actions/checkout", "v4")


def test_main_requires_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """`main` exits non-zero when GH_TOKEN is absent."""
    monkeypatch.delenv("GH_TOKEN", raising=False)
    assert ras.main([]) == 1


def test_main_refreshes_files(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`main` rewrites refs across the configured roots and reports them."""
    root = tmp_path / "workflows"
    root.mkdir()
    target = root / "ci.yml"
    target.write_text("  - uses: actions/checkout@v4\n", encoding="utf-8")

    def fake_fetch(_repo: str, _ref: str, token: str) -> str:
        assert token == "token"
        return SHA_A

    monkeypatch.setenv("GH_TOKEN", "token")
    monkeypatch.setattr(ras, "WORKFLOW_ROOTS", (root,))
    monkeypatch.setattr(ras, "github_fetch", fake_fetch)

    assert ras.main([]) == 0
    assert target.read_text(encoding="utf-8") == f"  - uses: actions/checkout@{SHA_A} # v4\n"
    assert "Updated" in capsys.readouterr().out
