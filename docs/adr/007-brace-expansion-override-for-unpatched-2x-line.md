# ADR-007: npm override for the unpatched brace-expansion 2.x line

**Date:** 2026-07-26 **Status:** Accepted **Deciders:** Aditya Kumar Darak

## Context

`brace-expansion` is affected by CVE-2026-14257 (GHSA-mh99-v99m-4gvg, high, CVSS 7.5). Its `expand()` function bounds the number of results but not their length. Chained brace groups can therefore keep the result count under the limit while making each result grow until the Node process exhausts memory.

Every version at or below 5.0.7 is affected. The patched release is 5.0.8. There is no patched 2.x release.

The dependency tree contains both a 5.0.7 copy and this nested dependency path:

```text
vite-plugin-pwa
  -> workbox-build
       -> @trickfilm400/rollup-plugin-off-main-thread
            -> ejs
                 -> jake
                      -> filelist
                           -> minimatch@5.1.9
                                -> brace-expansion@^2.0.1
```

Relocking alone cannot move the nested copy to a patched version because `minimatch@5.1.9` requires the 2.x line. The complete chain is used only during development and builds. It is not shipped in the web bundle.

## Decision

Add a single npm override, following the pattern established in [ADR-001](001-npm-overrides-for-transitive-dependency-gaps.md):

```json
"overrides": {
  "brace-expansion": "^5.0.8"
}
```

Forcing 5.0.8 across the dependency tree is compatible with the repository's consumers. The package provides both import and CommonJS entry points, retains the same `expand()` surface, and supports this repository's Node versions.

## Consequences

- `make audit-node` and `make security` pass without suppressing the advisory.
- The dependency tree resolves a single patched `brace-expansion` version.
- `make check-overrides` verifies that the override remains necessary by testing the tree without it.
- The override applies to every consumer in the tree. This is intentional because no consumer should resolve an affected version.
- Once upstream dependency ranges accept a patched release, remove the override and mark this ADR as superseded.
