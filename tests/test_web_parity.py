"""Cross-runtime parity tests between Python and web cleaner contracts."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from linkedin_analyzer.cleaners.comments import clean_comments
from linkedin_analyzer.cleaners.connections import clean_connections
from linkedin_analyzer.cleaners.messages import clean_messages
from linkedin_analyzer.cleaners.shares import clean_shares

FIXTURES_DIR = Path(__file__).parent / "fixtures"
# Cleaned dates are converted from UTC to the local timezone, so parity tests
# assert the format instead of an exact machine-dependent value.
LOCAL_DATETIME_PATTERN = r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$"


def test_shares_fixture_matches_expected_python_contract(tmp_path: Path) -> None:
    """Shares cleaner should produce stable output for shared parity fixture."""
    output_file = tmp_path / "Shares.xlsx"

    result = clean_shares(
        input_path=FIXTURES_DIR / "shares-parity.csv",
        output_path=output_file,
    )

    assert result.success is True
    df = pd.read_excel(output_file).fillna("")
    assert df["Date"].str.match(LOCAL_DATETIME_PATTERN).all()
    assert list(df["ShareLink"]) == [
        "https://www.linkedin.com/feed/update/urn:li:share:1",
        "https://www.linkedin.com/feed/update/urn:li:share:2",
    ]
    assert list(df["ShareCommentary"]) == [
        'He said "hi".\n\nNext "line" here.',
        "Smart “quotes” and naïve emoji 📌 stay intact.",
    ]
    assert list(df["SharedUrl"]) == ["https://example.com/post", ""]
    assert list(df["MediaUrl"]) == ["", ""]
    assert list(df["Visibility"]) == ["MEMBER_NETWORK", "CONNECTIONS"]


def test_comments_fixture_matches_expected_python_contract(tmp_path: Path) -> None:
    """Comments cleaner should produce stable output for shared parity fixture."""
    output_file = tmp_path / "Comments.xlsx"

    result = clean_comments(
        input_path=FIXTURES_DIR / "comments-parity.csv",
        output_path=output_file,
    )

    assert result.success is True
    df = pd.read_excel(output_file).fillna("")
    assert df["Date"].str.match(LOCAL_DATETIME_PATTERN).all()
    assert list(df["Link"]) == [
        "https://www.linkedin.com/feed/update/urn:li:activity:1",
        "https://www.linkedin.com/feed/update/urn:li:activity:2",
    ]
    assert list(df["Message"]) == [
        'She wrote "great post" yesterday.\n📌 Naïve “smart quotes” line.',
        'Plain text with "doubled" quotes',
    ]


def test_messages_fixture_matches_expected_python_contract(tmp_path: Path) -> None:
    """Messages cleaner should produce stable output for shared parity fixture."""
    output_file = tmp_path / "Messages.xlsx"

    result = clean_messages(
        input_path=FIXTURES_DIR / "messages-parity.csv",
        output_path=output_file,
    )

    assert result.success is True
    df = pd.read_excel(output_file).fillna("")
    assert list(df["FROM"]) == ["Ada"]
    assert list(df["TO"]) == ["Bob"]
    assert df["DATE"].str.match(LOCAL_DATETIME_PATTERN).all()
    assert list(df["CONTENT"]) == ['He said "hello"']
    assert list(df["FOLDER"]) == ["INBOX"]
    assert list(df["CONVERSATION ID"]) == ["abc"]
    assert list(df["SENDER PROFILE URL"]) == ["https://linkedin.com/in/ada"]
    assert list(df["RECIPIENT PROFILE URLS"]) == ["https://linkedin.com/in/bob"]


def test_connections_fixture_matches_expected_python_contract(tmp_path: Path) -> None:
    """Connections cleaner should produce stable output for shared parity fixture."""
    output_file = tmp_path / "Connections.xlsx"

    result = clean_connections(
        input_path=FIXTURES_DIR / "connections-parity.csv",
        output_path=output_file,
    )

    assert result.success is True
    df = pd.read_excel(output_file).fillna("")
    assert list(df["First Name"]) == ["Ada", ""]
    assert list(df["Last Name"]) == ["Lovelace", "Builder"]
    assert list(df["URL"]) == [
        "https://linkedin.com/in/ada",
        "https://linkedin.com/in/bob",
    ]
    assert list(df["Email Address"]) == ["", ""]
    assert list(df["Company"]) == ["Analytical Engines", "Builders Inc"]
    assert list(df["Position"]) == ["Mathematician", "Engineer"]
    assert list(df["Connected On"]) == ["2026-01-30", "2026-02-15"]
