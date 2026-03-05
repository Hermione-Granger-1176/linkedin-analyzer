"""Tests for text cleaning utilities."""

from __future__ import annotations

import pandas as pd

from linkedin_analyzer.core.text import (
    clean_comments_message,
    clean_connections_date,
    clean_date,
    clean_empty_field,
    clean_messages_content,
    clean_shares_commentary,
    clean_value,
    escape_excel_formula,
    is_missing,
)


class TestIsMissing:
    """Tests for is_missing function."""

    def test_none_is_missing(self) -> None:
        assert is_missing(None) is True

    def test_pandas_na_is_missing(self) -> None:
        assert is_missing(pd.NA) is True

    def test_nan_is_missing(self) -> None:
        assert is_missing(float("nan")) is True

    def test_empty_string_is_missing(self) -> None:
        assert is_missing("") is True

    def test_zero_is_not_missing(self) -> None:
        assert is_missing(0) is False

    def test_regular_string_is_not_missing(self) -> None:
        assert is_missing("hello") is False

    def test_whitespace_is_missing(self) -> None:
        assert is_missing("   ") is True

    def test_na_string_is_missing(self) -> None:
        assert is_missing("NA") is True

    def test_na_lowercase_is_missing(self) -> None:
        assert is_missing("na") is True

    def test_nan_string_is_missing(self) -> None:
        assert is_missing("NaN") is True

    def test_padded_na_string_is_missing(self) -> None:
        assert is_missing("  NA  ") is True

    def test_nat_is_missing(self) -> None:
        assert is_missing(pd.NaT) is True

    def test_na_like_strings_are_missing(self) -> None:
        for value in ["N/A", "NULL", "#N/A", "-1.#IND", "NONE", "<NA>"]:
            assert is_missing(value) is True


class TestCleanSharesCommentary:
    """Tests for clean_shares_commentary function."""

    def test_removes_leading_quote(self) -> None:
        result = clean_shares_commentary('"Hello world')
        assert result == "Hello world"

    def test_removes_trailing_quote(self) -> None:
        result = clean_shares_commentary('Hello world"')
        assert result == "Hello world"

    def test_removes_both_quotes(self) -> None:
        result = clean_shares_commentary('"Hello world"')
        assert result == "Hello world"

    def test_converts_csv_line_break_pattern(self) -> None:
        result = clean_shares_commentary('Line 1"\n"Line 2')
        assert result == "Line 1\nLine 2"

    def test_converts_escaped_double_quotes(self) -> None:
        result = clean_shares_commentary('He said ""hello""')
        assert result == 'He said "hello"'

    def test_handles_complex_pattern(self) -> None:
        input_text = (
            '"The next phase of AI isn\'t about IQ."\n""\n""AI companies have been obsessed"'
        )
        result = clean_shares_commentary(input_text)
        assert "The next phase" in result
        assert "AI companies" in result

    def test_strips_whitespace(self) -> None:
        result = clean_shares_commentary("  Hello world  ")
        assert result == "Hello world"

    def test_returns_empty_for_none(self) -> None:
        result = clean_shares_commentary(None)
        assert result == ""

    def test_returns_empty_for_nan(self) -> None:
        result = clean_shares_commentary(float("nan"))
        assert result == ""

    def test_converts_non_string_to_string(self) -> None:
        result = clean_shares_commentary(12345)
        assert result == "12345"


class TestCleanCommentsMessage:
    """Tests for clean_comments_message function."""

    def test_removes_backslash_escaped_quotes(self) -> None:
        result = clean_comments_message('He said \\"hello\\"')
        assert result == 'He said "hello"'

    def test_handles_double_double_quotes(self) -> None:
        result = clean_comments_message('He said ""hello""')
        assert result == 'He said "hello"'

    def test_preserves_line_breaks(self) -> None:
        result = clean_comments_message("Line 1\nLine 2\nLine 3")
        assert result == "Line 1\nLine 2\nLine 3"

    def test_preserves_code_blocks(self) -> None:
        code = """#Excel

=LET(
    _data, A1:A10,
    _result, SUM(_data),
    _result
)"""
        result = clean_comments_message(code)
        assert "#Excel" in result
        assert "=LET(" in result
        assert "_result" in result

    def test_strips_whitespace(self) -> None:
        result = clean_comments_message("  Hello world  ")
        assert result == "Hello world"

    def test_returns_empty_for_none(self) -> None:
        result = clean_comments_message(None)
        assert result == ""

    def test_returns_empty_for_nan(self) -> None:
        result = clean_comments_message(float("nan"))
        assert result == ""


class TestCleanEmptyField:
    """Tests for clean_empty_field function."""

    def test_returns_empty_for_none(self) -> None:
        result = clean_empty_field(None)
        assert result == ""

    def test_returns_empty_for_nan(self) -> None:
        result = clean_empty_field(float("nan"))
        assert result == ""

    def test_returns_empty_for_double_quotes(self) -> None:
        result = clean_empty_field('""')
        assert result == ""

    def test_returns_empty_for_single_quote(self) -> None:
        result = clean_empty_field('"')
        assert result == ""

    def test_returns_empty_for_empty_string(self) -> None:
        result = clean_empty_field("")
        assert result == ""

    def test_returns_value_for_non_empty(self) -> None:
        result = clean_empty_field("hello")
        assert result == "hello"

    def test_strips_whitespace(self) -> None:
        result = clean_empty_field("  hello  ")
        assert result == "hello"

    def test_returns_empty_for_whitespace_only(self) -> None:
        # Whitespace strips to empty string, which is in the empty set
        result = clean_empty_field("   ")
        assert result == ""


class TestCleanMessagesContent:
    """Tests for clean_messages_content function."""

    def test_removes_backslash_escaped_quotes(self) -> None:
        result = clean_messages_content('He said \\"hello\\"')
        assert result == 'He said "hello"'

    def test_handles_double_double_quotes(self) -> None:
        result = clean_messages_content('He said ""hello""')
        assert result == 'He said "hello"'

    def test_preserves_line_breaks(self) -> None:
        result = clean_messages_content("Line 1\nLine 2")
        assert result == "Line 1\nLine 2"

    def test_returns_empty_for_missing(self) -> None:
        assert clean_messages_content(None) == ""
        assert clean_messages_content(float("nan")) == ""


class TestCleanDate:
    """Tests for clean_date function."""

    def test_returns_empty_for_none(self) -> None:
        result = clean_date(None)
        assert result == ""

    def test_returns_empty_for_nan(self) -> None:
        result = clean_date(float("nan"))
        assert result == ""

    def test_returns_as_is_for_invalid_format(self) -> None:
        result = clean_date("not a date")
        assert result == "not a date"

    def test_returns_as_is_for_date_only(self) -> None:
        result = clean_date("2024-01-15")
        assert result == "2024-01-15"

    def test_converts_valid_datetime(self) -> None:
        # We can't test exact local time conversion since it depends on timezone,
        # but we can verify format is preserved
        result = clean_date("2024-01-15 14:30:00")
        assert len(result) == 19  # YYYY-MM-DD HH:MM:SS
        assert result[4] == "-"
        assert result[7] == "-"
        assert result[10] == " "
        assert result[13] == ":"
        assert result[16] == ":"

    def test_returns_empty_for_empty_string(self) -> None:
        result = clean_date("")
        assert result == ""

    def test_returns_empty_for_na_string(self) -> None:
        result = clean_date("NA")
        assert result == ""

    def test_strips_utc_suffix(self) -> None:
        result = clean_date("2024-01-15 14:30:00 UTC")
        assert len(result) == 19
        assert result[4] == "-"
        assert result[13] == ":"


class TestCleanConnectionsDate:
    """Tests for clean_connections_date function."""

    def test_returns_empty_for_missing(self) -> None:
        assert clean_connections_date(None) == ""
        assert clean_connections_date(float("nan")) == ""

    def test_converts_short_month_name(self) -> None:
        assert clean_connections_date("30 Jan 2026") == "2026-01-30"

    def test_converts_long_month_name(self) -> None:
        assert clean_connections_date("30 January 2026") == "2026-01-30"

    def test_returns_as_is_for_invalid_format(self) -> None:
        assert clean_connections_date("2026/01/30") == "2026/01/30"


class TestCleanValue:
    """Tests for clean_value function."""

    def test_returns_empty_for_none(self) -> None:
        result = clean_value(None)
        assert result == ""

    def test_returns_empty_for_nan(self) -> None:
        result = clean_value(float("nan"))
        assert result == ""

    def test_returns_empty_for_empty_string(self) -> None:
        result = clean_value("")
        assert result == ""

    def test_returns_empty_for_na_string(self) -> None:
        result = clean_value("NA")
        assert result == ""

    def test_strips_whitespace(self) -> None:
        result = clean_value("  hello  ")
        assert result == "hello"

    def test_returns_value_for_non_empty(self) -> None:
        result = clean_value("hello")
        assert result == "hello"

    def test_converts_non_string(self) -> None:
        result = clean_value(12345)
        assert result == "12345"


class TestEscapeExcelFormula:
    """Tests for escape_excel_formula function."""

    def test_prefixes_formula(self) -> None:
        assert escape_excel_formula("=SUM(A1:A2)") == "'=SUM(A1:A2)"

    def test_leaves_plain_text(self) -> None:
        assert escape_excel_formula("hello") == "hello"

    def test_leaves_non_string(self) -> None:
        assert escape_excel_formula(123) == 123

    def test_prefixes_plus(self) -> None:
        assert escape_excel_formula("+cmd") == "'+cmd"

    def test_prefixes_minus(self) -> None:
        assert escape_excel_formula("-cmd") == "'-cmd"

    def test_prefixes_at(self) -> None:
        assert escape_excel_formula("@SUM(A1)") == "'@SUM(A1)"

    def test_prefixes_tab(self) -> None:
        assert escape_excel_formula("\tcmd") == "'\tcmd"

    def test_prefixes_cr(self) -> None:
        assert escape_excel_formula("\rcmd") == "'\rcmd"

    def test_prefixes_lf(self) -> None:
        assert escape_excel_formula("\ncmd") == "'\ncmd"
