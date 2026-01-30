"""Excel formatting utilities."""

from __future__ import annotations

from typing import TYPE_CHECKING

from openpyxl import load_workbook
from openpyxl.styles import Alignment

if TYPE_CHECKING:
    from pathlib import Path

    from linkedin_analyzer.core.types import CleanerConfig


def format_excel_output(output_path: Path, config: CleanerConfig) -> None:
    """Apply formatting to an Excel file.

    Args:
        output_path: Path to the Excel file
        config: Cleaner configuration with column settings

    Raises:
        RuntimeError: If the worksheet cannot be loaded
    """
    wb = load_workbook(output_path)
    ws = wb.active

    if ws is None:
        raise RuntimeError("Failed to load active worksheet")

    # Set column widths
    for col_letter, width in config.column_widths.items():
        ws.column_dimensions[col_letter].width = width

    # Enable text wrapping for specified columns
    wrap_columns = config.wrap_text_columns
    if wrap_columns:
        for row in ws.iter_rows(min_row=2, max_row=ws.max_row):
            for cell in row:
                if cell.column in wrap_columns:
                    cell.alignment = Alignment(wrap_text=True, vertical="top")

    # Set header row alignment
    for cell in ws[1]:
        cell.alignment = Alignment(horizontal="center", vertical="center")

    wb.save(output_path)
