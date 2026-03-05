import { onCLS, onFCP, onINP, onLCP, onTTFB } from "web-vitals";

import { captureError, captureMetric } from "./sentry.js";

let telemetryInitialized = false;

/**
 * Capture a duration measurement in milliseconds.
 * @param {string} name
 * @param {number} durationMs
 * @param {object} [context]
 */
export function reportPerformanceMeasure(name, durationMs, context) {
    if (typeof name !== "string" || !name) {
        return;
    }

    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
        return;
    }

    captureMetric(`perf:${name}`, durationMs, {
        unit: "ms",
        ...(context && typeof context === "object" ? context : {}),
    });
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
        const unit = name === "CLS" ? "" : "ms";

        captureMetric(`web-vital:${name}`, value, {
            unit,
            id: metric.id || null,
            rating: metric.rating || null,
            delta: Number.isFinite(metric.delta) ? metric.delta : null,
            navigationType: metric.navigationType || null,
        });
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
