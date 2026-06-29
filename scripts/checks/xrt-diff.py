#!/usr/bin/env python3
"""Cross-runtime content diff: Python CLI xlsx output vs web cleaner JSON rows.

Usage (prefer the Makefile):
  1. make run-cli args="all"   -> xlsx files in data/output
  2. make cleaner-diff         -> row dumps in the temp checks folder
  3. make xrt-diff             -> cell-level comparison

Stdlib-only on purpose (reads xlsx as zipped XML), so it runs with any python3.
Reads the web cleaner row dumps from $LIA_CHECKS_OUT (default
$TMPDIR/linkedin-analyzer/checks-out), the same temp folder cleaner-diff.mjs
writes to. Requires your private export-derived xlsx in data/output and those
dumps; the script skips cleanly when either is missing.
"""
import hashlib
import json
import os
import re
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "data/output"
JSON_DIR = Path(
    os.environ.get("LIA_CHECKS_OUT", Path(tempfile.gettempdir()) / "linkedin-analyzer" / "checks-out")
)
FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r", "\n")

TYPES = {
    "shares": "Shares.xlsx",
    "comments": "Comments.xlsx",
    "messages": "Messages.xlsx",
    "connections": "Connections.xlsx",
}


def read_xlsx_rows(path):
    """Read an xlsx worksheet into a list of row value lists (stdlib zip+XML)."""
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall("m:si", NS):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
        sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
        rows = []
        for row in sheet.find("m:sheetData", NS).findall("m:row", NS):
            cells = {}
            for c in row.findall("m:c", NS):
                ref = c.get("r")
                col = re.match(r"[A-Z]+", ref).group()
                col_idx = 0
                for ch in col:
                    col_idx = col_idx * 26 + (ord(ch) - 64)
                v = c.find("m:v", NS)
                if v is None:
                    val = ""
                elif c.get("t") == "s":
                    val = shared[int(v.text)]
                else:
                    val = v.text or ""
                cells[col_idx - 1] = val
            width = max(cells) + 1 if cells else 0
            rows.append([cells.get(i, "") for i in range(width)])
        return rows


def escape_formula(value):
    """Prefix a leading formula character with a quote, matching the web cleaner."""
    if isinstance(value, str) and value.startswith(FORMULA_PREFIXES):
        return f"'{value}"
    return value


def main():
    """Compare every CLI xlsx cell against the web cleaner rows for each type."""
    missing = [
        name
        for name in TYPES.values()
        if not (OUT / name).exists()
    ]
    missing += [
        f"{type_name}.json"
        for type_name in TYPES
        if not (JSON_DIR / f"{type_name}.json").exists()
    ]
    if missing:
        print(
            f"SKIP: missing inputs ({', '.join(missing)}). "
            "Run `make run-cli args=all` then `make cleaner-diff` first."
        )
        return 0

    for type_name, xlsx_name in TYPES.items():
        xlsx_rows = read_xlsx_rows(OUT / xlsx_name)
        header, xlsx_data = xlsx_rows[0], xlsx_rows[1:]

        js_rows = json.loads((JSON_DIR / f"{type_name}.json").read_text())
        js_data = [[escape_formula(row.get(col, "")) for col in header] for row in js_rows]

        # Pad xlsx rows to header width (trailing empty cells are omitted in XML).
        width = len(header)
        xlsx_data = [(r + [""] * width)[:width] for r in xlsx_data]

        mismatches = [(i, a, b) for i, (a, b) in enumerate(zip(xlsx_data, js_data)) if a != b]
        sha_py = hashlib.sha256(json.dumps(xlsx_data).encode()).hexdigest()[:16]
        sha_js = hashlib.sha256(json.dumps(js_data).encode()).hexdigest()[:16]
        row_count_delta = len(xlsx_data) - len(js_data)
        identical = sha_py == sha_js and len(xlsx_data) == len(js_data)
        status = "IDENTICAL" if identical else "DIFFERS"
        print(
            f"{type_name:<12} {status:<10} rows: py={len(xlsx_data)} js={len(js_data)} "
            f"sha: py={sha_py} js={sha_js} cell-mismatched-rows={len(mismatches)} "
            f"row-count-delta={row_count_delta:+d}"
        )
        for i, a, b in mismatches[:3]:
            for col_i, (x, y) in enumerate(zip(a, b)):
                if x != y:
                    print(f"    row {i} col {header[col_i]!r}: py={x[:90]!r} js={y[:90]!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
