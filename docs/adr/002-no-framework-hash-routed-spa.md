# ADR-002: No-framework hash-routed SPA

**Date:** 2026-07-03 **Status:** Superseded in part by [ADR-011](011-svelte-for-screen-views.md) (screen views may use Svelte; hash routing stands) **Deciders:** Aditya Kumar Darak

## Context

The web app (`web/`) processes LinkedIn exports entirely in the browser and keeps file contents local. It ships as static assets to Vercel (or any static host) plus one optional serverless function. Two constraints shaped the front-end choice:

- No backend renders pages, and static hosts do not rewrite arbitrary paths to `index.html`. A history-API router would need per-host rewrite configuration to survive a page reload or a shared deep link.
- A small dependency tree and bundle reduce the code that maintainers must audit for privacy and supply-chain risks.

## Decision

Build the app as a vanilla JavaScript single-page app with a small hand-written hash router (`web/src/app/router.js`) and no UI framework. Screens are plain modules that register routes like `#analytics` and read shared query params (for example `?range=3m`) from the router. Hash routing means the server only ever serves `index.html`, so deep links and reloads work on any static host without rewrite rules.

## Consequences

- The app has no framework runtime to monitor for security advisories. `make web-build-size` enforces the production bundle budget.
- The app can move between static hosts without server-side routing configuration.
- Each screen manages its DOM, state, rendering, and lifecycle manually. Unit and end-to-end tests check that behavior.
