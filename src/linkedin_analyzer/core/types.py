"""Core types and data structures for LinkedIn analyzer."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path

# Type aliases for clarity
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
    """

    name: str
    width: int = 20
    wrap_text: bool = False
    cleaner: TextCleaner | None = None


@dataclass(frozen=True, slots=True)
class CleanerConfig:
    """Configuration for a CSV cleaner.

    Attributes:
        input_path: Path to input CSV file
        output_path: Path to output Excel file
        columns: List of column configurations
        csv_kwargs: Additional arguments to pass to pd.read_csv
    """

    input_path: Path
    output_path: Path
    columns: tuple[ColumnConfig, ...]
    csv_kwargs: Mapping[str, object] = field(default_factory=dict)

    @property
    def required_columns(self) -> list[str]:
        """Return list of required column names."""
        return [col.name for col in self.columns]

    @property
    def column_widths(self) -> dict[str, int]:
        """Return mapping of Excel column letters to widths."""
        letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        return {letters[i]: col.width for i, col in enumerate(self.columns)}

    @property
    def wrap_text_columns(self) -> list[int]:
        """Return 1-indexed column numbers that should have text wrapping."""
        return [i + 1 for i, col in enumerate(self.columns) if col.wrap_text]


@dataclass(frozen=True, slots=True)
class CleanerResult:
    """Result of a cleaning operation.

    Attributes:
        success: Whether the operation succeeded
        rows_processed: Number of rows processed
        input_path: Path to input file
        output_path: Path to output file
        error: Error message if operation failed
    """

    success: bool
    rows_processed: int
    input_path: Path
    output_path: Path
    error: str | None = None

    def __str__(self) -> str:
        """Return a human-readable summary of the result."""
        if self.success:
            return (
                "Successfully processed "
                f"{self.rows_processed} rows: {self.input_path} -> {self.output_path}"
            )
        return f"Failed to process {self.input_path}: {self.error}"
