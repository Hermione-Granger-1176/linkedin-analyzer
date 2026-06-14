import { onCLS, onFCP, onINP, onLCP, onTTFB } from "web-vitals";

import { captureError, captureMetric } from "./sentry.js";

let telemetryInitialized = false;

/**
 * Capture a duration measurement in milliseconds. The value is buffered numerically;
 * the metric name carries enough context, so no string payload is attached.
 * @param {string} name
 * @param {number} durationMs
 */
export function reportPerformanceMeasure(name, durationMs) {
    if (typeof name !== "string" || !name) {
        return;
    }

    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
        return;
    }

    captureMetric(`perf:${name}`, durationMs);
}

/**
 * Start web-vitals reporting once per page lifecycle.
 */
export function initTelemetry() {
    if (telemetryInitialized) {
        return;
    }
    telemetryInitialized = true;

    const reportWebVital = (metric) => {
        if (!metric || typeof metric !== "object") {
            return;
        }

        const value = Number(metric.value);
        if (!Number.isFinite(value)) {
            return;
        }

        const name = metric.name || "unknown";
        captureMetric(`web-vital:${name}`, value);
    };

    try {
        onCLS(reportWebVital);
        onINP(reportWebVital);
        onLCP(reportWebVital);
        onFCP(reportWebVital);
        onTTFB(reportWebVital);
    } catch (error) {
        captureError(error, {
            module: "telemetry",
            operation: "init-web-vitals",
        });
    }
}
