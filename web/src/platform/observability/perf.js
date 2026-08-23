/* Performance instrumentation helpers shared across insight pages. */

import { reportPerformanceMeasure } from "./telemetry.js";

/**
 * Yield one frame so a loading overlay can paint before heavy parsing.
 * @returns {Promise<void>}
 */
export function nextFrame() {
    return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
    });
}

/**
 * Mark a performance point if available.
 * @param {string} name - Mark name
 */
export function markPerformance(name) {
    // Keep the guard for environments without the Performance API.
    /* v8 ignore next 3 */
    if (typeof performance === "undefined" || typeof performance.mark !== "function") {
        return;
    }
    performance.mark(name);
}

/**
 * Measure a performance range if available.
 * @param {string} name - Measure name
 * @param {string} start - Start mark
 * @param {string} end - End mark
 */
export function measurePerformance(name, start, end) {
    // Keep the guard for environments without the Performance API.
    /* v8 ignore next 3 */
    if (typeof performance === "undefined" || typeof performance.measure !== "function") {
        return;
    }
    try {
        performance.measure(name, start, end);

        // Keep the guard for partial Performance API implementations.
        /* v8 ignore next 3 */
        if (typeof performance.getEntriesByName !== "function") {
            return;
        }

        const entries = performance.getEntriesByName(name);
        const lastEntry = entries.length ? entries[entries.length - 1] : null;
        if (
            !lastEntry ||
            lastEntry.entryType !== "measure" ||
            !Number.isFinite(lastEntry.duration)
        ) {
            return;
        }

        reportPerformanceMeasure(name, lastEntry.duration);
    } catch {
        // Ignore missing marks to keep instrumentation resilient.
    }
}
