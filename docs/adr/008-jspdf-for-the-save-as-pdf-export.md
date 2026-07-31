# ADR-008: jsPDF for the Save as PDF export

**Date:** 2026-07-31 **Status:** Accepted **Deciders:** Aditya Kumar Darak

## Context

The web app needed a **Save as PDF** button: an A4 document of the user's insights, drawn in the app's warm light palette regardless of the current theme, and containing more than the screen shows. On top of the insight cards, the pro tip and the all-time stats, it can carry the last 5 messages of the 10 most recently messaged contacts in full, behind an opt-in confirmation.

That last section is the constraint. Message bodies are of unbounded and unpredictable length, so the document needs real text measurement, wrapping and pagination: a single message may be longer than a page and has to flow across pages rather than overflow or loop.

[ADR-002](002-no-framework-hash-routed-spa.md) commits this project to a small dependency surface, so a new runtime dependency needs a record.

Three options were considered.

**`window.print()` with an `@media print` stylesheet.** No new dependency at all. Rejected: the document is deliberately not what is on screen. The Insights screen renders only the first six cards and holds no message text at all (`MessagesAnalytics.buildMessageState` discards `CONTENT` by design), so printing would require building the whole document into hidden DOM first. Pagination, page numbering and the file name would all be at the browser's discretion, and headless-browser output would vary across engines, making the behavior untestable in the e2e suite.

**`pdf-lib`.** Smaller and pleasant to work with, but it offers no text measurement and no wrapping. Every line break in a variable-length message thread would have to be computed by hand against font metrics the library does not expose. Rejected.

**`jspdf`.** Provides `splitTextToSize`, `getTextWidth`, TrueType embedding through `addFileToVFS`/`addFont`, and deterministic A4 output as a `Blob`. It is the only one of the three that answers the wrapping requirement directly.

## Decision

Add `jspdf` as a runtime dependency and load it with a dynamic `import()`, following the pattern `features/cleaning/excel.js` already uses for `write-excel-file`.

Three constraints go with it:

1. **It never enters the initial bundle.** The `import("jspdf")` sits inside the export orchestrator, so Vite emits it as its own chunk. A `size-limit` budget guards the chunk, and the index budget guards against it leaking into the entry.
2. **Colors are read from the stylesheet, never copied into JavaScript.** The light palette selector in `foundations/variables.css` was widened from `:root` to `:root, [data-theme="light"], .theme-light` (a pure selector addition; no token values changed). At export time a detached `.theme-light` element is mounted and the tokens are read back with `getComputedStyle`. The document is light by construction and cannot drift from the site palette.
3. **Fonts are fetched, not bundled.** `PatrickHand-Regular.ttf` and `Caveat-Regular.ttf` (both SIL OFL, licence included) ship next to the existing `.woff2` files in `web/public/fonts/` and are fetched at export time. They stay out of every JavaScript bundle and are only paid for on export.

Two follow-on decisions fall out of this:

- **Icons become accent-coloured left rules and roundels.** jsPDF cannot draw SVG without `svg2pdf.js`; a second dependency is not worth the insight-card icons.
- **Thread selection gets its own worker.** `messages-worker.js` has an 8 kB budget and a contract the Messages screen depends on, so `features/export/threads-worker.js` is separate.

## Consequences

- The dependency surface grows by one runtime package, offset by it being absent from the initial load. Only a user who exports pays for it.
- The layout engine (`features/export/pdf-document.js`) is written against a small drawing surface (`splitTextToSize`, `text`, `rect`, `roundedRect`, `circle`, `addPage`), which keeps it unit-testable against a stub document and would keep a future library swap tractable.
- A fetch failure for either font degrades to jsPDF's built-in Helvetica rather than failing the export.
- The `.ttf` files were generated once from the shipped `.woff2` files with `fonttools` and committed. No conversion script lives in `scripts/`, which carries a 100 % coverage requirement.
- Message bodies can end up inside the downloaded file by explicit opt-in. Consistent with [ADR-004](004-opt-in-telemetry-with-pii-scrubbing.md), no part of that content is ever logged, reported or sent anywhere: diagnostics from the export path carry fixed module and operation identifiers only.
