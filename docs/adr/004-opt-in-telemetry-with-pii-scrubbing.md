# ADR-004: Opt-in-only telemetry with layered PII scrubbing

**Date:** 2026-07-03 **Status:** Accepted **Deciders:** Aditya Kumar Darak

## Context

The app's core promise is that file contents stay in the user's browser. Diagnostics are still valuable for catching runtime errors and performance regressions, but any always-on telemetry, or telemetry that could carry cell contents, file names, or other personal data, would break that promise.

## Decision

Keep diagnostics off until the user explicitly opts in. With consent, send only the diagnostic fields listed below.

- The browser initializes Sentry only after consent through the telemetry banner or footer toggle. Users can revoke consent at any time. `web/src/platform/observability/telemetry.js` and `web/src/platform/observability/sentry.js` enforce this requirement.
- Before transmission, the browser rebuilds error events from a fixed schema. Allowed fields are diagnostic identifiers, normalized same-origin script paths, nonnegative integer source locations, sourcemap debug IDs, and configured environment and release metadata.
- Performance telemetry contains allowlisted nonnegative measurements and positive integer counts. The browser buffers these values and sends one numeric event when a nonempty buffer flushes on page hide. The event may include the `effects` tag with a value of `lite`, `standard`, or `rich`. [ADR-009](009-device-tiers-for-effects.md) defines these tiers.
- A later visit that detects an unfinished run may send one `processing-unfinished` event. Allowed values are the combined file-size bucket, the `navigator.deviceMemory` bucket, and whether the run processed one file or several. Memory is `unknown` when the browser does not expose it. Any disallowed value causes the browser to discard the event.
- Raw user-controlled strings are not attached. This includes file contents and names, messages, URLs and queries, DOM text, rejection values, local filesystem paths, arbitrary context, object serialization, breadcrumbs, request/user data, and SDK-added context.

## Consequences

- Without consent, the browser does not initialize Sentry or emit diagnostic events.
- Diagnostic event counts do not establish the error rate. Missing events do not establish that no errors occurred. [Monitor diagnostics](../operations.md#monitor-diagnostics) explains this limitation. Reproduce incidents locally with matching fixtures before assessing their impact.
- CSP violation reports (`/api/csp-report`) are the one signal that does not depend on consent. The collector rebuilds them from a bounded violation-metadata allowlist, strips URL queries and fragments, and never attaches uploaded file contents.
