# ADR-009: Device tiers for effects

**Date:** 2026-10-16 **Status:** Proposed **Deciders:** Aditya Kumar Darak

## Context

The web app's decoration (Pip's moves, dashed strokes, blurred overlays, and later characters, Rive, or 3D) costs nothing on a fast laptop and can make a low-end phone or a PC without hardware-accelerated graphics stutter. Each visual feature guessing at the device on its own would give inconsistent results and duplicate probes. The app needs one answer to "how much decoration can this device carry", and that answer must never change what the app computes.

## Decision

One module, `web/src/platform/device/capabilities.js`, reads the device signals once, picks an effects tier, and caches the result. Every visual feature reads its tier from there.

Signals, each read as unknown when the browser does not expose it, never as low:

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
- The tier never changes processing. Heavy work stays in workers on every tier. Processing decisions read the raw signals (`deviceMemory` above all), never the tier, so Save-Data, a jank downgrade, or reduced motion cannot change how many files process at once.
- `prefers-reduced-motion: reduce` always wins over the tier.
- There is no visitor override. An earlier **Auto**, **Lite**, and **Full** toggle was removed: the device signals and the jank downgrade decide, and a stored `linkedin-analyzer-effects` value from that toggle is removed on load.
- The WebGL probe runs only when its answer can change the tier, so a device the cheaper signals put on `lite` never creates a WebGL context.
- Under **Auto**, repeated long animation frames while the page is otherwise idle drop the session one tier. The app never upgrades automatically and never downgrades an explicit choice.
- The page ships marked `lite` and upgrades once the profile is known. The CSP forbids inline scripts and module scripts run after first paint, so starting low is how the page avoids painting heavy effects on a device that cannot carry them.
- Stylesheets gate expensive effects on the root attribute, for example `:root[data-effects="lite"] .pip-trail { animation: none; }`.
- With telemetry consent, the tier in use is sent as one allowlisted `effects` tag on the session metrics event.

## Consequences

- One probe per page, and one place to tune thresholds.
- Fast devices start their decoration a moment after first paint instead of with it.
- The thresholds are a starting point. Desktop Chromium's CPU throttling slows only the page's main thread, not workers, so tuning them against throttled runs measures decoration cost, not processing cost.
- Future visual stages (characters, Rive, 3D) read the tier from this module and must ship a `lite` fallback that carries the same information.

## Validation

- `web/tests/platform/device/capabilities.test.js` covers every branch of the tier mapping, including every signal missing, that a `lite` device skips the WebGL probe, and that Save-Data leaves the processing signals unchanged.
- `web/e2e/effects-tier.e2e.spec.js` checks that a Chromium run with `--disable-gpu` gets no higher than `standard`, and that Save-Data gets `lite`, creates no WebGL context, and runs no animation other than `transform` or `opacity`.
