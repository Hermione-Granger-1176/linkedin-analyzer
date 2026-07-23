# ADR-004: Opt-in-only telemetry with layered PII scrubbing

**Date:** 2026-07-03 **Status:** Accepted **Deciders:** Aditya Kumar Darak

## Context

The app's core promise is that file contents stay in the user's browser. Diagnostics are still valuable for catching runtime errors and performance regressions, but any always-on telemetry, or telemetry that could carry cell contents, file names, or other personal data, would break that promise.

## Decision

Keep diagnostics off until the user explicitly opts in, and scrub aggressively when they do.

- The Sentry SDK is not initialized until consent is granted through the telemetry banner or footer toggle, and consent can be revoked at any time (`web/src/telemetry.js`, `web/src/sentry.js`). Most visitors never opt in, so the default is no telemetry at all.
- Layered reduction runs before anything leaves the browser. Error events are rebuilt from a strict schema containing fixed diagnostic identifiers, normalized same-origin JavaScript or service-worker pathnames, nonnegative integer line and column locations, sourcemap debug IDs, and configured environment/release metadata. Performance telemetry is limited to allowlisted nonnegative numeric measures and positive integer counts, buffered and sent as one numeric event each time a nonempty buffer is flushed on page hide.
- Raw user-controlled strings are not attached. This includes file contents and names, messages, URLs and queries, DOM text, rejection values, local filesystem paths, arbitrary context, object serialization, breadcrumbs, request/user data, and SDK-added context.

## Consequences

- Privacy is preserved by default and by construction: with no consent there is no SDK and no events.
- Error visibility is a lower bound, not a true rate. This blind spot is documented in `docs/operations.md` (Observability blind spot): the absence of events does not mean the absence of errors, and incident severity should not be sized from event counts. Prefer local reproduction with a matching fixture.
- CSP violation reports (`/api/csp-report`) are the one signal that does not depend on consent, since they carry only violation metadata and never file contents.
