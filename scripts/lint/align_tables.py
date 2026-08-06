#!/usr/bin/env python3
"""Align Markdown table pipes so columns line up visually."""

from __future__ import annotations

import re
import sys
from pathlib import Path

from scripts import REPO_ROOT
from scripts.lint import iter_lint_paths

SEPARATOR_PATTERN = re.compile(r"^[\s|:*-]+$")


def is_table_line(line: str) -> bool:
    """Return whether a line looks like a Markdown table row."""
    stripped = line.strip()
    return "|" in stripped and stripped.startswith("|") and stripped.endswith("|")


def split_cells(line: str) -> list[str]:
    """Split a table row into cell contents, stripping the outer pipes."""
    stripped = line.strip()
    if stripped.startswith("|"):
        stripped = stripped[1:]
    if stripped.endswith("|"):
        stripped = stripped[:-1]
    return [cell.strip() for cell in stripped.split("|")]


def is_separator_row(cells: list[str]) -> bool:
    """Return whether every cell matches the Markdown separator pattern."""
    return all(SEPARATOR_PATTERN.match(cell) for cell in cells)


def build_separator(widths: list[int], original_cells: list[str]) -> str:
    """Rebuild a separator row while preserving alignment markers."""
    parts = []
    for width, raw_cell in zip(widths, original_cells, strict=True):
        cell = raw_cell.strip()
        left_colon = cell.startswith(":")
        right_colon = cell.endswith(":")
        parts.append(
            (":" if left_colon else "")
            + "-" * (width - int(left_colon) - int(right_colon))
            + (":" if right_colon else "")
        )
    return "| " + " | ".join(parts) + " |"


def align_table(lines: list[str]) -> list[str]:
    """Align a block of table lines so pipe characters line up vertically."""
    rows = [split_cells(line) for line in lines]
    column_count = max(len(row) for row in rows)
    rows = [row + [""] * (column_count - len(row)) for row in rows]
    content_rows = [row for row in rows if not is_separator_row(row)]
    widths = [
        max(3, max((len(row[column]) for row in content_rows), default=0))
        for column in range(column_count)
    ]

    return [
        build_separator(widths, row)
        if is_separator_row(row)
        else "| " + " | ".join(cell.ljust(widths[index]) for index, cell in enumerate(row)) + " |"
        for row in rows
    ]


def process_file(path: Path) -> bool:
    """Align every Markdown table in a file and report whether it changed."""
    text = path.read_text(encoding="utf-8")
    aligned_text = align_document(text)
    if aligned_text == text:
        return False
    path.write_text(aligned_text, encoding="utf-8")
    return True


def align_document(text: str) -> str:
    """Return Markdown with every table aligned."""
    lines = text.split("\n")

    output: list[str] = []
    table_block: list[str] = []
    in_code_fence = False

    def flush_block() -> None:
        if not table_block:
            return
        output.extend(align_table(table_block))
        table_block.clear()

    for line in lines:
        if line.strip().startswith("```"):
            in_code_fence = not in_code_fence

        if not in_code_fence and is_table_line(line):
            table_block.append(line)
        else:
            flush_block()
            output.append(line)

    flush_block()

    return "\n".join(output)


def find_markdown_files() -> list[Path]:
    """Find Markdown files under the repository's normal lint boundary."""
    return [path for path in iter_lint_paths(REPO_ROOT) if path.suffix.casefold() == ".md"]


def main() -> None:
    """Align explicitly selected files or every repository Markdown file."""
    arguments = sys.argv[1:]
    check_only = "--check" in arguments
    files = [Path(argument) for argument in arguments if argument != "--check"]
    files = files or find_markdown_files()

    changed_count = 0
    for path in files:
        if not path.exists():
            print(f"Skipping {path} (not found)")
            continue
        if check_only:
            original = path.read_text(encoding="utf-8")
            if align_document(original) != original:
                changed_count += 1
                print(f"Table alignment needed in {path}")
        elif process_file(path):
            changed_count += 1
            print(f"Aligned tables in {path}")

    if changed_count == 0:
        print("No tables needed alignment")
    elif check_only:
        print(f"Table alignment needed in {changed_count} file(s)")
        raise SystemExit(1)
    else:
        print(f"Aligned tables in {changed_count} file(s)")


if __name__ == "__main__":  # pragma: no cover
    main()
