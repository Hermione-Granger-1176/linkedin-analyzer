"""Tests for the CLI module."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from linkedin_analyzer.cli import main, parse_args


class TestParseArgs:
    """Tests for argument parsing."""

    def test_shares_command(self) -> None:
        args = parse_args(["shares"])
        assert args.command == "shares"
        assert args.input == Path("data/input/Shares.csv")
        assert args.output == Path("data/output/Shares.xlsx")

    def test_shares_with_custom_paths(self) -> None:
        args = parse_args(["shares", "--input", "my.csv", "--output", "my.xlsx"])
        assert args.command == "shares"
        assert args.input == Path("my.csv")
        assert args.output == Path("my.xlsx")

    def test_comments_command(self) -> None:
        args = parse_args(["comments"])
        assert args.command == "comments"
        assert args.input == Path("data/input/Comments.csv")
        assert args.output == Path("data/output/Comments.xlsx")

    def test_all_command(self) -> None:
        args = parse_args(["all"])
        assert args.command == "all"
        assert args.shares_input == Path("data/input/Shares.csv")
        assert args.shares_output == Path("data/output/Shares.xlsx")
        assert args.comments_input == Path("data/input/Comments.csv")
        assert args.comments_output == Path("data/output/Comments.xlsx")

    def test_log_level(self) -> None:
        args = parse_args(["--log-level", "DEBUG", "shares"])
        assert args.log_level == "DEBUG"

    def test_no_command(self) -> None:
        args = parse_args([])
        assert args.command is None


class TestMain:
    """Tests for main function."""

    def test_no_command_returns_error(self) -> None:
        with patch("linkedin_analyzer.cli.parse_args") as mock_parse:
            # First call returns args with no command
            mock_parse.side_effect = [
                type("Args", (), {"command": None, "log_level": "INFO"})(),
                SystemExit(0),  # Second call for help
            ]
            # Will raise SystemExit from the help call
            with pytest.raises(SystemExit):
                main([])

    def test_shares_command_success(self, tmp_path: Path) -> None:
        # Create test file
        input_file = tmp_path / "Shares.csv"
        output_file = tmp_path / "Shares.xlsx"
        input_file.write_text(
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility\n"
            "2025-01-01,http://link,Hello,,,PUBLIC\n"
        )

        exit_code = main(["shares", "--input", str(input_file), "--output", str(output_file)])
        assert exit_code == 0
        assert output_file.exists()

    def test_comments_command_success(self, tmp_path: Path) -> None:
        # Create test file
        input_file = tmp_path / "Comments.csv"
        output_file = tmp_path / "Comments.xlsx"
        input_file.write_text("Date,Link,Message\n2025-01-01,http://link,Hello\n")

        exit_code = main(["comments", "--input", str(input_file), "--output", str(output_file)])
        assert exit_code == 0
        assert output_file.exists()

    def test_file_not_found_returns_error(self, tmp_path: Path) -> None:
        exit_code = main(
            [
                "shares",
                "--input",
                str(tmp_path / "nonexistent.csv"),
                "--output",
                str(tmp_path / "output.xlsx"),
            ]
        )
        assert exit_code == 1
