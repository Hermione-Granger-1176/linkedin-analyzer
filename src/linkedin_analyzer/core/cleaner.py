"""Base cleaner functionality."""

from __future__ import annotations

import logging
from typing import Any

import pandas as pd

from linkedin_analyzer.core.excel import format_excel_output
from linkedin_analyzer.core.text import clean_value, escape_excel_formula, is_missing
from linkedin_analyzer.core.types import CleanerConfig, CleanerResult

LOG = logging.getLogger(__name__)


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

    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        LOG.info("Reading %s", input_path)
        csv_kwargs: dict[str, Any] = dict(config.csv_kwargs)
        if config.skiprows:
            csv_kwargs.setdefault("skiprows", config.skiprows)
        df = pd.read_csv(input_path, **csv_kwargs)
        LOG.info("Found %d rows", len(df))

        df = df.rename(columns=lambda name: str(name).strip().lstrip("\ufeff"))
        df = df.replace(r"^\s*$", pd.NA, regex=True)
        df = df.dropna(how="all")

        LOG.info("Validating columns")
        validate_columns(df, config.required_columns)
        normalize_required_columns(df, config.required_columns)
        if config.required_columns:
            df = df.dropna(subset=config.required_columns)
        if config.drop_if_all_missing:
            drop_columns = [col for col in config.drop_if_all_missing if col in df.columns]
            if drop_columns:
                normalize_required_columns(df, drop_columns)
                df = df.dropna(subset=drop_columns, how="all")

        # Apply cleaners to columns
        # (use clean_value as default for columns without a specific cleaner)
        for col_config in config.columns:
            if col_config.name not in df.columns:
                continue
            cleaner = col_config.cleaner if col_config.cleaner is not None else clean_value
            LOG.info("Cleaning column: %s", col_config.name)
            df[col_config.name] = df[col_config.name].apply(cleaner)

        df = df.map(escape_excel_formula)

        configured_columns = [col.name for col in config.columns]
        df = df.reindex(columns=configured_columns, fill_value="")

        LOG.info("Exporting to %s", output_path)
        df.to_excel(output_path, index=False, engine="openpyxl")

        LOG.info("Formatting Excel output")
        format_excel_output(output_path, config)

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
