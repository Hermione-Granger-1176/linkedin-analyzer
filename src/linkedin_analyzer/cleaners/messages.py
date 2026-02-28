"""Messages CSV cleaner module."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from linkedin_analyzer.core.cleaner import run_cleaner
from linkedin_analyzer.core.paths import DEFAULT_MESSAGES_INPUT, DEFAULT_MESSAGES_OUTPUT
from linkedin_analyzer.core.text import clean_date, clean_empty_field, clean_messages_content
from linkedin_analyzer.core.types import CleanerConfig, CleanerResult, ColumnConfig

if TYPE_CHECKING:
    from collections.abc import Mapping
    from pathlib import Path

DEFAULT_INPUT = DEFAULT_MESSAGES_INPUT
DEFAULT_OUTPUT = DEFAULT_MESSAGES_OUTPUT

# Column configurations for messages.csv
MESSAGES_COLUMNS: tuple[ColumnConfig, ...] = (
    ColumnConfig(name="FROM", width=24, required=True),
    ColumnConfig(name="TO", width=24, required=True),
    ColumnConfig(name="DATE", width=20, required=True, cleaner=clean_date),
    ColumnConfig(
        name="CONTENT",
        width=100,
        wrap_text=True,
        required=True,
        cleaner=clean_messages_content,
    ),
    ColumnConfig(name="FOLDER", width=16),
    ColumnConfig(name="CONVERSATION ID", width=40),
    ColumnConfig(name="SENDER PROFILE URL", width=48, cleaner=clean_empty_field),
    ColumnConfig(name="RECIPIENT PROFILE URLS", width=48, cleaner=clean_empty_field),
)


@dataclass(frozen=True, slots=True)
class MessagesCleanerConfig(CleanerConfig):
    """Configuration for Messages CSV cleaner.

    Provides sensible defaults for cleaning LinkedIn Messages export files.
    """

    input_path: Path = DEFAULT_INPUT
    output_path: Path = DEFAULT_OUTPUT
    columns: tuple[ColumnConfig, ...] = MESSAGES_COLUMNS
    csv_kwargs: Mapping[str, object] = field(default_factory=dict)


def clean_messages(
    input_path: Path | None = None,
    output_path: Path | None = None,
) -> CleanerResult:
    """Clean a Messages CSV file and export to Excel.

    Args:
        input_path: Path to input CSV file (default: messages.csv)
        output_path: Path to output Excel file (default: Messages.xlsx)

    Returns:
        CleanerResult with operation status and details
    """
    config = MessagesCleanerConfig(
        input_path=input_path or DEFAULT_INPUT,
        output_path=output_path or DEFAULT_OUTPUT,
    )
    return run_cleaner(config)
