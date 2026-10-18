# ADR-010: Stream uploads and store original files

**Date:** 2026-10-16 **Status:** Accepted **Deciders:** Aditya Kumar Darak

## Context

The web app read each upload into one decoded string on the page, handed that string to a worker, and stored the same string in IndexedDB. A 100 MB export therefore held several full copies of its text at once: the page's read, the copy the worker parsed, the copy it sent back for storage, and the copy every screen and export read back from storage. Each copy of decoded text costs about twice the file size in JavaScript heap, so the copies, not the analysis, set the peak memory and decided whether a phone could finish.

A `File` is a reference to bytes the browser already holds. Posting it to a worker clones the reference, not the bytes, and a stored `Blob` lives in the browser's storage rather than in JavaScript heap. A worker can stream either one.

## Decision

- The page posts the uploaded `File` to the analytics worker, which streams and decodes it with `web/src/features/upload/read.js` and cleans rows as each chunk arrives. The worker no longer returns the text.
- `web/src/platform/persistence/storage.js` stores the original `File` as a `Blob` in a `fileBlobs` object store (database version 4), next to the metadata record in `files`. Saving a type removes its old `fileTexts` record. WebKit can refuse a `Blob` in IndexedDB in an ephemeral session, such as a Safari private window or a Playwright context, and some builds never answer that write at all, which would also hold up every later write to the store. So the first save of a session writes a small `Blob` to a separate throwaway database and reads it back, giving up after two seconds. When that probe fails, or a `Blob` write fails later, the record stores the file's bytes as an `ArrayBuffer`, and reading it wraps them back into a `File`. Saves of one type are applied in call order, because the `ArrayBuffer` path awaits each file's read before writing, and a later file in the same drop could otherwise be overwritten by an earlier one whose read finished last.
- `getFile` returns a `blob`. Text records written by version 3 (`fileTexts`, or text inline in `files`) are read and wrapped as a `File`, so an upload from before the change still works inside the 24-hour session window. The next upload of that type replaces it.
- Worker requests for Messages, Connections, Insights, and the PDF export carry a CSV source: the stored `Blob`, or text from a caller that already holds it. Workers stream a `Blob` through the cleaner with `processCsvSource`, so these requests do not put the file text on the page. Only the main-thread fallbacks decode on the main thread, and they run only for small files when no worker is available. Size checks use bytes for a `Blob` and characters for text.
- The in-memory fallback storage holds the `File` reference itself.

### What changes in ADR-003

ADR-003 said the app persists raw CSV text. It now persists the original file bytes as a `Blob`. The session TTL sweep, the **Clear data** control, the in-memory fallback, and the privacy trade-off stay as ADR-003 describes them; **Clear data** and the sweep clear the `fileBlobs` store along with the others.

## Consequences

- The page's share of a 100 MB upload drops from several copies of the text to none, and stored data costs browser storage rather than JavaScript heap.
- Reading a stored file is asynchronous everywhere, including the main-thread fallbacks used when Workers are unavailable. Those fallbacks keep their size ceilings and read the `Blob` only below them.
- The stored record is the file as uploaded, so a future change to decoding or cleaning applies to stored uploads too, rather than to text decoded by an older build.
- Safari has had bugs storing large `Blob` records in IndexedDB. `web/e2e/stored-upload.e2e.spec.js` stores and re-reads a 40 MB export in every Playwright project, including WebKit. Playwright's WebKit is built from WebKit sources but is not the Safari app, so a pass is evidence, not proof, for Safari and iPhones.

## Validation

- `web/tests/platform/persistence/storage.test.js` covers the version 4 records, legacy text records read as Blobs, and the text record removed on save.
- `make test-e2e` runs the stored-upload test in Chromium, Firefox, and WebKit.
- `make bench-browser size_mb=100` and `make audit-state` measure the peak and retained memory recorded in [testing](../testing.md).
