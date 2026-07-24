#!/usr/bin/env python3
"""Measure per-cleaner peak resident memory over a local LinkedIn export.

Usage (prefer the Makefile):
  make audit-memory-python
  make audit-memory-python strict=1
  make audit-memory-python input_dir=/private/export

Each of the four Python cleaners runs in a separate child process so their peak
resident set sizes never overlap. The report is content-safe: it lists only
fixed type names, input byte sizes, processed row counts, peak RSS, and a
status. No cleaned rows or cell values are ever emitted, and each cleaner writes
its xlsx into an owner-only temporary directory that is always removed.

Peak RSS comes from resource.getrusage(RUSAGE_SELF).ru_maxrss, reported in KiB
on Linux. This establishes a measurement, not a budget. Missing inputs skip
outside strict mode and fail in strict audit mode.
"""

from __future__ import annotations

import argparse
import resource
import subprocess
import sys
import tempfile
from pathlib import Path

from linkedin_analyzer.cleaners.comments import clean_comments
from linkedin_analyzer.cleaners.connections import clean_connections
from linkedin_analyzer.cleaners.messages import clean_messages
from linkedin_analyzer.cleaners.shares import clean_shares

REPO = Path(__file__).resolve().parents[2]
DEFAULT_INPUT_DIR = REPO / "data/input"

# Fixed data type -> (input filename, cleaner). messages.csv is lowercase in the
# export, matching the CLI's default input name for that type.
TYPES = {
    "shares": ("Shares.csv", clean_shares),
    "comments": ("Comments.csv", clean_comments),
    "messages": ("messages.csv", clean_messages),
    "connections": ("Connections.csv", clean_connections),
}


def run_child(type_name: str, input_path: str, output_path: str) -> int:
    """Run one cleaner in this process and print its peak RSS on one line."""
    _, cleaner = TYPES[type_name]
    result = cleaner(input_path=Path(input_path), output_path=Path(output_path))
    # Read peak RSS after the cleaner so it reflects the whole run in this
    # isolated process. ru_maxrss is KiB on Linux but bytes on macOS; normalize
    # to KiB so results stay comparable across developer machines.
    raw_maxrss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    peak_rss_kib = raw_maxrss // 1024 if sys.platform == "darwin" else raw_maxrss
    status = "OK" if result.success else "ERROR"
    print(f"rows={result.rows_processed} peak_rss_kib={peak_rss_kib} status={status}")
    return 0 if result.success else 1


def measure(type_name: str, input_path: Path, output_dir: Path) -> tuple[int, int, str] | None:
    """Run one cleaner in a child process and parse its structured result line."""
    output_path = output_dir / f"{type_name}.xlsx"
    completed = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve()),
            "--child",
            type_name,
            str(input_path),
            str(output_path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    for line in completed.stdout.splitlines():
        if line.startswith("rows="):
            fields = dict(part.split("=", 1) for part in line.split())
            return int(fields["rows"]), int(fields["peak_rss_kib"]), fields["status"]
    return None


def run_audit(input_dir: Path, strict: bool) -> int:
    """Measure every cleaner's peak RSS and return nonzero for errors."""
    missing = [name for name, (filename, _) in TYPES.items() if not (input_dir / filename).is_file()]
    if missing:
        for name in missing:
            print(f"{name:<12} MISSING    input-file-absent=1")
        status = "FAILED" if strict else "SKIPPED"
        print(f"RESULT       {status:<10} missing-inputs={len(missing)}")
        return 1 if strict else 0

    errors = 0
    with tempfile.TemporaryDirectory(prefix="linkedin-analyzer-memory-") as temp_dir:
        output_dir = Path(temp_dir)
        output_dir.chmod(0o700)
        for type_name, (filename, _) in TYPES.items():
            input_path = input_dir / filename
            input_bytes = input_path.stat().st_size
            measured = measure(type_name, input_path, output_dir)
            if measured is None:
                errors += 1
                print(f"{type_name:<12} ERROR      input-bytes={input_bytes} measurement-failures=1")
                continue

            rows, peak_rss_kib, status = measured
            if status != "OK":
                errors += 1
            print(
                f"{type_name:<12} {status:<10} input-bytes={input_bytes} rows={rows} "
                f"peak-rss-kib={peak_rss_kib} peak-rss-mib={peak_rss_kib / 1024:.1f}"
            )

    status = "FAILED" if errors else "MEASURED"
    print(f"RESULT       {status:<10} types={len(TYPES)} errors={errors}")
    return 1 if errors else 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse the input directory, strict audit mode, and hidden child dispatch."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT_DIR)
    parser.add_argument("--strict", action="store_true")
    # Hidden self-dispatch: run one cleaner in isolation and report its peak RSS.
    parser.add_argument("--child", nargs=3, metavar=("TYPE", "INPUT", "OUTPUT"))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Dispatch to the child measurement or the parent audit run."""
    args = parse_args(argv)
    if args.child is not None:
        type_name, input_path, output_path = args.child
        return run_child(type_name, input_path, output_path)
    return run_audit(args.input_dir, args.strict)


if __name__ == "__main__":
    sys.exit(main())
