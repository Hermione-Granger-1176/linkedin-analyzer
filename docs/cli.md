# Python CLI Reference

Command-line tool for cleaning LinkedIn CSV exports into formatted Excel files.

## Installation

```bash
# From PyPI
pip install linkedin-analyzer

# From source
pip install -e .

# With dev dependencies
pip install -e ".[dev]"
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
- Connections CSV skips the first 3 header rows before parsing.
- Connections rows missing all of First Name, Last Name, and URL are dropped.

## Required Columns

- Shares: `Date`, `ShareLink`, `ShareCommentary`
- Comments: `Date`, `Link`, `Message`
- Messages: `FROM`, `TO`, `DATE`, `CONTENT`
- Connections: `Connected On`

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

- Input directory: `data/input/`
- Output directory: `data/output/`
