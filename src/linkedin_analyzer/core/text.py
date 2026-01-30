"""Text cleaning utilities."""

from __future__ import annotations

from typing import Any, cast

import pandas as pd


def is_missing(value: object) -> bool:
    """Check if a value is missing (None or pandas NA).

    Args:
        value: Value to check

    Returns:
        True if the value is missing, False otherwise
    """
    if value is None:
        return True
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
