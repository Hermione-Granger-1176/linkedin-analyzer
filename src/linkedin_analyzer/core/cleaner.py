"""Base cleaner functionality."""

from __future__ import annotations

import logging
from typing import Any

import pandas as pd

from linkedin_analyzer.core.excel import format_excel_output
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
    missing = [col for col in required if col not in df.columns]
    if missing:
        raise ValueError(f"Missing required columns: {', '.join(missing)}")


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
        df = pd.read_csv(input_path, **csv_kwargs)
        LOG.info("Found %d rows", len(df))

        LOG.info("Validating columns")
        validate_columns(df, config.required_columns)

        # Apply cleaners to columns
        for col_config in config.columns:
            if col_config.cleaner is not None:
                LOG.info("Cleaning column: %s", col_config.name)
                df[col_config.name] = df[col_config.name].apply(col_config.cleaner)

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
