"""Comments CSV cleaner module."""

from __future__ import annotations

from dataclasses import dataclass, field
from types import MappingProxyType
from typing import TYPE_CHECKING

from linkedin_analyzer.core.cleaner import run_cleaner
from linkedin_analyzer.core.paths import DEFAULT_COMMENTS_INPUT, DEFAULT_COMMENTS_OUTPUT
from linkedin_analyzer.core.text import clean_comments_message
from linkedin_analyzer.core.types import CleanerConfig, CleanerResult, ColumnConfig

if TYPE_CHECKING:
    from collections.abc import Mapping
    from pathlib import Path

DEFAULT_INPUT = DEFAULT_COMMENTS_INPUT
DEFAULT_OUTPUT = DEFAULT_COMMENTS_OUTPUT

# Column configurations for Comments.csv
COMMENTS_COLUMNS: tuple[ColumnConfig, ...] = (
    ColumnConfig(name="Date", width=20),
    ColumnConfig(name="Link", width=60),
    ColumnConfig(
        name="Message",
        width=100,
        wrap_text=True,
        cleaner=clean_comments_message,
    ),
)

# CSV parsing options for Comments.csv (uses backslash escaping)
COMMENTS_CSV_KWARGS: Mapping[str, object] = MappingProxyType({"escapechar": "\\"})


@dataclass(frozen=True, slots=True)
class CommentsCleanerConfig(CleanerConfig):
    """Configuration for Comments CSV cleaner.

    Provides sensible defaults for cleaning LinkedIn Comments export files.
    """

    input_path: Path = DEFAULT_INPUT
    output_path: Path = DEFAULT_OUTPUT
    columns: tuple[ColumnConfig, ...] = COMMENTS_COLUMNS
    csv_kwargs: Mapping[str, object] = field(default_factory=lambda: COMMENTS_CSV_KWARGS)


def clean_comments(
    input_path: Path | None = None,
    output_path: Path | None = None,
) -> CleanerResult:
    """Clean a Comments CSV file and export to Excel.

    Args:
        input_path: Path to input CSV file (default: Comments.csv)
        output_path: Path to output Excel file (default: Comments.xlsx)

    Returns:
        CleanerResult with operation status and details
    """
    config = CommentsCleanerConfig(
        input_path=input_path or DEFAULT_INPUT,
        output_path=output_path or DEFAULT_OUTPUT,
    )
    return run_cleaner(config)
