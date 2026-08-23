# Web architecture

The web app is a static, vanilla JavaScript single-page app. `web/src/app.js` composes routes, screens, persistence, workers, observability, tutorials, and the PDF export. Feature code stays under `web/src/features/`; browser infrastructure stays under `web/src/platform/`.

## Why the app uses a hash router

The app deploys as static assets. A hash router keeps the route after a reload without asking the host to rewrite `/analytics` to `index.html`. `web/src/app/router.js` parses the hash into a route name and query parameters, and `web/src/app/screen-manager.js` activates one screen at a time.

The registered routes are `home`, `clean`, `analytics`, `connections`, `messages`, and `insights`. The four data views share the `range` parameter. The router remembers shared parameters when the user changes screens, and it sorts query keys when it builds a hash.

[ADR-002](adr/002-no-framework-hash-routed-spa.md) records the choice to use a small hand-written router instead of a UI framework and history-based routing.

## How files move through the app

1. `web/src/features/upload/` reads uploaded `File` objects as bytes and decodes them as UTF-8 or WHATWG Windows-1252.
2. `web/src/features/cleaning/` identifies the file type from its header, parses bounded CSV rows, cleans fields, and creates workbooks.
3. Feature workers parse or aggregate data for Analytics, Connections, Messages, and export dashboards.
4. `web/src/platform/persistence/` stores raw file text and computed aggregates when IndexedDB works.
5. Screens read aggregates and render charts, lists, and insight cards in the browser.
6. Export modules create Excel, PNG, or PDF downloads in the browser.

No application endpoint receives the uploaded file contents. The only server-side function is `api/csp-report.mjs`, which accepts browser CSP violation reports.

## Why workers have separate contracts

Long CSV parses and analytics calculations run in Web Workers so the main thread can continue handling input, navigation, and cancellation. `web/src/app/worker-contracts.js` defines shared request and response shapes for worker messages.

The Connections and Messages screens keep their own workers and request counters. PDF export uses separate transports in `web/src/features/export/` so an export cannot terminate or reset a worker that a screen is using. The export transports share lifecycle code from `worker-transport.js` and use a bounded main-thread fallback for small files when Workers are unavailable.

The message export has a separate `threads-worker.js` because the Messages screen intentionally drops message bodies from its in-memory aggregates. The worker reads the stored message file only when the user opts in to message contents for a PDF.

## How the cleaner stays in parity

Python implements the CLI cleaner under `src/linkedin_analyzer/`. JavaScript implements the browser cleaner under `web/src/features/cleaning/`. The two runtimes share checked-in parity fixtures and a generated corpus.

`tests/integration/test_web_parity.py` and `web/tests/integration/parity.test.js` compare the two runtimes with the expected corpus output. Run `make gen-parity-corpus` after an intentional corpus change, then run the relevant tests. [ADR-005](adr/005-dual-runtime-cleaner-with-parity-fixtures.md) records the design.

## How persistence degrades

`web/src/platform/persistence/storage.js` selects IndexedDB when it is available. It stores file metadata and text separately, stores analytics aggregates, and reports when persistence is lost. The module keeps an in-memory implementation for browsers that reject IndexedDB operations.

`web/src/platform/persistence/session.js` records last activity in `localStorage`. A startup sweep removes stale files and analytics after 24 hours without activity. Screens wait for the sweep before they restore stored data. [ADR-003](adr/003-indexeddb-storage-with-session-ttl.md) records the privacy and reliability trade-off.

## How diagnostics stay opt in

`web/src/platform/observability/sentry.js` does not initialize Sentry without a DSN and stored consent. Before sending an error, it rebuilds the event from allowlisted module and operation values, safe same-origin script paths, bounded stack locations, and optional release metadata.

`web/src/platform/observability/telemetry.js` records only allowlisted numeric web-vitals and performance measurements. It buffers the latest value and a count, then sends a numeric `session-metrics` event when the page becomes hidden.

`api/csp-report.mjs` is separate from consent because a browser needs a valid CSP reporting endpoint even when diagnostics forwarding is off. It accepts legacy and Reporting API shapes, keeps only bounded violation metadata, removes URL queries and fragments, and forwards reports only when `CSP_REPORT_URI` or `SENTRY_DSN` is configured. [ADR-004](adr/004-opt-in-telemetry-with-pii-scrubbing.md) records the data reduction rules.

## How the PDF export is split

`web/src/features/export/pdf.js` owns the user flow. `pdf-runtime.js` loads the export graph on demand, including `jspdf`, fonts, chart drawing, data collection, and layout. The initial bundle does not include that graph.

`pdf-document.js` lays out measured blocks on A4 pages. `pdf-charts.js` redraws charts as PDF vectors instead of copying canvas pixels. The exporter reads the light theme tokens from CSS and loads TrueType fonts only when a user starts an export. Font fallback replaces unsupported characters with `?` so missing text is visible.

The export collects dashboard data from the feature workers and keeps names and message bodies behind independent confirmation choices. [ADR-008](adr/008-jspdf-for-the-save-as-pdf-export.md) records the dependency and export design.

## Keep delegated events safe

Shared delegated click handlers use `web/src/shared/dom-events.js` and its `DomEvents.closest(event, selector)` helper. The helper handles targets that are text nodes or other non-Element values before it searches for the matching control, so screens do not repeat inconsistent `instanceof Element` guards.

## Keep visual assets owned

Decorative SVG and mascot drawings are not application data. Shared definitions live in `web/index.html`, pose and animation rules live in the component styles, and event-driven reactions live beside the feature that triggers them. Keep decorative elements `aria-hidden`, `focusable="false"`, and out of pointer hit testing. Honor `prefers-reduced-motion` for idle loops and one-shot reactions.

## How the PWA cache works

`web/vite.config.mjs` uses `vite-plugin-pwa` with an injected service worker. `web/src/sw.js` precaches the build manifest, serves navigation with NetworkFirst, refreshes scripts and styles with StaleWhileRevalidate, and caches fonts and images with CacheFirst. Both runtime media caches expire entries after 30 days.

The build uses a relative base path, so the static app can run below a domain root. The PWA manifest and asset paths use the same relative base.

## Keep module ownership clear

Put application wiring in `web/src/app/`, browser services in `web/src/platform/`, reusable UI in `web/src/shared/`, and user-facing behavior in `web/src/features/`. Mirror source ownership in `web/tests/`. Add a source file under an existing root rather than adding a per-file tool list. Read [project structure](structure.md) for the directory map.
