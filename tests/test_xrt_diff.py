"""Focused tests for the private cross-runtime verifier."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest
from openpyxl import Workbook

SCRIPT_PATH = Path(__file__).parents[1] / "scripts/checks/xrt-diff.py"
PRIVATE_MARKER = "PRIVATE_SYNTHETIC_MARKER_7f42"
HEADER = ["Name", "Value"]
BASE_ROWS = [["Ada", "same"]]


def load_xrt_diff() -> ModuleType:
    """Load the hyphenated verifier script as an importable module."""
    spec = importlib.util.spec_from_file_location("xrt_diff_test_module", SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


XRT_DIFF = load_xrt_diff()


def write_xlsx(path: Path, rows: list[list[str]]) -> None:
    """Write an ordinary synthetic workbook with openpyxl."""
    workbook = Workbook()
    worksheet = workbook.active
    assert worksheet is not None
    for row in rows:
        worksheet.append(row)
    workbook.save(path)
    workbook.close()


def write_inputs(
    xlsx_dir: Path,
    json_dir: Path,
    *,
    python_rows: dict[str, list[list[str]]] | None = None,
    web_rows: dict[str, list[list[str]]] | None = None,
) -> None:
    """Write synthetic workbook and row-dump pairs for all fixed types."""
    xlsx_dir.mkdir()
    json_dir.mkdir()
    python_rows = python_rows or {}
    web_rows = web_rows or {}

    for type_name, xlsx_name in XRT_DIFF.TYPES.items():
        current_python_rows = python_rows.get(type_name, BASE_ROWS)
        current_web_rows = web_rows.get(type_name, BASE_ROWS)
        write_xlsx(xlsx_dir / xlsx_name, [HEADER, *current_python_rows])
        payload = [dict(zip(HEADER, row, strict=True)) for row in current_web_rows]
        (json_dir / f"{type_name}.json").write_text(json.dumps(payload), encoding="utf-8")


def run_diff(
    capsys: pytest.CaptureFixture[str],
    xlsx_dir: Path,
    json_dir: Path,
    *,
    strict: bool = False,
) -> tuple[int, str]:
    """Run the verifier and return its exit code and combined captured output."""
    arguments = ["--xlsx-dir", str(xlsx_dir), "--json-dir", str(json_dir)]
    if strict:
        arguments.append("--strict")
    exit_code = XRT_DIFF.main(arguments)
    captured = capsys.readouterr()
    return exit_code, f"{captured.out}{captured.err}"


def test_read_xlsx_rows_preserves_values_and_header_width_padding(tmp_path: Path) -> None:
    """Keep exact cell values while padding short rows to the header width."""
    path = tmp_path / "synthetic.xlsx"
    write_xlsx(path, [HEADER, ["Ada"]])

    assert XRT_DIFF.read_xlsx_rows(path) == [HEADER, ["Ada", ""]]


def test_changed_cell_fails_without_printing_private_content(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Fail on changed cells while reporting only bounded coordinates."""
    xlsx_dir = tmp_path / "xlsx"
    json_dir = tmp_path / "json"
    web_rows = {
        "shares": [
            [PRIVATE_MARKER, "changed"],
            [PRIVATE_MARKER, "changed"],
            [PRIVATE_MARKER, "changed"],
            [PRIVATE_MARKER, "changed"],
        ],
    }
    python_rows = {
        "shares": [["Ada", "same"], ["B", "1"], ["C", "2"], ["D", "3"]],
    }
    write_inputs(xlsx_dir, json_dir, python_rows=python_rows, web_rows=web_rows)

    exit_code, output = run_diff(capsys, xlsx_dir, json_dir)

    assert exit_code == 1
    assert "shares       DIFFERS" in output
    assert "row=1 column=1" in output
    assert output.count("shares       DETAIL") == 3
    assert PRIVATE_MARKER not in output
    assert "sha=" not in output.lower()
    assert "digest=" not in output.lower()


def test_formula_prefix_drift_is_not_hidden(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Compare staged web values exactly without verifier-side formula escaping."""
    xlsx_dir = tmp_path / "xlsx"
    json_dir = tmp_path / "json"
    write_inputs(
        xlsx_dir,
        json_dir,
        python_rows={"shares": [["Ada", "'=SUM(A1:A1)"]]},
        web_rows={"shares": [["Ada", "=SUM(A1:A1)"]]},
    )

    exit_code, output = run_diff(capsys, xlsx_dir, json_dir)

    assert exit_code == 1
    assert "shares       DIFFERS" in output
    assert "row=1 column=2" in output


@pytest.mark.parametrize(
    ("python_rows", "web_rows", "expected"),
    [
        ([*BASE_ROWS, ["Python", "extra"]], BASE_ROWS, "extra-python-rows=1"),
        (BASE_ROWS, [*BASE_ROWS, ["Web", "extra"]], "extra-web-rows=1"),
    ],
)
def test_extra_rows_on_either_side_fail(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    python_rows: list[list[str]],
    web_rows: list[list[str]],
    expected: str,
) -> None:
    """Detect extra Python and web rows beyond the common prefix."""
    xlsx_dir = tmp_path / "xlsx"
    json_dir = tmp_path / "json"
    write_inputs(
        xlsx_dir,
        json_dir,
        python_rows={"shares": python_rows},
        web_rows={"shares": web_rows},
    )

    exit_code, output = run_diff(capsys, xlsx_dir, json_dir)

    assert exit_code == 1
    assert expected in output
    assert "shares       DETAIL" in output


def test_malformed_json_fails_cleanly_and_redacts_content(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Convert malformed JSON into a sanitized nonzero comparison failure."""
    xlsx_dir = tmp_path / "xlsx"
    json_dir = tmp_path / "json"
    write_inputs(xlsx_dir, json_dir)
    (json_dir / "shares.json").write_text(
        f'{{"value":"{PRIVATE_MARKER}"',
        encoding="utf-8",
    )

    exit_code, output = run_diff(capsys, xlsx_dir, json_dir)

    assert exit_code == 1
    assert "shares       ERROR" in output
    assert "comparison-failures=1" in output
    assert PRIVATE_MARKER not in output
    assert "Traceback" not in output


def test_malformed_workbook_fails_cleanly(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Treat a malformed workbook as a sanitized comparison failure."""
    xlsx_dir = tmp_path / "xlsx"
    json_dir = tmp_path / "json"
    write_inputs(xlsx_dir, json_dir)
    (xlsx_dir / "Shares.xlsx").write_bytes(b"not an xlsx workbook")

    exit_code, output = run_diff(capsys, xlsx_dir, json_dir)

    assert exit_code == 1
    assert "shares       ERROR" in output
    assert "Traceback" not in output


@pytest.mark.parametrize(
    ("strict", "expected_code", "expected_status"),
    [(False, 0, "SKIPPED"), (True, 1, "FAILED")],
)
def test_missing_inputs_skip_unless_strict(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    strict: bool,
    expected_code: int,
    expected_status: str,
) -> None:
    """Keep local skips friendly while making strict audits fail closed."""
    xlsx_dir = tmp_path / "xlsx"
    json_dir = tmp_path / "json"
    write_inputs(xlsx_dir, json_dir)
    (json_dir / "shares.json").unlink()

    exit_code, output = run_diff(capsys, xlsx_dir, json_dir, strict=strict)

    assert exit_code == expected_code
    assert expected_status in output
    assert "missing-inputs=1" in output
    assert "shares.json" not in output


def test_identical_inputs_succeed(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """Return success when every synthetic row and cell matches."""
    xlsx_dir = tmp_path / "xlsx"
    json_dir = tmp_path / "json"
    write_inputs(xlsx_dir, json_dir)

    exit_code, output = run_diff(capsys, xlsx_dir, json_dir)

    assert exit_code == 0
    assert "RESULT       IDENTICAL" in output
    assert "differing=0" in output
    assert "errors=0" in output
