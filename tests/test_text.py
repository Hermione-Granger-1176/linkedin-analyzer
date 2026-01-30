"""Tests for text cleaning utilities."""

from __future__ import annotations

import pandas as pd

from linkedin_analyzer.core.text import (
    clean_comments_message,
    clean_empty_field,
    clean_shares_commentary,
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

    def test_empty_string_is_not_missing(self) -> None:
        assert is_missing("") is False

    def test_zero_is_not_missing(self) -> None:
        assert is_missing(0) is False

    def test_regular_string_is_not_missing(self) -> None:
        assert is_missing("hello") is False

    def test_whitespace_is_not_missing(self) -> None:
        assert is_missing("   ") is False


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
