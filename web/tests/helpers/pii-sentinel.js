/**
 * Sentinel helpers for the "no PII reaches telemetry" tests.
 *
 * piiError builds an error whose message and properties contain PII_MARKER.
 * expectFixedError asserts that the value reaching `captureError` is a new
 * error with no PII_MARKER in its message, stack, or properties.
 */

import { expect } from "vitest";

/** Text that must never appear in anything handed to captureError. */
export const PII_MARKER = "SENTINEL-PII-DO-NOT-REPORT";

/**
 * Build an error carrying the sentinel in its message and in a custom property.
 * @param {string} [label] - Extra context for the message
 * @returns {Error} Error that must never cross the telemetry boundary
 */
export function piiError(label = "parse") {
    const error = new Error(`${label} failed for "meet me at 5" ${PII_MARKER}`);
    error.row = { FROM: `Ada ${PII_MARKER}`, CONTENT: PII_MARKER };
    return error;
}

/**
 * Assert a reported value is a freshly built error with no sentinel anywhere.
 * @param {unknown} reported - First argument captureError received
 * @param {Error} original - Error the code under test caught
 */
export function expectFixedError(reported, original) {
    expect(reported).toBeInstanceOf(Error);
    expect(reported).not.toBe(original);
    const surface = JSON.stringify([
        reported.message,
        reported.stack || "",
        Object.entries(reported),
    ]);
    expect(surface).not.toContain(PII_MARKER);
}
