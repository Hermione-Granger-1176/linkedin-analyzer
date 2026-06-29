# Project Structure

The tree below highlights the key directories and modules; it is a map, not an exhaustive file index. When in doubt, trust the directory layout over any single file line, and let the tooling configs discover sources from their roots (see CLAUDE.md rule 5).

```text
linkedin-analyzer/
├── web/                                # Web app (SPA)
│   ├── index.html                      # SPA shell containing all screens
│   ├── public/
│   │   ├── assets/
│   │   │   ├── icon.svg                # SVG favicon (modern browsers)
│   │   │   ├── favicon.ico             # ICO favicon (legacy browsers)
│   │   │   ├── apple-touch-icon.png    # 180px icon (iOS home screen)
│   │   │   ├── icon-192.png            # 192px icon (Android/PWA)
│   │   │   └── icon-512.png            # 512px icon (PWA splash/OG cards)
│   │   ├── fonts/
│   │   │   ├── PatrickHand-Regular.woff2 # Self-hosted Patrick Hand font
│   │   │   └── Caveat-Regular.woff2    # Self-hosted Caveat font
│   │   └── robots.txt                  # Search engine directives
│   ├── vite.config.js                  # Vite build + generated PWA manifest config
│   ├── src/
│   │   ├── css/
│   │   │   ├── variables.css           # Theme variables + @font-face (light/dark)
│   │   │   ├── style.css               # Main styles
│   │   │   ├── screens.css             # Screen transitions + page animation rules
│   │   │   ├── sketch.css              # Hand-drawn effects
│   │   │   └── tutorial.css            # Tutorial overlays, popovers, and mini tips
│   │   ├── constants.js                # Shared cross-module constants
│   │   ├── dom-events.js               # Delegated DOM event target helpers
│   │   ├── runtime.js                  # Global error handler
│   │   ├── sentry.js                   # Sentry error reporting integration
│   │   ├── telemetry.js                # Web-vitals and perf telemetry
│   │   ├── session.js                  # Session management
│   │   ├── theme.js                    # Theme toggle
│   │   ├── decorations.js              # Background doodles (Rough.js)
│   │   ├── avatar.js                   # Deterministic contact avatar generation
│   │   ├── storage.js                  # IndexedDB helpers
│   │   ├── data-cache.js               # In-memory cache across route switches
│   │   ├── router.js                   # Hash router + shared query params
│   │   ├── screen-manager.js           # Screen lifecycle + transitions
│   │   ├── loading-overlay.js          # Shared loading overlay manager
│   │   ├── app.js                      # SPA bootstrap wiring
│   │   ├── upload.js                   # Home/upload logic
│   │   ├── upload-decode.js            # Byte-decoding and storage-error helpers
│   │   ├── upload-state.js             # File-state and hint helpers
│   │   ├── cleaner.js                  # CSV cleaning logic
│   │   ├── cleaner-configs.js          # Per-file-type cleaner configuration
│   │   ├── csv-parser.js               # Low-level CSV parsing primitives
│   │   ├── field-cleaners.js           # Field-level cleaning primitives
│   │   ├── clean.js                    # Clean screen UI logic
│   │   ├── excel.js                    # Excel generation (write-excel-file)
│   │   ├── analytics.js                # Analytics engine
│   │   ├── analytics-worker.js         # Worker for analytics aggregates/views
│   │   ├── analytics-ui.js             # Analytics screen controller
│   │   ├── connections-worker.js       # Worker for connections network analytics
│   │   ├── connections-ui.js           # Connections screen controller
│   │   ├── messages-worker.js          # Worker for messages/connections parsing
│   │   ├── messages-analytics.js       # Messages analytics computations
│   │   ├── messages-format.js          # Formatting, range, and signature helpers
│   │   ├── messages-insights.js        # Messages screen controller
│   │   ├── insights-ui.js              # Insights screen controller
│   │   ├── tutorial-steps.js           # Per-route tutorial and mini-tip definitions
│   │   ├── tutorial-geometry.js        # Geometry and math helpers for the overlay
│   │   ├── tutorial.js                 # Tutorial engine
│   │   ├── charts.js                   # Canvas chart rendering (incl. PNG export)
│   │   ├── worker-contracts.js         # Shared worker message contracts
│   │   ├── ui/                         # Reusable UI modules (e.g. chart-tooltip.js)
│   │   └── sw.js                       # Service Worker for PWA offline caching
│   ├── tests/                          # Vitest unit tests
│   └── e2e/                            # Playwright browser tests
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
│   │   ├── paths.py                    # Default paths
│   │   └── limits.py                   # Resource limit constants
│   └── cleaners/
│       ├── __init__.py
│       ├── shares.py                   # Shares CSV cleaner
│       ├── comments.py                 # Comments CSV cleaner
│       ├── messages.py                 # Messages CSV cleaner
│       └── connections.py              # Connections CSV cleaner
│
├── tests/                              # Python tests
├── docs/                               # Documentation
│   └── adr/                            # Architecture Decision Records
├── config/                             # Tooling config moved out of repo root
│   ├── eslint.config.mjs               # ESLint flat config
│   ├── jsconfig.json                   # Web JavaScript type-check config
│   ├── knip.json                       # JavaScript dead-code config
│   ├── playwright.config.js            # Playwright browser test config
│   ├── prettierignore                  # Prettier ignore rules
│   └── prettierrc.json                 # Prettier formatting rules
├── scripts/
│   ├── check-overrides.mjs             # Validates npm overrides are still needed
│   ├── checks/                         # Local cleaner-diff, benchmark, and export-exploration tools (need data/input)
│   ├── ci/                             # Local CI parallel-runner and GitHub Actions workflow helpers
│   ├── gh/                             # GitHub PR/CI helper (auto-detect repo/PR, GraphQL, CI triage)
│   └── lint/                           # Local lint helpers
├── data/
│   ├── input/                          # Place CSVs here
│   └── output/                         # Generated Excel files
│
├── api/                                # Vercel serverless functions
│   └── csp-report.mjs                  # CSP violation report collector
├── .github/                            # GitHub metadata, workflows, and community docs
│   ├── CONTRIBUTING.md                 # Contributor guide shown by GitHub
│   ├── SECURITY.md                     # Coordinated disclosure policy
│   ├── actions/                        # Composite actions (ci-setup, verified-commit)
│   └── workflows/                      # CI, audit, publish, and maintenance workflows
├── Dockerfile                          # CLI container image (multi-stage, non-root)
├── vercel.json                         # Vercel config
├── .pre-commit-config.yaml             # Local pre-commit hooks
├── Makefile                            # Local and CI command entrypoints
├── package.json                        # NPM config
├── pyproject.toml                      # Python config
├── uv.lock                             # Locked Python dependency resolution
├── CHANGELOG.md                        # Python package changelog
├── LICENSE                             # MIT license
└── README.md
```

## Key Files

### Web App Core

| File                         | Purpose                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `web/src/router.js`          | Hash route parsing, URL query params, shared param propagation |
| `web/src/screen-manager.js`  | Screen transitions and controller lifecycle                    |
| `web/src/app.js`             | Route registration and bootstrapping                           |
| `web/src/loading-overlay.js` | Global content loading overlay + blur handling                 |
| `web/src/data-cache.js`      | In-memory cache and cache notifications                        |
| `web/src/session.js`         | Session TTL cleanup on startup                                 |

### Assets & Meta

| File                                     | Purpose                                              |
| ---------------------------------------- | ---------------------------------------------------- |
| `web/public/assets/icon.svg`             | SVG favicon served to modern browsers                |
| `web/public/assets/favicon.ico`          | 32px ICO fallback for legacy browsers                |
| `web/public/assets/apple-touch-icon.png` | 180px PNG for iOS home screen bookmark               |
| `web/public/assets/icon-192.png`         | 192px PNG for Android and PWA icon                   |
| `web/public/assets/icon-512.png`         | 512px PNG for PWA splash screen and OG cards         |
| `web/vite.config.js`                     | Build config and source for generated PWA metadata   |
| `web/public/robots.txt`                  | Allows all crawlers                                  |
| `web/index.html` `<head>`                | OG, Twitter Card, theme-color, and favicon link tags |

### Processing

| File                            | Purpose                                               |
| ------------------------------- | ----------------------------------------------------- |
| `web/src/cleaner.js`            | CSV parsing/cleaning logic used by web workers and UI |
| `web/src/analytics-worker.js`   | Builds analytics views off main thread                |
| `web/src/connections-worker.js` | Parses connections and computes network analytics     |
| `web/src/messages-worker.js`    | Parses messages/connections off main thread           |
| `web/src/messages-analytics.js` | Shared messages analytics helpers for UI + worker     |
| `web/src/excel.js`              | `.xlsx` generation and download helpers               |

### Python CLI

| File | Purpose |
| --- | --- |
| `src/linkedin_analyzer/cli.py` | Commands: `shares`, `comments`, `messages`, `connections`, `all` |
| `src/linkedin_analyzer/core/text.py` | Quote/date/value normalization rules |
| `src/linkedin_analyzer/core/excel.py` | Excel formatting with `openpyxl` |

## Data Flow (Web)

1. User uploads CSV files on `#home`.
2. Raw CSV text is stored via `storage.js` in IndexedDB for restore when available, with an in-memory fallback otherwise.
3. On startup, a non-blocking TTL sweep clears stale session data while caches hydrate. Screens wait for cleanup to finish before loading stored data.
4. Analytics and Insights aggregates are prepared in `analytics-worker.js` after fresh uploads; restored dashboards read persisted analytics directly. Connections analytics runs in `connections-worker.js`.
5. Screen controllers load cached/persisted data through `data-cache.js` and `storage.js`.
6. Route changes swap screens without full page reload.
7. URL query params (for example `range`) are used to restore filter state.

## Data Flow (CLI)

1. User runs a CLI command (for example `linkedin-analyzer messages`).
2. `cli.py` parses args and dispatches cleaner functions.
3. Cleaner modules read CSV with pandas.
4. Shared text/date cleaning rules are applied.
5. Formatted `.xlsx` output is written to configured path.
