# ADR-003: IndexedDB storage with session TTL and in-memory fallback

**Date:** 2026-07-03 **Status:** Accepted, storage format amended by [ADR-010](010-stream-uploads-and-store-original-files.md) **Deciders:** Aditya Kumar Darak

## Context

The app processes uploads in the browser and has no server that stores user data. Keeping uploads and analytics in memory alone would lose them on every reload. Local persistence has two constraints:

- Private browsing, storage partitioning, and browser policies can block IndexedDB or cause storage operations to fail. The app must work without IndexedDB.
- Persisting personal data on a device is a privacy risk, especially on shared or public computers, so retained data must not live forever.

## Decision

The original decision stored raw CSV text and the analytics base in IndexedDB through `web/src/platform/persistence/storage.js`. [ADR-010](010-stream-uploads-and-store-original-files.md) replaces stored text with original file bytes. When IndexedDB is unavailable or fails, storage uses an in-memory fallback.

At startup, `web/src/platform/persistence/session.js` removes uploads and cached analytics after 24 hours without activity (`SESSION_TTL_MS = 24 * 60 * 60 * 1000`). Screens wait for that cleanup before loading stored data. **Clear data** removes stored uploads and analytics immediately.

## Consequences

- Uploads and analytics survive reloads when IndexedDB is available, so users do not re-upload on every visit.
- Without IndexedDB, the app works in memory and loses session data on reload.
- Startup cleanup removes data after 24 hours without activity. Users can also remove it with **Clear data**. The privacy documentation explains that retained data remains until cleanup runs or the user clears it.
