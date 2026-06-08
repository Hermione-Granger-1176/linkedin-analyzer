"""Tests for package-level metadata."""

from __future__ import annotations

import importlib
from importlib.metadata import PackageNotFoundError
from unittest.mock import patch

import linkedin_analyzer


def test_version_falls_back_when_metadata_missing() -> None:
    """__version__ degrades to 0.0.0 when the package isn't installed."""
    try:
        with patch(
            "importlib.metadata.version", side_effect=PackageNotFoundError("linkedin-analyzer")
        ):
            importlib.reload(linkedin_analyzer)
        assert linkedin_analyzer.__version__ == "0.0.0"
    finally:
        # Restore the real version so other tests see accurate metadata.
        importlib.reload(linkedin_analyzer)
