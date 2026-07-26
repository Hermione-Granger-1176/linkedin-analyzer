# ADR-007: npm override forcing brace-expansion off the unpatched 2.x line

**Date:** 2026-07-25 **Status:** Accepted **Deciders:** Aditya Kumar Darak

## Context

`brace-expansion` is affected by CVE-2026-14257 (GHSA-mh99-v99m-4gvg, high, CVSS 7.5). Its `expand()` bounds the number of results but not their length, so chained brace groups keep the result count under the limit while each result grows exponentially. Roughly 7.5 KB of input is enough to crash a default Node process with an uncatchable out-of-memory error.

Every version at or below 5.0.7 is affected and the only patched release is **5.0.8**. There is no patched 2.x: 2.1.2 is the highest version that line ever received.

Bumping the direct dependency with `make lock-node-update packages="brace-expansion"` fixed the top-level copy but left a second, nested copy in place:

```
ejs
  -> jake
       -> filelist@1.0.6
            -> minimatch@5.1.9
                 -> brace-expansion@^2.0.1   (CVE-2026-14257, no fix in range)
```

`minimatch@5.1.9` pins `^2.0.1`, so no amount of relocking reaches a patched version. The whole chain is a devDependency; nothing here ships to users.

## Decision

Add a single npm override, following the pattern established in [ADR-001](001-npm-overrides-for-transitive-dependency-gaps.md):

```jsonc
"overrides": {
  "brace-expansion": "^5.0.8"
}
```

Forcing 5.0.8 across the tree is safe for the CommonJS consumers in this chain. Despite declaring `"type": "module"`, `brace-expansion@5.0.8` ships dual entry points with both `import` and `require` conditions and a `dist/commonjs/` build, so `minimatch@5.1.9` continues to `require()` it unchanged. Its `engines` field (`node: 20 || >=22`) is satisfied by this repository's floor of `^22.13.0 || >=24`. The exported surface is the same `expand()` function.

## Consequences

- `make audit-node` passes, and `make security` is green.
- The nested copy is gone; the tree now resolves a single `brace-expansion@5.0.8`.
- `make check-overrides` verifies the override is still required by removing it and re-running the audit. It reports `still needed (audit failure)` today and will report the override as removable once `minimatch` widens its constraint, at which point this ADR should be marked superseded and the entry deleted.
- Overriding by bare package name applies to every consumer in the tree, not just this chain. That is intentional: no consumer here should be on the unpatched line.
