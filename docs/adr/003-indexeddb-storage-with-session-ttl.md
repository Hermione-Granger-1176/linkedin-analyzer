# ADR-003: IndexedDB storage with session TTL and in-memory fallback

**Date:** 2026-07-03 **Status:** Accepted **Deciders:** Aditya Kumar Darak

## Context

The app processes uploads client-side and has no backend to persist state. Users still expect their uploaded exports and computed analytics to survive a page reload, so a purely in-memory model loses work on every refresh. Two realities complicate naive persistence:

- Some environments (private browsing, storage-partitioned or locked-down browsers) make IndexedDB unavailable or throwing. The app must stay functional without it.
- Persisting personal data on a device is a privacy risk, especially on shared or public computers, so retained data must not live forever.

## Decision

Persist raw CSV text and the analytics base in IndexedDB (`web/src/storage.js`), with an in-memory fallback that transparently takes over when IndexedDB is missing or errors. A session TTL sweep (`web/src/session.js`, `SESSION_TTL_MS = 24 * 60 * 60 * 1000`, that is 24 hours) runs on startup and clears uploads and cached analytics whose last activity is older than the TTL. Screens wait for the sweep before loading stored data, and a **Clear data** control lets the user purge immediately.

## Consequences

- Uploads and analytics survive reloads when IndexedDB is available, so users do not re-upload on every visit.
- When IndexedDB is unavailable the app degrades to an in-memory session: fully usable, but nothing persists across reloads. No hard failure.
- Retained personal data is bounded: stale data is auto-cleared after 24 hours, and users on shared machines can clear it on demand. The privacy docs call out that persistence exists until the sweep runs or the user clears it.
