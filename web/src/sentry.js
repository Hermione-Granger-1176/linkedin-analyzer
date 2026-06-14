import * as Sentry from "@sentry/browser";

let sentryReady = false;
const TELEMETRY_CONSENT_STORAGE_KEY = "linkedin-analyzer:telemetry-consent";
const NOISY_EVENT_PATTERNS = [
    /ResizeObserver loop limit exceeded/i,
    /ResizeObserver loop completed with undelivered notifications/i,
    /chrome-extension:\/\//i,
    /moz-extension:\/\//i,
    /safari-extension:\/\//i,
    /Non-Error promise rejection captured/i,
];
// Breadcrumb categories that can capture user-entered content or arbitrary DOM
// text. Dropped before they reach Sentry because this app processes private
// LinkedIn data and breadcrumbs are not needed to triage runtime errors.
const SENSITIVE_BREADCRUMB_CATEGORIES = new Set(["console", "ui.input", "ui.click"]);
const MAX_BREADCRUMBS = 20;

// Buffered metric datapoints for the current page lifecycle. Each entry holds the
// latest numeric value and how many times the metric was recorded. The buffer is
// flushed as a single "session-metrics" event on visibility loss so Sentry quota
// is spent once per session instead of once per web-vital/perf measure.
let metricBuffer = new Map();
let flushListenersAttached = false;

/**
 * Check whether a context key can identify a local uploaded file.
 * @param {string} key
 * @returns {boolean}
 */
function isSensitiveContextKey(key) {
    return key.replace(/[^a-z]/gi, "").toLowerCase().includes("filename");
}

/**
 * Add non-sensitive context values to a Sentry scope.
 * @param {object} scope
 * @param {object} context
 */
function setContextExtras(scope, context) {
    Object.entries(context).forEach(([key, value]) => {
        if (!isSensitiveContextKey(key)) {
            scope.setExtra(key, value === undefined ? null : value);
        }
    });
}

/**
 * Redact local filenames from captured error messages and stacks.
 * @param {unknown} error
 * @param {object|undefined} context
 * @returns {unknown}
 */
function sanitizeCapturedError(error, context) {
    if (!(error instanceof Error) || !context) {
        return error;
    }

    const sensitiveValues = Object.entries(context)
        .filter(([key, value]) => isSensitiveContextKey(key) && typeof value === "string" && value)
        .map(([, value]) => value);
    if (!sensitiveValues.length) {
        return error;
    }

    const redact = (text) =>
        sensitiveValues.reduce((sanitized, value) => sanitized.replaceAll(value, "[file]"), text);
    const sanitizedMessage = redact(error.message);
    const sanitizedStack = typeof error.stack === "string" ? redact(error.stack) : undefined;
    if (sanitizedMessage === error.message && sanitizedStack === error.stack) {
        return error;
    }

    const sanitizedError = new Error(sanitizedMessage);
    sanitizedError.name = typeof error.name === "string" ? error.name : "Error";
    if (sanitizedStack) {
        sanitizedError.stack = sanitizedStack;
    }
    return sanitizedError;
}

/**
 * Resolve a release tag for Sentry events.
 * @returns {string|undefined}
 */
function resolveRelease() {
    const release = import.meta.env.VITE_APP_RELEASE;
    if (typeof release !== "string") {
        return undefined;
    }
    const normalized = release.trim();
    return normalized || undefined;
}

/**
 * Check whether an event should be dropped as known browser noise.
 * @param {object} event
 * @returns {boolean}
 */
function isNoisyEvent(event) {
    if (!event || typeof event !== "object") {
        return false;
    }

    const exceptionValues =
        event.exception && Array.isArray(event.exception.values) ? event.exception.values : [];
    const messages = [
        event.message,
        ...exceptionValues.map((value) => value && value.value),
    ].filter((value) => typeof value === "string");

    if (messages.some((message) => NOISY_EVENT_PATTERNS.some((pattern) => pattern.test(message)))) {
        return true;
    }

    for (const value of exceptionValues) {
        const frames =
            value && value.stacktrace && Array.isArray(value.stacktrace.frames)
                ? value.stacktrace.frames
                : [];
        for (const frame of frames) {
            const filename = frame && typeof frame.filename === "string" ? frame.filename : "";
            if (NOISY_EVENT_PATTERNS.some((pattern) => pattern.test(filename))) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Drop or sanitize breadcrumbs that could carry user data before they are stored.
 * @param {object} breadcrumb
 * @returns {object|null}
 */
function scrubBreadcrumb(breadcrumb) {
    if (!breadcrumb || typeof breadcrumb !== "object") {
        return null;
    }

    if (SENSITIVE_BREADCRUMB_CATEGORIES.has(breadcrumb.category)) {
        return null;
    }

    // DOM breadcrumbs include serialized element text; keep the event type but
    // drop the message so user-entered content is never transmitted.
    if (breadcrumb.category === "ui" || breadcrumb.category === "dom") {
        return { ...breadcrumb, message: undefined };
    }

    return breadcrumb;
}

/** Initialize Sentry when DSN is configured and telemetry consent is granted. */
export function initSentry() {
    const dsn = import.meta.env.VITE_SENTRY_DSN;
    if (!dsn || !hasTelemetryConsent()) {
        sentryReady = false;
        return;
    }
    Sentry.init({
        dsn,
        /* v8 ignore next */
        environment: import.meta.env.MODE || "development",
        release: resolveRelease(),
        sendDefaultPii: false,
        maxBreadcrumbs: MAX_BREADCRUMBS,
        beforeSend(event) {
            return isNoisyEvent(event) ? null : event;
        },
        beforeBreadcrumb(breadcrumb) {
            return scrubBreadcrumb(breadcrumb);
        },
    });
    sentryReady = true;
    attachMetricFlushListeners();
}

/**
 * Attach one-time listeners that flush buffered metrics when the page is
 * backgrounded or unloaded. Registered once even if Sentry re-initializes.
 */
function attachMetricFlushListeners() {
    if (flushListenersAttached) {
        return;
    }
    flushListenersAttached = true;
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            flushMetrics();
        }
    });
    window.addEventListener("pagehide", flushMetrics);
}

/**
 * Stop sending telemetry after consent is revoked at runtime. Drops any buffered
 * metrics and closes the Sentry client so later capture calls are no-ops.
 */
export function disableTelemetry() {
    sentryReady = false;
    metricBuffer = new Map();
    try {
        Sentry.close();
    } catch {
        // Ignore Sentry shutdown failures.
    }
}

function hasTelemetryConsent() {
    try {
        return window.localStorage.getItem(TELEMETRY_CONSENT_STORAGE_KEY) === "granted";
    } catch {
        return false;
    }
}

export function setTelemetryConsent(granted) {
    try {
        if (granted) {
            window.localStorage.setItem(TELEMETRY_CONSENT_STORAGE_KEY, "granted");
        } else {
            window.localStorage.removeItem(TELEMETRY_CONSENT_STORAGE_KEY);
        }
    } catch {
        return;
    }
}

export function telemetryConsentGranted() {
    return hasTelemetryConsent();
}

/**
 * Capture an error if Sentry is configured.
 * @param {unknown} error
 * @param {object} [context]
 */
export function captureError(error, context) {
    if (!sentryReady) {
        return;
    }
    try {
        const capturedError = sanitizeCapturedError(error, context);
        if (context && typeof context === "object") {
            Sentry.withScope((scope) => {
                setContextExtras(scope, context);
                Sentry.captureException(capturedError);
            });
            return;
        }
        Sentry.captureException(capturedError);
    } catch {
        // Ignore Sentry failures.
    }
}

/**
 * Buffer a lightweight numeric metric for the current session. Datapoints are
 * aggregated locally and sent as one summary event on page hide (see
 * `flushMetrics`) so each web-vital/perf measure no longer costs a Sentry event.
 * Only the numeric value is retained — any string context is intentionally
 * dropped so the summary payload can never carry user-derived text.
 * @param {string} name
 * @param {number} value
 */
export function captureMetric(name, value) {
    if (!sentryReady || typeof name !== "string" || !name) {
        return;
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
        return;
    }

    const entry = metricBuffer.get(name);
    if (entry) {
        entry.value = value;
        entry.count += 1;
    } else {
        metricBuffer.set(name, { value, count: 1 });
    }
}

/**
 * Send all buffered metrics as a single numeric-only "session-metrics" event and
 * reset the buffer. Safe to call repeatedly: a no-op when nothing is buffered.
 */
export function flushMetrics() {
    if (!sentryReady || metricBuffer.size === 0) {
        return;
    }

    // Swap the buffer out before sending so metrics recorded during/after the
    // flush start a fresh batch instead of being dropped or double-counted.
    const buffered = metricBuffer;
    metricBuffer = new Map();

    try {
        Sentry.withScope((scope) => {
            scope.setTag("telemetry.type", "session-metrics");
            scope.setLevel("info");
            for (const [name, entry] of buffered) {
                scope.setExtra(`metric:${name}`, entry.value);
                if (entry.count > 1) {
                    scope.setExtra(`metric:${name}:count`, entry.count);
                }
            }
            Sentry.captureMessage("session-metrics");
        });
    } catch {
        // Ignore Sentry failures.
    }
}
