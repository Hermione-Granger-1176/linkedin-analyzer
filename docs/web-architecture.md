# Web architecture

The web app is a static, vanilla JavaScript single-page app. `web/src/app.js` composes routes, screens, persistence, workers, observability, tutorials, and the PDF export. Feature code stays under `web/src/features/`; browser infrastructure stays under `web/src/platform/`.

## Why the app uses a hash router

The app deploys as static assets. A hash router keeps the route after a reload without asking the host to rewrite `/analytics` to `index.html`. `web/src/app/router.js` parses the hash into a route name and query parameters, and `web/src/app/screen-manager.js` activates one screen at a time.

The registered routes are `home`, `clean`, `analytics`, `connections`, `messages`, and `insights`. The four data views share the `range` parameter. The router remembers shared parameters when the user changes screens, and it sorts query keys when it builds a hash.

The upload screen ships in the main bundle because most visits land on it. Every other screen registers a loader instead of a controller, and its code is fetched the first time its route opens: the screen manager shows the loading overlay, waits for the import, then initializes the controller with the route's latest parameters. A failed import is reported and tried again on the next visit. Once an upload makes Analytics available, `web/src/app/route-preload.js` fetches its code while the browser is idle, except on the lite effects tier with Save-Data on.

[ADR-002](adr/002-no-framework-hash-routed-spa.md) records the choice to use a small hand-written router instead of a UI framework and history-based routing.

## How files move through the app

1. `web/src/features/upload/` validates the uploaded `File` objects and posts each one to the analytics worker. Posting a `File` clones a reference to its bytes, not the bytes, so the page never holds the file text while it processes. The worker streams the bytes with `read.js`, reports bytes read as progress, and decodes them as strict UTF-8, starting over as WHATWG Windows-1252 if the bytes are not valid UTF-8.
2. `web/src/features/cleaning/` identifies the file type from the first 64K characters, then parses and cleans each row as its chunk arrives, so the worker never builds the full row and record arrays. The limits apply as running counts. If streaming cannot finish, for example on a parse error, the worker runs the whole-text cleaner instead, so results and error messages match. The same module creates workbooks.
3. Feature workers parse or aggregate data for Analytics, Connections, Messages, the Clean screen, and export dashboards.
4. `web/src/platform/persistence/` stores each original upload as a `Blob`, with computed aggregates, when IndexedDB works. Screens and exports pass the stored `Blob` to their workers, which read it off the main thread.
5. Screens read aggregates and render charts, lists, and insight cards in the browser.
6. Export modules create Excel, PNG, or PDF downloads in the browser.

No application endpoint receives the uploaded file contents. The only server-side function is `api/csp-report.mjs`, which accepts browser CSP violation reports.

## Why workers have separate contracts

Long CSV parses and analytics calculations run in Web Workers so the main thread can continue handling input, navigation, and cancellation. `web/src/app/worker-contracts.js` defines shared request and response shapes for worker messages.

The analytics worker runs its requests one at a time in arrival order, because reading a file is asynchronous. A multi-file upload therefore processes its files one after another, so only one file's parse state is alive at a time. **Clear data** skips that queue: it aborts the read in flight, drops the requests queued before it, and resets the worker. The worker replies with the cleaned result only; the page stores the `File` it already holds.

The Connections and Messages screens keep their own workers and request counters. The Messages worker keeps one event per participant per message as typed-array columns, a contact ID and a timestamp, instead of one object each, and transfers those buffers to the page rather than copying them. PDF export uses separate transports in `web/src/features/export/` so an export cannot terminate or reset a worker that a screen is using. The export transports share lifecycle code from `worker-transport.js` and use a bounded main-thread fallback for small files when Workers are unavailable.

The Clean screen sends its preview, Excel, and cleaned CSV builds to `cleaning-worker.js` through `clean-client.js`, one request at a time. The worker keeps the last file it cleaned, keyed by type and upload time, so a download right after the preview does not parse the file again. The page receives five preview rows or a finished `Blob`, never the cleaned rows. Where Workers are unavailable, the same job runs on the main thread.

The message export has a separate `threads-worker.js` because the Messages screen intentionally drops message bodies from its in-memory aggregates. The worker reads the stored message file only when the user opts in to message contents for a PDF.

## How the cleaner stays in parity

Python implements the CLI cleaner under `src/linkedin_analyzer/`. JavaScript implements the browser cleaner under `web/src/features/cleaning/`. The two runtimes share checked-in parity fixtures and a generated corpus.

`tests/integration/test_web_parity.py` and `web/tests/integration/parity.test.js` compare the two runtimes with the expected corpus output. Run `make gen-parity-corpus` after an intentional corpus change, then run the relevant tests. [ADR-005](adr/005-dual-runtime-cleaner-with-parity-fixtures.md) records the design.

## How persistence degrades

`web/src/platform/persistence/storage.js` selects IndexedDB when it is available. It stores file metadata and the original upload `Blob` separately, stores analytics aggregates, and reports when persistence is lost. Text records written before database version 4 are still read, wrapped as a `File`, until the next upload of that type replaces them. The module keeps an in-memory implementation for browsers that reject IndexedDB operations; it holds the uploaded `File` reference. [ADR-010](adr/010-stream-uploads-and-store-original-files.md) records the move from stored text to stored files.

`web/src/platform/persistence/session.js` records last activity in `localStorage`. A startup sweep removes stale files and analytics after 24 hours without activity. Screens wait for the sweep before they restore stored data. [ADR-003](adr/003-indexeddb-storage-with-session-ttl.md) records the privacy and reliability trade-off.

## How diagnostics stay opt in

`web/src/platform/observability/sentry.js` does not initialize Sentry without a DSN and stored consent. Before sending an error, it rebuilds the event from allowlisted module and operation values, safe same-origin script paths, bounded stack locations, and optional release metadata.

`web/src/platform/observability/telemetry.js` records only allowlisted numeric web-vitals and performance measurements. It buffers the latest value and a count, then sends a numeric `session-metrics` event when the page becomes hidden.

`web/src/platform/observability/run-tracker.js` notices processing runs that did not finish. A tab the browser kills cannot report as it dies, so the upload page writes a `localStorage` marker when processing starts, refreshes its heartbeat every 5 seconds, and removes it when every job settles. `pagehide` records that the page was left, so a reload or a normal close is not reported. At startup, the app removes left markers silently, asks other open tabs over a `BroadcastChannel` whether one owns a remaining run, and rechecks a run with a recent heartbeat once it would be stale. Only a run with no owner and a stale heartbeat shows the notice and, with consent, sends one `processing-unfinished` event. The signal counts runs that did not finish, not crashes: read it as a trend across size buckets.

`api/csp-report.mjs` is separate from consent because a browser needs a valid CSP reporting endpoint even when diagnostics forwarding is off. It accepts legacy and Reporting API shapes, keeps only bounded violation metadata, removes URL queries and fragments, and forwards reports only when `CSP_REPORT_URI` or `SENTRY_DSN` is configured. [ADR-004](adr/004-opt-in-telemetry-with-pii-scrubbing.md) records the data reduction rules.

## How the PDF export is split

`web/src/features/export/pdf.js` owns the user flow. `pdf-runtime.js` loads the export graph on demand, including `jspdf`, fonts, chart drawing, data collection, and layout. The initial bundle does not include that graph.

`pdf-document.js` lays out measured blocks on A4 pages. `pdf-charts.js` redraws charts as PDF vectors instead of copying canvas pixels. The exporter reads the light theme tokens from CSS and loads TrueType fonts only when a user starts an export. Font fallback replaces unsupported characters with `?` so missing text is visible.

The export collects dashboard data from the feature workers and keeps names and message bodies behind independent confirmation choices. [ADR-008](adr/008-jspdf-for-the-save-as-pdf-export.md) records the dependency and export design.

## How the effects tier is chosen

`web/src/platform/device/capabilities.js` reads CPU cores, `navigator.deviceMemory`, Save-Data, the coarse-pointer query, and accelerated WebGL once, picks the `lite`, `standard`, or `rich` tier, and caches the profile. `web/src/shared/ui/effects.js` applies the tier as `data-effects` on the root element, wires the **Auto**, **Lite**, and **Full** toggle, and, under **Auto**, drops one tier when `web/src/platform/device/jank.js` sees repeated long animation frames while no processing or screen load is running. Stylesheets gate expensive effects on `:root[data-effects="lite"]`.

The page ships marked `lite` and upgrades after the profile is known, because the CSP forbids the inline script that could set it before first paint. The WebGL probe is skipped under the **Lite** override. The tier controls decoration only: processing reads the raw signals, never the tier. [ADR-009](adr/009-device-tiers-for-effects.md) records the thresholds and rules.

## Keep delegated events safe

Shared delegated click handlers use `web/src/shared/dom-events.js` and its `DomEvents.closest(event, selector)` helper. The helper handles targets that are text nodes or other non-Element values before it searches for the matching control, so screens do not repeat inconsistent `instanceof Element` guards.

## Keep visual assets owned

Decorative SVG and mascot drawings are not application data. Shared definitions live in `web/index.html`, pose and animation rules live in the component styles, and event-driven reactions live beside the feature that triggers them. Keep decorative elements `aria-hidden`, `focusable="false"`, and out of pointer hit testing. Honor `prefers-reduced-motion` for idle loops and one-shot reactions.

## How the PWA cache works

`web/vite.config.mjs` uses `vite-plugin-pwa` with an injected service worker. `web/src/sw.js` precaches the build manifest, serves navigation with NetworkFirst, refreshes scripts and styles with StaleWhileRevalidate, and caches fonts and images with CacheFirst. Both runtime media caches expire entries after 30 days.

The build uses a relative base path, so the static app can run below a domain root. The PWA manifest and asset paths use the same relative base.

## Keep module ownership clear

Put application wiring in `web/src/app/`, browser services in `web/src/platform/`, reusable UI in `web/src/shared/`, and user-facing behavior in `web/src/features/`. Mirror source ownership in `web/tests/`. Add a source file under an existing root rather than adding a per-file tool list. Read [project structure](structure.md) for the directory map.
