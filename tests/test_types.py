"""Tests for core types."""

from __future__ import annotations

from pathlib import Path

import pytest

from linkedin_analyzer.core.types import CleanerConfig, CleanerResult, ColumnConfig


class TestColumnConfig:
    """Tests for ColumnConfig dataclass."""

    def test_default_values(self) -> None:
        config = ColumnConfig(name="Test")
        assert config.name == "Test"
        assert config.width == 20
        assert config.wrap_text is False
        assert config.cleaner is None

    def test_custom_values(self) -> None:
        def my_cleaner(x: object) -> str:
            return str(x).upper()

        config = ColumnConfig(
            name="Message",
            width=100,
            wrap_text=True,
            cleaner=my_cleaner,
        )
        assert config.name == "Message"
        assert config.width == 100
        assert config.wrap_text is True
        assert config.cleaner is not None
        assert config.cleaner("hello") == "HELLO"

    def test_is_frozen(self) -> None:
        config = ColumnConfig(name="Test")
        with pytest.raises(AttributeError):
            config.name = "Other"  # type: ignore[misc]


class TestCleanerConfig:
    """Tests for CleanerConfig dataclass."""

    def test_required_columns(self) -> None:
        config = CleanerConfig(
            input_path=Path("input.csv"),
            output_path=Path("output.xlsx"),
            columns=(
                ColumnConfig(name="Date"),
                ColumnConfig(name="Message"),
            ),
        )
        assert config.required_columns == ["Date", "Message"]

    def test_column_widths(self) -> None:
        config = CleanerConfig(
            input_path=Path("input.csv"),
            output_path=Path("output.xlsx"),
            columns=(
                ColumnConfig(name="Date", width=20),
                ColumnConfig(name="Link", width=60),
                ColumnConfig(name="Message", width=100),
            ),
        )
        assert config.column_widths == {"A": 20, "B": 60, "C": 100}

    def test_wrap_text_columns(self) -> None:
        config = CleanerConfig(
            input_path=Path("input.csv"),
            output_path=Path("output.xlsx"),
            columns=(
                ColumnConfig(name="Date", wrap_text=False),
                ColumnConfig(name="Link", wrap_text=False),
                ColumnConfig(name="Message", wrap_text=True),
            ),
        )
        # 1-indexed, so Message is column 3
        assert config.wrap_text_columns == [3]

    def test_multiple_wrap_text_columns(self) -> None:
        config = CleanerConfig(
            input_path=Path("input.csv"),
            output_path=Path("output.xlsx"),
            columns=(
                ColumnConfig(name="A", wrap_text=True),
                ColumnConfig(name="B", wrap_text=False),
                ColumnConfig(name="C", wrap_text=True),
            ),
        )
        assert config.wrap_text_columns == [1, 3]


class TestCleanerResult:
    """Tests for CleanerResult dataclass."""

    def test_success_result(self) -> None:
        result = CleanerResult(
            success=True,
            rows_processed=100,
            input_path=Path("input.csv"),
            output_path=Path("output.xlsx"),
        )
        assert result.success is True
        assert result.rows_processed == 100
        assert result.error is None

    def test_failure_result(self) -> None:
        result = CleanerResult(
            success=False,
            rows_processed=0,
            input_path=Path("input.csv"),
            output_path=Path("output.xlsx"),
            error="File not found",
        )
        assert result.success is False
        assert result.rows_processed == 0
        assert result.error == "File not found"

    def test_str_success(self) -> None:
        result = CleanerResult(
            success=True,
            rows_processed=100,
            input_path=Path("input.csv"),
            output_path=Path("output.xlsx"),
        )
        result_str = str(result)
        assert "100 rows" in result_str
        assert "input.csv" in result_str
        assert "output.xlsx" in result_str

    def test_str_failure(self) -> None:
        result = CleanerResult(
            success=False,
            rows_processed=0,
            input_path=Path("input.csv"),
            output_path=Path("output.xlsx"),
            error="Something went wrong",
        )
        result_str = str(result)
        assert "Failed" in result_str
        assert "Something went wrong" in result_str
