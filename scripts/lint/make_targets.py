"""Shared Markdown, workflow, source, and Makefile parsing for repository checks."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from scripts.lint import SKIP_DIRECTORIES, iter_lint_paths

if TYPE_CHECKING:
    from collections.abc import Callable

REPO_ROOT = Path(__file__).resolve().parents[2]
MAKEFILE_PATH = REPO_ROOT / "Makefile"
MARKDOWN_SUFFIX = ".md"
SOURCE_SUFFIXES = frozenset({".py", ".mjs", ".js"})
WORKFLOW_SUFFIXES = frozenset({".yml", ".yaml"})
WORKFLOW_ROOT = ".github"
TEST_DIRECTORY_NAMES = frozenset({"tests", "test", "e2e", "__tests__"})
TARGET_PATTERN = re.compile(r"^([A-Za-z][A-Za-z0-9_-]*):(?!=)", re.MULTILINE)
GROUP_PATTERN = re.compile(
    r"^# ─── .+? @([A-Za-z][A-Za-z0-9_-]*) .*",
    re.MULTILINE,
)
MAKE_REFERENCE_PATTERN = re.compile(
    r"(?<![A-Za-z0-9_./$-])"
    r"(?:[A-Z_][A-Z0-9_]*=(?:\"[^\"]*\"|'[^']*'|[^\s\"']+)\s+)*"
    r"make\s+([A-Za-z][A-Za-z0-9_-]*)\b"
    r"(?![A-Za-z0-9_?*./:=+%-])"
)
INLINE_CODE_PATTERN = re.compile(r"`([^`\n]+)`")
RUN_KEY_PATTERN = re.compile(r"^(\s*)(?:-\s+)?run:\s*(.*)$")
BLOCK_SCALAR_PATTERN = re.compile(r"^[|>][+-]?\d*$")


@dataclass(frozen=True)
class CodeSnippet:
    """One inline-code or fenced-code snippet extracted from Markdown."""

    line_number: int
    text: str
    column_start: int | None = field(default=None, compare=False)


@dataclass(frozen=True)
class MakeReference:
    """One documented ``make <target>`` reference."""

    target: str
    line_number: int
    snippet: str


def parse_makefile_targets(content: str) -> set[str]:
    """Return invokable target names declared in Makefile content."""
    targets = {
        match.group(1)
        for match in TARGET_PATTERN.finditer(content)
        if not match.group(1).startswith(".")
    }
    if re.search(r"^help-%:", content, re.MULTILINE):
        targets.update(f"help-{slug}" for slug in GROUP_PATTERN.findall(content))
    return targets


def load_makefile_targets(path: Path | None = None) -> set[str]:
    """Load target names from the repository Makefile."""
    makefile_path = path or MAKEFILE_PATH
    return parse_makefile_targets(makefile_path.read_text(encoding="utf-8"))


def iter_markdown_files(root: Path) -> list[Path]:
    """Return Markdown paths while pruning ignored and symlinked directories."""
    files: list[Path] = []
    for current_root, directory_names, file_names in os.walk(
        root,
        topdown=True,
        followlinks=False,
    ):
        current_path = Path(current_root)
        directory_names[:] = sorted(
            name
            for name in directory_names
            if name not in SKIP_DIRECTORIES and not (current_path / name).is_symlink()
        )
        files.extend(
            path
            for name in sorted(file_names)
            if (path := current_path / name).suffix.lower() == ".md"
            and path.is_file()
            and not path.is_symlink()
        )
    return files


def extract_markdown_code_snippets(text: str) -> list[CodeSnippet]:
    """Extract inline-code and fenced-code snippets from Markdown text."""
    snippets: list[CodeSnippet] = []
    in_code_fence = False
    for line_number, line in enumerate(text.splitlines(), start=1):
        if line.strip().startswith("```"):
            in_code_fence = not in_code_fence
            continue

        if in_code_fence:
            snippet = line.strip()
            if snippet and not snippet.startswith("#"):
                snippets.append(CodeSnippet(line_number=line_number, text=snippet))
            continue

        for match in INLINE_CODE_PATTERN.finditer(line):
            snippet = match.group(1)
            if snippet.strip():
                snippets.append(
                    CodeSnippet(
                        line_number=line_number,
                        text=snippet,
                        column_start=match.start(),
                    )
                )
    return snippets


def extract_source_code_snippets(text: str) -> list[CodeSnippet]:
    """Extract backticked spans from source comments, docstrings, and strings.

    Source files mix prose with commands, and an unquoted scan would read
    ordinary English such as "make sure" as a target reference. Backticks are
    the convention this repository already uses when naming a command inside a
    string, so they are what marks a span as a real reference.
    """
    snippets: list[CodeSnippet] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        for match in INLINE_CODE_PATTERN.finditer(line):
            snippet = match.group(1)
            if snippet.strip():
                snippets.append(
                    CodeSnippet(
                        line_number=line_number,
                        text=snippet,
                        column_start=match.start(),
                    )
                )
    return snippets


def extract_workflow_run_snippets(text: str) -> list[CodeSnippet]:
    """Extract shell lines from workflow and composite-action ``run:`` values.

    A ``run:`` value is shell, so every ``make`` word in it is a real
    invocation. These are the references that break CI silently when a target
    is renamed, which is why they are read directly rather than via backticks.
    """
    snippets: list[CodeSnippet] = []
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        match = RUN_KEY_PATTERN.match(lines[index])
        index += 1
        if match is None:
            continue

        indent, value = match.group(1), match.group(2).strip()
        if not BLOCK_SCALAR_PATTERN.match(value):
            if value:
                snippets.append(CodeSnippet(line_number=index, text=value))
            continue

        while index < len(lines):
            body = lines[index]
            stripped = body.strip()
            if stripped and len(body) - len(body.lstrip()) <= len(indent):
                break
            if stripped:
                snippets.append(CodeSnippet(line_number=index + 1, text=stripped))
            index += 1
    return snippets


def is_test_path(relative_path: Path) -> bool:
    """Return whether a repository-relative path holds test code.

    Test files legitimately name targets that do not exist, as fixtures for
    the checkers themselves, so they are excluded from source scanning.
    """
    if any(part in TEST_DIRECTORY_NAMES for part in relative_path.parts):
        return True
    name = relative_path.name
    return name.startswith("test_") or ".test." in name or ".spec." in name


def snippet_extractor(relative_path: Path) -> Callable[[str], list[CodeSnippet]] | None:
    """Return the snippet extractor for a path, or ``None`` when unscanned."""
    suffix = relative_path.suffix.lower()
    if suffix == MARKDOWN_SUFFIX:
        return extract_markdown_code_snippets
    if is_test_path(relative_path):
        return None
    if suffix in WORKFLOW_SUFFIXES and relative_path.parts[:1] == (WORKFLOW_ROOT,):
        return extract_workflow_run_snippets
    if suffix in SOURCE_SUFFIXES:
        return extract_source_code_snippets
    return None


def iter_reference_files(root: Path) -> list[Path]:
    """Return every file whose ``make`` references are validated."""
    return [
        path
        for path in iter_lint_paths(root)
        if snippet_extractor(path.relative_to(root)) is not None
    ]


def extract_make_references(text: str) -> list[MakeReference]:
    """Extract documented ``make <target>`` references from Markdown code."""
    return _references_from_snippets(extract_markdown_code_snippets(text))


def extract_path_make_references(relative_path: Path, text: str) -> list[MakeReference]:
    """Extract ``make <target>`` references using the rule for the path's kind."""
    extractor = snippet_extractor(relative_path)
    if extractor is None:
        return []
    return _references_from_snippets(extractor(text))


def _references_from_snippets(snippets: list[CodeSnippet]) -> list[MakeReference]:
    """Return every ``make <target>`` reference found in extracted snippets."""
    references: list[MakeReference] = []
    for code_snippet in snippets:
        for match in MAKE_REFERENCE_PATTERN.finditer(code_snippet.text):
            references.append(
                MakeReference(
                    target=match.group(1),
                    line_number=code_snippet.line_number,
                    snippet=match.group(0).strip(),
                )
            )
    return references
