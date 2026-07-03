# Python CLI Reference

Command-line tool for cleaning LinkedIn CSV exports into formatted Excel files.

## Installation

```bash
# From PyPI
pip install linkedin-analyzer

# From source for development
make install

# Run the local CLI
make run-cli args="--help"
```

## Commands

### Shares

```bash
linkedin-analyzer shares
```

Reads `data/input/Shares.csv`, writes `data/output/Shares.xlsx`.

### Comments

```bash
linkedin-analyzer comments
```

Reads `data/input/Comments.csv`, writes `data/output/Comments.xlsx`.

### Messages

```bash
linkedin-analyzer messages
```

Reads `data/input/messages.csv`, writes `data/output/Messages.xlsx`.

### Connections

```bash
linkedin-analyzer connections
```

Reads `data/input/Connections.csv`, writes `data/output/Connections.xlsx`.

### All

```bash
linkedin-analyzer all
```

Processes all four exports in one run.

By default, `all` exits with code 1 if any input file is absent. Pass `--skip-missing` to treat a missing input file as a skip (logged as a warning) rather than a failure, so a partial export set still succeeds:

```bash
linkedin-analyzer all --skip-missing
```

Only genuinely absent input files are skipped. A file that exists but is malformed or otherwise fails to process still exits with code 1. Without the flag, behavior is unchanged.

## Options

### Version

```bash
linkedin-analyzer --version
```

### Global log level

```bash
linkedin-analyzer --log-level DEBUG shares
linkedin-analyzer --log-level INFO all
```

Defaults to `INFO`. Also configurable via the `LOG_LEVEL` environment variable.

### Log format

```bash
linkedin-analyzer --log-format json all
```

Choose `text` (default, human-readable) or `json` (structured, one object per line). Also configurable via the `LOG_FORMAT` environment variable. See [Operations and Deployment](operations.md) for production logging guidance.

### Input encoding

```bash
linkedin-analyzer --encoding latin-1 shares
linkedin-analyzer --encoding utf-8 all
```

Forces the encoding used to read input CSVs. When omitted, the encoding is auto-detected (see Cleaning Notes below). Pass this when characters look wrong, or when you already know the export's encoding. Like `--log-level` and `--log-format`, it is a global option and goes before the command.

### Resource limits

```bash
linkedin-analyzer --max-input-bytes 104857600 --max-rows 1000000 shares
linkedin-analyzer --max-input-bytes 0 --max-rows 0 all
```

By default, the CLI rejects input files larger than 104857600 bytes and CSVs with more than 1000000 parsed rows. Pass `0` to disable either limit. These are global options and go before the command.

The web app enforces its own, different caps (per-file size, decoded text, rows, columns, and per-field length); see [web app Limits](web-app.md#limits).

Environment defaults:

- `LINKEDIN_ANALYZER_MAX_INPUT_BYTES`
- `LINKEDIN_ANALYZER_MAX_ROWS`

### Custom paths for single-file commands

```bash
linkedin-analyzer shares --input my_shares.csv --output cleaned_shares.xlsx
linkedin-analyzer comments --input my_comments.csv --output cleaned_comments.xlsx
linkedin-analyzer messages --input my_messages.csv --output cleaned_messages.xlsx
linkedin-analyzer connections --input my_connections.csv --output cleaned_connections.xlsx
```

### Custom paths for `all`

```bash
linkedin-analyzer all \
  --shares-input data/input/Shares.csv \
  --shares-output data/output/Shares.xlsx \
  --comments-input data/input/Comments.csv \
  --comments-output data/output/Comments.xlsx \
  --messages-input data/input/messages.csv \
  --messages-output data/output/Messages.xlsx \
  --connections-input data/input/Connections.csv \
  --connections-output data/output/Connections.xlsx
```

## Cleaning Notes

- Shares commentary escaping is normalized.
- Comments CSV uses backslash escaping for special characters.
- Comments and messages escaped quotes are normalized.
- UTC timestamps are converted to local time where applicable.
- NA-like values are treated as missing.
- Rows missing required fields are dropped.
- Cell values that start with Excel formula prefixes are quote-prefixed to avoid spreadsheet formula execution.
- Encoding is auto-detected when `--encoding` is not set: UTF-8 (BOM-aware) is tried first, then Latin-1, which decodes any byte sequence. On the fallback the CLI logs a WARNING suggesting `--encoding`; pass it if characters look wrong.
- Connections CSV skips the first 3 header rows before parsing.
- Connections rows missing all of First Name, Last Name, and URL are dropped.

## Required Columns

- Shares: `Date`, `ShareLink`, `ShareCommentary`
- Comments: `Date`, `Link`, `Message`
- Messages: `FROM`, `TO`, `DATE`, `CONTENT`
- Connections: `First Name`, `Last Name`, `Connected On`

For Connections rows, only `Connected On` must contain a value. Rows are also dropped when `First Name`, `Last Name`, and `URL` are all missing.

## Python API

```python
from pathlib import Path
from linkedin_analyzer import clean_comments, clean_connections, clean_messages, clean_shares

result = clean_shares(input_path=Path("Shares.csv"), output_path=Path("Shares.xlsx"))
print(result)

result = clean_messages(input_path=Path("messages.csv"), output_path=Path("Messages.xlsx"))
print(result)
```

## Default Paths

Configured in `src/linkedin_analyzer/core/paths.py`:

- Base data directory: `data/`, configurable with `LINKEDIN_ANALYZER_DATA_DIR`
- Input directory: `data/input/`
- Output directory: `data/output/`
