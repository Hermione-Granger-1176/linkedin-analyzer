"""Shared Markdown and Makefile parsing for repository documentation checks."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from scripts.lint import SKIP_DIRECTORIES

REPO_ROOT = Path(__file__).resolve().parents[2]
MAKEFILE_PATH = REPO_ROOT / "Makefile"
TARGET_PATTERN = re.compile(r"^([A-Za-z][A-Za-z0-9_-]*):(?!=)", re.MULTILINE)
GROUP_PATTERN = re.compile(
    r"^# ─── .+? @([A-Za-z][A-Za-z0-9_-]*) .*",
    re.MULTILINE,
)
MAKE_REFERENCE_PATTERN = re.compile(
    r"(?:[A-Z_][A-Z0-9_]*=(?:\"[^\"]*\"|'[^']*'|[^\s\"']+)\s+)*"
    r"make\s+([A-Za-z][A-Za-z0-9_-]*)\b(?![A-Za-z0-9_?*-])"
)
INLINE_CODE_PATTERN = re.compile(r"`([^`\n]+)`")


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


def extract_make_references(text: str) -> list[MakeReference]:
    """Extract documented ``make <target>`` references from Markdown code."""
    references: list[MakeReference] = []
    for code_snippet in extract_markdown_code_snippets(text):
        for match in MAKE_REFERENCE_PATTERN.finditer(code_snippet.text):
            references.append(
                MakeReference(
                    target=match.group(1),
                    line_number=code_snippet.line_number,
                    snippet=match.group(0).strip(),
                )
            )
    return references
