# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-03-06

### Added

- Structured JSON logging for CLI (`--log-format json` / `LOG_FORMAT` env).
- `LOG_LEVEL` and `LINKEDIN_ANALYZER_DATA_DIR` environment variable support.
- Dynamic versioning from git tags via `hatch-vcs`.
- ARIA `tabindex` attributes and programmatic heading focus for screen-reader navigation.
- `axe-core` accessibility end-to-end test for the analytics screen.
- IndexedDB storage hardening with in-memory fallback when unavailable.
- IndexedDB schema versioning for stored files and analytics payloads.
- Size-limit CI checks for bundle size monitoring.
- Cross-runtime cleaner parity fixtures for web and Python.
- Consent-gated Sentry diagnostics initialization.
- Publish-time artifact validation and Docker version propagation.

### Changed

- Replace vulnerable `xlsx` library with `write-excel-file` in the web export path.
- Make diagnostics (Sentry) opt-in and align privacy wording with runtime behavior.
- Bump Python Docker base image from 3.12-slim to 3.14-slim.
- Bump 10 GitHub Actions to latest SHA-pinned versions.
- Bump npm dependencies: `@sentry/browser` 9 to 10, `web-vitals` 4 to 5, `jsdom` 26 to 28.

### Fixed

- Docker version propagation for `hatch-vcs` builds.
- Analytics filter label and action colors raised to AA-safe contrast.
- Upload progress test stability across CI runtimes.

### Security

- Expand OWASP CSV injection escape to cover all formula prefixes.
- Trivy container image scan before Docker push in CI.

## [0.4.0] - 2026-03-05

### Added

- Guided tutorial overlay with per-screen steps, spotlight, SVG pointer arrows, keyboard
  navigation, focus trap, and mini-tips with engagement-paced timing.
- Session TTL cleanup clearing stale uploads and cached analytics after 24 hours.
- Worker contracts module (`worker-contracts.js`) with typed parse/normalize helpers for
  all worker message envelopes.
- Large-file guardrails: 40 MB hard limit per file, 30-second `FileReader` timeout,
  streaming `ReadableStream` path for 5-40 MB files, and CSV size limits (30 MB text,
  250 k rows, 256 columns).
- XSS-safe DOM APIs via centralized `chart-tooltip.js`; user-controlled strings no longer
  reach `innerHTML`.
- Sentry release tracking (`VITE_APP_RELEASE`) and `beforeSend` noise filter.
- Web Vitals telemetry (CLS, FCP, INP, LCP, TTFB) wired into Sentry metrics.
- Playwright end-to-end tests with Chromium and Firefox.
- Prettier, TypeScript type-checking (`config/jsconfig.json`), and stricter ESLint rules
  (`no-eval`, `no-implied-eval`, `no-throw-literal`, import cycle depth 3).
- `.github/SECURITY.md` with coordinated disclosure policy.
- CodeQL analysis workflow for JavaScript and Python.
- Dependabot configuration with grouped updates per ecosystem.
- Operations runbook (`docs/operations.md`).

### Changed

- Service worker rewritten with Workbox-style strategies: NetworkFirst for navigation,
  StaleWhileRevalidate for scripts/styles, CacheFirst for fonts/images.
- CI push triggers scoped to `main` only with concurrency cancellation.
- Node test matrix expanded to 20 and 22; Python matrix to 3.11, 3.12, and 3.13.
- PyPI publishing switched to OIDC trusted publishing (no API token secret).
- Docker publishing switched to multi-arch `linux/amd64,linux/arm64` via `docker/build-push-action`.
- Vitest coverage thresholds raised to statements 95 %, branches 85 %, functions 96 %, lines 96 %.

### Fixed

- Upload timeout race saving empty content when pending entry is null.
- Session cleanup race resolved with `Session.waitForCleanup()` awaited in all screen load paths.
- Service worker cache-put floating promise fixed with `event.waitUntil()`.
- Worker error resilience: all three workers now wrap dispatch in try/catch with consistent
  error shapes via `toErrorMessage` helper.

## [0.3.0] - 2026-03-02

### Added

- PWA manifest (`manifest.webmanifest`) for standalone display with theme colors.
- Favicon set: SVG source, 32 px ICO, 180 px Apple Touch, 192 px and 512 px PNGs.
- Open Graph and Twitter Card meta tags for social link previews.
- `robots.txt` allowing all crawlers with sitemap reference.
- Connections analytics screen with growth timeline, top companies, top positions bar
  charts, and network stats.
- Chart PNG export via hover button on all chart cards.
- Self-hosted Google Fonts eliminating external DNS lookups.
- Service worker for offline PWA support with static asset and CDN script caching.

### Changed

- CI workflows hardened with SHA-pinned actions, GitHub App token authentication, and
  monthly refresh schedule.
- Control flow simplified with dispatch/state patterns and modernized loop usage.

### Fixed

- Screen overlap on refresh and tab transitions (absolute positioning for exit animation,
  immediate `active` class removal).
- Animation race in `exportPng` resolved with temporary detached canvas.
- Stale popup `z-index` on stat card re-renders.
- `drawRegistry` entries surviving the clear-then-redraw cycle.
- Dark-mode selection text visibility (white text on yellow highlight).

### Security

- SHA-pinned all GitHub Actions with App token authentication.

## [0.2.0] - 2026-02-28

### Added

- Messages and Connections CSV cleaning in both Python CLI and web app.
- Single-page application hash router replacing multi-page HTML stubs.
- Shared URL-driven time-range filters across analytics, messages, and insights screens.
- Content loading overlay with gear animation and skeleton loaders.
- Messages parsing Web Worker with in-memory cache to avoid UI freeze.

### Changed

- Code quality audit: full JSDoc annotations across 13 JS files, `.editorconfig` codifying
  indent styles, `from __future__ import annotations` in Python init files, dictionary
  lookups replacing if/elif chains, extracted helper functions.
- Cleaner, docs, and tooling alignment pass.

### Fixed

- Upload progress feedback and export functionality improvements.

## [0.1.0] - 2026-01-31

Initial release of linkedin-analyzer encompassing the Python CLI, web application,
analytics dashboard, CI pipeline, and project documentation.

### Added

- Python CLI (`linkedin-analyzer`) for cleaning LinkedIn **Shares** and **Comments** CSV
  exports to formatted Excel files.
- Centralized default paths and deduplicated CLI argument handling.
- 95 %+ test coverage with `pytest-cov` threshold enforcement.
- Web-based Data Cleaner with drag-and-drop CSV upload, auto-detection of file type, and
  Excel download.
- Hand-drawn sketch aesthetic (Rough.js) with dark/light theme toggle.
- 100 % client-side processing — files never leave the browser.
- Analytics and Insights screens with multi-file upload support.
- Pre-computed aggregates, timeline year grouping, and Web Worker offloading for smooth
  analytics rendering.
- ESLint configuration and initial web test suite.
- Vite build pipeline with Vercel static deployment configuration.
- MIT license (SPDX text) and comprehensive README.

### Changed

- Web UI refactored from single-page script into multipage flow with dedicated screen
  modules.
- UTC timestamps converted once at ingestion in the web pipeline.

### Fixed

- Timezone conversion and chart alignment on initial render.
- Topic filtering re-enabled after analytics refactor.
- Analytics timeline rendering reliability across date ranges.
- CI test globs and Vercel rewrite rules.
- Repository URLs in `package.json` and `pyproject.toml`.

[Unreleased]: https://github.com/Hermione-Granger-1176/linkedin-analyzer/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Hermione-Granger-1176/linkedin-analyzer/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Hermione-Granger-1176/linkedin-analyzer/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Hermione-Granger-1176/linkedin-analyzer/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Hermione-Granger-1176/linkedin-analyzer/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Hermione-Granger-1176/linkedin-analyzer/releases/tag/v0.1.0
