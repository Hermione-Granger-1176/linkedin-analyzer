"""Text cleaning utilities."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, cast

import pandas as pd

MISSING_TEXT_VALUES = frozenset(
    {
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
        "NONE",
        "<NA>",
    }
)
CONNECTION_MONTH_LOOKUP = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}
DATETIME_FORMAT = "%Y-%m-%d %H:%M:%S"
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r", "\n")


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
        return not trimmed or trimmed.upper() in MISSING_TEXT_VALUES
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

    if text.startswith('"'):
        text = text[1:]

    if text.endswith('"'):
        text = text[:-1]

    text = text.replace('"\n"', "\n")

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

    text = text.replace('\\"', '"')

    text = text.replace('""', '"')

    return text.strip()


def clean_messages_content(value: object) -> str:
    r"""Clean CONTENT field from LinkedIn messages export.

    Handles common quote escaping patterns:
    - Converts backslash-escaped quotes (\\") to regular quotes (")
    - Converts double-double quotes ("") to regular quotes (")
    - Preserves line breaks and unicode characters

    Args:
        value: Raw value from CSV

    Returns:
        Cleaned string
    """
    if is_missing(value):
        return ""

    text = str(value)
    text = text.replace('\\"', '"')
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
    if text.upper().endswith(" UTC"):
        text = text[:-4].strip()

    try:
        utc_dt = datetime.strptime(text, DATETIME_FORMAT).replace(
            tzinfo=UTC,
        )
        local_dt = utc_dt.astimezone()
        return local_dt.strftime(DATETIME_FORMAT)
    except (ValueError, OverflowError):
        return text


def clean_connections_date(value: object) -> str:
    """Convert LinkedIn Connections date to ISO format.

    Parses dates in "DD Mon YYYY" or "DD Month YYYY" format and returns
    "YYYY-MM-DD". Month parsing is locale-independent and expects English
    month names from LinkedIn exports.

    Args:
        value: Raw connection date value

    Returns:
        Date string in ISO format, empty string if missing, or original value
        if parsing fails
    """
    if is_missing(value):
        return ""

    text = str(value).strip()
    parts = text.split()
    if len(parts) != 3:
        return text

    day_str, month_str, year_str = parts
    if not day_str.isdigit() or not year_str.isdigit():
        return text

    month = CONNECTION_MONTH_LOOKUP.get(month_str[:3].lower())
    if month is None:
        return text

    try:
        parsed = datetime(int(year_str), month, int(day_str))
    except ValueError:
        return text

    return parsed.strftime("%Y-%m-%d")


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
    """Escape strings starting with OWASP formula injection prefixes.

    Prevents Excel/Sheets from interpreting cell values as formulas.
    Covers: = + - @ TAB CR LF per OWASP CSV Injection guidelines.

    Args:
        value: Cleaned cell value

    Returns:
        Original value, or quote-prefixed string if it starts with a
        formula injection character
    """
    if isinstance(value, str) and value.startswith(_FORMULA_PREFIXES):
        return f"'{value}"
    return value
