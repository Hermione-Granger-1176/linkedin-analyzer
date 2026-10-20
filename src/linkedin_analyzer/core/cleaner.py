"""Base cleaner functionality."""

from __future__ import annotations

import logging
import os
import tempfile
from io import StringIO
from pathlib import Path
from typing import Any, Literal

import pandas as pd

from linkedin_analyzer.core.excel import format_excel_worksheet
from linkedin_analyzer.core.text import (
    clean_value,
    escape_excel_formula,
    is_missing,
    remove_illegal_chars,
)
from linkedin_analyzer.core.types import CleanerConfig, CleanerResult

LOG = logging.getLogger(__name__)

_WHATWG_WINDOWS_1252_C1_CODE_POINTS = (
    0x20AC,
    0x0081,
    0x201A,
    0x0192,
    0x201E,
    0x2026,
    0x2020,
    0x2021,
    0x02C6,
    0x2030,
    0x0160,
    0x2039,
    0x0152,
    0x008D,
    0x017D,
    0x008F,
    0x0090,
    0x2018,
    0x2019,
    0x201C,
    0x201D,
    0x2022,
    0x2013,
    0x2014,
    0x02DC,
    0x2122,
    0x0161,
    0x203A,
    0x0153,
    0x009D,
    0x017E,
    0x0178,
)
_WHATWG_WINDOWS_1252_TRANSLATION = str.maketrans(
    {
        byte_value: chr(code_point)
        for byte_value, code_point in enumerate(
            _WHATWG_WINDOWS_1252_C1_CODE_POINTS,
            start=0x80,
        )
    }
)


def _byte_unit(value: int) -> str:
    """Return a singular or plural byte unit."""
    return "byte" if value == 1 else "bytes"


def _decode_csv_bytes(data: bytes) -> tuple[str, bool]:
    """Decode bytes as BOM-aware UTF-8, then WHATWG Windows-1252."""
    try:
        return data.decode("utf-8-sig"), False
    except UnicodeDecodeError:
        latin_1 = data.decode("latin-1")
        return latin_1.translate(_WHATWG_WINDOWS_1252_TRANSLATION), True


def _read_csv_with_fallback(
    input_path: Path,
    csv_kwargs: dict[str, Any],
    encoding: str | None,
) -> pd.DataFrame:
    """Read a CSV, auto-detecting a usable encoding when one is not specified.

    LinkedIn (and user-edited) exports are not always UTF-8. When no explicit
    encoding is requested, this tries UTF-8 (BOM-aware) first, then falls back to
    WHATWG Windows-1252 to match browser ``TextDecoder`` behavior.

    Args:
        input_path: Path to the CSV file to read
        csv_kwargs: Additional keyword arguments forwarded to pandas.read_csv;
            an ``encoding`` entry here is consumed (popped) to avoid passing the
            argument twice, and is used only when ``encoding`` is None
        encoding: Explicit encoding to use; when None, encoding is auto-detected

    Returns:
        The parsed DataFrame
    """
    # Resolve encoding precedence and remove it from csv_kwargs so it is never
    # passed to pandas.read_csv twice. CleanerConfig.encoding wins; otherwise an
    # encoding supplied via csv_kwargs is honored.
    kwargs_encoding = csv_kwargs.pop("encoding", None)
    resolved_encoding = encoding if encoding is not None else kwargs_encoding
    if resolved_encoding is not None:
        frame: pd.DataFrame = pd.read_csv(input_path, encoding=resolved_encoding, **csv_kwargs)
        return frame
    text, used_fallback = _decode_csv_bytes(input_path.read_bytes())
    if used_fallback:
        LOG.warning(
            "UTF-8 decode failed for %s; retrying with Windows-1252. "
            "Pass --encoding to choose the correct encoding if characters look wrong.",
            input_path,
        )
    frame = pd.read_csv(StringIO(text), **csv_kwargs)
    return frame


def _log_dropped(before: int, after: int, reason: str) -> None:
    """Log how many rows a drop step removed, when any were removed.

    Args:
        before: Row count before the drop
        after: Row count after the drop
        reason: Human-readable description of why the rows were dropped
    """
    dropped = before - after
    if dropped > 0:
        LOG.info("Dropped %d rows %s", dropped, reason)


def _normalize_header(name: object) -> str:
    """Return a stripped column name without a leading byte-order mark."""
    return str(name).strip().lstrip("\ufeff")


def validate_columns(df: pd.DataFrame, required: list[str]) -> None:
    """Validate that required columns exist in the DataFrame.

    Args:
        df: DataFrame to validate
        required: List of required column names

    Raises:
        ValueError: If any required columns are missing
    """
    normalized_columns = {_normalize_header(column) for column in df.columns}
    missing = [col for col in required if col not in normalized_columns]
    if missing:
        raise ValueError(f"Missing required columns: {', '.join(missing)}")


def normalize_required_columns(df: pd.DataFrame, required: list[str]) -> None:
    """Normalize required columns so blank-like values become missing."""
    for column in required:
        if column not in df.columns:
            continue
        normalized = df[column].astype("string").str.strip()
        normalized = normalized.mask(normalized.map(is_missing), pd.NA)
        df[column] = normalized


def _write_excel_atomic(df: pd.DataFrame, output_path: Path, config: CleanerConfig) -> None:
    """Write and format a DataFrame to an Excel file atomically.

    Writes and formats a temporary file in the destination directory, then
    atomically replaces the target so a crash mid-write cannot leave a truncated
    or corrupt .xlsx at output_path. The temporary file is removed if any step
    fails.

    Args:
        df: DataFrame to export
        output_path: Final path for the Excel file
        config: Cleaner configuration with formatting settings
    """
    tmp_fd, tmp_name = tempfile.mkstemp(
        prefix=f".{output_path.stem}-",
        suffix=output_path.suffix,
        dir=output_path.parent,
    )
    os.close(tmp_fd)
    tmp_path = Path(tmp_name)
    try:
        with pd.ExcelWriter(tmp_path, engine="openpyxl") as writer:
            df.to_excel(writer, index=False)
            LOG.info("Formatting Excel output")
            format_excel_worksheet(writer.book.active, config)
        tmp_path.replace(output_path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def _limit_error(name: str, value: int) -> str | None:
    """Return an error when a resource limit is negative."""
    if value < 0:
        return f"{name} must be a non-negative integer"
    return None


def _failure_result(
    config: CleanerConfig,
    error: str,
    *,
    missing_input: bool = False,
) -> CleanerResult:
    """Return a failed cleaner result for the configured paths."""
    return CleanerResult(
        success=False,
        rows_processed=0,
        input_path=config.input_path,
        output_path=config.output_path,
        error=error,
        missing_input=missing_input,
    )


def _apply_row_read_limit(csv_kwargs: dict[str, Any], max_rows: int) -> None:
    """Bound CSV parsing to one row past the configured row limit."""
    if max_rows <= 0:
        return

    read_limit = max_rows + 1
    existing_nrows = csv_kwargs.get("nrows")
    if isinstance(existing_nrows, int):
        read_limit = min(existing_nrows, read_limit)
    csv_kwargs["nrows"] = read_limit


def _preflight_error(config: CleanerConfig) -> str | None:
    """Return why the input cannot be processed, or None when the limits allow it."""
    for name, value in (
        ("max_input_bytes", config.max_input_bytes),
        ("max_rows", config.max_rows),
    ):
        error = _limit_error(name, value)
        if error:
            return error

    if config.max_input_bytes <= 0:
        return None
    try:
        input_size = config.input_path.stat().st_size
    except OSError as exc:
        return str(exc)
    if input_size > config.max_input_bytes:
        return (
            "Input file is too large: "
            f"{input_size} {_byte_unit(input_size)} exceeds limit of "
            f"{config.max_input_bytes} {_byte_unit(config.max_input_bytes)}"
        )
    return None


def _load_frame(config: CleanerConfig) -> pd.DataFrame:
    """Read the input CSV and enforce the configured row limit."""
    LOG.info("Reading %s", config.input_path)
    csv_kwargs: dict[str, Any] = dict(config.csv_kwargs)
    if config.skiprows:
        csv_kwargs.setdefault("skiprows", config.skiprows)
    _apply_row_read_limit(csv_kwargs, config.max_rows)
    df = _read_csv_with_fallback(config.input_path, csv_kwargs, config.encoding)
    LOG.info("Found %d rows", len(df))
    if config.max_rows > 0 and len(df) > config.max_rows:
        raise ValueError(
            f"Input CSV has too many rows: {len(df)} exceeds limit of {config.max_rows}"
        )
    return df


def _normalize_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Normalize headers, turn blank cells into missing values, and drop empty rows."""
    df = df.rename(columns=_normalize_header)
    duplicate_columns = [str(name) for name in df.columns[df.columns.duplicated()].unique()]
    if duplicate_columns:
        raise ValueError(
            f"Duplicate columns after header normalization: {', '.join(duplicate_columns)}"
        )
    df = df.replace(r"^\s*$", pd.NA, regex=True)
    rows_before = len(df)
    df = df.dropna(how="all")
    _log_dropped(rows_before, len(df), "with no values")
    return df


def _drop_rows_missing(
    df: pd.DataFrame,
    columns: list[str],
    *,
    how: Literal["any", "all"],
    reason: str,
) -> pd.DataFrame:
    """Drop rows whose values in ``columns`` are missing, and log how many went.

    ``how="any"`` drops a row missing any of the columns; ``how="all"`` drops it
    only when every one of them is missing. Does nothing when ``columns`` is empty.
    """
    if not columns:
        return df
    normalize_required_columns(df, columns)
    rows_before = len(df)
    df = df.dropna(subset=columns, how=how)
    _log_dropped(rows_before, len(df), reason)
    return df


def _filter_rows(df: pd.DataFrame, config: CleanerConfig) -> pd.DataFrame:
    """Check the required columns exist, then drop rows that lack required values."""
    LOG.info("Validating columns")
    validate_columns(df, config.required_columns)
    required_row_columns = list(config.required_row_columns or config.required_columns)
    df = _drop_rows_missing(
        df,
        required_row_columns,
        how="any",
        reason="missing required values",
    )
    optional_columns = [col for col in config.drop_if_all_missing if col in df.columns]
    return _drop_rows_missing(
        df,
        optional_columns,
        how="all",
        reason="with all optional fields empty",
    )


def _clean_columns(df: pd.DataFrame, config: CleanerConfig) -> pd.DataFrame:
    """Apply each column's cleaner, then keep only the configured columns in order."""
    for col_config in config.columns:
        if col_config.name not in df.columns:
            continue
        cleaner = col_config.cleaner if col_config.cleaner is not None else clean_value
        LOG.info("Cleaning column: %s", col_config.name)
        df[col_config.name] = df[col_config.name].apply(cleaner)

    return df.reindex(columns=[col.name for col in config.columns], fill_value="")


def _sanitize_cells(df: pd.DataFrame) -> pd.DataFrame:
    r"""Make every cell safe to write to a worksheet.

    Strips XML-illegal control characters before formula-escaping so a cell
    like "\x01=SUM(...)" is both made writable by openpyxl and still
    recognized as a formula-injection payload to quote-prefix.
    """
    for column in df.columns:
        df[column] = df[column].map(remove_illegal_chars).map(escape_excel_formula)
    return df


def run_cleaner(config: CleanerConfig) -> CleanerResult:
    """Execute a cleaning operation.

    Args:
        config: Cleaner configuration

    Returns:
        Result of the cleaning operation
    """
    input_path = config.input_path
    output_path = config.output_path

    if not input_path.exists():
        return _failure_result(
            config,
            f"Input file does not exist: {input_path}",
            missing_input=True,
        )

    error = _preflight_error(config)
    if error:
        return _failure_result(config, error)

    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        df = _load_frame(config)
        df = _filter_rows(_normalize_frame(df), config)
        df = _sanitize_cells(_clean_columns(df, config))

        LOG.info("Exporting to %s", output_path)
        _write_excel_atomic(df, output_path, config)

        LOG.info("Done. Total rows: %d", len(df))
        return CleanerResult(
            success=True,
            rows_processed=len(df),
            input_path=input_path,
            output_path=output_path,
        )

    except Exception as exc:
        LOG.exception("Failed to clean and export data")
        return _failure_result(config, str(exc))
