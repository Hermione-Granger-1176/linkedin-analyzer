# ADR-013: npm override for patched minimatch

**Date:** 2026-11-12 **Status:** Proposed **Deciders:** Aditya Kumar Darak

## Context

Minimatch 10.2.6 remains in the development dependency tree through ESLint, `@eslint/config-array`, `@typescript-eslint/typescript-estree`, and `eslint-plugin-import-x`. Those copies are affected by [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), a denial of service through glob pattern amplification. Their dependency ranges exclude the patched major version.

The previous security exception documented an additional compatibility blocker: `eslint-plugin-import-x` 4.17.1 imported `makeRe`, which minimatch 11 removed. Plugin 4.18.1 accepts minimatch 11 and uses supported APIs. Upgrading the plugin makes it possible to replace the affected minimatch copies without disabling import lint rules.

## Decision

Upgrade `eslint-plugin-import-x` to `^4.18.1`, remove the minimatch advisory exception from `config/security_audit.json`, and add this range-qualified npm override:

```json
{
  "overrides": {
    "minimatch@>=7.0.0 <11.0.8": "^11.0.8"
  }
}
```

The existing glob override remains in place. Selecting minimatch 11.0.8 also updates the shared copy previously resolved to 11.0.3. The override leaves filelist's minimatch 5.1.9 unchanged because that version is outside this advisory's affected range.

## Consequences

- The affected development tools resolve minimatch 11.0.8 without an advisory exception.
- The override crosses a major version boundary for some callers. Lint, type checks, tests, and the production build must continue to pass.
- `make check-overrides` tests whether upstream dependency ranges can resolve patched versions without the override. The weekly dependency audit alerts maintainers when the override becomes unnecessary.
- Remove the minimatch override when that check reports it is unnecessary, run `make ci-web` and `make audit-node`, and mark this ADR as superseded after verification.

## Validation

- `make node-install` installs the updated lockfile successfully.
- The installed dependency tree contains minimatch 11.0.8 and filelist's unaffected 5.1.9 copy. No minimatch 10 copies remain.
- `make audit-node` passes with only the existing deepmerge exception.
- `make check-overrides` confirms that both the minimatch and glob overrides are still necessary.
- `make ci-web` passes lint, type checks, all 2,537 tests, the production build, and bundle size limits.
