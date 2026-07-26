from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from scripts.lint import check_doc_commands, make_targets

if TYPE_CHECKING:
    import pytest


def write_text(path: Path, content: str) -> None:
    """Write UTF-8 test content."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_parse_makefile_targets_skips_special_targets() -> None:
    """Only invokable target names are returned."""
    targets = make_targets.parse_makefile_targets(
        ".PHONY: lint\nsetup: install\nlint-js: ## Run eslint\n"
    )

    assert targets == {"setup", "lint-js"}


def test_extract_markdown_code_snippets_reads_inline_and_fenced_blocks() -> None:
    """Inline and fenced commands retain their source line numbers."""
    snippets = make_targets.extract_markdown_code_snippets(
        "Use `make help`.\n\n```bash\npytest\nmake test-py\n```\n"
    )

    assert snippets == [
        make_targets.CodeSnippet(line_number=1, text="make help"),
        make_targets.CodeSnippet(line_number=4, text="pytest"),
        make_targets.CodeSnippet(line_number=5, text="make test-py"),
    ]


def test_extract_markdown_code_snippets_skips_comments_and_blank_code() -> None:
    """Shell comments and blank inline spans are not commands."""
    snippets = make_targets.extract_markdown_code_snippets(
        "A blank ` ` span.\n```bash\n# pytest is wrapped by make test-py\npytest\n```\n"
    )

    assert snippets == [make_targets.CodeSnippet(line_number=4, text="pytest")]


def test_iter_default_paths_limits_command_lint_scope(tmp_path: Path) -> None:
    """Default command lint covers only contributor-facing documents."""
    for relative in check_doc_commands.DEFAULT_DOC_PATHS:
        write_text(tmp_path / relative, "# Contributor documentation\n")
    write_text(tmp_path / "docs" / "architecture.md", "# Internal\n")

    paths = check_doc_commands.iter_default_paths(tmp_path)

    assert paths == [tmp_path / relative for relative in check_doc_commands.DEFAULT_DOC_PATHS]


def test_find_replacement_targets_reports_compound_commands() -> None:
    """Raw commands inside a compound snippet map to their Make targets."""
    targets = check_doc_commands.find_replacement_targets(
        "make setup && pytest && npm run lint",
        {"setup", "test-py", "lint-js"},
    )

    assert targets == ["test-py", "lint-js"]


def test_find_replacement_targets_prefers_specific_full_match() -> None:
    """A specific command does not also trigger its broader partial rule."""
    targets = check_doc_commands.find_replacement_targets(
        "npm run test:e2e",
        {"test-e2e", "test-js"},
    )

    assert targets == ["test-e2e"]


def test_find_replacement_targets_deduplicates_repeated_targets() -> None:
    """Equivalent commands emit one replacement target."""
    targets = check_doc_commands.find_replacement_targets(
        "pip-audit && npm audit",
        {"security"},
    )

    assert targets == ["security"]


def test_find_replacement_targets_covers_lock_and_format_commands() -> None:
    """Dependency and formatting commands map to supported wrappers."""
    targets = check_doc_commands.find_replacement_targets(
        "npm install --package-lock-only && uv lock && npm run lint -- --fix",
        {"lock-node", "lock", "fmt-js"},
    )

    assert targets == ["lock-node", "lock", "fmt-js"]


def test_find_replacement_targets_ignores_make_and_descriptive_mentions() -> None:
    """Make invocations and prose tool descriptions are not violations."""
    assert check_doc_commands.find_replacement_targets("make test-py", {"test-py"}) == []
    assert check_doc_commands.find_replacement_targets("ruff scans Python files", {"lint-py"}) == []


def test_check_doc_commands_reports_direct_commands(tmp_path: Path) -> None:
    """Actionable direct commands produce greppable replacement messages."""
    write_text(tmp_path / "Makefile", "test-py:\n\t@true\nlint-js:\n\t@true\n")
    doc_path = tmp_path / "README.md"
    write_text(
        doc_path,
        "Use `python -m pytest --ignore=tests/browser` and `npm run lint`.\n",
    )

    violations = check_doc_commands.run_check(paths=[doc_path], root=tmp_path)

    assert violations == [
        "README.md:1: use `make test-py` instead of `python -m pytest --ignore=tests/browser`",
        "README.md:1: use `make lint-js` instead of `npm run lint`",
    ]


def test_check_doc_commands_flags_fenced_and_step_commands(tmp_path: Path) -> None:
    """Fenced commands, checklist items, and ordered steps are actionable."""
    write_text(tmp_path / "Makefile", "test-py:\n\t@true\n")
    doc_path = tmp_path / "README.md"
    write_text(doc_path, "```bash\npytest\n```\n- [ ] `pytest`\n1. `pytest`\n")

    violations = check_doc_commands.run_check(paths=[doc_path], root=tmp_path)

    assert violations == [
        "README.md:2: use `make test-py` instead of `pytest`",
        "README.md:4: use `make test-py` instead of `pytest`",
        "README.md:5: use `make test-py` instead of `pytest`",
    ]


def test_check_doc_commands_ignores_descriptive_and_negated_commands(tmp_path: Path) -> None:
    """Descriptive lists and explicit prohibitions remain valid guidance."""
    write_text(tmp_path / "Makefile", "lint-py:\n\t@true\ntest-py:\n\t@true\n")
    doc_path = tmp_path / "README.md"
    write_text(
        doc_path,
        "- `pytest` enforces coverage for Python tests.\n"
        "- `ruff` scans Python files.\n"
        "Do not run `pytest` directly.\n",
    )

    assert check_doc_commands.run_check(paths=[doc_path], root=tmp_path) == []


def test_check_doc_commands_scopes_negation_to_current_clause(tmp_path: Path) -> None:
    """A negation does not hide an actionable command in a later clause."""
    write_text(tmp_path / "Makefile", "test-py:\n\t@true\nlint-js:\n\t@true\n")
    doc_path = tmp_path / "README.md"
    write_text(doc_path, "Do not run `pytest`; instead run `npm run lint`.\n")

    violations = check_doc_commands.run_check(paths=[doc_path], root=tmp_path)

    assert violations == ["README.md:1: use `make lint-js` instead of `npm run lint`"]


def test_check_doc_commands_tracks_repeated_inline_snippet_occurrences(tmp_path: Path) -> None:
    """Identical snippets in separate clauses keep independent actionability."""
    write_text(tmp_path / "Makefile", "test-py:\n\t@true\n")
    doc_path = tmp_path / "README.md"
    write_text(doc_path, "Do not run `pytest`; instead run `pytest`.\n")

    violations = check_doc_commands.run_check(paths=[doc_path], root=tmp_path)

    assert violations == ["README.md:1: use `make test-py` instead of `pytest`"]


def test_check_doc_commands_preserves_padded_inline_code(tmp_path: Path) -> None:
    """Whitespace inside backticks does not bypass negation analysis."""
    write_text(tmp_path / "Makefile", "test-py:\n\t@true\n")
    doc_path = tmp_path / "README.md"
    write_text(doc_path, "Do not run ` pytest ` directly.\n")

    assert check_doc_commands.run_check(paths=[doc_path], root=tmp_path) == []


def test_check_doc_commands_keeps_negation_across_neighboring_code_spans(
    tmp_path: Path,
) -> None:
    """Punctuation and verbs inside code spans do not strand a negation."""
    write_text(tmp_path / "Makefile", "web:\n\t@true\n")
    doc_path = tmp_path / "README.md"
    write_text(
        doc_path,
        "Never run `.venv/bin/*`, `pytest`, `npm run`, `npx`, or `vite` directly.\n",
    )

    assert check_doc_commands.run_check(paths=[doc_path], root=tmp_path) == []


def test_run_check_rejects_default_path_symlink(tmp_path: Path) -> None:
    """Default contributor documents cannot read through symbolic links."""
    write_text(tmp_path / "Makefile", "test-py:\n\t@true\n")
    target = tmp_path / "target.md"
    write_text(target, "Run `make test-py`.\n")
    (tmp_path / "README.md").symlink_to(target)

    violations = check_doc_commands.run_check(root=tmp_path)

    assert violations == ["README.md: symbolic links are not supported"]


def test_run_check_reports_non_utf8_markdown(tmp_path: Path) -> None:
    """Invalid UTF-8 contributor documents fail without a traceback."""
    write_text(tmp_path / "Makefile", "test-py:\n\t@true\n")
    doc_path = tmp_path / "README.md"
    doc_path.write_bytes(b"\x80bad")

    violations = check_doc_commands.run_check(paths=[doc_path], root=tmp_path)

    assert violations == ["README.md: not valid UTF-8 text (invalid start byte)"]


def test_main_uses_default_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The CLI discovers existing contributor documents by default."""
    write_text(tmp_path / "Makefile", "test-py:\n\t@true\n")
    write_text(tmp_path / "README.md", "Run `make test-py`.\n")
    write_text(tmp_path / ".github" / "CONTRIBUTING.md", "Use `make test-py`.\n")
    monkeypatch.setattr(check_doc_commands, "REPO_ROOT", tmp_path)

    exit_code = check_doc_commands.main([])

    assert exit_code == 0
    assert capsys.readouterr().out.strip() == "Command lint passed for 2 file(s)"


def test_main_reports_rule_failures_consistently(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Rule failures include shared CI context and indented details."""
    write_text(tmp_path / "Makefile", "test-py:\n\t@true\n")
    write_text(tmp_path / "README.md", "Run `pytest`.\n")
    monkeypatch.setattr(check_doc_commands, "REPO_ROOT", tmp_path)

    exit_code = check_doc_commands.main(["README.md"])

    captured = capsys.readouterr().out
    assert exit_code == 1
    assert captured.startswith("Command lint failed:\n")
    assert "  README.md:1: use `make test-py` instead of `pytest`" in captured


def test_main_rejects_invalid_target_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Missing, non-Markdown, and escaping paths are rejected together."""
    write_text(tmp_path / "Makefile", "test-py:\n\t@true\n")
    write_text(tmp_path / "notes.txt", "Run pytest.\n")
    monkeypatch.setattr(check_doc_commands, "REPO_ROOT", tmp_path)

    exit_code = check_doc_commands.main(["missing.md", "notes.txt", "../outside.md"])

    captured = capsys.readouterr().out
    assert exit_code == 1
    assert captured.startswith("Command lint failed:\n")
    assert "missing.md: path does not exist" in captured
    assert "notes.txt: path must be a Markdown file" in captured
    assert "../outside.md: path must stay within the repository" in captured


def test_main_rejects_symlink_components(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Explicit paths cannot traverse file or directory symbolic links."""
    write_text(tmp_path / "Makefile", "test-py:\n\t@true\n")
    target = tmp_path / "target.md"
    write_text(target, "Run `make test-py`.\n")
    (tmp_path / "linked.md").symlink_to(target)
    target_directory = tmp_path / "target-directory"
    write_text(target_directory / "guide.md", "Run `make test-py`.\n")
    (tmp_path / "linked-directory").symlink_to(target_directory, target_is_directory=True)
    monkeypatch.setattr(check_doc_commands, "REPO_ROOT", tmp_path)

    exit_code = check_doc_commands.main(["linked.md", "linked-directory/guide.md"])

    captured = capsys.readouterr().out
    assert exit_code == 1
    assert captured.count("symbolic links are not supported") == 2


def test_mask_inline_code_preserves_offsets_and_blanks_contents() -> None:
    """Masking keeps line length stable for clause analysis."""
    masked = check_doc_commands._mask_inline_code("Run `npm run` then `a.b` now")

    assert masked == "Run `_______` then `___` now"
