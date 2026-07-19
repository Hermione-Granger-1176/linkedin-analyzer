"""Core types and data structures for LinkedIn analyzer."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from openpyxl.utils import get_column_letter

from linkedin_analyzer.core.limits import DEFAULT_MAX_INPUT_BYTES, DEFAULT_MAX_ROWS

if TYPE_CHECKING:
    from pathlib import Path

TextCleaner = Callable[[object], str]
ColumnWidths = Mapping[str, int]


@dataclass(frozen=True, slots=True)
class ColumnConfig:
    """Configuration for a single column.

    Attributes:
        name: Column name in the DataFrame
        width: Excel column width
        wrap_text: Whether to enable text wrapping in Excel
        cleaner: Optional function to clean the column values
        required: Whether the column is required for validation
    """

    name: str
    width: int = 20
    wrap_text: bool = False
    cleaner: TextCleaner | None = None
    required: bool = False


@dataclass(frozen=True, slots=True)
class CleanerConfig:
    """Configuration for a CSV cleaner.

    Attributes:
        input_path: Path to input CSV file
        output_path: Path to output Excel file
        columns: List of column configurations
        csv_kwargs: Additional arguments to pass to pd.read_csv
        skiprows: Number of rows to skip before reading headers
        required_row_columns: Columns that must contain row values after header validation
        drop_if_all_missing: Drop rows when all these columns are missing
        encoding: Explicit input CSV encoding; when None, decoding is auto-detected
        max_input_bytes: Maximum input CSV size in bytes; 0 disables the limit
        max_rows: Maximum parsed row count; 0 disables the limit
    """

    input_path: Path
    output_path: Path
    columns: tuple[ColumnConfig, ...]
    csv_kwargs: Mapping[str, object] = field(default_factory=dict)
    skiprows: int = 0
    required_row_columns: tuple[str, ...] = ()
    drop_if_all_missing: tuple[str, ...] = ()
    encoding: str | None = None
    max_input_bytes: int = DEFAULT_MAX_INPUT_BYTES
    max_rows: int = DEFAULT_MAX_ROWS

    @property
    def required_columns(self) -> list[str]:
        """Return list of column names marked as required."""
        return [col.name for col in self.columns if col.required]

    @property
    def column_widths(self) -> dict[str, int]:
        """Return mapping of Excel column letters to widths."""
        return {
            get_column_letter(index): column.width
            for index, column in enumerate(self.columns, start=1)
        }

    @property
    def wrap_text_columns(self) -> list[int]:
        """Return 1-indexed column numbers that should have text wrapping."""
        return [index for index, column in enumerate(self.columns, start=1) if column.wrap_text]


@dataclass(frozen=True, slots=True)
class CleanerResult:
    """Result of a cleaning operation.

    Attributes:
        success: Whether the operation succeeded
        rows_processed: Number of rows processed
        input_path: Path to input file
        output_path: Path to output file
        error: Error message if operation failed
        missing_input: True when the failure was solely a non-existent input
            file, letting callers distinguish an absent file from a malformed
            or otherwise failing one
    """

    success: bool
    rows_processed: int
    input_path: Path
    output_path: Path
    error: str | None = None
    missing_input: bool = False

    def __str__(self) -> str:
        """Return a human-readable summary of the result."""
        if self.success:
            row_unit = "row" if self.rows_processed == 1 else "rows"
            return (
                "Successfully processed "
                f"{self.rows_processed} {row_unit}: {self.input_path} -> {self.output_path}"
            )
        return f"Failed to process {self.input_path}: {self.error}"
