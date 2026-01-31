# Project Structure

```
linkedin-analyzer/
├── web/                           # Web app (static site)
│   ├── index.html                 # Home / upload hub
│   ├── clean.html                 # Cleaner page
│   ├── analytics.html             # Analytics dashboard
│   ├── insights.html              # Insights page
│   ├── css/
│   │   ├── variables.css          # Theme variables (light/dark)
│   │   ├── style.css              # Main styles
│   │   ├── screens.css            # Page-specific styles
│   │   └── sketch.css             # Hand-drawn effects
│   ├── js/
│   │   ├── runtime.js             # Global error handler
│   │   ├── theme.js               # Theme toggle
│   │   ├── decorations.js         # Background doodles (Rough.js)
│   │   ├── storage.js             # IndexedDB helpers
│   │   ├── upload.js              # File upload flow
│   │   ├── cleaner.js             # CSV cleaning logic
│   │   ├── clean.js               # Cleaner page UI
│   │   ├── excel.js               # Excel generation (SheetJS)
│   │   ├── analytics.js           # Analytics engine
│   │   ├── analytics-worker.js    # Web worker for analytics
│   │   ├── analytics-ui.js        # Analytics page UI
│   │   ├── charts.js              # Canvas chart rendering
│   │   └── insights-ui.js         # Insights page UI
│   └── tests/                     # Web tests
│
├── src/linkedin_analyzer/         # Python package
│   ├── __init__.py                # Package exports
│   ├── cli.py                     # Click CLI
│   ├── py.typed                   # PEP 561 marker
│   ├── core/
│   │   ├── __init__.py
│   │   ├── types.py               # Type definitions
│   │   ├── text.py                # Text cleaning utilities
│   │   ├── excel.py               # Excel formatting
│   │   ├── cleaner.py             # Base cleaner
│   │   └── paths.py               # Default paths
│   └── cleaners/
│       ├── __init__.py
│       ├── shares.py              # Shares CSV cleaner
│       └── comments.py            # Comments CSV cleaner
│
├── tests/                         # Python tests
├── docs/                          # Documentation
├── data/
│   ├── input/                     # Place CSVs here
│   └── output/                    # Generated Excel files
│
├── .github/workflows/ci.yml       # GitHub Actions
├── vercel.json                    # Vercel config
├── package.json                   # NPM config
├── pyproject.toml                 # Python config
├── LICENSE                        # MIT license
└── README.md
```

## Key Files

### Web App

| File | Purpose |
|------|---------|
| `runtime.js` | Global error banner for unhandled errors |
| `storage.js` | IndexedDB wrapper for storing cleaned data |
| `cleaner.js` | Cleans CSV content, converts UTC to local time |
| `analytics.js` | Computes aggregates, timelines, topics, heatmap |
| `charts.js` | Renders Canvas charts with Rough.js sketchy style |

### Python

| File | Purpose |
|------|---------|
| `cli.py` | Click commands: `shares`, `comments`, `all` |
| `core/text.py` | Quote unescaping, text normalization |
| `core/excel.py` | Excel styling with openpyxl |
| `cleaners/shares.py` | Shares.csv specific cleaning |
| `cleaners/comments.py` | Comments.csv specific cleaning |

## Data Flow

### Web

1. User drops CSV on upload zone
2. `upload.js` reads file, stores raw content in IndexedDB
3. `cleaner.js` parses CSV, fixes escaping, converts timestamps
4. Cleaned data stored in IndexedDB
5. `analytics.js` computes aggregates (runs in Web Worker)
6. `charts.js` renders visualizations on Canvas

### CLI

1. User runs `linkedin-analyzer shares`
2. `cli.py` parses args, calls `clean_shares()`
3. `cleaners/shares.py` reads CSV with custom parser
4. `core/text.py` fixes quote escaping
5. `core/excel.py` writes formatted .xlsx
