"""Tests for the cleaner module."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from linkedin_analyzer.core.cleaner import run_cleaner, validate_columns
from linkedin_analyzer.core.types import CleanerConfig, ColumnConfig


class TestValidateColumns:
    """Tests for validate_columns function."""

    def test_valid_columns(self) -> None:
        df = pd.DataFrame({"A": [1, 2], "B": [3, 4], "C": [5, 6]})
        # Should not raise
        validate_columns(df, ["A", "B"])

    def test_missing_columns(self) -> None:
        df = pd.DataFrame({"A": [1, 2], "B": [3, 4]})
        with pytest.raises(ValueError, match="Missing required columns"):
            validate_columns(df, ["A", "B", "C", "D"])

    def test_empty_required(self) -> None:
        df = pd.DataFrame({"A": [1, 2]})
        # Should not raise
        validate_columns(df, [])


class TestRunCleaner:
    """Tests for run_cleaner function."""

    def test_file_not_found(self, tmp_path: Path) -> None:
        config = CleanerConfig(
            input_path=tmp_path / "nonexistent.csv",
            output_path=tmp_path / "output.xlsx",
            columns=(ColumnConfig(name="A"),),
        )
        result = run_cleaner(config)
        assert result.success is False
        assert "does not exist" in (result.error or "")

    def test_successful_clean(self, tmp_path: Path) -> None:
        # Create test CSV
        input_path = tmp_path / "test.csv"
        output_path = tmp_path / "test.xlsx"
        input_path.write_text("Date,Message\n2025-01-01,Hello World\n")

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(
                ColumnConfig(name="Date", width=20),
                ColumnConfig(name="Message", width=50),
            ),
        )
        result = run_cleaner(config)

        assert result.success is True
        assert result.rows_processed == 1
        assert output_path.exists()

    def test_applies_cleaner_function(self, tmp_path: Path) -> None:
        # Create test CSV
        input_path = tmp_path / "test.csv"
        output_path = tmp_path / "test.xlsx"
        input_path.write_text("Name\nhello\nworld\n")

        def uppercase_cleaner(value: object) -> str:
            return str(value).upper()

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name", cleaner=uppercase_cleaner),),
        )
        result = run_cleaner(config)

        assert result.success is True

        # Verify the cleaner was applied
        df = pd.read_excel(output_path)
        assert list(df["Name"]) == ["HELLO", "WORLD"]

    def test_missing_column_error(self, tmp_path: Path) -> None:
        # Create test CSV with different columns
        input_path = tmp_path / "test.csv"
        output_path = tmp_path / "test.xlsx"
        input_path.write_text("A,B\n1,2\n")

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(
                ColumnConfig(name="X"),
                ColumnConfig(name="Y"),
            ),
        )
        result = run_cleaner(config)

        assert result.success is False
        assert "Missing required columns" in (result.error or "")

    def test_csv_kwargs_passed(self, tmp_path: Path) -> None:
        # Create test CSV with backslash escaping
        input_path = tmp_path / "test.csv"
        output_path = tmp_path / "test.xlsx"
        input_path.write_text('Name\n"hello \\"world\\""\n')

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name"),),
            csv_kwargs={"escapechar": "\\"},
        )
        result = run_cleaner(config)

        assert result.success is True
        df = pd.read_excel(output_path)
        assert 'hello "world"' in df["Name"].iloc[0]
