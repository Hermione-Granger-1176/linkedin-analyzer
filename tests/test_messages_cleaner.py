"""Tests for messages cleaner module."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from linkedin_analyzer.cleaners.messages import (
    MESSAGES_COLUMNS,
    MessagesCleanerConfig,
    clean_messages,
)
from linkedin_analyzer.core.paths import DEFAULT_MESSAGES_INPUT, DEFAULT_MESSAGES_OUTPUT


def test_messages_defaults() -> None:
    """Messages cleaner config should expose expected defaults."""
    config = MessagesCleanerConfig()
    assert config.input_path == DEFAULT_MESSAGES_INPUT
    assert config.output_path == DEFAULT_MESSAGES_OUTPUT
    assert config.columns == MESSAGES_COLUMNS


def test_clean_messages_success(tmp_path: Path) -> None:
    """Messages cleaner should produce a cleaned Excel file."""
    input_file = tmp_path / "messages.csv"
    output_file = tmp_path / "Messages.xlsx"
    input_file.write_text(
        "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS\n"
        'abc,Ada,Bob,2025-01-01 10:00:00 UTC,"He said ""hello""",INBOX,https://a,https://b\n'
    )

    result = clean_messages(input_path=input_file, output_path=output_file)

    assert result.success is True
    assert result.rows_processed == 1
    assert output_file.exists()

    df = pd.read_excel(output_file)
    assert list(df.columns) == [column.name for column in MESSAGES_COLUMNS]
    assert df["CONTENT"].iloc[0] == 'He said "hello"'
    assert len(df["DATE"].iloc[0]) == 19
