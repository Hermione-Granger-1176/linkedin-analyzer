# Project Structure

```text
linkedin-analyzer/
├── web/                                # Web app (SPA)
│   ├── index.html                      # SPA shell containing all screens
│   ├── robots.txt                      # Search engine directives
│   ├── assets/
│   │   ├── icon.svg                    # SVG favicon (modern browsers)
│   │   ├── favicon.ico                 # ICO favicon (legacy browsers)
│   │   ├── apple-touch-icon.png        # 180px icon (iOS home screen)
│   │   ├── icon-192.png                # 192px icon (Android/PWA)
│   │   ├── icon-512.png                # 512px icon (PWA splash/OG cards)
│   │   └── manifest.webmanifest        # PWA web app manifest
│   ├── fonts/
│   │   ├── PatrickHand-Regular.woff2   # Self-hosted Patrick Hand font
│   │   └── Caveat-Regular.woff2        # Self-hosted Caveat font
│   ├── css/
│   │   ├── variables.css               # Theme variables + @font-face (light/dark)
│   │   ├── style.css                   # Main styles
│   │   ├── screens.css                 # Screen transitions + page animation rules
│   │   ├── sketch.css                  # Hand-drawn effects
│   │   └── tutorial.css                # Tutorial overlays, popovers, and mini tips
│   ├── js/
│   │   ├── runtime.js                  # Global error handler
│   │   ├── theme.js                    # Theme toggle
│   │   ├── decorations.js              # Background doodles (Rough.js)
│   │   ├── storage.js                  # IndexedDB helpers
│   │   ├── data-cache.js               # In-memory cache across route switches
│   │   ├── router.js                   # Hash router + shared query params
│   │   ├── screen-manager.js           # Screen lifecycle + transitions
│   │   ├── loading-overlay.js          # Shared loading overlay manager
│   │   ├── app.js                      # SPA bootstrap wiring
│   │   ├── upload.js                   # Home/upload logic
│   │   ├── cleaner.js                  # CSV cleaning logic
│   │   ├── clean.js                    # Clean screen UI logic
│   │   ├── excel.js                    # Excel generation (SheetJS)
│   │   ├── analytics.js                # Analytics engine
│   │   ├── analytics-worker.js         # Worker for analytics aggregates/views
│   │   ├── analytics-ui.js             # Analytics screen controller
│   │   ├── connections-worker.js       # Worker for connections network analytics
│   │   ├── connections-ui.js           # Connections screen controller
│   │   ├── messages-worker.js          # Worker for messages/connections parsing
│   │   ├── messages-insights.js        # Messages screen controller
│   │   ├── insights-ui.js              # Insights screen controller
│   │   ├── tutorial-steps.js           # Per-route tutorial and mini-tip definitions
│   │   ├── tutorial.js                 # Tutorial engine
│   │   └── charts.js                   # Canvas chart rendering (incl. PNG export)
│   ├── sw.js                           # Service Worker for PWA offline caching
│   └── tests/                          # Web tests
│
├── src/linkedin_analyzer/              # Python package
│   ├── __init__.py                     # Package exports
│   ├── cli.py                          # argparse CLI
│   ├── py.typed                        # PEP 561 marker
│   ├── core/
│   │   ├── __init__.py
│   │   ├── types.py                    # Type definitions
│   │   ├── text.py                     # Text cleaning utilities
│   │   ├── excel.py                    # Excel formatting
│   │   ├── cleaner.py                  # Base cleaner
│   │   └── paths.py                    # Default paths
│   └── cleaners/
│       ├── __init__.py
│       ├── shares.py                   # Shares CSV cleaner
│       ├── comments.py                 # Comments CSV cleaner
│       ├── messages.py                 # Messages CSV cleaner
│       └── connections.py              # Connections CSV cleaner
│
├── tests/                              # Python tests
├── docs/                               # Documentation
├── data/
│   ├── input/                          # Place CSVs here
│   └── output/                         # Generated Excel files
│
├── .github/workflows/ci.yml            # GitHub Actions
├── vercel.json                         # Vercel config
├── package.json                        # NPM config
├── pyproject.toml                      # Python config
├── LICENSE                             # MIT license
└── README.md
```

## Key Files

### Web App Core

| File                        | Purpose                                                        |
| --------------------------- | -------------------------------------------------------------- |
| `web/js/router.js`          | Hash route parsing, URL query params, shared param propagation |
| `web/js/screen-manager.js`  | Screen transitions and controller lifecycle                    |
| `web/js/app.js`             | Route registration and bootstrapping                           |
| `web/js/loading-overlay.js` | Global content loading overlay + blur handling                 |
| `web/js/data-cache.js`      | In-memory cache and cache notifications                        |
| `web/js/session.js`         | Session TTL cleanup on startup                                 |

### Assets & Meta

| File                              | Purpose                                        |
| --------------------------------- | ---------------------------------------------- |
| `web/assets/icon.svg`             | SVG favicon served to modern browsers          |
| `web/assets/favicon.ico`          | 32px ICO fallback for legacy browsers          |
| `web/assets/apple-touch-icon.png` | 180px PNG for iOS home screen bookmark         |
| `web/assets/icon-192.png`         | 192px PNG for Android and PWA icon             |
| `web/assets/icon-512.png`         | 512px PNG for PWA splash screen and OG cards   |
| `web/assets/manifest.webmanifest` | PWA manifest (name, icons, theme, display)     |
| `web/robots.txt`                  | Allows all crawlers                            |
| `web/index.html` `<head>`         | OG, Twitter Card, theme-color, and icon `link` |

### Processing

| File                           | Purpose                                               |
| ------------------------------ | ----------------------------------------------------- |
| `web/js/cleaner.js`            | CSV parsing/cleaning logic used by web workers and UI |
| `web/js/analytics-worker.js`   | Builds analytics views off main thread                |
| `web/js/connections-worker.js` | Parses connections and computes network analytics     |
| `web/js/messages-worker.js`    | Parses messages/connections off main thread           |
| `web/js/messages-analytics.js` | Shared messages analytics helpers for UI + worker     |
| `web/js/excel.js`              | `.xlsx` generation and download helpers               |

### Python CLI

| File                                  | Purpose                                                          |
| ------------------------------------- | ---------------------------------------------------------------- |
| `src/linkedin_analyzer/cli.py`        | Commands: `shares`, `comments`, `messages`, `connections`, `all` |
| `src/linkedin_analyzer/core/text.py`  | Quote/date/value normalization rules                             |
| `src/linkedin_analyzer/core/excel.py` | Excel formatting with `openpyxl`                                 |

## Data Flow (Web)

1. User uploads CSV files on `#home`.
2. Raw CSV text is stored in IndexedDB via `storage.js`.
3. On startup, a non-blocking TTL sweep clears stale session data while caches hydrate.
4. Analytics aggregate base is prepared in `analytics-worker.js` on a scheduled prime; connections analytics in `connections-worker.js`.
5. Screen controllers load cached/persisted data through `data-cache.js` and `storage.js`.
6. Route changes swap screens without full page reload.
7. URL query params (for example `range`) are used to restore filter state.

## Data Flow (CLI)

1. User runs a CLI command (for example `linkedin-analyzer messages`).
2. `cli.py` parses args and dispatches cleaner functions.
3. Cleaner modules read CSV with pandas.
4. Shared text/date cleaning rules are applied.
5. Formatted `.xlsx` output is written to configured path.
