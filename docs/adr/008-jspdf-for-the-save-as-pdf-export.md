# ADR-008: jsPDF for the Save as PDF export

**Date:** 2026-07-31 **Status:** Accepted **Deciders:** Aditya Kumar Darak

## Context

The web app needed a **Save as PDF** button: an A4 document of the user's insights, drawn in the app's warm light palette regardless of the current theme, and containing more than the screen shows. On top of the insight cards, the pro tip and the all-time stats, it can carry the last 5 messages of the 10 most recently messaged contacts in full, behind an opt-in confirmation.

Message length determines the layout requirements. A single message may exceed one page, so the exporter needs text measurement, wrapping, and pagination to split it across pages.

[ADR-002](002-no-framework-hash-routed-spa.md) favors a small dependency tree. Adding a runtime dependency therefore requires a recorded reason.

Three options were considered.

**`window.print()` with an `@media print` stylesheet.** Rejected because the report contains data absent from the screen. The Insights screen originally rendered six cards and held no message text (`MessagesAnalytics.buildMessageState` discards `CONTENT`). Printing would require a separate hidden document. Browsers would control pagination, page numbering, and the file name, making consistent output harder to test across engines.

**`pdf-lib`.** Rejected because it did not meet the text measurement and wrapping requirements of this implementation. Message threads would require separate line-breaking and font-metric handling.

**`jspdf`.** Provides `splitTextToSize`, `getTextWidth`, TrueType embedding through `addFileToVFS`/`addFont`, and deterministic A4 output as a `Blob`. It is the only one of the three that answers the wrapping requirement directly.

## Decision

Add `jspdf` as a runtime dependency and load it with a dynamic `import()`, following the pattern `features/cleaning/excel.js` already uses for `write-excel-file`.

Three constraints go with it:

1. **It never enters the initial bundle.** The `import("jspdf")` sits inside the export orchestrator, so Vite emits it as its own chunk. A `size-limit` budget guards the chunk, and the index budget guards against it leaking into the entry.
2. **Colors are read from the stylesheet, never copied into JavaScript.** The light palette selector in `foundations/variables.css` was widened from `:root` to `:root, [data-theme="light"], .theme-light` (a pure selector addition; no token values changed). At export time a detached `.theme-light` element is mounted and the tokens are read back with `getComputedStyle`. The document is light by construction and cannot drift from the site palette.
3. **Fonts load at export time.** `PatrickHand-Regular.ttf` and `Caveat-Regular.ttf` ship next to the `.woff2` files in `web/public/fonts/`. Both include SIL OFL licences. Fetching the fonts during export keeps them out of JavaScript bundles and the initial page download.

The library choice also affects icons and thread selection:

- **Icons become accent-coloured left rules and roundels.** jsPDF cannot draw SVG without `svg2pdf.js`; a second dependency is not worth the insight-card icons.
- **Thread selection gets its own worker.** `messages-worker.js` has a tight size budget and a contract the Messages screen depends on, so `features/export/threads-worker.js` is separate.

## Consequences

- The app adds one runtime package that loads only during export.
- The layout engine (`features/export/pdf-document.js`) uses `splitTextToSize`, `text`, `rect`, `roundedRect`, `circle`, and `addPage`. Tests can supply a stub document with those methods. A replacement library would need to support the same drawing operations.
- A fetch failure for either font degrades to jsPDF's built-in Helvetica rather than failing the export.
- The `.ttf` files were generated once from the shipped `.woff2` files with `fonttools` and committed. No conversion script lives in `scripts/`, which carries a 100% coverage requirement.
- Without Web Workers, small exports select threads on the main thread. Larger exports omit the message section to avoid freezing the page. The original fallback limit was 5 MB.
- A parse failure attributed to a request prevents a main-thread retry. An id-zero failure occurs before or outside request processing and permits the small-file fallback, because it does not establish whether the file can be parsed.
- Message bodies can end up inside the downloaded file by explicit opt-in. Consistent with [ADR-004](004-opt-in-telemetry-with-pii-scrubbing.md), no part of that content is ever logged, reported or sent anywhere: diagnostics from the export path carry fixed module and operation identifiers only.
- Thread selection reads `CONTENT` verbatim. Spreadsheet formula prefixes and control-character removal do not apply to PDF message text.
- Thread selection resolves the account owner using the connections file, then conversation coverage. The owner does not appear in their own connections list. If neither check identifies one owner, the export reports `direction: "unknown"`. Reading the connections file adds one local input to the message export without sending it outside the browser.
- The export retains `LinkedIn Member` conversations and scopes each anonymous correspondent to its `CONVERSATION ID`. Analytics drops that placeholder to avoid merging unrelated people. The export keeps it so recent conversations remain in the report.
