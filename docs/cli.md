# Python CLI reference

`linkedin-analyzer` reads a LinkedIn CSV export and writes a formatted Excel workbook. It requires Python 3.12 or newer.

## Installation

Install the published package from PyPI:

```bash
pip install linkedin-analyzer
```

In a repository checkout, run the CLI with `make run-cli args="shares"`. Replace `shares` with any command from the next section. [Development setup](development.md) covers the checkout environment.

## Commands

Each single-file command reads one CSV and writes one workbook. Default paths use the base directory set in [data directory](#data-directory).

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

`all` returns exit code 1 when any file is missing or fails. Add `--skip-missing` to skip files that do not exist. A malformed file still fails the run.

## Input and output paths

Single-file commands accept `--input` and `--output`:

```bash
linkedin-analyzer shares --input raw/Shares.csv --output clean/Shares.xlsx
linkedin-analyzer comments --input raw/Comments.csv --output clean/Comments.xlsx
linkedin-analyzer messages --input raw/messages.csv --output clean/Messages.xlsx
linkedin-analyzer connections --input raw/Connections.csv --output clean/Connections.xlsx
```

`all` accepts a named pair of flags for each file type:

```bash
linkedin-analyzer all \
  --shares-input raw/Shares.csv --shares-output clean/Shares.xlsx \
  --comments-input raw/Comments.csv --comments-output clean/Comments.xlsx \
  --messages-input raw/messages.csv --messages-output clean/Messages.xlsx \
  --connections-input raw/Connections.csv --connections-output clean/Connections.xlsx
```

## Set global options

Global options go before the command name.

| Option              | Default         | Description                                                              |
| ------------------- | --------------- | ------------------------------------------------------------------------ |
| `--version`         | package version | Print the CLI version and exit.                                          |
| `--log-level`       | `INFO`          | Accepts `DEBUG`, `INFO`, `WARNING`, `ERROR`, or `CRITICAL`.              |
| `--log-format`      | `text`          | Accepts `text` or `json`. JSON writes one object per line.               |
| `--encoding`        | auto-detect     | Read the CSV in this encoding. See [encoding](data-formats.md#encoding). |
| `--max-input-bytes` | `134217728`     | Reject a file above this byte count. `0` disables the limit.             |
| `--max-rows`        | `1000000`       | Reject a CSV above this parsed row count. `0` disables the limit.        |

Examples:

```bash
linkedin-analyzer --version
linkedin-analyzer --log-level DEBUG shares
linkedin-analyzer --log-format json all
linkedin-analyzer --encoding iso-8859-1 shares
linkedin-analyzer --max-input-bytes 0 --max-rows 0 all
```

Environment variables set defaults for the matching options: `LOG_LEVEL`, `LOG_FORMAT`, `LINKEDIN_ANALYZER_MAX_INPUT_BYTES`, and `LINKEDIN_ANALYZER_MAX_ROWS`. A command-line option overrides its environment default. An invalid numeric value falls back to the built-in default.

## Data directory

`LINKEDIN_ANALYZER_DATA_DIR` sets the base directory for default paths. The default base is `data`, relative to the directory where you run the command.

```bash
LINKEDIN_ANALYZER_DATA_DIR=/srv/linkedin-data linkedin-analyzer all
```

The CLI then reads from `/srv/linkedin-data/input/` and writes to `/srv/linkedin-data/output/`. Explicit `--input` and `--output` paths take precedence over the base directory. The CLI creates the output directory when it is missing. It does not create the input directory.

## Logs and exit codes

Text logs use this shape:

```text
2026-08-23 12:00:00,000 INFO linkedin_analyzer: Successfully processed 10 rows: data/input/Shares.csv -> data/output/Shares.xlsx
```

JSON logs contain `timestamp`, `level`, `logger`, and `message`. Records with an exception also include `exception`.

The CLI returns 0 when the operation succeeds, 1 when the run fails, and 130 when you interrupt it with Ctrl-C. Running the CLI without a command prints help and returns 0.

## Python API

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

The package exports `clean_shares`, `clean_comments`, `clean_messages`, and `clean_connections`. Each accepts `input_path`, `output_path`, `encoding`, `max_input_bytes`, and `max_rows`, and returns a `CleanerResult` (defined in `linkedin_analyzer.core.types`). Passing `None` for a path uses the default path. A `CleanerResult` has `success`, `rows_processed`, `input_path`, `output_path`, `error`, and `missing_input`.

The package also exports `CleanerConfig`, `ColumnConfig`, `CommentsCleanerConfig`, `ConnectionsCleanerConfig`, `MessagesCleanerConfig`, `SharesCleanerConfig`, and `__version__`. It includes `py.typed` for type checkers.

## Related reference

[Data formats](data-formats.md) covers required columns, output columns, row rules, encoding, formula escaping, date conversion, and workbook formatting.
