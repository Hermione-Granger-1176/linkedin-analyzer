# Python CLI reference

`linkedin-analyzer` reads a LinkedIn CSV export and writes a formatted Excel workbook. The package supports Python 3.12 and newer.

## Installation

The published package is available from PyPI:

```bash
pip install linkedin-analyzer
```

In a repository checkout, `make setup` installs the development environment and `make run-cli args="..."` invokes its CLI. `make install` refreshes the Python environment alone. [Clean an export](getting-started.md) gives the first-run procedure.

## Commands

Each single-file command reads one CSV and writes one workbook:

| Command                         | Default input                | Default output                 |
| ------------------------------- | ---------------------------- | ------------------------------ |
| `linkedin-analyzer shares`      | `data/input/Shares.csv`      | `data/output/Shares.xlsx`      |
| `linkedin-analyzer comments`    | `data/input/Comments.csv`    | `data/output/Comments.xlsx`    |
| `linkedin-analyzer messages`    | `data/input/messages.csv`    | `data/output/Messages.xlsx`    |
| `linkedin-analyzer connections` | `data/input/Connections.csv` | `data/output/Connections.xlsx` |

The `all` command runs all four cleaners:

```bash
linkedin-analyzer all
```

`all` returns exit code 1 when any file is missing or fails to process. `--skip-missing` skips files that do not exist. A malformed file still fails the run.

## Input and output paths

Single-file commands accept `--input` and `--output`:

```bash
linkedin-analyzer shares --input raw/Shares.csv --output clean/Shares.xlsx
linkedin-analyzer comments --input raw/Comments.csv --output clean/Comments.xlsx
linkedin-analyzer messages --input raw/messages.csv --output clean/Messages.xlsx
linkedin-analyzer connections --input raw/Connections.csv --output clean/Connections.xlsx
```

`all` accepts a named pair for each file type:

```bash
linkedin-analyzer all \
  --shares-input raw/Shares.csv --shares-output clean/Shares.xlsx \
  --comments-input raw/Comments.csv --comments-output clean/Comments.xlsx \
  --messages-input raw/messages.csv --messages-output clean/Messages.xlsx \
  --connections-input raw/Connections.csv --connections-output clean/Connections.xlsx
```

## Set global options

Global options precede the command name.

| Option              | Default         | Description                                                                                |
| ------------------- | --------------- | ------------------------------------------------------------------------------------------ |
| `--version`         | package version | Print the CLI version and exit.                                                            |
| `--log-level`       | `INFO`          | Accepts `DEBUG`, `INFO`, `WARNING`, `ERROR`, or `CRITICAL`.                                |
| `--log-format`      | `text`          | Accepts `text` or `json`. JSON writes one object per line.                                 |
| `--encoding`        | auto-detect     | Read CSV data with the specified encoding instead of the UTF-8 then Windows-1252 fallback. |
| `--max-input-bytes` | `134217728`     | Reject an input file above this byte count. `0` disables the limit.                        |
| `--max-rows`        | `1000000`       | Reject a CSV above this parsed row count. `0` disables the limit.                          |

Examples:

```bash
linkedin-analyzer --version
linkedin-analyzer --log-level DEBUG shares
linkedin-analyzer --log-format json all
linkedin-analyzer --encoding iso-8859-1 shares
linkedin-analyzer --max-input-bytes 0 --max-rows 0 all
```

The environment variables `LOG_LEVEL`, `LOG_FORMAT`, `LINKEDIN_ANALYZER_MAX_INPUT_BYTES`, and `LINKEDIN_ANALYZER_MAX_ROWS` provide defaults for the matching options. A command-line option overrides its environment default. Invalid numeric environment values fall back to the built-in default.

When `--encoding` is omitted, the CLI tries BOM-aware UTF-8 and then applies the browser-compatible WHATWG Windows-1252 mapping to the fallback bytes. An explicit encoding is passed through unchanged, so `iso-8859-1` preserves its C1 code points instead of applying that mapping.

## Data directory

`LINKEDIN_ANALYZER_DATA_DIR` sets the base directory for default paths:

```bash
LINKEDIN_ANALYZER_DATA_DIR=/srv/linkedin-data linkedin-analyzer all
```

The CLI then reads from `/srv/linkedin-data/input/` and writes to `/srv/linkedin-data/output/`. Explicit `--input` and `--output` paths take precedence over the base directory.

## Logs and exit codes

Text logs use this shape:

```text
2026-08-23 12:00:00,000 INFO linkedin_analyzer: Successfully processed 10 rows: data/input/Shares.csv -> data/output/Shares.xlsx
```

JSON logs contain `timestamp`, `level`, `logger`, and `message`. Error records can also include `exception`.

The process returns 0 when the requested operation succeeds, 1 for a processing error, and 130 when the user interrupts it with Ctrl-C. Running the CLI without a command prints help and returns 0.

## Python API

The package exports four cleaning functions and their configuration types:

```python
from pathlib import Path

from linkedin_analyzer import clean_comments, clean_connections, clean_messages, clean_shares

result = clean_shares(
    input_path=Path("Shares.csv"),
    output_path=Path("Shares.xlsx"),
)
if not result.success:
    raise RuntimeError(result.error)
```

The functions are `clean_shares`, `clean_comments`, `clean_messages`, and `clean_connections`. Each accepts `input_path`, `output_path`, `encoding`, `max_input_bytes`, and `max_rows`, and returns a `CleanerResult`. Passing `None` for an input or output path uses the configured default path.

The package also exports `CleanerConfig`, `ColumnConfig`, the four cleaner configuration types, and `__version__`. The package includes `py.typed` for type checker support.

## Related reference

See [data formats](data-formats.md) for required columns, output columns, row filtering, encoding behavior, formula escaping, date conversion, and workbook formatting.
