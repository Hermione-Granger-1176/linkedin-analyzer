"""Default paths for LinkedIn analyzer inputs and outputs."""

from __future__ import annotations

from pathlib import Path

DATA_DIR = Path("data")
INPUT_DIR = DATA_DIR / "input"
OUTPUT_DIR = DATA_DIR / "output"

DEFAULT_SHARES_INPUT = INPUT_DIR / "Shares.csv"
DEFAULT_SHARES_OUTPUT = OUTPUT_DIR / "Shares.xlsx"
DEFAULT_COMMENTS_INPUT = INPUT_DIR / "Comments.csv"
DEFAULT_COMMENTS_OUTPUT = OUTPUT_DIR / "Comments.xlsx"
