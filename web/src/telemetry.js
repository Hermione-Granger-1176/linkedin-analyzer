import { onCLS, onFCP, onINP, onLCP, onTTFB } from "web-vitals";

import { captureError, captureMetric } from "./sentry.js";
import { PERFORMANCE_MEASURE_NAMES, WEB_VITAL_NAMES } from "./telemetry-metrics.js";

let telemetryInitialized = false;

/**
 * Capture a duration measurement in milliseconds. The value is buffered numerically;
 * the metric name carries enough context, so no string payload is attached.
 * @param {string} name
 * @param {number} durationMs
 */
export function reportPerformanceMeasure(name, durationMs) {
    if (typeof name !== "string" || !PERFORMANCE_MEASURE_NAMES.has(name)) {
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

        if (!WEB_VITAL_NAMES.has(metric.name)) {
            return;
        }

        const value = metric.value;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            return;
        }

        captureMetric(`web-vital:${metric.name}`, value);
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
