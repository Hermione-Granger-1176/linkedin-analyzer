"""Command-line interface for LinkedIn analyzer."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from linkedin_analyzer.cleaners.comments import clean_comments
from linkedin_analyzer.cleaners.connections import clean_connections
from linkedin_analyzer.cleaners.messages import clean_messages
from linkedin_analyzer.cleaners.shares import clean_shares
from linkedin_analyzer.core.paths import (
    DEFAULT_COMMENTS_INPUT,
    DEFAULT_COMMENTS_OUTPUT,
    DEFAULT_CONNECTIONS_INPUT,
    DEFAULT_CONNECTIONS_OUTPUT,
    DEFAULT_MESSAGES_INPUT,
    DEFAULT_MESSAGES_OUTPUT,
    DEFAULT_SHARES_INPUT,
    DEFAULT_SHARES_OUTPUT,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from linkedin_analyzer.core.types import CleanerResult

LOG = logging.getLogger("linkedin_analyzer")

SINGLE_COMMAND_SPECS = (
    (
        "shares",
        "Clean LinkedIn Shares CSV export",
        DEFAULT_SHARES_INPUT,
        DEFAULT_SHARES_OUTPUT,
    ),
    (
        "comments",
        "Clean LinkedIn Comments CSV export",
        DEFAULT_COMMENTS_INPUT,
        DEFAULT_COMMENTS_OUTPUT,
    ),
    (
        "messages",
        "Clean LinkedIn Messages CSV export",
        DEFAULT_MESSAGES_INPUT,
        DEFAULT_MESSAGES_OUTPUT,
    ),
    (
        "connections",
        "Clean LinkedIn Connections CSV export",
        DEFAULT_CONNECTIONS_INPUT,
        DEFAULT_CONNECTIONS_OUTPUT,
    ),
)

ALL_COMMAND_NAMES = tuple(spec[0] for spec in SINGLE_COMMAND_SPECS)


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
    """Add --input and --output arguments with the given defaults.

    Args:
        parser: Subcommand parser to add arguments to
        default_input: Default path for the input CSV file
        default_output: Default path for the output Excel file
    """
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
    """Add --{name}-input and --{name}-output arguments with the given defaults.

    Args:
        parser: Subcommand parser to add arguments to
        name: Prefix for the argument names (e.g. 'shares', 'comments')
        default_input: Default path for the input CSV file
        default_output: Default path for the output Excel file
    """
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


def _build_parser() -> argparse.ArgumentParser:
    """Build the argument parser with all subcommands.

    Returns:
        Configured argument parser with all supported subcommands
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

  # Clean all exports
  linkedin-analyzer all

  # Clean messages and connections
  linkedin-analyzer messages
  linkedin-analyzer connections

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

    for name, help_text, default_input, default_output in SINGLE_COMMAND_SPECS:
        command_parser = subparsers.add_parser(name, help=help_text)
        _add_default_io_args(command_parser, default_input, default_output)

    # All subcommand
    all_parser = subparsers.add_parser(
        "all",
        help="Clean all LinkedIn CSV exports",
    )
    for name, _help_text, default_input, default_output in SINGLE_COMMAND_SPECS:
        _add_named_io_args(all_parser, name, default_input, default_output)

    return parser


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse command-line arguments.

    Args:
        argv: Command-line arguments (defaults to sys.argv[1:])

    Returns:
        Parser and parsed arguments namespace
    """
    return _build_parser().parse_args(argv)


def run_shares(args: argparse.Namespace) -> int:
    """Run the shares cleaner."""
    return _run_single_cleaner(args, clean_shares)


def run_comments(args: argparse.Namespace) -> int:
    """Run the comments cleaner."""
    return _run_single_cleaner(args, clean_comments)


def run_messages(args: argparse.Namespace) -> int:
    """Run the messages cleaner."""
    return _run_single_cleaner(args, clean_messages)


def run_connections(args: argparse.Namespace) -> int:
    """Run the connections cleaner."""
    return _run_single_cleaner(args, clean_connections)


def run_all(args: argparse.Namespace) -> int:
    """Run all cleaners.

    Args:
        args: Parsed command-line arguments

    Returns:
        Exit code (0 for success, non-zero for failure)
    """
    tasks = tuple(
        (
            command_name.capitalize(),
            _get_cleaner(command_name),
            getattr(args, f"{command_name}_input"),
            getattr(args, f"{command_name}_output"),
        )
        for command_name in ALL_COMMAND_NAMES
    )
    exit_code = 0
    for label, cleaner, input_path, output_path in tasks:
        LOG.info("Processing %s...", label)
        result = cleaner(input_path=input_path, output_path=output_path)
        if _handle_result(result) != 0:
            exit_code = 1

    return exit_code


def _handle_result(result: CleanerResult) -> int:
    """Handle a cleaner result and return appropriate exit code.

    Args:
        result: Cleaner result to handle

    Returns:
        Exit code (0 for success, 1 for failure)
    """
    if not result.success:
        LOG.error(str(result))
        return 1

    LOG.info(str(result))
    return 0


def _run_single_cleaner(
    args: argparse.Namespace,
    cleaner: Callable[..., CleanerResult],
) -> int:
    """Run one cleaner function with standard CLI arguments."""
    result = cleaner(input_path=args.input, output_path=args.output)
    return _handle_result(result)


def _get_cleaner(command_name: str) -> Callable[..., CleanerResult]:
    """Resolve cleaner by command name using live module bindings."""
    mapping: dict[str, Callable[..., CleanerResult]] = {
        "shares": clean_shares,
        "comments": clean_comments,
        "messages": clean_messages,
        "connections": clean_connections,
    }
    return mapping[command_name]


def main(argv: Sequence[str] | None = None) -> int:
    """Main entry point for the CLI.

    Args:
        argv: Command-line arguments (defaults to sys.argv[1:])

    Returns:
        Exit code (0 for success, non-zero for failure)
    """
    parser = _build_parser()
    args = parser.parse_args(argv)
    configure_logging(args.log_level)

    if args.command is None:
        parser.print_help()
        return 1

    command_handlers = {
        "shares": run_shares,
        "comments": run_comments,
        "messages": run_messages,
        "connections": run_connections,
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
