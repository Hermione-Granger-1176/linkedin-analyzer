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
    """Prose and incomplete target tokens are not interpreted as commands."""
    references = make_targets.extract_make_references(
        "Adding a new make target with a description makes it appear automatically.\n"
        "CI and local workflows use the same make targets.\n"
        "The two `make audit-memory-*` targets measure memory usage.\n"
        "Examples include `make lint-py=value` and `make lint-py.extra`.\n"
    )

    assert references == []


def test_extract_make_references_requires_standalone_make_command() -> None:
    """Executable-name substrings and paths are not mistaken for Make commands."""
    references = make_targets.extract_make_references(
        "Ignore `remake check-local`, `gmake check-local`, and `foo-make check-local`.\n"
        "Ignore `./make check-local` and `$make check-local`.\n"
        "Accept `make check-local&&make lint-py`.\n"
    )

    assert [reference.target for reference in references] == ["check-local", "lint-py"]


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
    """Missing, unscannable, and escaping paths are rejected together."""
    write_text(tmp_path / "Makefile", "help:\n\t@true\n")
    write_text(tmp_path / "notes.txt", "Use make help.\n")
    monkeypatch.setattr(check_make_targets, "REPO_ROOT", tmp_path)

    exit_code = check_make_targets.main(["missing.md", "notes.txt", "../outside.md"])

    captured = capsys.readouterr().out
    assert exit_code == 1
    assert "missing.md: path does not exist" in captured
    assert "notes.txt: path must be Markdown, YAML under .github" in captured
    assert "../outside.md: path must stay within the repository" in captured


def test_extract_source_code_snippets_requires_backticks() -> None:
    """Source prose is only a reference when the command is backticked."""
    references = make_targets.extract_path_make_references(
        Path("scripts/gh/pr_watch.py"),
        "# Run `make lint-py` first.\n"
        'raise GhError("inspect `make pr-review-comments` before merging")\n'
        "# We should make sure this works and make it fast.\n",
    )

    assert [reference.target for reference in references] == ["lint-py", "pr-review-comments"]


def test_extract_workflow_run_snippets_reads_block_scalars_and_inline_values() -> None:
    """Workflow shell is read directly, since every make word there is an invocation."""
    references = make_targets.extract_path_make_references(
        Path(".github/workflows/ci.yml"),
        "jobs:\n"
        "  build:\n"
        "    steps:\n"
        "      - name: Audit\n"
        "        run: |\n"
        "          make audit-node\n"
        "          make ci-alert-issue \\\n"
        "            title=x\n"
        "      - name: Lint\n"
        "        run: make lint-py\n"
        "      - name: Not shell\n"
        "        with:\n"
        "          args: make not-a-reference\n",
    )

    assert [reference.target for reference in references] == [
        "audit-node",
        "ci-alert-issue",
        "lint-py",
    ]


def test_extract_workflow_run_snippets_stops_at_the_next_key() -> None:
    """A block scalar ends at the next key rather than swallowing later steps."""
    snippets = make_targets.extract_workflow_run_snippets(
        "      - name: One\n        run: |\n          make lint-py\n      - name: Two\n"
    )

    assert [snippet.text for snippet in snippets] == ["make lint-py"]


def test_extract_workflow_run_snippets_stops_at_sibling_keys_of_a_dash_step() -> None:
    """A `- run: |` block ends at its own sibling keys, which sit left of the body."""
    snippets = make_targets.extract_workflow_run_snippets(
        "      - run: |\n"
        "          make lint-py\n"
        "        shell: bash\n"
        "        env:\n"
        "          CMD: make not-shell\n"
    )

    assert [snippet.text for snippet in snippets] == ["make lint-py"]


def test_extract_workflow_run_snippets_allows_a_comment_after_the_indicator() -> None:
    """A commented block indicator still opens a block, so its shell is not skipped."""
    snippets = make_targets.extract_workflow_run_snippets(
        "      - run: | # keep this in one step\n          make lint-py\n"
    )

    assert [snippet.text for snippet in snippets] == ["make lint-py"]


def test_extract_workflow_run_snippets_records_body_line_numbers() -> None:
    """Reported line numbers point at the shell line, not the run key."""
    snippets = make_targets.extract_workflow_run_snippets("steps:\n  run: |\n    make lint-py\n")

    assert [(snippet.line_number, snippet.text) for snippet in snippets] == [(3, "make lint-py")]


def test_extract_source_code_snippets_ignores_empty_backticks() -> None:
    """A backticked span holding only whitespace is not a command."""
    assert make_targets.extract_source_code_snippets("x = ` `  # ` `\n") == []


def test_extract_workflow_run_snippets_ignores_an_empty_run_value() -> None:
    """A `run:` key with no value and no block indicator yields nothing."""
    assert make_targets.extract_workflow_run_snippets("steps:\n  run:\n") == []


def test_extract_workflow_run_snippets_skips_blank_lines_inside_a_block() -> None:
    """Blank lines inside a block scalar neither end it nor become snippets."""
    snippets = make_targets.extract_workflow_run_snippets(
        "  run: |\n    make lint-py\n\n    make test-py\n"
    )

    assert [snippet.text for snippet in snippets] == ["make lint-py", "make test-py"]


def test_extract_path_make_references_returns_nothing_for_unscanned_paths() -> None:
    """An unscanned path yields no references even when its text names a target."""
    assert make_targets.extract_path_make_references(Path("notes.txt"), "run `make help`") == []


def test_is_test_path_covers_directory_and_filename_conventions() -> None:
    """Test fixtures naming absent targets are excluded by path convention."""
    assert make_targets.is_test_path(Path("tests/test_check_make_targets.py"))
    assert make_targets.is_test_path(Path("web/tests/tutorial.test.js"))
    assert make_targets.is_test_path(Path("e2e/smoke.spec.js"))
    assert make_targets.is_test_path(Path("scripts/gh/test_helper.py"))
    assert not make_targets.is_test_path(Path("scripts/gh/pr_watch.py"))
    assert not make_targets.is_test_path(Path("docs/development.md"))


def test_snippet_extractor_selects_a_rule_per_file_kind() -> None:
    """Each scanned kind gets the extractor that avoids its own false positives."""
    assert (
        make_targets.snippet_extractor(Path("README.md"))
        is make_targets.extract_markdown_code_snippets
    )
    assert (
        make_targets.snippet_extractor(Path(".github/workflows/ci.yml"))
        is make_targets.extract_workflow_run_snippets
    )
    assert (
        make_targets.snippet_extractor(Path(".github/actions/ci-setup/action.yml"))
        is make_targets.extract_workflow_run_snippets
    )
    # Scanned by directory rather than by an enumerated list of workflow paths,
    # so YAML with no `run:` key is read and simply yields nothing.
    assert (
        make_targets.snippet_extractor(Path(".github/dependabot.yml"))
        is make_targets.extract_workflow_run_snippets
    )
    assert (
        make_targets.snippet_extractor(Path("scripts/gh/pr_watch.py"))
        is make_targets.extract_source_code_snippets
    )


def test_snippet_extractor_skips_unscanned_paths() -> None:
    """Config YAML outside .github, test code, and other suffixes are not scanned."""
    assert make_targets.snippet_extractor(Path("config/anything.yml")) is None
    assert make_targets.snippet_extractor(Path("tests/test_pr_watch.py")) is None
    assert make_targets.snippet_extractor(Path("notes.txt")) is None
    assert make_targets.snippet_extractor(Path("web/src/styles.css")) is None


def test_iter_reference_files_covers_workflows_and_source_but_not_tests(tmp_path: Path) -> None:
    """The default scan reaches beyond Markdown without picking up fixtures."""
    write_text(tmp_path / "README.md", "# Root\n")
    write_text(tmp_path / ".github" / "workflows" / "ci.yml", "on: push\n")
    write_text(tmp_path / "scripts" / "tool.py", "x = 1\n")
    write_text(tmp_path / "tests" / "test_tool.py", "x = 1\n")
    write_text(tmp_path / "config" / "tool.yml", "x: 1\n")
    write_text(tmp_path / "node_modules" / "pkg" / "index.js", "x = 1\n")

    files = make_targets.iter_reference_files(tmp_path)

    assert sorted(path.relative_to(tmp_path).as_posix() for path in files) == [
        ".github/workflows/ci.yml",
        "README.md",
        "scripts/tool.py",
    ]


def test_run_check_reports_an_unknown_target_in_workflow_shell(tmp_path: Path) -> None:
    """A renamed target referenced by CI shell fails the lint, not the next CI run."""
    write_text(tmp_path / "Makefile", "lint-py:\n\t@true\n")
    workflow = tmp_path / ".github" / "workflows" / "ci.yml"
    write_text(workflow, "steps:\n  - run: |\n      make lint-py\n      make lint-typo\n")

    violations = check_make_targets.run_check(paths=[workflow], root=tmp_path)

    assert violations == [
        ".github/workflows/ci.yml:4: unknown Make target `lint-typo`",
    ]


def test_run_check_reports_an_unknown_target_in_source_strings(tmp_path: Path) -> None:
    """A wrong target named in an error message is caught before it misleads anyone."""
    write_text(tmp_path / "Makefile", "pr-review-comments:\n\t@true\n")
    module = tmp_path / "scripts" / "gh" / "pr_watch.py"
    write_text(module, 'raise GhError("inspect `make pr-comment-typo` before merging")\n')

    violations = check_make_targets.run_check(paths=[module], root=tmp_path)

    assert violations == [
        "scripts/gh/pr_watch.py:1: unknown Make target `pr-comment-typo`",
    ]


def test_resolve_requested_paths_reports_an_inaccessible_path(tmp_path: Path) -> None:
    """Descending through a regular file is reported, not raised as a traceback."""
    write_text(tmp_path / "README.md", "# Root\n")

    _, errors = check_make_targets.resolve_requested_paths(["README.md/nested.md"], tmp_path)

    assert errors == ["README.md/nested.md: path could not be accessed"]


def test_resolve_requested_paths_rejects_a_directory(tmp_path: Path) -> None:
    """A directory that merely looks like Markdown is not read as a file."""
    (tmp_path / "docs.md").mkdir()

    _, errors = check_make_targets.resolve_requested_paths(["docs.md"], tmp_path)

    assert errors == ["docs.md: path does not exist or is not a file"]


def test_resolve_requested_paths_rejects_a_path_resolving_outside(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A path that resolves out of the repository is refused before it is read."""
    write_text(tmp_path / "README.md", "# Root\n")
    outside = tmp_path.parent / f"{tmp_path.name}-outside" / "README.md"
    original = Path.resolve

    def escaping_resolve(self: Path, strict: bool = False) -> Path:
        """Resolve the candidate file to a location outside the repository."""
        if self.name == "README.md":
            return outside
        return original(self, strict=strict)

    monkeypatch.setattr(Path, "resolve", escaping_resolve)

    _, errors = check_make_targets.resolve_requested_paths(["README.md"], tmp_path)

    assert errors == ["README.md: path resolves outside the repository"]


def test_run_check_reports_a_candidate_outside_the_workspace(tmp_path: Path) -> None:
    """A candidate from outside the workspace is refused rather than read."""
    write_text(tmp_path / "Makefile", "help:\n\t@true\n")
    outside = tmp_path.parent / f"{tmp_path.name}-outside.md"

    violations = check_make_targets.run_check(paths=[outside], root=tmp_path)

    assert violations == [f"{outside}: path must stay within the repository"]


def test_run_check_surfaces_path_errors_for_candidates(tmp_path: Path) -> None:
    """A candidate that fails validation is reported instead of silently skipped."""
    write_text(tmp_path / "Makefile", "help:\n\t@true\n")

    violations = check_make_targets.run_check(paths=[tmp_path / "missing.md"], root=tmp_path)

    assert violations == ["missing.md: path does not exist"]


def test_main_without_paths_scans_the_whole_repository(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Omitting paths falls back to the full repository scan."""
    write_text(tmp_path / "Makefile", "help:\n\t@true\n")
    write_text(tmp_path / "README.md", "Use `make help`.\n")
    write_text(tmp_path / "scripts" / "tool.py", '"""Run `make help`."""\n')
    monkeypatch.setattr(check_make_targets, "REPO_ROOT", tmp_path)

    exit_code = check_make_targets.main([])

    assert exit_code == 0
    assert "Make target check passed for 2 file(s)" in capsys.readouterr().out


def test_run_check_ignores_absent_targets_in_test_fixtures(tmp_path: Path) -> None:
    """Checker fixtures may name targets that deliberately do not exist."""
    write_text(tmp_path / "Makefile", "help:\n\t@true\n")
    fixture = tmp_path / "tests" / "test_check_make_targets.py"
    write_text(fixture, 'doc = "Use `make missing-target`."\n')

    assert check_make_targets.run_check(root=tmp_path) == []


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
