"""Cross-runtime parity tests between Python and web cleaner contracts."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from linkedin_analyzer.cleaners.connections import clean_connections
from linkedin_analyzer.cleaners.messages import clean_messages

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def test_messages_fixture_matches_expected_python_contract(tmp_path: Path) -> None:
    """Messages cleaner should produce stable output for shared parity fixture."""
    output_file = tmp_path / "Messages.xlsx"

    result = clean_messages(
        input_path=FIXTURES_DIR / "messages-parity.csv",
        output_path=output_file,
    )

    assert result.success is True
    df = pd.read_excel(output_file)
    assert list(df["FROM"]) == ["Ada"]
    assert list(df["CONTENT"]) == ['He said "hello"']


def test_connections_fixture_matches_expected_python_contract(tmp_path: Path) -> None:
    """Connections cleaner should produce stable output for shared parity fixture."""
    output_file = tmp_path / "Connections.xlsx"

    result = clean_connections(
        input_path=FIXTURES_DIR / "connections-parity.csv",
        output_path=output_file,
    )

    assert result.success is True
    df = pd.read_excel(output_file)
    assert list(df["Connected On"]) == ["2026-01-30", "2026-02-15"]
    assert list(df["URL"].fillna("")) == [
        "https://linkedin.com/in/ada",
        "https://linkedin.com/in/bob",
    ]
