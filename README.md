# LinkedIn Analyzer

Clean and analyze your LinkedIn data exports. Available as a **web app** (no installation) or **Python CLI**.

## Web App

Try the web-based Data Cleaner - no installation needed!

- Drag & drop your LinkedIn CSV exports (Shares.csv or Comments.csv)
- Instantly clean and download as formatted Excel
- Explore analytics and insights dashboards (timeline, topics, heatmap)
- Weekly timeline detail for 1-3 month ranges
- 100% client-side - your files never leave your browser
- Works offline after first load
- Light/dark theme with hand-drawn aesthetic
- Timestamps are treated as local time (matches the CSV values)

### Deploy Your Own

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/aditya/linkedin-analyzer)

Or run locally:

```bash
# Using Python
python3 -m http.server 3000 --directory web

# Or using npx
npx serve web -l 3000
```

Then open http://localhost:3000

---

## Features

- **Web App** - Cleaner + Analytics + Insights dashboards, fully client-side
- **Clean LinkedIn Shares exports** - Handles the complex quote escaping in `Shares.csv`
- **Clean LinkedIn Comments exports** - Handles backslash-escaped quotes in `Comments.csv`
- **Export to Excel** - Produces well-formatted `.xlsx` files with proper column widths and text wrapping
- **Privacy-first** - Web app runs entirely in your browser, no data uploaded
- **Type-safe** - Python code fully typed with strict mypy compliance
- **Well-tested** - Comprehensive test suite with pytest
- **CLI interface** - Easy-to-use command-line interface for automation

Note: The web analytics uses the timestamps exactly as provided in the CSV. If your export is UTC, convert it before upload to see local times.

## Python CLI

### Installation

```bash
# From source
pip install -e .

# With development dependencies
pip install -e ".[dev]"
```

### Command Line Usage

By default, the CLI reads CSV exports from `data/input` and writes Excel files to `data/output`.
Defaults are defined in `src/linkedin_analyzer/core/paths.py`.

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

### Web Setup

```bash
npm install
npm run dev
```

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

# Run web tests
npm run test:web

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

# Lint web JS
npm run lint:web
```

### CI

GitHub Actions runs linting, type checks, and tests for both the web and Python code.

## Project Structure

```
linkedin-analyzer/
├── web/                         # Web App (static site)
│   ├── index.html               # Home (upload hub)
│   ├── clean.html               # Cleaner UI
│   ├── analytics.html           # Analytics dashboard
│   ├── insights.html            # Insights dashboard
│   ├── css/
│   │   ├── variables.css        # Theme variables (light/dark)
│   │   ├── style.css            # Main styles
│   │   └── sketch.css           # Hand-drawn effects
│   └── js/
│       ├── analytics-ui.js      # Analytics page UI
│       ├── analytics-worker.js  # Analytics web worker
│       ├── analytics.js         # Analytics engine
│       ├── charts.js            # Canvas chart rendering
│       ├── clean.js             # Cleaner page UI
│       ├── cleaner.js           # CSV cleaning (JS port)
│       ├── decorations.js       # Background doodles
│       ├── excel.js             # Excel generation
│       ├── insights-ui.js       # Insights page UI
│       ├── runtime.js           # Global runtime error guard
│       ├── storage.js           # IndexedDB helpers
│       ├── theme.js             # Theme toggle logic
│       └── upload.js            # Upload flow
├── src/                         # Python CLI
│   └── linkedin_analyzer/
│       ├── __init__.py          # Package exports
│       ├── cli.py               # Command-line interface
│       ├── py.typed             # PEP 561 marker
│       ├── core/
│       │   ├── __init__.py      # Core module exports
│       │   ├── types.py         # Type definitions
│       │   ├── text.py          # Text cleaning utilities
│       │   ├── excel.py         # Excel formatting utilities
│       │   ├── cleaner.py       # Base cleaner functionality
│       │   └── paths.py         # Default input/output paths
│       └── cleaners/
│           ├── __init__.py      # Cleaners module exports
│           ├── shares.py        # Shares CSV cleaner
│           └── comments.py      # Comments CSV cleaner
├── data/
│   ├── input/                   # Place LinkedIn CSV exports here
│   └── output/                  # Generated Excel outputs
├── tests/                       # Python tests
├── vercel.json                  # Vercel deployment config
├── package.json                 # NPM config (for local dev server)
├── pyproject.toml               # Python project configuration
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

---

Made with care by **Aditya Kumar Darak (Hermione Granger)**
