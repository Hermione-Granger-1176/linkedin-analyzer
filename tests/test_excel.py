"""Tests for Excel formatting utilities."""

from __future__ import annotations

from pathlib import Path

import pytest

import linkedin_analyzer.core.excel as excel
from linkedin_analyzer.core.types import CleanerConfig, ColumnConfig


def test_format_excel_output_raises_without_active_sheet(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Raise an error when no worksheet is available."""
    class DummyWorkbook:
        active = None

    def fake_load_workbook(_: Path) -> DummyWorkbook:
        return DummyWorkbook()

    monkeypatch.setattr(excel, "load_workbook", fake_load_workbook)

    config = CleanerConfig(
        input_path=tmp_path / "input.csv",
        output_path=tmp_path / "output.xlsx",
        columns=(ColumnConfig(name="A"),),
    )

    with pytest.raises(RuntimeError, match="Failed to load active worksheet"):
        excel.format_excel_output(tmp_path / "output.xlsx", config)
