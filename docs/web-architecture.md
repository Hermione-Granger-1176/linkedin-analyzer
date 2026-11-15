# Web architecture

The web app is a static JavaScript single-page app. Screen controllers, workers, and storage are plain modules, and screen views can be Svelte components. `web/src/app.js` composes routes, screens, persistence, workers, observability, tutorials, and the PDF export. Feature code lives in `web/src/features/`, and browser infrastructure lives in `web/src/platform/`.

## Why the app uses a hash router

The app deploys as static assets, so the route lives in the hash and survives a reload without host rewrite rules. `web/src/app/router.js` parses the hash into a route name and query parameters. `web/src/app/screen-manager.js` activates one screen at a time.

The routes are `home`, `clean`, `analytics`, `connections`, `messages`, and `insights`. The four data views share the `range` parameter. The router keeps shared parameters when the user changes screens, and it sorts query keys when it builds a hash.

The upload screen ships in the main bundle because most visits start there. Other screens register loaders and import their code on the first visit to their route. The screen manager shows a loading overlay during the import, then initializes the controller with the route's latest parameters. A failed import shows **Try again**. Revisiting the route retries the import, and leaving a screen during loading removes its overlay.

Once an upload makes Analytics available, `web/src/app/route-preload.js` loads its code while the browser is idle. It skips preloading when the `lite` tier and Save-Data both apply. In production, the service worker precaches screen chunks after the page loads, so later visits can open screens offline. See [How the PWA cache works](#how-the-pwa-cache-works).

For the reasons, see [ADR-002](adr/002-no-framework-hash-routed-spa.md).

## Where Svelte fits

A screen can render parts of its view with Svelte 5 components. A component mounts into an element the screen's markup already has. The controller calls the functions the component exposes, passing results it already holds, such as a worker reply. The Insights card grid (`web/src/features/insights/InsightCards.svelte`) is one example. Components never read files, talk to workers, or hold raw datasets, and they set no inline styles, so the CSP stays as it is. The Svelte runtime is one shared chunk that loads with the first screen that needs it.

For the decision, see [ADR-011](adr/011-svelte-for-screen-views.md).

## How files move through the app

1. `web/src/features/upload/` validates each uploaded `File` and posts it to the analytics worker, without decoding it on the page. The worker streams the bytes with `read.js`, reports bytes read as progress, and decodes them as strict UTF-8. If the bytes are not valid UTF-8, it starts over as WHATWG Windows-1252.
2. `web/src/features/cleaning/` identifies the file type from the first 64K characters. It parses and cleans each row as its chunk arrives, without building full row and record arrays. The limits apply as running counts. If streaming cannot finish, such as after a parse error, the worker runs the whole-text cleaner, so results and error messages match. The same module creates workbooks.
3. Feature workers parse or aggregate data for Analytics, Connections, Messages, the Clean screen, and export dashboards.
4. `web/src/platform/persistence/` stores each original upload as a `Blob`, with computed aggregates, when IndexedDB is available. Screens and exports pass the stored `Blob` to their workers, which read it off the main thread. Fallbacks that run without Workers decode on the main thread.
5. Screens read aggregates and render charts, lists, and insight cards in the browser.
6. Export modules create Excel, PNG, or PDF downloads in the browser.

No application endpoint receives uploaded file contents. `api/csp-report.mjs` accepts browser CSP violation reports. `api/sentry-tunnel.mjs` relays opt-in Sentry diagnostics to the configured project. The browser reduces those diagnostics before it sends them, and the relay checks only the destination.

For the storage decision, see [ADR-010](adr/010-stream-uploads-and-store-original-files.md).

## Why workers have separate contracts

Long CSV parses and analytics calculations run in Web Workers, so the main thread keeps handling input, navigation, and cancellation. `web/src/app/worker-contracts.ts` defines the request and response shapes as TypeScript types, alongside runtime validators that check each message against them.

The analytics worker handles requests in arrival order and holds the parse state of one file at a time. The page starts each file's timeout when processing begins, so queued files do not spend their allowance while they wait.

The worker computes analytics once per batch and includes them in the reply to the last file. The page saves them after every analytics input in the batch is saved. A rejected last file, or one that cannot be stored and is not an analytics input, does not block that save. If an analytics input fails to save, the stored analytics stay unchanged, and the next upload reloads the worker's state from storage.

**Clear data** bypasses the queue. It aborts the active read, discards queued requests, and resets the worker. A restore that is reading stored files discards its results. Worker replies contain the cleaned result without the original text. The page keeps the uploaded `File` reference it already holds.

The Connections and Messages screens each have their own worker and request counters. The Messages worker stores each participant's message events in typed-array columns of contact IDs and timestamps. It transfers those buffers to the page instead of copying them.

PDF export uses separate transports in `web/src/features/export/`, so an export cannot terminate or reset a screen's worker. The transports share lifecycle code from `worker-transport.js`. Without Web Workers, small files use a main-thread fallback with size limits.

`web/src/features/cleaning/string-pool.js` shares repeated cell values across retained rows, so each distinct name or profile URL is stored once.

The Clean screen sends its preview, Excel, and cleaned CSV builds to `cleaning-worker.js` through `clean-client.js`, one request at a time. The worker keeps the last file it cleaned, keyed by type and upload time, so a download right after the preview does not parse the file again. The page receives five preview rows or a finished `Blob`, never the cleaned rows. Without Workers, the same job runs on the main thread.

The message export has a separate `threads-worker.js`, because the Messages screen drops message bodies from its in-memory aggregates. The worker reads the stored file only when the user opts in to message contents for a PDF. It reads the file twice: first to choose threads from rows without bodies, then again for only the bodies it chose. It never holds every message body at once.

## How the cleaner stays in parity

Python implements the CLI cleaner under `src/linkedin_analyzer/`. JavaScript implements the browser cleaner under `web/src/features/cleaning/`. Both runtimes check the same parity fixtures and a generated corpus. `tests/integration/test_web_parity.py` and `web/tests/integration/parity.test.js` compare each runtime's output with the expected corpus output. Run `make gen-parity-corpus` after an intentional corpus change, then run the tests described in [testing](testing.md#check-cleaner-parity).

For the design, see [ADR-005](adr/005-dual-runtime-cleaner-with-parity-fixtures.md).

## How persistence degrades

`web/src/platform/persistence/storage.js` uses IndexedDB when it is available. It stores file metadata and the original upload `Blob` separately, stores analytics aggregates, and reports when persistence is lost. For browsers that reject IndexedDB operations, it keeps an in-memory implementation that holds the uploaded `File` reference.

`web/src/platform/persistence/session.js` records the last activity in `localStorage`. At startup, a sweep removes files and analytics that have been idle for 24 hours. Screens wait for the sweep before they restore stored data.

For the decisions, see [ADR-003](adr/003-indexeddb-storage-with-session-ttl.md) and [ADR-010](adr/010-stream-uploads-and-store-original-files.md).

## How diagnostics stay opt in

`web/src/platform/observability/sentry.js` does not start Sentry without a DSN and stored consent. Before it sends an error, it rebuilds the event from allowlisted module and operation values, same-origin script paths, bounded stack locations, and optional release metadata.

`web/src/platform/observability/telemetry.js` records only allowlisted numeric web-vitals and performance measurements. It buffers the latest value and a count, then sends one numeric `session-metrics` event when the page becomes hidden.

`web/src/platform/observability/run-tracker.js` detects unfinished processing runs with a `localStorage` marker. The upload page creates the marker when processing starts, refreshes its heartbeat every 5 seconds, and removes it after all jobs settle. The `pagehide` and `freeze` events mark a run as left, so normal navigation and frozen tabs do not count as unfinished. A tab that resumes or returns from the back or forward cache writes the full marker again.

At startup, the app removes markers for runs marked as left. It asks other tabs over a `BroadcastChannel` whether they own each remaining run. A recent heartbeat delays the check until it goes stale. A run with no owner and a stale heartbeat triggers the notice. With consent, the app also sends one `processing-unfinished` event. That event identifies the run without establishing its cause.

`api/csp-report.mjs` does not depend on consent, because a browser needs a valid CSP reporting endpoint even when diagnostics forwarding is off. It accepts legacy and Reporting API shapes, keeps bounded violation metadata, removes URL queries and fragments, and forwards reports only when `CSP_REPORT_URI` or `SENTRY_DSN` is set.

For the data reduction rules, see [ADR-004](adr/004-opt-in-telemetry-with-pii-scrubbing.md).

## How the PDF export is split

`web/src/features/export/pdf.js` owns the user flow. `pdf-runtime.js` loads the export graph on demand, including `jspdf`, fonts, chart drawing, data collection, and layout, so the initial bundle does not include it.

`pdf-document.js` lays out measured blocks on A4 pages. `pdf-charts.js` redraws charts as PDF vectors instead of copying canvas pixels. The exporter reads the light theme tokens from CSS and loads TrueType fonts only when the user starts an export. Font fallback replaces unsupported characters with `?`, so missing text stays visible.

The export collects dashboard data from the feature workers. Names and message bodies each need a separate confirmation.

For the dependency and design, see [ADR-008](adr/008-jspdf-for-the-save-as-pdf-export.md).

## How the effects tier is chosen

`web/src/platform/device/capabilities.js` reads CPU cores, `navigator.deviceMemory`, Save-Data, the coarse-pointer query, and accelerated WebGL once. It picks the `lite`, `standard`, or `rich` tier and caches the profile. `web/src/shared/ui/effects.js` applies the tier as `data-effects` on the root element. It drops one tier when `web/src/platform/device/jank.js` sees repeated long animation frames while no processing or screen load is running. Stylesheets gate expensive effects on `:root[data-effects="lite"]`.

The page starts with `lite` effects, because the CSP forbids an inline script from setting a tier before first paint. After it reads the device profile, the app selects the tier automatically. If CPU or memory signals already rule out `rich`, it skips the WebGL probe. File processing does not read the effects tier.

For the thresholds and rules, see [ADR-009](adr/009-device-tiers-for-effects.md).

## Keep delegated events safe

Shared delegated click handlers use `web/src/shared/dom-events.js` and its `DomEvents.closest(event, selector)` helper. The helper handles targets that are text nodes or other non-Element values before it searches for the matching control, so screens do not repeat `instanceof Element` guards.

## Keep visual assets owned

Decorative SVG and mascot drawings are not application data. Shared definitions live in `web/index.html`, pose and animation rules live in the component styles, and event-driven reactions live beside the feature that triggers them. Keep decorative elements `aria-hidden`, `focusable="false"`, and out of pointer hit testing. Honor `prefers-reduced-motion` for idle loops and one-shot reactions.

## How the PWA cache works

`web/vite.config.mjs` uses `vite-plugin-pwa` with an injected service worker. `web/src/sw.js` precaches the build manifest, serves navigation with NetworkFirst, refreshes scripts and styles with StaleWhileRevalidate, and caches fonts and images with CacheFirst. Both runtime caches expire entries after 30 days.

The build uses a relative base path, so the static app can run below a domain root. The PWA manifest and asset paths use the same relative base.

## Keep module ownership clear

Put application wiring in `web/src/app/`, browser services in `web/src/platform/`, reusable UI in `web/src/shared/`, and user-facing behavior in `web/src/features/`. Mirror source ownership in `web/tests/`. Add a source file under an existing root rather than adding a per-file tool list. Read [project structure](structure.md) for the directory map.
