# ADR-010: Stream uploads and store original files

**Date:** 2026-10-16 **Status:** Accepted **Deciders:** Aditya Kumar Darak

## Context

The web app read each upload into one decoded string on the page, handed that string to a worker, and stored the same string in IndexedDB. A 100 MB export therefore held several full copies of its text at once: the page's read, the copy the worker parsed, the copy it sent back for storage, and the copy every screen and export read back from storage. Each copy of decoded text costs about twice the file size in JavaScript heap, so the copies, not the analysis, set the peak memory and decided whether a phone could finish.

A worker can receive a `File` through structured cloning and stream its contents without the page first decoding the upload into one string. IndexedDB can store the original file as a `Blob`, so the app does not need to retain that decoded string for later reads. The [File API](https://www.w3.org/TR/FileAPI/#file-section) defines serialization of a `File` but does not guarantee whether the browser copies its bytes.

## Decision

- The page posts the uploaded `File` to the analytics worker, which streams and decodes it with `web/src/features/upload/read.js` and cleans rows as each chunk arrives. The worker no longer returns the text.
- `web/src/platform/persistence/storage.js` stores the original `File` as a `Blob` in the `fileBlobs` object store (database version 4). Metadata stays in `files`. Saving a file type removes its old `fileTexts` record.
- Before the first save, the app tests `Blob` storage in a temporary database with a two-second timeout. Some WebKit builds reject or never complete these writes in private sessions. The probe prevents an unanswered write from blocking subsequent saves.
- If the probe or a later `Blob` write fails, the app stores the bytes as an `ArrayBuffer`. Reading those bytes recreates a `File`.
- Saves of the same file type run in call order. Reading a file into an `ArrayBuffer` is asynchronous, so an earlier save could otherwise overwrite a later file.
- `getFile` returns a `blob`. Text records written by version 3 (`fileTexts`, or text inline in `files`) are read and wrapped as a `File`, so an upload from before the change still works inside the 24-hour session window. The next upload of that type replaces it.
- Worker requests for Messages, Connections, Insights, and the PDF export carry a CSV source: the stored `Blob`, or text from a caller that already holds it. Workers stream a `Blob` through the cleaner with `processCsvSource`, so these requests do not put the file text on the page. Only the main-thread fallbacks decode on the main thread, and they run only for small files when no worker is available. Size checks use bytes for a `Blob` and characters for text.
- The in-memory fallback storage holds the `File` reference itself.

### What changes in ADR-003

ADR-003 specified stored CSV text. The app now stores the original file bytes as a `Blob`. The session cleanup, **Clear data**, in-memory fallback, and privacy trade-off remain as ADR-003 describes them. Both cleanup operations include the `fileBlobs` store.

## Consequences

- The page no longer retains several full copies of an upload's decoded text. Later reads use the stored `Blob` instead.
- Reading a stored file is asynchronous everywhere, including the main-thread fallbacks used when Workers are unavailable. Those fallbacks keep their size ceilings and read the `Blob` only below them.
- The stored record is the file as uploaded, so a future change to decoding or cleaning applies to stored uploads too, rather than to text decoded by an older build.
- Safari has had bugs storing large `Blob` records in IndexedDB. `web/e2e/stored-upload.e2e.spec.js` stores and re-reads a 40 MB export in every Playwright project, including WebKit. Playwright's WebKit is built from WebKit sources but is not the Safari app, so a pass is evidence, not proof, for Safari and iPhones.

## Validation

- `web/tests/platform/persistence/storage.test.js` covers the version 4 records, legacy text records read as Blobs, and the text record removed on save.
- `make test-e2e` runs the stored-upload test in Chromium, Firefox, and WebKit.
- `make bench-browser size_mb=100` and `make audit-state` measure peak and retained memory. The [large-export investigation](../large-export-investigation.md) records the October 2026 results.
