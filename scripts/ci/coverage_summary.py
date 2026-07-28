#!/usr/bin/env python3
"""Render the Python and JavaScript coverage totals as one markdown table.

Both suites already enforce their own floors and fail the build below them, so
this adds no gate. What it adds is the number itself, on the run page, where
noticing a slow slide from 99.4% to 99.1% does not require opening a log and
scrolling to the end of a test run.

The two suites report through different tools, so the counts come from each
one's own machine-readable output: ``coverage.json`` from pytest-cov and
``coverage/coverage-summary.json`` from Vitest. Percentages are recomputed from
the covered and total counts rather than read from the reports, so the
percentage in a row can never disagree with the two numbers beside it.

A report that is absent becomes a note rather than an error, because the summary
step runs even when the suite that writes it failed first. A report that is
present but unreadable is still an error: that means something broke.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

# Relative to the repository root, which is where the Makefile runs this. The
# Python report lives outside coverage/ on purpose: Vitest wipes that directory
# before its own run, and ci-heavy-checks runs both suites in parallel.
DEFAULT_PYTHON_REPORT = Path(".artifacts") / "coverage" / "python-coverage.json"
DEFAULT_JS_REPORT = Path("coverage") / "coverage-summary.json"

# The metrics Vitest reports, in the order they are shown. Its `branchesTrue`
# entry is deliberately absent: it counts only implicit else branches and reads
# as 100% of zero on this codebase.
JS_METRICS = ("statements", "branches", "functions", "lines")

# pytest-cov names the same two counts differently, and reports no function or
# line coverage of its own.
PYTHON_METRICS = (
    ("statements", "covered_lines", "num_statements"),
    ("branches", "covered_branches", "num_branches"),
)

TABLE_HEADER = (
    "| Suite | Metric | Covered | Total | Percent |",
    "| --- | --- | ---: | ---: | ---: |",
)


@dataclass(frozen=True)
class CoverageMetric:
    """One covered-of-total count for one suite."""

    suite: str
    metric: str
    covered: int
    total: int

    @property
    def percent(self) -> float:
        """Return the covered percentage, calling nothing-to-cover complete."""
        if self.total == 0:
            return 100.0
        return self.covered / self.total * 100


def _load_object(path: Path, section: str) -> dict[str, object]:
    """Load one JSON report and return the named top-level object from it."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Coverage report {path} is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"Coverage report {path} must be a JSON object.")
    block = payload.get(section)
    if not isinstance(block, dict):
        raise ValueError(f"Coverage report {path} is missing a {section!r} object.")
    return block


def _count(block: dict[str, object], key: str, path: Path) -> int:
    """Return one non-negative integer count from a coverage report block."""
    value = block.get(key)
    # bool is a subclass of int, so it would otherwise pass as a count of 1.
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"Coverage report {path} has no non-negative integer {key!r}.")
    return value


def read_python_metrics(path: Path) -> list[CoverageMetric]:
    """Read the statement and branch totals from a pytest-cov JSON report."""
    totals = _load_object(path, "totals")
    return [
        CoverageMetric("Python", metric, _count(totals, covered, path), _count(totals, total, path))
        for metric, covered, total in PYTHON_METRICS
    ]


def read_js_metrics(path: Path) -> list[CoverageMetric]:
    """Read the four totals from a Vitest ``json-summary`` coverage report."""
    total = _load_object(path, "total")
    metrics = []
    for metric in JS_METRICS:
        block = total.get(metric)
        if not isinstance(block, dict):
            raise ValueError(f"Coverage report {path} is missing a {metric!r} total.")
        metrics.append(
            CoverageMetric(
                "JavaScript", metric, _count(block, "covered", path), _count(block, "total", path)
            )
        )
    return metrics


def render_summary(metrics: list[CoverageMetric], notes: list[str]) -> str:
    """Render coverage metrics and any notes as a markdown section."""
    lines = ["## Coverage", ""]
    if metrics:
        lines.extend(TABLE_HEADER)
        lines.extend(
            f"| {metric.suite} | {metric.metric} | {metric.covered} | "
            f"{metric.total} | {metric.percent:.2f}% |"
            for metric in metrics
        )
        lines.append("")
    lines.extend(f"> {note}" for note in notes)
    if notes:
        lines.append("")
    return "\n".join(lines)


def build_summary(*, python_report: Path, js_report: Path) -> str:
    """Build the coverage summary from whichever reports were written."""
    metrics: list[CoverageMetric] = []
    notes: list[str] = []
    for label, path, read in (
        ("Python", python_report, read_python_metrics),
        ("JavaScript", js_report, read_js_metrics),
    ):
        if not path.is_file():
            notes.append(f"No {label} coverage report at `{path}`; that suite did not finish.")
            continue
        metrics.extend(read(path))
    return render_summary(metrics, notes)


def _build_parser() -> argparse.ArgumentParser:
    """Build the coverage summary command-line parser."""
    parser = argparse.ArgumentParser(description="Render coverage totals as markdown")
    parser.add_argument(
        "--python-report",
        default=str(DEFAULT_PYTHON_REPORT),
        help=f"pytest-cov JSON report (default: {DEFAULT_PYTHON_REPORT})",
    )
    parser.add_argument(
        "--js-report",
        default=str(DEFAULT_JS_REPORT),
        help=f"Vitest json-summary report (default: {DEFAULT_JS_REPORT})",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Print the coverage summary markdown."""
    args = _build_parser().parse_args(argv)
    print(
        build_summary(
            python_report=Path(args.python_report),
            js_report=Path(args.js_report),
        )
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1) from exc
