# Project structure

The repository holds a Python package, a browser app, a Vercel function, tests, and tested repository automation. Directory ownership decides which quality gates discover a file.

## Map the repository

```text
linkedin-analyzer/
├── api/                         # Vercel serverless functions
├── config/                      # JavaScript, browser, and audit configuration
├── constraints/                 # Container build constraints
├── data/                        # Local input and output directories
├── docs/                        # Product, developer, operations, and ADR docs
├── scripts/                     # Tested checks, CI, GitHub, lint, and setup code
├── src/linkedin_analyzer/       # Published Python package
├── tests/                       # Python integration, package, and tooling tests
├── web/                         # Vite single-page app
├── .github/                     # Workflows, actions, templates, and policy files
├── .env.example                 # Optional browser and server diagnostics settings
├── .pre-commit-config.yaml      # Local hook definitions
├── .editorconfig                # Cross-editor text rules
├── Dockerfile                   # CLI container image
├── Makefile                     # Repository command interface
├── package.json                 # Node manifest and script definitions
├── pyproject.toml               # Python manifest and Python tool configuration
├── uv.lock                      # Frozen Python dependency resolution
├── package-lock.json            # Frozen Node dependency resolution
└── vercel.json                  # Static deployment and security headers
```

`data/input/` and `data/output/` contain local exports and generated workbooks. Git ignores their contents and keeps only `.gitkeep` files. Never commit a real LinkedIn export.

The repository keeps one source of truth for tool configuration. `pyproject.toml` owns Python linting, typing, tests, coverage, and dead-code settings. Files under `config/` own JavaScript, CSS, browser, formatting, and audit settings. `web/` owns Vite and Vitest configuration.

`CLAUDE.md` is the repository instruction file. `AGENTS.md` is a symlink to it. `CHANGELOG.md` records Python package releases only. The root also holds `LICENSE`, `.gitignore`, `.npmrc`, and `.yamllint.yml`.

## Browse the web app

```text
web/
├── e2e/                         # Playwright specs, fixtures, and helpers
├── public/                      # Icons, fonts, security.txt, and robots.txt
├── src/
│   ├── app/                     # Bootstrap, router, screen lifecycle, worker contracts
│   ├── features/                # User-facing capabilities
│   │   ├── analytics/           # Activity aggregation and Analytics screen
│   │   ├── cleaning/            # Bounded CSV parser and Excel cleaner
│   │   ├── connections/         # Network aggregation and Connections screen
│   │   ├── export/              # Excel lists, chart downloads, and PDF export
│   │   ├── insights/            # Rule-based insight screen and its Svelte card grid
│   │   ├── messages/            # Message parsing and relationship screen
│   │   ├── tutorial/            # Guided tutorials and mini-tips
│   │   └── upload/              # File reading, decoding, upload state, and progress
│   ├── platform/                # Device, persistence, and observability services
│   ├── shared/                  # Reused constants, events, workers, and UI
│   ├── styles/                  # Foundation, feature, component, and responsive CSS
│   ├── app.js                   # Application composition and route registration
│   └── sw.js                    # Injected service worker source
├── tests/                       # Vitest tests that mirror source ownership
├── index.html                   # App markup, screen containers, and inline SVG definitions
├── vite.config.mjs              # Vite, PWA, and optional Sentry source-map setup
└── vitest.config.mjs            # Vitest environment, coverage, and include rules
```

Keep feature code inside its feature directory. Put code used by multiple features in `web/src/shared/` or `web/src/platform/` only when its ownership is clear. Keep screen controllers responsible for screen state, and keep worker code responsible for parsing or aggregation that does not need the DOM.

## Browse the Python package

```text
src/linkedin_analyzer/
├── __init__.py                  # Public package exports and version
├── cli.py                       # Argument parsing, logging, dispatch, and exit codes
├── cleaners/                    # One module per export type, each with its public clean_* function
├── core/                        # Shared CSV pipeline, workbook formatting, limits, paths, text rules, and types
└── py.typed                     # Type-checker marker
```

The four modules under `cleaners/` provide the public `clean_*` functions. `core/cleaner.py` owns the common pipeline, so each file-specific module declares only its columns and parsing rules.

## Browse tests

```text
tests/
├── fixtures/                    # Input, parity, malformed-input, and expected-output fixtures
├── integration/                 # Package integration and web parity tests
├── package/                     # Python cleaners, CLI, core, and Excel tests
├── support/                     # Shared GitHub test helpers
└── tooling/                     # Tests for checks, CI, GitHub, lint, and setup scripts
```

The browser suite follows the same ownership structure under `web/tests/`. Playwright specs live under `web/e2e/` because they exercise the built app in a real browser rather than the Vitest `jsdom` environment.

## Browse repository scripts

```text
scripts/
├── checks/                      # Private export comparisons, benchmarks, and memory checks
├── ci/                          # Coverage, audits, job gating, pins, and watchdogs
├── fixtures/                    # Parity corpus and synthetic large export generators
├── gh/                          # Tested pull request, issue, and CI helpers
├── lib/                         # Shared Git and workspace helpers
├── lint/                        # Documentation, Makefile, EditorConfig, and workflow checks
└── setup/                       # Safe cleanup and repository-local Playwright runtime
```

Scripts are part of the Python coverage target. A new Python script needs tests in the same change. The Makefile exposes the scripts through named targets instead of asking contributors to call modules directly.

## Follow the data flow

### Browser data flow

The browser pipeline runs from upload through storage to exports. See [web architecture](web-architecture.md#how-files-move-through-the-app) for each step and the module that owns it.

### CLI data flow

1. `src/linkedin_analyzer/cli.py` parses global options and dispatches a command.
2. A file-specific cleaner builds a `CleanerConfig`.
3. `core/cleaner.py` checks file limits, reads and decodes the CSV, validates headers, drops invalid rows, and applies column cleaners.
4. `core/text.py` prefixes formula-like strings with an apostrophe and removes control characters that XML forbids.
5. `core/excel.py` formats the workbook, and the writer replaces the destination atomically once the workbook is complete.

See [data formats](data-formats.md) for the shared cleaning rules.
