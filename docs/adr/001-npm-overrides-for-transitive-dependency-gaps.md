# ADR-001: npm overrides for transitive dependency gaps

**Date:** 2026-04-01 **Status:** Superseded **Resolved:** 2026-06-06 **Deciders:** Aditya Kumar Darak

Upstream resolved both dependency gaps on June 6, 2026, and the project removed these temporary overrides. The generic override checker remains available for later overrides. This record describes the dependency tree at that time.

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

- npm supports overrides without a separate dependency-management tool.
- No application code changes or intended runtime changes.
- Fixes the CVE and the peer-dep conflict immediately.
- Each override can be removed once upstream dependency ranges accept a compatible fix.
- Already used in this project for the same `serialize-javascript` issue.

**Cons:**

- Overrides must be reviewed when upstream packages release new versions.
- Removal requires checking the upstream dependency ranges. This ADR records those conditions.

### Option B: Replace vite-plugin-pwa with a custom Vite plugin

Write a custom plugin that builds the service worker and injects the precache manifest.

**Pros:**

- Removes the entire vulnerable transitive chain.
- No overrides needed.

**Cons:**

- Maintainers must review and maintain the custom plugin.
- Must be maintained when Vite's plugin API or workbox module structure changes.
- Loses community-maintained edge-case handling.
- Higher long-term maintenance burden for a temporary upstream gap.

### Option C: Fork vite-plugin-pwa

Fork the repo, update the peer dep, install from our fork.

**Pros:**

- Fixes the peer dep issue at the source.

**Cons:**

- Git-based npm dependencies require building the package from source.
- Must track upstream and rebase our fork.
- Maintainers must manage the fork in addition to the dependency override policy.

### Option D: Defer vite 8 upgrade

Keep vite at v7 in this PR; bump only eslint, jsdom, and typescript.

**Pros:**

- No workarounds needed for the peer dep issue.

**Cons:**

- Does not fix the serialize-javascript CVE (still in the tree via vite-plugin-pwa).
- Delays adoption of vite 8.

## Decision

**Option A: npm overrides.**

The temporary overrides addressed the vulnerability and peer dependency conflict without application code changes. They required less maintenance than a custom plugin or fork.

## Resolution

Both removal conditions are now satisfied:

- `vite-plugin-pwa` 1.3.0 supports Vite 8.
- `workbox-build` 7.4.1 uses `@rollup/plugin-terser` 1.0.0, which resolves `serialize-javascript` 7.0.5.

## Consequences

- Removing these overrides removed the `overrides` field from `package.json` at the time of resolution.
- `make check-overrides` exits successfully when no overrides are configured and remains available as a generic policy check.
- Future overrides require their own documented rationale and removal criteria.

[vite-pwa/vite-plugin-pwa#918]: https://github.com/vite-pwa/vite-plugin-pwa/issues/918
