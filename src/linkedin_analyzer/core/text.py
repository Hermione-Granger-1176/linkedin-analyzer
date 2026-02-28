"""Text cleaning utilities."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, cast

import pandas as pd


def is_missing(value: object) -> bool:
    """Check if a value is missing (None, pandas NA, empty, or NA-like string).

    Treats the following as missing:
    - None
    - Empty strings or whitespace-only strings
    - Literal "NA" or "NaN" strings (case-insensitive for "NA")
    - Pandas NA/NaT/NaN types

    Args:
        value: Value to check

    Returns:
        True if the value is missing, False otherwise
    """
    if value is None:
        return True
    # Check string values for empty, whitespace-only, or NA-like literals
    if isinstance(value, str):
        trimmed = value.strip()
        if trimmed == "":
            return True
        upper = trimmed.upper()
        missing_values = {
            "#N/A",
            "#N/A N/A",
            "#NA",
            "-1.#IND",
            "-1.#QNAN",
            "-NAN",
            "1.#IND",
            "1.#QNAN",
            "N/A",
            "NA",
            "NULL",
            "NAN",
        }
        return upper in missing_values
    try:
        # Use cast to Any since pd.isna accepts more types than stubs indicate
        result = pd.isna(cast("Any", value))
        # Handle scalar and array results
        if isinstance(result, bool):
            return result
        return bool(result)
    except (TypeError, ValueError):
        return False


def clean_shares_commentary(value: object) -> str:
    r"""Clean ShareCommentary field from LinkedIn Shares export.

    Handles the double-double quote escaping pattern used in Shares.csv:
    - Removes leading/trailing quotes
    - Converts CSV line break patterns ("\\n") to actual newlines
    - Converts escaped quotes ("") to single quotes (")

    Args:
        value: Raw value from CSV

    Returns:
        Cleaned string
    """
    if is_missing(value):
        return ""

    text = str(value)

    # Remove leading quote if present
    if text.startswith('"'):
        text = text[1:]

    # Remove trailing quote if present
    if text.endswith('"'):
        text = text[:-1]

    # Replace CSV line break pattern: "\n" (quote-newline-quote) with actual newline
    text = text.replace('"\n"', "\n")

    # Replace escaped double quotes with single quotes
    text = text.replace('""', '"')

    return text.strip()


def clean_comments_message(value: object) -> str:
    r"""Clean Message field from LinkedIn Comments export.

    Handles the backslash-escaped quote pattern used in Comments.csv:
    - Converts backslash-escaped quotes (\\") to regular quotes (")
    - Handles any double-double quote escaping as fallback
    - Preserves line breaks

    Args:
        value: Raw value from CSV

    Returns:
        Cleaned string
    """
    if is_missing(value):
        return ""

    text = str(value)

    # Replace backslash-escaped quotes with regular quotes
    # Note: The CSV parser with escapechar handles most of this,
    # but we do it anyway for safety
    text = text.replace('\\"', '"')

    # Also handle any double-double quote escaping (fallback)
    text = text.replace('""', '"')

    return text.strip()


def clean_empty_field(value: object) -> str:
    """Clean empty or quoted-empty fields.

    Args:
        value: Raw value from CSV

    Returns:
        Empty string if the field is empty/missing, otherwise the cleaned value
    """
    if is_missing(value):
        return ""
    text = str(value).strip()
    return "" if text in {'""', '"', ""} else text


def clean_date(value: object) -> str:
    """Convert a UTC datetime string to local timezone.

    Parses a datetime string in "YYYY-MM-DD HH:MM:SS" format, treats it as
    UTC, converts it to the local timezone, and returns it in the same format.

    Args:
        value: Raw UTC datetime string from CSV

    Returns:
        Datetime string converted to local timezone, empty string if missing,
        or the original value as-is if the format is unexpected
    """
    if is_missing(value):
        return ""

    text = str(value).strip()

    try:
        fmt = "%Y-%m-%d %H:%M:%S"
        utc_dt = datetime.strptime(text, fmt).replace(
            tzinfo=UTC,
        )
        local_dt = utc_dt.astimezone()
        return local_dt.strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, OverflowError):
        return text


def clean_value(value: object) -> str:
    """Clean a generic field value by trimming whitespace.

    Basic cleaner for columns that don't need specific cleaning logic.

    Args:
        value: Raw value from CSV

    Returns:
        Trimmed string, or empty string if missing
    """
    if is_missing(value):
        return ""
    return str(value).strip()


def escape_excel_formula(value: object) -> object:
    """Escape Excel formula-like strings to prevent repair warnings.

    Args:
        value: Cleaned cell value

    Returns:
        Original value, or prefixed string if it starts with "="
    """
    if isinstance(value, str) and value.startswith("="):
        return f"'{value}"
    return value
