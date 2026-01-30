"""Tests for the CLI module."""

from __future__ import annotations

import argparse
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

import linkedin_analyzer.cli as cli
from linkedin_analyzer.cli import main, parse_args
from linkedin_analyzer.core.types import CleanerResult


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

    def test_no_command_returns_one_when_help_does_not_exit(self) -> None:
        def fake_parse(argv: list[str] | None = None) -> SimpleNamespace:
            if argv == ["--help"]:
                return SimpleNamespace(command="shares", log_level="INFO")
            return SimpleNamespace(command=None, log_level="INFO")

        with patch("linkedin_analyzer.cli.parse_args", side_effect=fake_parse):
            assert main([]) == 1

    def test_unknown_command_returns_error(self) -> None:
        args = SimpleNamespace(command="unknown", log_level="INFO")
        with patch("linkedin_analyzer.cli.parse_args", return_value=args):
            assert main([]) == 1

    def test_main_handles_handler_exception(self) -> None:
        args = SimpleNamespace(command="shares", log_level="INFO")
        with (
            patch("linkedin_analyzer.cli.parse_args", return_value=args),
            patch("linkedin_analyzer.cli.run_shares", side_effect=RuntimeError("boom")),
        ):
            assert main([]) == 1


class TestRunAll:
    """Tests for running all cleaners."""

    def test_run_all_success(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        args = argparse.Namespace(
            shares_input=tmp_path / "Shares.csv",
            shares_output=tmp_path / "Shares.xlsx",
            comments_input=tmp_path / "Comments.csv",
            comments_output=tmp_path / "Comments.xlsx",
        )

        def fake_shares(*, input_path: Path, output_path: Path) -> CleanerResult:
            return CleanerResult(
                success=True,
                rows_processed=1,
                input_path=input_path,
                output_path=output_path,
            )

        def fake_comments(*, input_path: Path, output_path: Path) -> CleanerResult:
            return CleanerResult(
                success=True,
                rows_processed=1,
                input_path=input_path,
                output_path=output_path,
            )

        monkeypatch.setattr(cli, "clean_shares", fake_shares)
        monkeypatch.setattr(cli, "clean_comments", fake_comments)

        assert cli.run_all(args) == 0

    def test_run_all_failure(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        args = argparse.Namespace(
            shares_input=tmp_path / "Shares.csv",
            shares_output=tmp_path / "Shares.xlsx",
            comments_input=tmp_path / "Comments.csv",
            comments_output=tmp_path / "Comments.xlsx",
        )

        def fake_shares(*, input_path: Path, output_path: Path) -> CleanerResult:
            return CleanerResult(
                success=False,
                rows_processed=0,
                input_path=input_path,
                output_path=output_path,
                error="boom",
            )

        def fake_comments(*, input_path: Path, output_path: Path) -> CleanerResult:
            return CleanerResult(
                success=True,
                rows_processed=1,
                input_path=input_path,
                output_path=output_path,
            )

        monkeypatch.setattr(cli, "clean_shares", fake_shares)
        monkeypatch.setattr(cli, "clean_comments", fake_comments)

        assert cli.run_all(args) == 1

    def test_run_all_failure_on_comments(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        args = argparse.Namespace(
            shares_input=tmp_path / "Shares.csv",
            shares_output=tmp_path / "Shares.xlsx",
            comments_input=tmp_path / "Comments.csv",
            comments_output=tmp_path / "Comments.xlsx",
        )

        def fake_shares(*, input_path: Path, output_path: Path) -> CleanerResult:
            return CleanerResult(
                success=True,
                rows_processed=1,
                input_path=input_path,
                output_path=output_path,
            )

        def fake_comments(*, input_path: Path, output_path: Path) -> CleanerResult:
            return CleanerResult(
                success=False,
                rows_processed=0,
                input_path=input_path,
                output_path=output_path,
                error="boom",
            )

        monkeypatch.setattr(cli, "clean_shares", fake_shares)
        monkeypatch.setattr(cli, "clean_comments", fake_comments)

        assert cli.run_all(args) == 1
