# Project Structure

This document is a map of the repository. Trees show ownership and relationships directly. Tool configuration continues to discover files from directory roots, so adding a file inside an existing boundary automatically places it under the normal quality gates.

## Repository

```text
linkedin-analyzer/
├── api/                                # Vercel serverless functions
│   └── csp-report.mjs                  # CSP violation report collector
├── config/                             # JavaScript and repository tool configuration
│   ├── eslint.config.mjs
│   ├── jsconfig.json
│   ├── knip.json
│   ├── playwright.config.js
│   ├── prettierignore
│   ├── prettierrc.json
│   ├── security_audit.json
│   └── stylelint.config.mjs
├── constraints/
│   └── container-build                 # Container-only Python constraints
├── data/                               # Ignored local workspace
│   ├── input/                          # LinkedIn CSV exports
│   └── output/                         # Generated workbooks
├── docs/                               # User and developer documentation
│   ├── adr/                            # Architecture decision records
│   ├── cli.md
│   ├── development.md
│   ├── operations.md
│   ├── structure.md
│   ├── style-guide.md
│   └── web-app.md
├── scripts/                            # Tested repository automation
├── src/
│   └── linkedin_analyzer/              # Published Python package
├── tests/                              # Python package, integration, and tooling tests
├── web/                                # Vite single-page application
├── .github/                            # GitHub metadata, actions, and workflows
├── .dockerignore                       # Container build-context exclusions
├── .editorconfig                       # Cross-editor text conventions
├── .env.example                        # Optional web diagnostics configuration
├── .gitignore                          # Local and generated file exclusions
├── .npmrc                              # Node package-manager policy
├── .pre-commit-config.yaml             # Local Git hook checks
├── .yamllint.yml                       # YAML lint configuration
├── CHANGELOG.md                        # Python package changelog
├── CLAUDE.md                           # Shared repository agent guidance
├── AGENTS.md                           # Symlink to CLAUDE.md
├── Dockerfile                          # Python CLI container image
├── LICENSE
├── Makefile                            # Only command interface for the repository
├── README.md
├── package.json                        # Node dependencies and script definitions
├── package-lock.json                   # Frozen Node dependency resolution
├── pyproject.toml                      # Python build and quality configuration
├── uv.lock                             # Frozen Python dependency resolution
└── vercel.json                         # Vercel deployment configuration
```

The root intentionally retains files that package managers, deployment platforms, and contributors expect to find there. Moving those conventional entry points into another directory would reduce visible root files but increase operational surprise.

## Web Application

The browser application uses feature-first ownership. Application composition, browser infrastructure, reusable modules, styles, and user-facing features have separate boundaries.

```text
web/
├── e2e/                                # Playwright browser tests
│   ├── fixtures/
│   ├── helpers/                        # Shared spec helpers, such as PDF text extraction
│   ├── app.e2e.spec.js
│   ├── browser-xlsx.e2e.spec.js
│   ├── pdf-export.e2e.spec.js
│   └── screenshots.e2e.spec.js
├── public/
│   ├── assets/                         # Icons and application images
│   ├── fonts/                          # Self-hosted fonts
│   └── robots.txt
├── src/
│   ├── app/                            # Application composition primitives
│   │   ├── router.js                   # Hash routes and shared query parameters
│   │   ├── runtime.js                  # Global runtime and service worker setup
│   │   ├── screen-manager.js           # Screen lifecycle and transitions
│   │   └── worker-contracts.js         # Shared worker message contracts
│   ├── features/                       # User-facing capabilities
│   │   ├── analytics/
│   │   ├── cleaning/
│   │   ├── connections/
│   │   ├── export/
│   │   ├── insights/
│   │   ├── messages/
│   │   ├── tutorial/
│   │   └── upload/
│   ├── platform/                       # Browser and operational infrastructure
│   │   ├── observability/
│   │   └── persistence/
│   ├── shared/                         # Reused application primitives
│   │   └── ui/
│   ├── styles/                         # Styles grouped by responsibility
│   │   ├── components/
│   │   ├── features/
│   │   └── foundations/
│   ├── app.js                          # SPA bootstrap and route registration
│   └── sw.js                           # PWA source kept here for VitePWA
├── tests/                              # Vitest tests mirroring source ownership
│   ├── app/
│   ├── features/
│   ├── helpers/
│   ├── integration/
│   ├── platform/
│   └── shared/
├── index.html                          # SPA document and screen markup
├── vite.config.mjs                     # Vite and PWA build configuration
└── vitest.config.mjs                   # Vitest and coverage configuration
```

### Application Composition

```text
web/src/
├── app.js
└── app/
    ├── router.js
    ├── runtime.js
    ├── screen-manager.js
    └── worker-contracts.js
```

`app.js` wires the application together. Modules under `app/` define cross-feature composition and lifecycle behavior. Feature implementation does not belong in this boundary.

### Features

```text
web/src/features/
├── analytics/
│   ├── analytics-worker.js             # Aggregate and view computation worker
│   ├── analytics.js                    # Analytics engine
│   ├── constants.js                    # Calendar labels and analytics constants
│   ├── dates.js                        # Date parsing and calendar calculations
│   ├── insights.js                     # Narrative insight generation
│   ├── screen.js                       # Analytics screen controller
│   ├── stats.js                        # Numeric helpers
│   └── text.js                         # Topic and text normalization
├── cleaning/
│   ├── cleaner.js                      # Browser cleaner facade
│   ├── configs.js                      # Per-export cleaner configuration
│   ├── csv-parser.js                   # Bounded CSV parser
│   ├── excel.js                        # Workbook generation and download
│   ├── field-cleaners.js               # Field-level normalization
│   └── screen.js                       # Clean screen controller
├── connections/
│   ├── connections-worker.js           # Network analytics worker
│   ├── screen.js                       # Connections screen controller
│   └── view.js                         # Network aggregates shared by screen, worker, and export
├── export/
│   ├── availability.js                 # Stored-data reads and the export availability check
│   ├── collect.js                      # PDF document model assembly
│   ├── connections-transport.js        # Connections worker transport and fallback
│   ├── contact-keys.js                 # Contact keys for the self-detection tiebreak
│   ├── drawable-text.js                # Placeholders for characters the fonts cannot draw
│   ├── fonts.js                        # TrueType loading for jsPDF
│   ├── messages-parse.js               # CSV parsing that keeps message bodies verbatim
│   ├── messages-transport.js           # Messages worker transport and fallback
│   ├── palette.js                      # Light palette read from the stylesheet
│   ├── pdf-charts.js                   # Vector chart drawing for the dashboards
│   ├── pdf-document.js                 # A4 measure-and-draw layout engine
│   ├── pdf-layout.js                   # Page geometry and color arithmetic
│   ├── pdf-runtime.js                  # Lazy entry point to everything a run needs
│   ├── pdf.js                          # Export button, dialog, and orchestration
│   ├── threads-transport.js            # Thread worker transport and fallback
│   ├── threads-worker.js               # Message thread selection worker
│   ├── threads.js                      # Recent-thread selection
│   └── worker-transport.js             # Worker ownership, watchdog, and settling for all three
├── insights/
│   ├── reactions.js                    # Pip's stamp-sized pose for each insight card
│   └── screen.js                       # Cross-export insights controller
├── messages/
│   ├── analytics.js                    # Message analytics
│   ├── format.js                       # Formatting and range helpers
│   ├── hydrate.js                      # Map and Set state hydration
│   ├── list-dom.js                     # Message list row builders
│   ├── messages-worker.js              # Message parsing worker
│   ├── parse.js                        # Worker transport and fallback
│   ├── relationships.js                # Relationship queries
│   └── screen.js                       # Messages screen controller
├── tutorial/
│   ├── arrows.js                       # Pointer arrow variants
│   ├── geometry.js                     # Overlay geometry
│   ├── mascot.js                       # Pip drawn on the tutorial callout card
│   ├── pacing.js                       # Mini-tip pacing
│   ├── shell.js                        # Overlay DOM shell
│   ├── steps.js                        # Route tutorial definitions
│   ├── storage.js                      # Tutorial persistence
│   ├── targets.js                      # Target resolution
│   └── tutorial.js                     # Tutorial engine
└── upload/
    ├── decode.js                       # Byte decoding
    ├── jobs.js                         # Upload job identity
    ├── mascot.js                       # Drop-zone catcher poses
    ├── progress.js                     # Progress overlay controller
    ├── read.js                         # Streaming and FileReader input
    ├── state.js                        # File state and hints
    └── upload.js                       # Upload screen controller
```

Each feature owns its screen, domain logic, and worker when applicable. A module moves to `shared/` only after multiple features genuinely depend on it.

### Platform

```text
web/src/platform/
├── observability/
│   ├── metrics.js                      # Bounded telemetry metric helpers
│   ├── perf.js                         # Frame, mark, and measure helpers
│   ├── sentry.js                       # Opt-in error reporting
│   └── telemetry.js                    # Web vitals and performance telemetry
└── persistence/
    ├── data-cache.js                   # In-memory route cache
    ├── session.js                      # Session lifetime management
    └── storage.js                      # IndexedDB with memory fallback
```

Platform modules integrate with browser capabilities or operational services. They do not implement one user-facing feature.

### Shared Modules

```text
web/src/shared/
├── constants.js                        # Dependency-free cross-feature constants
├── dom-events.js                       # Delegated event target helpers
├── ui/
│   ├── alive.js                        # Hero Pip's gaze, boredom, and theme flinch
│   ├── avatar.js                       # Deterministic contact avatars
│   ├── chart-tooltip.js                # Shared chart tooltip
│   ├── charts.js                       # Canvas chart rendering and export
│   ├── decorations.js                  # Rough.js background decorations
│   ├── loading-overlay.js              # Shared loading overlay
│   ├── mascot.js                       # Click splats and the one-shot moments
│   ├── motion.js                       # Reduced-motion check and the one-shot mechanism
│   ├── nav-menu.js                     # Mobile navigation
│   ├── pip-parts.js                    # The SVG parts every drawing of Pip shares
│   └── theme.js                        # Theme selection
└── worker-timeout.js                   # Size-scaled watchdog budget for parsing workers
```

`shared/` is not a general utility bucket. Modules remain with their owning feature until reuse is concrete.

### Styles

```text
web/src/styles/
├── components/
│   ├── export-dialog.css
│   ├── mascot.css
│   └── overlays.css
├── features/
│   ├── analytics.css
│   ├── filters.css
│   ├── insights.css
│   ├── tutorial.css
│   └── upload.css
├── foundations/
│   ├── base.css
│   ├── layout.css
│   └── variables.css
├── responsive.css
├── screens.css
└── sketch.css
```

Foundation styles load first. Feature and component styles build on those foundations. Cross-cutting responsive and visual treatment files load last.

### Web Tests

```text
web/tests/
├── app/                                # app/ and app.js behavior
├── features/
│   ├── analytics/
│   ├── cleaning/
│   ├── connections/
│   ├── export/
│   ├── insights/
│   ├── messages/
│   ├── tutorial/
│   └── upload/
├── helpers/                            # Test-only DOM, telemetry, and Worker stand-ins
├── integration/
│   ├── cleaner-diff.test.js
│   ├── csp-report.test.js
│   ├── parity.test.js
│   ├── verified-commit.test.js
│   └── web-smoke.test.js
├── platform/
│   ├── observability/
│   ├── persistence/
│   └── pwa/
└── shared/
    └── ui/
```

Unit tests mirror the source boundary they verify. Integration tests cross application, runtime, or repository boundaries.

## Python Package

The Python package remains intentionally compact. Its existing package boundaries are already proportional to its size.

```text
src/linkedin_analyzer/
├── cleaners/
│   ├── __init__.py
│   ├── comments.py                     # Comments export cleaner
│   ├── connections.py                  # Connections export cleaner
│   ├── messages.py                     # Messages export cleaner
│   └── shares.py                       # Shares export cleaner
├── core/
│   ├── __init__.py
│   ├── cleaner.py                      # Shared cleaner pipeline
│   ├── excel.py                        # Workbook formatting
│   ├── limits.py                       # Resource limits
│   ├── paths.py                        # Default input and output paths
│   ├── text.py                         # Text and date normalization
│   └── types.py                        # Cleaner configuration and results
├── __init__.py                         # Package exports and version
├── cli.py                              # argparse command dispatch
└── py.typed                            # PEP 561 marker
```

Adding more Python package layers now would create navigation overhead without clarifying an existing ownership problem.

## Python Tests

Python tests distinguish published package behavior, cross-surface integration, reusable support, and repository tooling.

```text
tests/
├── fixtures/                           # Shared cleaner and parity fixtures
├── integration/
│   ├── test_package.py
│   └── test_web_parity.py
├── package/
│   ├── cleaners/
│   │   ├── test_connections.py
│   │   └── test_messages.py
│   ├── core/
│   │   ├── test_excel.py
│   │   ├── test_paths.py
│   │   ├── test_text.py
│   │   └── test_types.py
│   ├── test_cleaner.py
│   └── test_cli.py
├── support/
│   └── gh.py                           # Shared GitHub test doubles
└── tooling/
    ├── checks/                         # Tests for scripts/checks
    ├── ci/                             # Tests for scripts/ci
    ├── gh/                             # Tests for scripts/gh
    ├── lib/                            # Tests for scripts/lib
    ├── lint/                           # Tests for scripts/lint and Makefile policy
    └── setup/                          # Tests for scripts/setup
```

The nested Python test directories are packages. Their `__init__.py` files give duplicate test basenames unambiguous import names.

## Repository Scripts

```text
scripts/
├── checks/
│   ├── audit_memory_python.py
│   ├── check-overrides.mjs
│   ├── cleaner-diff.mjs
│   ├── heap-audit.mjs
│   ├── li_explore.py
│   ├── perf-bench.mjs
│   ├── pipeline-bench.mjs
│   ├── validate_browser_xlsx.py
│   ├── web-smoke.mjs
│   └── xrt-diff.py
├── ci/
│   ├── coverage_summary.py
│   ├── issue_alerts.py
│   ├── refresh_action_shas.py
│   ├── refresh_ci_pins.py
│   ├── repo_audit.py
│   ├── run_npm_audit.py
│   ├── run_parallel_checks.py
│   ├── run_security_audit.py
│   ├── schedule_watchdog.py
│   ├── security_audit_policy.py
│   └── workflow_helpers.py
├── fixtures/
│   └── gen-parity-corpus.mjs
├── gh/
│   ├── ci_status.py
│   ├── cli.py
│   ├── commit_message.py
│   ├── gh_runner.py
│   ├── issues.py
│   ├── pr_review.py
│   └── pr_watch.py
├── lib/
│   ├── gh_policy.py
│   ├── stage_files.py
│   └── workspace_status.py
├── lint/
│   ├── align_tables.py
│   ├── check_doc_commands.py
│   ├── check_editorconfig.py
│   ├── check_make_targets.py
│   ├── lint-workflows.mjs
│   └── make_targets.py
└── setup/
    ├── clean_venv.py
    └── playwright_local_runtime.py
```

Every script is invoked through a documented Make target. Direct script paths exist for implementation and testing, not as a second user interface.

## Data Flow

### Web

1. `features/upload/` reads and decodes selected CSV files.
2. `features/cleaning/` validates, cleans, and exports those files.
3. `platform/persistence/` stores raw input and prepared analytics locally.
4. Feature workers prepare analytics away from the main thread.
5. Feature screen controllers read through persistence and shared UI modules.
6. `app/router.js` and `app/screen-manager.js` coordinate route changes.

### Python CLI

1. `cli.py` parses the command and selects a cleaner.
2. `cleaners/` provides export-specific configuration.
3. `core/cleaner.py` runs the shared pipeline.
4. `core/text.py` applies normalization.
5. `core/excel.py` formats the generated workbook.
