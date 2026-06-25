"""Tests for the cleaner module."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from linkedin_analyzer.core.cleaner import (
    normalize_required_columns,
    run_cleaner,
    validate_columns,
)
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

    def test_bom_and_whitespace_headers(self) -> None:
        df = pd.DataFrame({"\ufeffDate ": ["2025-01-01"], " Message": ["Hello"]})
        validate_columns(df, ["Date", "Message"])


class TestNormalizeRequiredColumns:
    """Tests for normalize_required_columns function."""

    def test_skips_columns_absent_from_dataframe(self) -> None:
        # A required column missing from the frame is skipped, not an error.
        df = pd.DataFrame({"A": ["  x  "]})
        normalize_required_columns(df, ["A", "B"])
        assert list(df["A"]) == ["x"]


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

    def test_input_file_size_limit_returns_clear_error(self, tmp_path: Path) -> None:
        input_path = tmp_path / "test.csv"
        output_path = tmp_path / "test.xlsx"
        input_path.write_text("Name\nAda\n")

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name", required=True),),
            max_input_bytes=1,
        )
        result = run_cleaner(config)

        assert result.success is False
        assert result.error == "Input file is too large: 9 bytes exceeds limit of 1 byte"
        assert not output_path.exists()

    def test_zero_input_file_size_limit_disables_check(self, tmp_path: Path) -> None:
        input_path = tmp_path / "test.csv"
        output_path = tmp_path / "test.xlsx"
        input_path.write_text("Name\nAda\n")

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name", required=True),),
            max_input_bytes=0,
        )
        result = run_cleaner(config)

        assert result.success is True
        assert output_path.exists()

    def test_row_count_limit_returns_clear_error(self, tmp_path: Path) -> None:
        input_path = tmp_path / "test.csv"
        output_path = tmp_path / "test.xlsx"
        input_path.write_text("Name\nAda\nGrace\n")

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name", required=True),),
            max_rows=1,
        )
        result = run_cleaner(config)

        assert result.success is False
        assert result.error == "Input CSV has too many rows: 2 exceeds limit of 1"

    def test_zero_row_count_limit_disables_check(self, tmp_path: Path) -> None:
        input_path = tmp_path / "test.csv"
        output_path = tmp_path / "test.xlsx"
        input_path.write_text("Name\nAda\nGrace\n")

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name", required=True),),
            max_rows=0,
        )
        result = run_cleaner(config)

        assert result.success is True
        assert result.rows_processed == 2

    def test_negative_resource_limit_returns_clear_error(self, tmp_path: Path) -> None:
        input_path = tmp_path / "test.csv"
        output_path = tmp_path / "test.xlsx"
        input_path.write_text("Name\nAda\n")

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name", required=True),),
            max_rows=-1,
        )
        result = run_cleaner(config)

        assert result.success is False
        assert result.error == "max_rows must be a non-negative integer"

    def test_input_stat_failure_returns_clear_error(self, tmp_path: Path) -> None:
        class BadStatPath:
            def exists(self) -> bool:
                return True

            def stat(self) -> object:
                raise OSError("stat failed")

            def __str__(self) -> str:
                return "bad.csv"

        output_path = tmp_path / "test.xlsx"
        config = CleanerConfig(
            input_path=BadStatPath(),  # type: ignore[arg-type]
            output_path=output_path,
            columns=(ColumnConfig(name="Name", required=True),),
        )
        result = run_cleaner(config)

        assert result.success is False
        assert result.error == "stat failed"

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

    def test_missing_required_column_error(self, tmp_path: Path) -> None:
        input_path = tmp_path / "test.csv"
        output_path = tmp_path / "test.xlsx"
        input_path.write_text("A,B\n1,2\n")

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(
                ColumnConfig(name="X", required=True),
                ColumnConfig(name="Y", required=True),
            ),
        )
        result = run_cleaner(config)

        assert result.success is False
        assert "Missing required columns" in (result.error or "")

    def test_duplicate_columns_after_header_normalization_return_clear_error(
        self, tmp_path: Path
    ) -> None:
        input_path = tmp_path / "test.csv"
        output_path = tmp_path / "test.xlsx"
        input_path.write_text("Name, Name\nAda,Lovelace\n")

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name", required=True),),
        )
        result = run_cleaner(config)

        assert result.success is False
        assert result.error == "Duplicate columns after header normalization: Name"

    def test_optional_columns_not_required(self, tmp_path: Path) -> None:
        """Optional columns should not cause validation failure."""
        input_path = tmp_path / "test.csv"
        output_path = tmp_path / "test.xlsx"
        input_path.write_text("A,B\n1,2\n")

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(
                ColumnConfig(name="A", required=True),
                ColumnConfig(name="B", required=True),
                ColumnConfig(name="C"),  # optional, not in CSV
            ),
        )
        result = run_cleaner(config)

        assert result.success is True
        assert result.rows_processed == 1

    def test_default_clean_value_applied(self, tmp_path: Path) -> None:
        """Columns without a specific cleaner should get clean_value applied."""
        input_path = tmp_path / "test.csv"
        output_path = tmp_path / "test.xlsx"
        input_path.write_text("Name\n  hello  \n  world  \n")

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name"),),
        )
        result = run_cleaner(config)

        assert result.success is True
        df = pd.read_excel(output_path)
        assert list(df["Name"]) == ["hello", "world"]

    def test_formula_escaping_runs_after_column_cleaners(self, tmp_path: Path) -> None:
        input_path = tmp_path / "test.csv"
        output_path = tmp_path / "test.xlsx"
        input_path.write_text("Name\nvalue\n")

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name", cleaner=lambda _value: "=SUM(1)"),),
        )
        result = run_cleaner(config)

        assert result.success is True
        df = pd.read_excel(output_path)
        assert list(df["Name"]) == ["'=SUM(1)"]

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

    def test_skiprows_passed(self, tmp_path: Path) -> None:
        input_path = tmp_path / "connections.csv"
        output_path = tmp_path / "connections.xlsx"
        input_path.write_text(
            "Notes:\n"
            "LinkedIn export metadata\n"
            "\n"
            "First Name,Last Name,Connected On\n"
            "Ada,Lovelace,30 Jan 2026\n"
        )

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(
                ColumnConfig(name="First Name", required=True),
                ColumnConfig(name="Last Name", required=True),
                ColumnConfig(name="Connected On", required=True),
            ),
            skiprows=3,
        )
        result = run_cleaner(config)

        assert result.success is True
        df = pd.read_excel(output_path)
        assert list(df["First Name"]) == ["Ada"]

    def test_drop_if_all_missing(self, tmp_path: Path) -> None:
        input_path = tmp_path / "connections.csv"
        output_path = tmp_path / "connections.xlsx"
        input_path.write_text(
            "First Name,Last Name,URL,Connected On\n,,,2026-01-30\nAda,Lovelace,,2026-01-30\n"
        )

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(
                ColumnConfig(name="First Name"),
                ColumnConfig(name="Last Name"),
                ColumnConfig(name="URL"),
                ColumnConfig(name="Connected On", required=True),
            ),
            drop_if_all_missing=("First Name", "Last Name", "URL"),
        )
        result = run_cleaner(config)

        assert result.success is True
        df = pd.read_excel(output_path)
        assert list(df["First Name"].fillna("")) == ["Ada"]

    def test_successful_clean_leaves_no_temp_files(self, tmp_path: Path) -> None:
        input_path = tmp_path / "test.csv"
        output_path = tmp_path / "test.xlsx"
        input_path.write_text("Name\nhello\n")

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name"),),
        )
        result = run_cleaner(config)

        assert result.success is True
        leftover = [p.name for p in tmp_path.iterdir() if p.name.startswith(".test-")]
        assert leftover == []

    def test_write_failure_preserves_existing_output(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A failure mid-write must not corrupt an existing output or leave temp files."""
        import linkedin_analyzer.core.cleaner as cleaner_module

        input_path = tmp_path / "test.csv"
        output_path = tmp_path / "test.xlsx"
        input_path.write_text("Name\nhello\n")
        output_path.write_text("previous good output")

        def boom(*_args: object, **_kwargs: object) -> None:
            raise RuntimeError("formatting blew up")

        monkeypatch.setattr(cleaner_module, "format_excel_output", boom)

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name"),),
        )
        result = run_cleaner(config)

        assert result.success is False
        assert "formatting blew up" in (result.error or "")
        # Original output is untouched, and no temp file is left behind.
        assert output_path.read_text() == "previous good output"
        leftover = [p.name for p in tmp_path.iterdir() if p.name.startswith(".test-")]
        assert leftover == []

    def test_required_columns_drop_na_like_tokens(self, tmp_path: Path) -> None:
        input_path = tmp_path / "messages.csv"
        output_path = tmp_path / "messages.xlsx"
        input_path.write_text(
            "FROM,DATE\n"
            "#N/A,2026-01-30 10:00:00\n"
            "NONE,2026-01-30 10:05:00\n"
            "Ada,2026-01-30 10:10:00\n"
        )

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(
                ColumnConfig(name="FROM", required=True),
                ColumnConfig(name="DATE", required=True),
            ),
        )
        result = run_cleaner(config)

        assert result.success is True
        df = pd.read_excel(output_path)
        assert list(df["FROM"]) == ["Ada"]


class TestEncoding:
    """Tests for CSV input encoding handling."""

    def test_auto_detects_non_utf8_input(self, tmp_path: Path) -> None:
        """A Latin-1 file with no explicit encoding falls back and decodes cleanly."""
        input_path = tmp_path / "latin1.csv"
        output_path = tmp_path / "latin1.xlsx"
        input_path.write_bytes("Name\nJosé\n".encode("latin-1"))

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name"),),
        )
        result = run_cleaner(config)

        assert result.success is True
        df = pd.read_excel(output_path)
        assert list(df["Name"]) == ["José"]

    def test_explicit_encoding_is_used(self, tmp_path: Path) -> None:
        input_path = tmp_path / "latin1.csv"
        output_path = tmp_path / "latin1.xlsx"
        input_path.write_bytes("Name\nJosé\n".encode("latin-1"))

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name"),),
            encoding="latin-1",
        )
        result = run_cleaner(config)

        assert result.success is True
        df = pd.read_excel(output_path)
        assert list(df["Name"]) == ["José"]

    def test_encoding_from_csv_kwargs_is_used(self, tmp_path: Path) -> None:
        """An encoding supplied via csv_kwargs is honored (no duplicate-kwarg error)."""
        input_path = tmp_path / "latin1.csv"
        output_path = tmp_path / "latin1.xlsx"
        input_path.write_bytes("Name\nJosé\n".encode("latin-1"))

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name"),),
            csv_kwargs={"encoding": "latin-1"},
        )
        result = run_cleaner(config)

        assert result.success is True
        df = pd.read_excel(output_path)
        assert list(df["Name"]) == ["José"]

    def test_config_encoding_takes_precedence_over_csv_kwargs(self, tmp_path: Path) -> None:
        """CleanerConfig.encoding wins over an encoding in csv_kwargs, without erroring."""
        input_path = tmp_path / "latin1.csv"
        output_path = tmp_path / "latin1.xlsx"
        input_path.write_bytes("Name\nJosé\n".encode("latin-1"))

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name"),),
            csv_kwargs={"encoding": "utf-8"},
            encoding="latin-1",
        )
        result = run_cleaner(config)

        # latin-1 (from config.encoding) decodes cleanly; the utf-8 in csv_kwargs
        # would have raised, proving config.encoding took precedence.
        assert result.success is True
        df = pd.read_excel(output_path)
        assert list(df["Name"]) == ["José"]

    def test_explicit_encoding_mismatch_fails_cleanly(self, tmp_path: Path) -> None:
        """Forcing a wrong encoding yields a clean failure, not a traceback."""
        input_path = tmp_path / "latin1.csv"
        output_path = tmp_path / "latin1.xlsx"
        input_path.write_bytes("Name\nJosé\n".encode("latin-1"))

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name"),),
            encoding="utf-8",
        )
        result = run_cleaner(config)

        assert result.success is False
        assert not output_path.exists()

    def test_unicode_emoji_round_trips_through_excel(self, tmp_path: Path) -> None:
        input_path = tmp_path / "emoji.csv"
        output_path = tmp_path / "emoji.xlsx"
        input_path.write_text("Name\nAda 🚀\n", encoding="utf-8")

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name"),),
        )
        result = run_cleaner(config)

        assert result.success is True
        df = pd.read_excel(output_path)
        assert list(df["Name"]) == ["Ada 🚀"]

    def test_empty_file_fails_cleanly(self, tmp_path: Path) -> None:
        input_path = tmp_path / "empty.csv"
        output_path = tmp_path / "empty.xlsx"
        input_path.write_text("")

        config = CleanerConfig(
            input_path=input_path,
            output_path=output_path,
            columns=(ColumnConfig(name="Name"),),
        )
        result = run_cleaner(config)

        assert result.success is False
        assert not output_path.exists()

    def test_directory_input_fails_cleanly(self, tmp_path: Path) -> None:
        input_dir = tmp_path / "a_directory.csv"
        input_dir.mkdir()
        output_path = tmp_path / "out.xlsx"

        config = CleanerConfig(
            input_path=input_dir,
            output_path=output_path,
            columns=(ColumnConfig(name="Name"),),
        )
        result = run_cleaner(config)

        assert result.success is False
        assert not output_path.exists()
