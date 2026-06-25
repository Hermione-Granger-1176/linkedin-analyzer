"""Base cleaner functionality."""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Any

import pandas as pd

from linkedin_analyzer.core.excel import format_excel_output
from linkedin_analyzer.core.text import clean_value, escape_excel_formula, is_missing
from linkedin_analyzer.core.types import CleanerConfig, CleanerResult

LOG = logging.getLogger(__name__)


def _byte_unit(value: int) -> str:
    """Return a singular or plural byte unit."""
    return "byte" if value == 1 else "bytes"


def _read_csv_with_fallback(
    input_path: Path,
    csv_kwargs: dict[str, Any],
    encoding: str | None,
) -> pd.DataFrame:
    """Read a CSV, auto-detecting a usable encoding when one is not specified.

    LinkedIn (and user-edited) exports are not always UTF-8. When no explicit
    encoding is requested, this tries UTF-8 (BOM-aware) first, then falls back to
    Latin-1, which decodes any byte sequence and so never raises.

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
    try:
        frame = pd.read_csv(input_path, encoding="utf-8-sig", **csv_kwargs)
    except UnicodeDecodeError:
        LOG.warning(
            "UTF-8 decode failed for %s; retrying with latin-1. "
            "Pass --encoding to choose the correct encoding if characters look wrong.",
            input_path,
        )
        frame = pd.read_csv(input_path, encoding="latin-1", **csv_kwargs)
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


def validate_columns(df: pd.DataFrame, required: list[str]) -> None:
    """Validate that required columns exist in the DataFrame.

    Args:
        df: DataFrame to validate
        required: List of required column names

    Raises:
        ValueError: If any required columns are missing
    """
    normalized_columns = {str(col).strip().lstrip("\ufeff") for col in df.columns}
    missing = [col for col in required if col not in normalized_columns]
    if missing:
        raise ValueError(f"Missing required columns: {', '.join(missing)}")


def normalize_required_columns(df: pd.DataFrame, required: list[str]) -> None:
    """Normalize required columns so blank-like values become missing."""
    if not required:
        return

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
        df.to_excel(tmp_path, index=False, engine="openpyxl")
        LOG.info("Formatting Excel output")
        format_excel_output(tmp_path, config)
        tmp_path.replace(output_path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def _limit_error(name: str, value: int) -> str | None:
    """Return an error when a resource limit is negative."""
    if value < 0:
        return f"{name} must be a non-negative integer"
    return None


def _apply_row_read_limit(csv_kwargs: dict[str, Any], max_rows: int) -> None:
    """Bound CSV parsing to one row past the configured row limit."""
    if max_rows <= 0:
        return

    read_limit = max_rows + 1
    existing_nrows = csv_kwargs.get("nrows")
    if isinstance(existing_nrows, int):
        read_limit = min(existing_nrows, read_limit)
    csv_kwargs["nrows"] = read_limit


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
        return CleanerResult(
            success=False,
            rows_processed=0,
            input_path=input_path,
            output_path=output_path,
            error=f"Input file does not exist: {input_path}",
        )

    for name, value in (
        ("max_input_bytes", config.max_input_bytes),
        ("max_rows", config.max_rows),
    ):
        error = _limit_error(name, value)
        if error:
            return CleanerResult(
                success=False,
                rows_processed=0,
                input_path=input_path,
                output_path=output_path,
                error=error,
            )

    if config.max_input_bytes > 0:
        try:
            input_size = input_path.stat().st_size
        except OSError as e:
            return CleanerResult(
                success=False,
                rows_processed=0,
                input_path=input_path,
                output_path=output_path,
                error=str(e),
            )
        if input_size > config.max_input_bytes:
            return CleanerResult(
                success=False,
                rows_processed=0,
                input_path=input_path,
                output_path=output_path,
                error=(
                    "Input file is too large: "
                    f"{input_size} {_byte_unit(input_size)} exceeds limit of "
                    f"{config.max_input_bytes} {_byte_unit(config.max_input_bytes)}"
                ),
            )

    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        LOG.info("Reading %s", input_path)
        csv_kwargs: dict[str, Any] = dict(config.csv_kwargs)
        if config.skiprows:
            csv_kwargs.setdefault("skiprows", config.skiprows)
        _apply_row_read_limit(csv_kwargs, config.max_rows)
        df = _read_csv_with_fallback(input_path, csv_kwargs, config.encoding)
        LOG.info("Found %d rows", len(df))
        if config.max_rows > 0 and len(df) > config.max_rows:
            raise ValueError(
                f"Input CSV has too many rows: {len(df)} exceeds limit of {config.max_rows}"
            )

        df = df.rename(columns=lambda name: str(name).strip().lstrip("\ufeff"))
        duplicate_columns = [str(name) for name in df.columns[df.columns.duplicated()].unique()]
        if duplicate_columns:
            raise ValueError(
                f"Duplicate columns after header normalization: {', '.join(duplicate_columns)}"
            )
        df = df.replace(r"^\s*$", pd.NA, regex=True)
        rows_before_blank = len(df)
        df = df.dropna(how="all")
        _log_dropped(rows_before_blank, len(df), "with no values")

        LOG.info("Validating columns")
        validate_columns(df, config.required_columns)
        required_row_columns = list(config.required_row_columns or config.required_columns)
        normalize_required_columns(df, required_row_columns)
        if required_row_columns:
            rows_before_required = len(df)
            df = df.dropna(subset=required_row_columns)
            _log_dropped(rows_before_required, len(df), "missing required values")
        drop_columns = [col for col in (config.drop_if_all_missing or []) if col in df.columns]
        if drop_columns:
            normalize_required_columns(df, drop_columns)
            rows_before_optional = len(df)
            df = df.dropna(subset=drop_columns, how="all")
            _log_dropped(rows_before_optional, len(df), "with all optional fields empty")

        for col_config in config.columns:
            if col_config.name not in df.columns:
                continue
            cleaner = col_config.cleaner if col_config.cleaner is not None else clean_value
            LOG.info("Cleaning column: %s", col_config.name)
            df[col_config.name] = df[col_config.name].apply(cleaner)

        for column in df.columns:
            df[column] = df[column].map(escape_excel_formula)

        configured_columns = [col.name for col in config.columns]
        df = df.reindex(columns=configured_columns, fill_value="")

        LOG.info("Exporting to %s", output_path)
        _write_excel_atomic(df, output_path, config)

        LOG.info("Done. Total rows: %d", len(df))
        return CleanerResult(
            success=True,
            rows_processed=len(df),
            input_path=input_path,
            output_path=output_path,
        )

    except Exception as e:
        LOG.exception("Failed to clean and export data")
        return CleanerResult(
            success=False,
            rows_processed=0,
            input_path=input_path,
            output_path=output_path,
            error=str(e),
        )
