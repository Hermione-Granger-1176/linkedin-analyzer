from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

import pytest
from scripts.lint import align_tables

if TYPE_CHECKING:
    from _pytest.capture import CaptureFixture
    from _pytest.monkeypatch import MonkeyPatch


def test_is_table_line_detects_pipe_rows() -> None:
    """Recognize complete pipe-delimited rows."""
    assert align_tables.is_table_line("| a | b |") is True
    assert align_tables.is_table_line("| --- | --- |") is True
    assert align_tables.is_table_line("  | x | y |  ") is True
    assert align_tables.is_table_line("no pipes here") is False
    assert align_tables.is_table_line("partial | pipe") is False
    assert align_tables.is_table_line("| only left") is False


def test_split_cells_strips_outer_pipes() -> None:
    """Strip outer pipes and surrounding cell whitespace."""
    assert align_tables.split_cells("| a | b | c |") == ["a", "b", "c"]
    assert align_tables.split_cells("|  x  |  y  |") == ["x", "y"]


def test_split_cells_handles_missing_outer_pipes() -> None:
    """Tolerate rows without both outer pipes."""
    assert align_tables.split_cells("a | b |") == ["a", "b"]
    assert align_tables.split_cells("| a | b") == ["a", "b"]
    assert align_tables.split_cells("a | b") == ["a", "b"]


def test_is_separator_row() -> None:
    """Recognize plain and aligned Markdown separator cells."""
    assert align_tables.is_separator_row(["---", "---"]) is True
    assert align_tables.is_separator_row([":---:", "---:"]) is True
    assert align_tables.is_separator_row(["text", "---"]) is False


def test_build_separator_preserves_alignment_markers() -> None:
    """Retain leading and trailing alignment colons."""
    result = align_tables.build_separator([10, 10], [":---", "---:"])

    assert result.startswith("| :---")
    assert "---:" in result


def test_build_separator_uses_minimum_width() -> None:
    """Keep separator cells at least three characters wide."""
    assert align_tables.build_separator([3, 3], ["---", "---"]) == "| --- | --- |"


def test_align_table_pads_cells() -> None:
    """Pad each content cell to its column width."""
    lines = [
        "| A | Long |",
        "| --- | --- |",
        "| x | y |",
    ]

    aligned = align_tables.align_table(lines)

    assert aligned[0] == "| A   | Long |"
    assert aligned[2] == "| x   | y    |"


def test_align_table_handles_uneven_columns() -> None:
    """Fill missing cells in rows with fewer columns."""
    lines = [
        "| A | B |",
        "| --- | --- |",
        "| x |",
    ]

    aligned = align_tables.align_table(lines)

    assert len(aligned) == 3
    assert aligned[2].count("|") == 3


def test_process_file_aligns_tables(tmp_path: Path) -> None:
    """Align a table and preserve surrounding document content."""
    path = tmp_path / "test.md"
    path.write_text(
        "# Title\n\n| Short | Very Long Column |\n| --- | --- |\n| a | b |\n",
        encoding="utf-8",
    )

    assert align_tables.process_file(path) is True

    lines = path.read_text(encoding="utf-8").split("\n")
    assert "| Short | Very Long Column |" in lines
    assert lines[-1] == ""


def test_align_document_returns_aligned_text_without_writing() -> None:
    """Build aligned Markdown independently of filesystem writes."""
    text = "| A | Long |\n| --- | --- |\n| x | y |\n"

    assert align_tables.align_document(text) == ("| A   | Long |\n| --- | ---- |\n| x   | y    |\n")


def test_process_file_skips_code_fences(tmp_path: Path) -> None:
    """Leave table-shaped examples inside code fences unchanged."""
    path = tmp_path / "test.md"
    path.write_text("```\n| A | B |\n| --- | --- |\n```\n", encoding="utf-8")

    assert align_tables.process_file(path) is False


def test_process_file_returns_false_when_already_aligned(tmp_path: Path) -> None:
    """Report no change for an already aligned table."""
    path = tmp_path / "test.md"
    path.write_text("| A   | B   |\n| --- | --- |\n| x   | y   |\n", encoding="utf-8")

    assert align_tables.process_file(path) is False


def test_process_file_handles_table_at_end_of_file(tmp_path: Path) -> None:
    """Flush a table that ends with the file."""
    path = tmp_path / "test.md"
    path.write_text("| A | B |\n| --- | --- |\n| x | y |", encoding="utf-8")

    assert align_tables.process_file(path) is True


def test_find_markdown_files_uses_lint_boundary(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    """Find Markdown files while pruning ignored directories."""
    monkeypatch.setattr(align_tables, "REPO_ROOT", tmp_path)
    (tmp_path / "README.md").write_text("# Included", encoding="utf-8")
    ignored = tmp_path / "node_modules" / "package"
    ignored.mkdir(parents=True)
    (ignored / "README.md").write_text("# Ignored", encoding="utf-8")
    uppercase_suffix = tmp_path / "guide.MD"
    uppercase_suffix.write_text("# Included", encoding="utf-8")

    assert align_tables.find_markdown_files() == [
        tmp_path / "README.md",
        uppercase_suffix,
    ]


def test_main_with_no_args_processes_repo(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
    capsys: CaptureFixture[str],
) -> None:
    """Process discovered repository files when no paths are supplied."""
    monkeypatch.setattr(align_tables, "REPO_ROOT", tmp_path)
    monkeypatch.setattr("sys.argv", ["align_tables.py"])
    (tmp_path / "doc.md").write_text(
        "| A | B |\n| --- | --- |\n| x | y |\n",
        encoding="utf-8",
    )

    align_tables.main()

    assert "Aligned tables in 1 file(s)" in capsys.readouterr().out


def test_main_with_explicit_files(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
    capsys: CaptureFixture[str],
) -> None:
    """Process only explicitly supplied paths."""
    path = tmp_path / "test.md"
    path.write_text("No tables here.\n", encoding="utf-8")
    monkeypatch.setattr("sys.argv", ["align_tables.py", str(path)])

    align_tables.main()

    assert "No tables needed alignment" in capsys.readouterr().out


def test_main_skips_missing_files(
    monkeypatch: MonkeyPatch,
    capsys: CaptureFixture[str],
) -> None:
    """Report and skip an explicitly selected missing path."""
    monkeypatch.setattr("sys.argv", ["align_tables.py", "/nonexistent/file.md"])

    align_tables.main()

    assert "Skipping" in capsys.readouterr().out


def test_main_check_reports_unaligned_files_without_writing(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
    capsys: CaptureFixture[str],
) -> None:
    """Check mode fails for unaligned tables without modifying them."""
    path = tmp_path / "test.md"
    original = "| A | Long |\n| --- | --- |\n"
    path.write_text(original, encoding="utf-8")
    monkeypatch.setattr("sys.argv", ["align_tables.py", "--check", str(path)])

    with pytest.raises(SystemExit, match="1"):
        align_tables.main()

    assert path.read_text(encoding="utf-8") == original
    assert "Table alignment needed in 1 file(s)" in capsys.readouterr().out


def test_main_check_accepts_aligned_files(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
    capsys: CaptureFixture[str],
) -> None:
    """Check mode succeeds when selected tables are aligned."""
    path = tmp_path / "test.md"
    path.write_text("| A   | Long |\n| --- | ---- |\n", encoding="utf-8")
    monkeypatch.setattr("sys.argv", ["align_tables.py", "--check", str(path)])

    align_tables.main()

    assert "No tables needed alignment" in capsys.readouterr().out
