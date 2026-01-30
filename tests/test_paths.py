"""Tests for default path constants."""

from __future__ import annotations

from pathlib import Path

import linkedin_analyzer.core.paths as paths


def test_default_paths() -> None:
    """Verify default input/output path constants."""
    assert Path("data") == paths.DATA_DIR
    assert Path("data") / "input" == paths.INPUT_DIR
    assert Path("data") / "output" == paths.OUTPUT_DIR
    assert Path("data/input/Shares.csv") == paths.DEFAULT_SHARES_INPUT
    assert Path("data/output/Shares.xlsx") == paths.DEFAULT_SHARES_OUTPUT
    assert Path("data/input/Comments.csv") == paths.DEFAULT_COMMENTS_INPUT
    assert Path("data/output/Comments.xlsx") == paths.DEFAULT_COMMENTS_OUTPUT
