"""Command-line interface for LinkedIn analyzer."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from linkedin_analyzer.cleaners.comments import clean_comments
from linkedin_analyzer.cleaners.shares import clean_shares
from linkedin_analyzer.core.paths import (
    DEFAULT_COMMENTS_INPUT,
    DEFAULT_COMMENTS_OUTPUT,
    DEFAULT_SHARES_INPUT,
    DEFAULT_SHARES_OUTPUT,
)

if TYPE_CHECKING:
    from collections.abc import Sequence

    from linkedin_analyzer.core.types import CleanerResult

LOG = logging.getLogger("linkedin_analyzer")


def configure_logging(level: str) -> None:
    """Configure logging with the specified level.

    Args:
        level: Logging level name (DEBUG, INFO, WARNING, ERROR, CRITICAL)
    """
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def _add_default_io_args(
    parser: argparse.ArgumentParser,
    default_input: Path,
    default_output: Path,
) -> None:
    parser.add_argument(
        "--input",
        type=Path,
        default=default_input,
        help=f"Path to input CSV file (default: {default_input})",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=default_output,
        help=f"Path to output Excel file (default: {default_output})",
    )


def _add_named_io_args(
    parser: argparse.ArgumentParser,
    name: str,
    default_input: Path,
    default_output: Path,
) -> None:
    parser.add_argument(
        f"--{name}-input",
        type=Path,
        default=default_input,
        help=f"Path to {name} input CSV file (default: {default_input})",
    )
    parser.add_argument(
        f"--{name}-output",
        type=Path,
        default=default_output,
        help=f"Path to {name} output Excel file (default: {default_output})",
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse command-line arguments.

    Args:
        argv: Command-line arguments (defaults to sys.argv[1:])

    Returns:
        Parsed arguments namespace
    """
    parser = argparse.ArgumentParser(
        prog="linkedin-analyzer",
        description="Clean and export LinkedIn CSV data to Excel",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Clean Shares.csv and export to Shares.xlsx
  linkedin-analyzer shares

  # Clean Comments.csv and export to Comments.xlsx
  linkedin-analyzer comments

  # Clean both files
  linkedin-analyzer all

  # Specify custom input/output paths
  linkedin-analyzer shares --input my_shares.csv --output cleaned_shares.xlsx
        """,
    )
    parser.add_argument(
        "--version",
        action="version",
        version="%(prog)s 1.0.0",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        help="Logging level (default: INFO)",
    )

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # Shares subcommand
    shares_parser = subparsers.add_parser(
        "shares",
        help="Clean LinkedIn Shares CSV export",
    )
    _add_default_io_args(shares_parser, DEFAULT_SHARES_INPUT, DEFAULT_SHARES_OUTPUT)

    # Comments subcommand
    comments_parser = subparsers.add_parser(
        "comments",
        help="Clean LinkedIn Comments CSV export",
    )
    _add_default_io_args(comments_parser, DEFAULT_COMMENTS_INPUT, DEFAULT_COMMENTS_OUTPUT)

    # All subcommand
    all_parser = subparsers.add_parser(
        "all",
        help="Clean all LinkedIn CSV exports (Shares and Comments)",
    )
    _add_named_io_args(all_parser, "shares", DEFAULT_SHARES_INPUT, DEFAULT_SHARES_OUTPUT)
    _add_named_io_args(all_parser, "comments", DEFAULT_COMMENTS_INPUT, DEFAULT_COMMENTS_OUTPUT)

    return parser.parse_args(argv)


def run_shares(args: argparse.Namespace) -> int:
    """Run the shares cleaner.

    Args:
        args: Parsed command-line arguments

    Returns:
        Exit code (0 for success, non-zero for failure)
    """
    result = clean_shares(input_path=args.input, output_path=args.output)
    return _handle_result(result)


def run_comments(args: argparse.Namespace) -> int:
    """Run the comments cleaner.

    Args:
        args: Parsed command-line arguments

    Returns:
        Exit code (0 for success, non-zero for failure)
    """
    result = clean_comments(input_path=args.input, output_path=args.output)
    return _handle_result(result)


def run_all(args: argparse.Namespace) -> int:
    """Run all cleaners.

    Args:
        args: Parsed command-line arguments

    Returns:
        Exit code (0 for success, non-zero for failure)
    """
    exit_code = 0

    LOG.info("Processing Shares...")
    shares_result = clean_shares(
        input_path=args.shares_input,
        output_path=args.shares_output,
    )
    if _handle_result(shares_result) != 0:
        exit_code = 1

    LOG.info("Processing Comments...")
    comments_result = clean_comments(
        input_path=args.comments_input,
        output_path=args.comments_output,
    )
    if _handle_result(comments_result) != 0:
        exit_code = 1

    return exit_code


def _handle_result(result: CleanerResult) -> int:
    """Handle a cleaner result and return appropriate exit code.

    Args:
        result: Cleaner result to handle

    Returns:
        Exit code (0 for success, 1 for failure)
    """
    if result.success:
        LOG.info(str(result))
        return 0
    else:
        LOG.error(str(result))
        return 1


def main(argv: Sequence[str] | None = None) -> int:
    """Main entry point for the CLI.

    Args:
        argv: Command-line arguments (defaults to sys.argv[1:])

    Returns:
        Exit code (0 for success, non-zero for failure)
    """
    args = parse_args(argv)
    configure_logging(args.log_level)

    if args.command is None:
        # No command specified, print help
        parse_args(["--help"])
        return 1

    command_handlers = {
        "shares": run_shares,
        "comments": run_comments,
        "all": run_all,
    }

    handler = command_handlers.get(args.command)
    if handler is None:
        LOG.error("Unknown command: %s", args.command)
        return 1

    try:
        return handler(args)
    except Exception:
        LOG.exception("Unexpected error")
        return 1


if __name__ == "__main__":
    sys.exit(main())
