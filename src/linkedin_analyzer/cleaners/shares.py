"""Shares CSV cleaner module."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from linkedin_analyzer.core.cleaner import run_cleaner
from linkedin_analyzer.core.text import clean_empty_field, clean_shares_commentary
from linkedin_analyzer.core.types import CleanerConfig, CleanerResult, ColumnConfig

if TYPE_CHECKING:
    from collections.abc import Mapping

DEFAULT_INPUT = Path("data/input/Shares.csv")
DEFAULT_OUTPUT = Path("data/output/Shares.xlsx")

# Column configurations for Shares.csv
SHARES_COLUMNS: tuple[ColumnConfig, ...] = (
    ColumnConfig(name="Date", width=20),
    ColumnConfig(name="ShareLink", width=60),
    ColumnConfig(
        name="ShareCommentary",
        width=100,
        wrap_text=True,
        cleaner=clean_shares_commentary,
    ),
    ColumnConfig(name="SharedUrl", width=30, cleaner=clean_empty_field),
    ColumnConfig(name="MediaUrl", width=30, cleaner=clean_empty_field),
    ColumnConfig(name="Visibility", width=18),
)


@dataclass(frozen=True, slots=True)
class SharesCleanerConfig(CleanerConfig):
    """Configuration for Shares CSV cleaner.

    Provides sensible defaults for cleaning LinkedIn Shares export files.
    """

    input_path: Path = DEFAULT_INPUT
    output_path: Path = DEFAULT_OUTPUT
    columns: tuple[ColumnConfig, ...] = SHARES_COLUMNS
    csv_kwargs: Mapping[str, object] = field(default_factory=dict)


def clean_shares(
    input_path: Path | None = None,
    output_path: Path | None = None,
) -> CleanerResult:
    """Clean a Shares CSV file and export to Excel.

    Args:
        input_path: Path to input CSV file (default: Shares.csv)
        output_path: Path to output Excel file (default: Shares.xlsx)

    Returns:
        CleanerResult with operation status and details
    """
    config = SharesCleanerConfig(
        input_path=input_path or DEFAULT_INPUT,
        output_path=output_path or DEFAULT_OUTPUT,
    )
    return run_cleaner(config)
