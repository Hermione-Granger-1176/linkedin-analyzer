/* Performance instrumentation helpers shared across insight pages. */

import { reportPerformanceMeasure } from "./telemetry.js";

/**
 * Resolves after the next animation frame.
 * @returns {Promise<void>}
 */
export function nextFrame() {
    return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
    });
}

/**
 * Mark a performance point.
 * @param {string} name - Mark name
 */
export function markPerformance(name) {
    performance.mark(name);
}

/**
 * Measure a performance range and report it.
 * @param {string} name - Measure name
 * @param {string} start - Start mark
 * @param {string} end - End mark
 */
export function measurePerformance(name, start, end) {
    try {
        performance.measure(name, start, end);
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
        // Missing marks are ignored.
    }
}

/**
 * Mark the start of a performance span.
 * @param {string} name - Span name; its marks are `${name}:start` and `${name}:end`
 * @returns {() => void} Call to mark the end and record the measure
 */
export function startPerformanceSpan(name) {
    const start = `${name}:start`;
    const end = `${name}:end`;
    markPerformance(start);
    return () => {
        markPerformance(end);
        measurePerformance(name, start, end);
    };
}
