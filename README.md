# LinkedIn Analyzer

A production-ready Python tool to clean and export LinkedIn CSV data exports to Excel.

## Features

- **Clean LinkedIn Shares exports** - Handles the complex quote escaping in `Shares.csv`
- **Clean LinkedIn Comments exports** - Handles backslash-escaped quotes in `Comments.csv`
- **Export to Excel** - Produces well-formatted `.xlsx` files with proper column widths and text wrapping
- **Type-safe** - Fully typed with strict mypy compliance
- **Well-tested** - Comprehensive test suite with pytest
- **CLI interface** - Easy-to-use command-line interface

## Installation

```bash
# From source
pip install -e .

# With development dependencies
pip install -e ".[dev]"
```

## Usage

### Command Line

By default, the CLI reads CSV exports from `data/input` and writes Excel files to `data/output`.

```bash
# Clean Shares.csv and export to Shares.xlsx
linkedin-analyzer shares

# Clean Comments.csv and export to Comments.xlsx
linkedin-analyzer comments

# Clean both files
linkedin-analyzer all

# Specify custom input/output paths
linkedin-analyzer shares --input my_shares.csv --output cleaned_shares.xlsx

# Set log level
linkedin-analyzer --log-level DEBUG shares
```

### Python API

```python
from pathlib import Path
from linkedin_analyzer import clean_shares, clean_comments

# Clean shares
result = clean_shares(
    input_path=Path("Shares.csv"),
    output_path=Path("Shares.xlsx"),
)
print(f"Processed {result.rows_processed} rows")

# Clean comments
result = clean_comments(
    input_path=Path("Comments.csv"),
    output_path=Path("Comments.xlsx"),
)
print(f"Processed {result.rows_processed} rows")
```

### Custom Configuration

```python
from pathlib import Path
from linkedin_analyzer.core import CleanerConfig, ColumnConfig, run_cleaner

def my_cleaner(value: object) -> str:
    return str(value).upper()

config = CleanerConfig(
    input_path=Path("data.csv"),
    output_path=Path("data.xlsx"),
    columns=(
        ColumnConfig(name="Name", width=30, cleaner=my_cleaner),
        ColumnConfig(name="Description", width=100, wrap_text=True),
    ),
)

result = run_cleaner(config)
```

## Development

### Setup

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # or `venv\Scripts\activate` on Windows

# Install with dev dependencies
pip install -e ".[dev]"
```

### Running Tests

```bash
# Run all tests
pytest

# Run with coverage
pytest --cov=linkedin_analyzer --cov-report=html

# Run specific test file
pytest tests/test_text.py -v
```

### Type Checking

```bash
mypy src/linkedin_analyzer
```

### Linting

```bash
ruff check src tests
ruff format src tests
```

## Project Structure

```
linkedin-analyzer/
├── src/
│   └── linkedin_analyzer/
│       ├── __init__.py          # Package exports
│       ├── cli.py               # Command-line interface
│       ├── py.typed             # PEP 561 marker
│       ├── core/
│       │   ├── __init__.py      # Core module exports
│       │   ├── types.py         # Type definitions
│       │   ├── text.py          # Text cleaning utilities
│       │   ├── excel.py         # Excel formatting utilities
│       │   └── cleaner.py       # Base cleaner functionality
│       └── cleaners/
│           ├── __init__.py      # Cleaners module exports
│           ├── shares.py        # Shares CSV cleaner
│           └── comments.py      # Comments CSV cleaner
├── data/
│   ├── input/                   # Place LinkedIn CSV exports here
│   └── output/                  # Generated Excel outputs
├── tests/
│   ├── __init__.py
│   ├── test_text.py             # Text utility tests
│   ├── test_types.py            # Type tests
│   ├── test_cleaner.py          # Cleaner tests
│   └── test_cli.py              # CLI tests
├── pyproject.toml               # Project configuration
└── README.md                    # This file
```

## What Gets Cleaned

### Shares.csv

LinkedIn's Shares export uses a complex quote escaping pattern:

**Before:**
```
"The next phase of AI isn't about IQ.""
""""
""AI companies have been obsessed with which model is ""smarter"" for the past few months."
```

**After:**
```
The next phase of AI isn't about IQ.

AI companies have been obsessed with which model is "smarter" for the past few months.
```

### Comments.csv

LinkedIn's Comments export uses backslash-escaped quotes:

**Before:**
```
"#CopilotInExcel

=COPILOT(
  \"Extract and clean the data\",
  A2:A40
)"
```

**After:**
```
#CopilotInExcel

=COPILOT(
  "Extract and clean the data",
  A2:A40
)
```

## License

MIT
