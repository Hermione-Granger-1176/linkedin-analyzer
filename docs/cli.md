# Python CLI Reference

Command-line tool for cleaning LinkedIn CSV exports.

## Installation

```bash
# From source
pip install -e .

# With dev dependencies
pip install -e ".[dev]"
```

## Commands

### Clean Shares

```bash
linkedin-analyzer shares
```

Reads `data/input/Shares.csv`, outputs `data/output/Shares.xlsx`.

### Clean Comments

```bash
linkedin-analyzer comments
```

Reads `data/input/Comments.csv`, outputs `data/output/Comments.xlsx`.

### Clean Both

```bash
linkedin-analyzer all
```

Processes both files.

## Options

### Custom paths

```bash
linkedin-analyzer shares --input my_shares.csv --output cleaned.xlsx
linkedin-analyzer comments --input my_comments.csv --output cleaned.xlsx
```

### Log level

```bash
linkedin-analyzer --log-level DEBUG shares
linkedin-analyzer --log-level INFO comments
```

## Python API

### Basic usage

```python
from pathlib import Path
from linkedin_analyzer import clean_shares, clean_comments

result = clean_shares(
    input_path=Path("Shares.csv"),
    output_path=Path("Shares.xlsx"),
)
print(f"Processed {result.rows_processed} rows")

result = clean_comments(
    input_path=Path("Comments.csv"),
    output_path=Path("Comments.xlsx"),
)
print(f"Processed {result.rows_processed} rows")
```

### Custom configuration

```python
from pathlib import Path
from linkedin_analyzer.core import CleanerConfig, ColumnConfig, run_cleaner

def uppercase(value: object) -> str:
    return str(value).upper()

config = CleanerConfig(
    input_path=Path("data.csv"),
    output_path=Path("data.xlsx"),
    columns=(
        ColumnConfig(name="Name", width=30, cleaner=uppercase),
        ColumnConfig(name="Description", width=100, wrap_text=True),
    ),
)

result = run_cleaner(config)
```

## What Gets Cleaned

### Shares.csv

LinkedIn uses nested quote escaping:

```
"The next phase of AI isn't about IQ.""
""""
""AI companies have been obsessed with which model is ""smarter"" for the past few months."
```

Becomes:

```
The next phase of AI isn't about IQ.

AI companies have been obsessed with which model is "smarter" for the past few months.
```

### Comments.csv

LinkedIn uses backslash-escaped quotes:

```
"=COPILOT(\"Extract data\", A2:A40)"
```

Becomes:

```
=COPILOT("Extract data", A2:A40)
```

## Default Paths

Configured in `src/linkedin_analyzer/core/paths.py`:

- Input: `data/input/`
- Output: `data/output/`
