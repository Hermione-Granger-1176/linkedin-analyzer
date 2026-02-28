"""Connections CSV cleaner module."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from linkedin_analyzer.core.cleaner import run_cleaner
from linkedin_analyzer.core.paths import DEFAULT_CONNECTIONS_INPUT, DEFAULT_CONNECTIONS_OUTPUT
from linkedin_analyzer.core.text import clean_connections_date, clean_empty_field
from linkedin_analyzer.core.types import CleanerConfig, CleanerResult, ColumnConfig

if TYPE_CHECKING:
    from collections.abc import Mapping
    from pathlib import Path

DEFAULT_INPUT = DEFAULT_CONNECTIONS_INPUT
DEFAULT_OUTPUT = DEFAULT_CONNECTIONS_OUTPUT

# Column configurations for Connections.csv
CONNECTIONS_COLUMNS: tuple[ColumnConfig, ...] = (
    ColumnConfig(name="First Name", width=20),
    ColumnConfig(name="Last Name", width=20),
    ColumnConfig(name="URL", width=50, cleaner=clean_empty_field),
    ColumnConfig(name="Email Address", width=32, cleaner=clean_empty_field),
    ColumnConfig(name="Company", width=30),
    ColumnConfig(name="Position", width=30),
    ColumnConfig(name="Connected On", width=20, required=True, cleaner=clean_connections_date),
)


@dataclass(frozen=True, slots=True)
class ConnectionsCleanerConfig(CleanerConfig):
    """Configuration for Connections CSV cleaner.

    Provides sensible defaults for cleaning LinkedIn Connections export files.
    """

    input_path: Path = DEFAULT_INPUT
    output_path: Path = DEFAULT_OUTPUT
    columns: tuple[ColumnConfig, ...] = CONNECTIONS_COLUMNS
    csv_kwargs: Mapping[str, object] = field(default_factory=dict)
    skiprows: int = 3
    drop_if_all_missing: tuple[str, ...] = ("First Name", "Last Name", "URL")


def clean_connections(
    input_path: Path | None = None,
    output_path: Path | None = None,
) -> CleanerResult:
    """Clean a Connections CSV file and export to Excel.

    Args:
        input_path: Path to input CSV file (default: Connections.csv)
        output_path: Path to output Excel file (default: Connections.xlsx)

    Returns:
        CleanerResult with operation status and details
    """
    config = ConnectionsCleanerConfig(
        input_path=input_path or DEFAULT_INPUT,
        output_path=output_path or DEFAULT_OUTPUT,
    )
    return run_cleaner(config)
