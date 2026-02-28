"""Tests for connections cleaner module."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from linkedin_analyzer.cleaners.connections import (
    CONNECTIONS_COLUMNS,
    ConnectionsCleanerConfig,
    clean_connections,
)
from linkedin_analyzer.core.paths import DEFAULT_CONNECTIONS_INPUT, DEFAULT_CONNECTIONS_OUTPUT


def test_connections_defaults() -> None:
    """Connections cleaner config should expose expected defaults."""
    config = ConnectionsCleanerConfig()
    assert config.input_path == DEFAULT_CONNECTIONS_INPUT
    assert config.output_path == DEFAULT_CONNECTIONS_OUTPUT
    assert config.columns == CONNECTIONS_COLUMNS
    assert config.skiprows == 3
    assert config.drop_if_all_missing == ("First Name", "Last Name", "URL")


def test_clean_connections_success(tmp_path: Path) -> None:
    """Connections cleaner should skip preamble rows and clean dates."""
    input_file = tmp_path / "Connections.csv"
    output_file = tmp_path / "Connections.xlsx"
    input_file.write_text(
        "Notes:\n"
        "LinkedIn metadata\n"
        "\n"
        "First Name,Last Name,URL,Email Address,Company,Position,Connected On\n"
        ",,,,,,30 Jan 2026\n"
        "Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,30 Jan 2026\n"
    )

    result = clean_connections(input_path=input_file, output_path=output_file)

    assert result.success is True
    assert result.rows_processed == 1
    assert output_file.exists()

    df = pd.read_excel(output_file)
    assert list(df.columns) == [column.name for column in CONNECTIONS_COLUMNS]
    assert df["Connected On"].iloc[0] == "2026-01-30"
