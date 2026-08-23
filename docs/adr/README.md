# Architecture decision records

These records preserve the reasoning behind choices that affect the repository's architecture, privacy boundary, dependency policy, and release process. They are historical records. Update the current product, development, or operations guide when a decision changes user or maintainer behavior.

## Records

- [ADR-001: npm overrides for transitive dependency gaps](001-npm-overrides-for-transitive-dependency-gaps.md)
- [ADR-002: No-framework hash-routed SPA](002-no-framework-hash-routed-spa.md)
- [ADR-003: IndexedDB storage with session TTL and in-memory fallback](003-indexeddb-storage-with-session-ttl.md)
- [ADR-004: Opt-in-only telemetry with layered PII scrubbing](004-opt-in-telemetry-with-pii-scrubbing.md)
- [ADR-005: Dual-runtime cleaner with parity fixtures](005-dual-runtime-cleaner-with-parity-fixtures.md)
- [ADR-006: hatch-vcs tag-driven versioning and CI-gated trusted publishing](006-hatch-vcs-versioning-and-gated-publishing.md)
- [ADR-007: npm override for the unpatched brace-expansion 2.x line](007-brace-expansion-override-for-unpatched-2x-line.md)
- [ADR-008: jsPDF for the Save as PDF export](008-jspdf-for-the-save-as-pdf-export.md)

When adding a record, use the next number, keep the file name descriptive, and link it from this page. Use the existing sections for context, decision, consequences, and validation when they apply.
