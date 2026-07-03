# ADR-002: No-framework hash-routed SPA

**Date:** 2026-07-03 **Status:** Accepted **Deciders:** Aditya Kumar Darak

## Context

The web app (`web/`) processes LinkedIn exports entirely in the browser and keeps file contents local. It ships as static assets to Vercel (or any static host) plus one optional serverless function. Two constraints shaped the front-end choice:

- No backend renders pages, and static hosts do not rewrite arbitrary paths to `index.html`. A history-API router would need per-host rewrite configuration to survive a page reload or a shared deep link.
- The privacy and supply-chain posture favors a minimal dependency tree and a small bundle that a person can audit, rather than a large framework runtime.

## Decision

Build the app as a vanilla JavaScript single-page app with a small hand-written hash router (`web/src/router.js`) and no UI framework. Screens are plain modules that register routes like `#analytics` and read shared query params (for example `?range=3m`) from the router. Hash routing means the server only ever serves `index.html`, so deep links and reloads work on any static host without rewrite rules.

## Consequences

- The dependency surface stays small: no framework runtime to track for security advisories, and the production bundle stays within the enforced size budget (`make web-build-size`).
- Deployment is trivially portable across static hosts because there are no server-side routing requirements.
- The cost is manual DOM and state management. Each screen owns its rendering and lifecycle, and there is no framework ecosystem to lean on. This is acceptable for an app of this size and is offset by strong unit and end-to-end test coverage.
