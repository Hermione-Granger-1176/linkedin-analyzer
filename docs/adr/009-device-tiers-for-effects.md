# ADR-009: Device tiers for effects

**Date:** 2026-10-16 **Status:** Proposed **Deciders:** Aditya Kumar Darak

## Context

Animations, dashed strokes, and blurred overlays can make devices with limited CPU or graphics resources stutter. If each visual feature checks the device separately, the app repeats probes and can choose inconsistent effects. A shared effects tier keeps those choices consistent without affecting file processing.

## Decision

One module, `web/src/platform/device/capabilities.js`, reads the device signals once, picks an effects tier, and caches the result. Every visual feature reads its tier from there.

The module reads the following signals. A signal the browser does not expose remains unknown.

- `navigator.hardwareConcurrency` for CPU cores.
- `navigator.deviceMemory` for approximate RAM. Only Chromium browsers expose it.
- `navigator.connection.saveData` for the data-saver setting.
- `matchMedia("(pointer: coarse)")` for touch-first devices.
- Accelerated WebGL: a `webgl2` context, falling back to `webgl`, requested with `failIfMajorPerformanceCaveat: true` and released at once with `WEBGL_lose_context`. A refusal means software rendering, a blocklisted driver, WebGL turned off, or no GPU, and reads as "accelerated WebGL unavailable", not "no GPU".

Tiers and thresholds:

| Tier       | Picked when                                                                             | Effects                                                                       |
| ---------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `lite`     | Save-Data is on, or memory is known and 2 GB or less, or cores are known and 2 or fewer | Static or `transform` and `opacity` moves only. No blur, no filters, no WebGL |
| `standard` | Anything else                                                                           | Full CSS and SVG animation                                                    |
| `rich`     | Accelerated WebGL, memory unknown or at least 8 GB, and at least 8 known cores          | Everything in `standard`, plus future canvas or WebGL scenes                  |

Rules every feature follows:

- `lite` is complete. Every number, chart, list, export, and control works in it. Higher tiers add motion and decoration, never information or function.
- The tier never changes processing. Heavy work stays in workers on every tier. Nothing in the processing path reads the tier, so Save-Data or reduced motion cannot change how files are handled. The raw signals stay in the profile so a future processing decision can read them directly.
- `prefers-reduced-motion: reduce` takes precedence over the tier.
- There is no visitor override. An earlier **Auto**, **Lite**, and **Full** toggle was removed: the device signals and the jank downgrade decide, and a stored `linkedin-analyzer-effects` value from that toggle is removed on load.
- The WebGL probe runs only when its result can change the tier. If CPU or memory signals already rule out `rich`, the app skips the probe.
- Repeated long animation frames while the page is otherwise idle drop the session one tier. The app never upgrades automatically.
- The page starts with `lite` effects and selects its tier after reading the device profile. The CSP forbids inline scripts, so the app cannot choose a tier before module scripts run. Starting with `lite` avoids expensive effects before that choice.
- Stylesheets gate expensive effects on the root attribute, for example `:root[data-effects="lite"] .pip-trail { animation: none; }`.
- With telemetry consent, the tier in use is sent as one allowlisted `effects` tag on the session metrics event.

## Consequences

- The app probes device capabilities once per page and defines the thresholds in one module.
- Fast devices start their decoration a moment after first paint instead of with it.
- The thresholds are a starting point. Desktop Chromium's CPU throttling slows only the page's main thread, not workers, so tuning them against throttled runs measures decoration cost, not processing cost.
- Future visual stages (characters, Rive, 3D) read the tier from this module and must ship a `lite` fallback that carries the same information.

## Validation

- `web/tests/platform/device/capabilities.test.js` covers every branch of the tier mapping, including every signal missing, that a device that cannot reach Rich skips the WebGL probe, and that Save-Data leaves the processing signals unchanged.
- `web/e2e/effects-tier.e2e.spec.js` checks that a Chromium run with `--disable-gpu` gets no higher than `standard`, and that Save-Data gets `lite`, creates no WebGL context, and runs no animation other than `transform` or `opacity` and no CSS or SVG filter.
