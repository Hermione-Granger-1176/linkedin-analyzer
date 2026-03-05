"""Default paths for LinkedIn analyzer inputs and outputs."""

from __future__ import annotations

import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("LINKEDIN_ANALYZER_DATA_DIR", "data"))
INPUT_DIR = DATA_DIR / "input"
OUTPUT_DIR = DATA_DIR / "output"

DEFAULT_SHARES_INPUT = INPUT_DIR / "Shares.csv"
DEFAULT_SHARES_OUTPUT = OUTPUT_DIR / "Shares.xlsx"
DEFAULT_COMMENTS_INPUT = INPUT_DIR / "Comments.csv"
DEFAULT_COMMENTS_OUTPUT = OUTPUT_DIR / "Comments.xlsx"
DEFAULT_MESSAGES_INPUT = INPUT_DIR / "messages.csv"
DEFAULT_MESSAGES_OUTPUT = OUTPUT_DIR / "Messages.xlsx"
DEFAULT_CONNECTIONS_INPUT = INPUT_DIR / "Connections.csv"
DEFAULT_CONNECTIONS_OUTPUT = OUTPUT_DIR / "Connections.xlsx"
