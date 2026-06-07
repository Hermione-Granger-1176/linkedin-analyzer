# ADR-001: npm overrides for transitive dependency gaps

**Date:** 2026-04-01 **Status:** Superseded **Resolved:** 2026-06-06 **Deciders:** Aditya Kumar Darak

This decision is superseded because both upstream dependency gaps have been resolved and the temporary overrides have been removed. The generic override checker remains available for any future overrides.

## Context

When upgrading major devDependencies (eslint 10, jsdom 29, typescript 6, vite 8) in PR #42, two transitive-dependency issues blocked `npm install`:

1. **vite-plugin-pwa 1.2.0** declares `peerDependencies.vite` as `^3.1.0 || ^4.0.0 || ^5.0.0 || ^6.0.0 || ^7.0.0` and has not yet added `^8.0.0`, even though the plugin works correctly with vite 8 in production ([vite-pwa/vite-plugin-pwa#918]).

2. **workbox-build 7.4.0** (a dependency of vite-plugin-pwa) pulls in `@rollup/plugin-terser@0.4.4`, which depends on `serialize-javascript@^6.0.1`. That range is vulnerable to **CVE-2026-34043** (CPU-exhaustion DoS via crafted array-like objects). The fix requires `serialize-javascript >= 7.0.5`. A newer `@rollup/plugin-terser@1.0.0` already depends on `serialize-javascript@^7.0.3`, but `workbox-build` has not updated its constraint yet.

The full vulnerable chain:

```
vite-plugin-pwa@1.2.0
  -> workbox-build@7.4.0
       -> @rollup/plugin-terser@0.4.4
            -> serialize-javascript@^6.0.1   (CVE-2026-34043)
```

## Options considered

### Option A: npm overrides (chosen)

Add two entries to `package.json` overrides:

```jsonc
"overrides": {
  "serialize-javascript": "^7.0.5",
  "vite-plugin-pwa": { "vite": "$vite" }
}
```

**Pros:**

- npm's built-in, first-class mechanism for exactly this use case.
- Zero code changes; same runtime behavior.
- Fixes the CVE and the peer-dep conflict immediately.
- Removable the day upstream publishes a fix (one-line deletion each).
- Already used in this project for the same `serialize-javascript` issue.

**Cons:**

- Overrides must be reviewed when upstream packages release new versions.
- Easy to forget they exist if not documented (this ADR addresses that).

### Option B: Replace vite-plugin-pwa with a custom Vite plugin

Write ~50 lines of custom code that builds the service worker and injects the precache manifest.

**Pros:**

- Removes the entire vulnerable transitive chain.
- No overrides needed.

**Cons:**

- We own the code; nobody else audits it.
- Must be maintained when Vite's plugin API or workbox module structure changes.
- Loses community-maintained edge-case handling.
- Higher long-term maintenance burden for a temporary upstream gap.

### Option C: Fork vite-plugin-pwa

Fork the repo, update the peer dep, install from our fork.

**Pros:**

- Fixes the peer dep issue at the source.

**Cons:**

- Git-based npm dependencies are fragile (build from source required).
- Must track upstream and rebase our fork.
- More moving parts than an override for the same result.

### Option D: Defer vite 8 upgrade

Keep vite at v7 in this PR; bump only eslint, jsdom, and typescript.

**Pros:**

- No workarounds needed for the peer dep issue.

**Cons:**

- Does not fix the serialize-javascript CVE (still in the tree via vite-plugin-pwa).
- Delays adoption of vite 8.

## Decision

**Option A: npm overrides.**

The overrides were temporary bridges while upstream caught up. They required zero code changes, fixed the security vulnerability, and carried the lowest maintenance burden.

## Resolution

Both removal conditions are now satisfied:

- `vite-plugin-pwa` 1.3.0 supports Vite 8.
- `workbox-build` 7.4.1 uses `@rollup/plugin-terser` 1.0.0, which resolves `serialize-javascript` 7.0.5.

## Consequences

- `package.json` no longer contains an `overrides` field.
- `make check-overrides` exits successfully when no overrides are configured and remains available as a generic policy check.
- Future overrides require their own documented rationale and removal criteria.

[vite-pwa/vite-plugin-pwa#918]: https://github.com/vite-pwa/vite-plugin-pwa/issues/918
