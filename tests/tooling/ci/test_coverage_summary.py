"""Cover the coverage summary renderer.

Check report totals, percentage calculations, and missing-report handling.
The rendered percentages must agree with their displayed counts.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from scripts.ci import coverage_summary

PYTHON_TOTALS = {
    "covered_lines": 4152,
    "num_statements": 4152,
    "covered_branches": 1280,
    "num_branches": 1288,
}

JS_TOTAL = {
    "statements": {"covered": 6302, "total": 6348},
    "branches": {"covered": 3637, "total": 3798},
    "functions": {"covered": 1079, "total": 1088},
    "lines": {"covered": 6193, "total": 6233},
}


def _write(path: Path, payload: object) -> Path:
    """Write a JSON coverage report and return its path."""
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _python_report(tmp_path: Path, totals: object = None) -> Path:
    """Write a pytest-cov JSON report."""
    payload = {"totals": PYTHON_TOTALS if totals is None else totals}
    return _write(tmp_path / "coverage.json", payload)


def _js_report(tmp_path: Path, total: object = None) -> Path:
    """Write a Vitest json-summary report."""
    return _write(tmp_path / "summary.json", {"total": JS_TOTAL if total is None else total})


# Percentages


def test_the_percentage_is_derived_from_the_counts_beside_it() -> None:
    """The percentage is computed from the covered and total counts of the same row."""
    metric = coverage_summary.CoverageMetric("Python", "branches", 1280, 1288)
    assert metric.percent == pytest.approx(99.3788, abs=1e-4)


def test_nothing_to_cover_counts_as_fully_covered() -> None:
    """A metric with a total of zero reports 100 percent without dividing by zero."""
    assert coverage_summary.CoverageMetric("JavaScript", "branches", 0, 0).percent == 100.0


def test_a_covered_count_above_the_total_is_an_error() -> None:
    """A covered count greater than the total raises ValueError."""
    with pytest.raises(ValueError, match="101 covered but only 100 total"):
        coverage_summary.CoverageMetric("Python", "statements", 101, 100)


# Reading the two report formats


def test_python_totals_are_read_from_the_pytest_cov_keys(tmp_path: Path) -> None:
    """Reads the statement and branch counts from pytest-cov's key names."""
    metrics = coverage_summary.read_python_metrics(_python_report(tmp_path))
    assert [(m.metric, m.covered, m.total) for m in metrics] == [
        ("statements", 4152, 4152),
        ("branches", 1280, 1288),
    ]


def test_js_totals_are_read_for_every_reported_metric(tmp_path: Path) -> None:
    """Every metric in JS_METRICS is read from the Vitest summary."""
    metrics = coverage_summary.read_js_metrics(_js_report(tmp_path))
    assert [m.metric for m in metrics] == list(coverage_summary.JS_METRICS)
    assert [(m.covered, m.total) for m in metrics] == [
        (6302, 6348),
        (3637, 3798),
        (1079, 1088),
        (6193, 6233),
    ]


def test_the_implicit_else_branch_metric_is_left_out(tmp_path: Path) -> None:
    """The Vitest `branchesTrue` metric is not read, since it is always 0 of 0."""
    report = _js_report(tmp_path, {**JS_TOTAL, "branchesTrue": {"covered": 0, "total": 0}})
    metrics = coverage_summary.read_js_metrics(report)
    assert [m.metric for m in metrics] == list(coverage_summary.JS_METRICS)


# Reports that cannot be trusted


def test_a_report_that_is_not_json_is_an_error(tmp_path: Path) -> None:
    """A report that is not valid JSON raises ValueError."""
    path = tmp_path / "coverage.json"
    path.write_text("not json", encoding="utf-8")
    with pytest.raises(ValueError, match="is not valid JSON"):
        coverage_summary.read_python_metrics(path)


def test_a_report_that_is_not_an_object_is_an_error(tmp_path: Path) -> None:
    """A report whose top-level value is not a JSON object raises ValueError."""
    path = _write(tmp_path / "coverage.json", [])
    with pytest.raises(ValueError, match="must be a JSON object"):
        coverage_summary.read_python_metrics(path)


@pytest.mark.parametrize("payload", [{}, {"totals": []}], ids=["absent", "wrong-shape"])
def test_a_report_without_its_totals_object_is_an_error(tmp_path: Path, payload: object) -> None:
    """A report without a 'totals' object raises ValueError."""
    path = _write(tmp_path / "coverage.json", payload)
    with pytest.raises(ValueError, match="missing a 'totals' object"):
        coverage_summary.read_python_metrics(path)


def test_a_js_report_missing_one_metric_is_an_error(tmp_path: Path) -> None:
    """A JS report that lacks one metric raises ValueError."""
    total = {key: value for key, value in JS_TOTAL.items() if key != "functions"}
    with pytest.raises(ValueError, match="missing a 'functions' total"):
        coverage_summary.read_js_metrics(_js_report(tmp_path, total))


@pytest.mark.parametrize(
    "covered",
    [None, "4152", -1, True],
    ids=["absent", "string", "negative", "boolean"],
)
def test_a_count_that_is_not_a_whole_number_is_an_error(tmp_path: Path, covered: object) -> None:
    """Rejects booleans, which Python treats as ints, along with other non-counts."""
    report = _python_report(tmp_path, {**PYTHON_TOTALS, "covered_lines": covered})
    with pytest.raises(ValueError, match="non-negative integer 'covered_lines'"):
        coverage_summary.read_python_metrics(report)


# Rendering


def test_both_suites_render_as_one_table(tmp_path: Path) -> None:
    """Pins the exact rendered rows of both suites."""
    summary = coverage_summary.build_summary(
        python_report=_python_report(tmp_path),
        js_report=_js_report(tmp_path),
    )
    assert summary.splitlines() == [
        "## Coverage",
        "",
        "| Suite | Metric | Covered | Total | Percent |",
        "| --- | --- | ---: | ---: | ---: |",
        "| Python | statements | 4152 | 4152 | 100.00% |",
        "| Python | branches | 1280 | 1288 | 99.38% |",
        "| JavaScript | statements | 6302 | 6348 | 99.28% |",
        "| JavaScript | branches | 3637 | 3798 | 95.76% |",
        "| JavaScript | functions | 1079 | 1088 | 99.17% |",
        "| JavaScript | lines | 6193 | 6233 | 99.36% |",
    ]


def test_a_missing_report_becomes_a_note_beside_the_suite_that_did_run(tmp_path: Path) -> None:
    """A missing report renders a note beside the suite that did run."""
    summary = coverage_summary.build_summary(
        python_report=tmp_path / "absent.json",
        js_report=_js_report(tmp_path),
    )
    assert "| Python |" not in summary
    assert "| JavaScript | statements | 6302 | 6348 | 99.28% |" in summary
    assert "> No Python coverage report at `" in summary


def test_two_missing_reports_leave_a_heading_and_two_notes(tmp_path: Path) -> None:
    """Two missing reports render a heading and one note per suite, with no table."""
    summary = coverage_summary.build_summary(
        python_report=tmp_path / "absent.json",
        js_report=tmp_path / "also-absent.json",
    )
    assert "| Suite |" not in summary
    assert summary.count("> No ") == 2


# The command line


def test_the_summary_is_printed_for_the_job_summary(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The Makefile redirects stdout straight into GITHUB_STEP_SUMMARY."""
    exit_code = coverage_summary.main(
        [
            "--python-report",
            str(_python_report(tmp_path)),
            "--js-report",
            str(_js_report(tmp_path)),
        ]
    )
    assert exit_code == 0
    assert "| Python | statements | 4152 | 4152 | 100.00% |" in capsys.readouterr().out


def test_the_default_report_paths_match_where_the_test_tools_write_them() -> None:
    """The default report paths match the paths the coverage tools write."""
    pyproject = (Path(__file__).parents[3] / "pyproject.toml").read_text(encoding="utf-8")
    vitest = (Path(__file__).parents[3] / "web" / "vitest.config.mjs").read_text(encoding="utf-8")
    assert f"--cov-report=json:{coverage_summary.DEFAULT_PYTHON_REPORT}" in pyproject
    assert "json-summary" in vitest
    assert Path("coverage/coverage-summary.json") == coverage_summary.DEFAULT_JS_REPORT


def test_the_python_report_is_written_outside_the_directory_vitest_wipes() -> None:
    """The Python report is outside coverage/, which Vitest clears before it runs."""
    assert coverage_summary.DEFAULT_JS_REPORT.parts[0] == "coverage"
    assert coverage_summary.DEFAULT_PYTHON_REPORT.parts[0] != "coverage"
