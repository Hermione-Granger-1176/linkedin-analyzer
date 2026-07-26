from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from scripts.lint import check_make_targets, make_targets

if TYPE_CHECKING:
    import pytest


def write_text(path: Path, content: str) -> None:
    """Write UTF-8 test content."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_parse_makefile_targets_adds_dynamic_group_help_targets() -> None:
    """Dynamic help targets are derived from documented Makefile groups."""
    targets = make_targets.parse_makefile_targets(
        "# ─── Pull requests @pr ───\n"
        "pr: ## PR commands\n"
        "# ─── Quality gates @quality ───\n"
        "check-local: ## Run checks\n"
        "help-%: ## List one group\n"
    )

    assert {"pr", "check-local", "help-pr", "help-quality"}.issubset(targets)


def test_parse_makefile_targets_does_not_invent_group_help_without_pattern() -> None:
    """Group comments alone do not create invokable help targets."""
    targets = make_targets.parse_makefile_targets(
        "# ─── Pull requests @pr ───\npr: ## PR commands\n"
    )

    assert "help-pr" not in targets


def test_extract_make_references_handles_environment_prefixes() -> None:
    """Environment-prefixed Make commands retain target and source context."""
    references = make_targets.extract_make_references(
        "Use `make check-local`.\n"
        'Run `ARTIFACTS_BROWSER_APP_SLUGS="demo" make test-browser-apps`.\n'
        "Generic `make <target>` guidance is ignored.\n"
    )

    assert references == [
        make_targets.MakeReference(
            target="check-local",
            line_number=1,
            snippet="make check-local",
        ),
        make_targets.MakeReference(
            target="test-browser-apps",
            line_number=2,
            snippet='ARTIFACTS_BROWSER_APP_SLUGS="demo" make test-browser-apps',
        ),
    ]


def test_extract_make_references_ignores_plain_prose() -> None:
    """Plain prose and wildcard target families are not interpreted as commands."""
    references = make_targets.extract_make_references(
        "Adding a new make target with a description makes it appear automatically.\n"
        "CI and local workflows use the same make targets.\n"
        "The two `make audit-memory-*` targets measure memory usage.\n"
    )

    assert references == []


def test_iter_markdown_files_prunes_local_and_dependency_directories(tmp_path: Path) -> None:
    """Repository scans prune ignored directories before descent."""
    write_text(tmp_path / "README.md", "# Root\n")
    write_text(tmp_path / "docs" / "guide.md", "# Guide\n")
    write_text(tmp_path / "node_modules" / "pkg" / "README.md", "# Ignore\n")
    write_text(tmp_path / ".agents" / "notes" / "README.md", "# Ignore\n")
    write_text(tmp_path / ".claude" / "memory" / "README.md", "# Ignore\n")
    write_text(tmp_path / ".codex" / "notes" / "README.md", "# Ignore\n")

    files = make_targets.iter_markdown_files(tmp_path)

    assert files == [tmp_path / "README.md", tmp_path / "docs" / "guide.md"]


def test_iter_markdown_files_does_not_follow_directory_symlinks(tmp_path: Path) -> None:
    """Repository scans do not traverse symlinked directories."""
    external = tmp_path.parent / f"{tmp_path.name}-external-docs"
    write_text(external / "outside.md", "# Outside\n")
    (tmp_path / "linked-docs").symlink_to(external, target_is_directory=True)

    assert make_targets.iter_markdown_files(tmp_path) == []


def test_check_file_reports_unknown_target(tmp_path: Path) -> None:
    """Unknown target references include path and line context."""
    write_text(tmp_path / "Makefile", "check-local:\n\t@true\n")
    doc_path = tmp_path / "README.md"
    write_text(doc_path, "Run `make check-local` and `make missing-target`.\n")

    violations = check_make_targets.run_check(paths=[doc_path], root=tmp_path)

    assert violations == ["README.md:1: unknown Make target `missing-target`"]


def test_check_file_accepts_dynamic_help_target(tmp_path: Path) -> None:
    """Documented dynamic group help targets are recognized."""
    write_text(
        tmp_path / "Makefile",
        "# ─── Pull requests @pr ───\npr:\n\t@true\nhelp-%:\n\t@true\n",
    )
    doc_path = tmp_path / "README.md"
    write_text(doc_path, "Run `make help-pr`.\n")

    assert check_make_targets.run_check(paths=[doc_path], root=tmp_path) == []


def test_run_check_reports_non_utf8_markdown(tmp_path: Path) -> None:
    """Invalid UTF-8 documentation fails without a traceback."""
    write_text(tmp_path / "Makefile", "help:\n\t@true\n")
    doc_path = tmp_path / "README.md"
    doc_path.write_bytes(b"\x80bad")

    violations = check_make_targets.run_check(paths=[doc_path], root=tmp_path)

    assert violations == ["README.md: not valid UTF-8 text (invalid start byte)"]


def test_run_check_skips_default_path_symlink(tmp_path: Path) -> None:
    """Default scans skip Markdown symlinks instead of reading their targets."""
    write_text(tmp_path / "Makefile", "help:\n\t@true\n")
    target = tmp_path / "target.md"
    write_text(target, "Run `make help`.\n")
    (tmp_path / "README.md").symlink_to(target)

    violations = check_make_targets.run_check(root=tmp_path)

    assert violations == []


def test_main_reports_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The CLI reports the number of checked Markdown files."""
    write_text(tmp_path / "Makefile", "help:\n\t@true\ncheck-local:\n\t@true\n")
    write_text(tmp_path / "README.md", "Use `make check-local`.\n")
    monkeypatch.setattr(check_make_targets, "REPO_ROOT", tmp_path)

    exit_code = check_make_targets.main(["README.md"])

    assert exit_code == 0
    assert "Make target check passed for 1 file(s) against Makefile" in capsys.readouterr().out


def test_main_reports_unknown_targets_consistently(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Unknown targets use shared CI failure context."""
    write_text(tmp_path / "Makefile", "check-local:\n\t@true\n")
    write_text(tmp_path / "README.md", "Use `make missing-target`.\n")
    monkeypatch.setattr(check_make_targets, "REPO_ROOT", tmp_path)

    exit_code = check_make_targets.main(["README.md"])

    captured = capsys.readouterr().out
    assert exit_code == 1
    assert captured.startswith("Make target check failed:\n")
    assert "  README.md:1: unknown Make target `missing-target`" in captured


def test_main_rejects_invalid_paths_together(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Missing, non-Markdown, and escaping paths are rejected together."""
    write_text(tmp_path / "Makefile", "help:\n\t@true\n")
    write_text(tmp_path / "notes.txt", "Use make help.\n")
    monkeypatch.setattr(check_make_targets, "REPO_ROOT", tmp_path)

    exit_code = check_make_targets.main(["missing.md", "notes.txt", "../outside.md"])

    captured = capsys.readouterr().out
    assert exit_code == 1
    assert "missing.md: path does not exist" in captured
    assert "notes.txt: path must be a Markdown file" in captured
    assert "../outside.md: path must stay within the repository" in captured


def test_main_rejects_symlink_components(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Explicit paths cannot traverse file or directory symbolic links."""
    write_text(tmp_path / "Makefile", "help:\n\t@true\n")
    target = tmp_path / "target.md"
    write_text(target, "Use `make help`.\n")
    (tmp_path / "linked.md").symlink_to(target)
    directory = tmp_path / "directory"
    write_text(directory / "guide.md", "Use `make help`.\n")
    (tmp_path / "linked-directory").symlink_to(directory, target_is_directory=True)
    monkeypatch.setattr(check_make_targets, "REPO_ROOT", tmp_path)

    exit_code = check_make_targets.main(["linked.md", "linked-directory/guide.md"])

    captured = capsys.readouterr().out
    assert exit_code == 1
    assert captured.count("symbolic links are not supported") == 2
