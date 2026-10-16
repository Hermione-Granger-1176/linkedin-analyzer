import * as Sentry from "@sentry/browser";

import { FILE_TYPES } from "../../shared/constants.js";

import { WIRE_METRIC_NAMES } from "./metrics.js";

/**
 * A stack frame reduced to its safe source location.
 * @typedef {object} ReducedFrame
 * @property {string} filename - Same-origin app script path
 * @property {number} [lineno] - Line number
 * @property {number} [colno] - Column number
 * @property {boolean} [in_app] - Whether the frame is app code
 */

/**
 * @typedef {object} ReducedException
 * @property {string} type - Built-in error name
 * @property {string} value - Fixed diagnostic ID, never the original message
 * @property {{frames: ReducedFrame[]}} [stacktrace] - Safe frames
 */

/** @typedef {{type: "sourcemap", code_file: string, debug_id: string}} ReducedDebugImage */

/**
 * The fixed-schema event that replaces every SDK event before transport.
 * @typedef {object} ReducedEvent
 * @property {import("@sentry/browser").SeverityLevel} level - Event level
 * @property {string} platform - Always "javascript"
 * @property {string} environment - Build mode
 * @property {string} [release] - Release tag
 * @property {string} [event_id] - SDK event ID
 * @property {number} [timestamp] - SDK event timestamp
 * @property {string} [message] - Fixed event message
 * @property {{values: ReducedException[]}} [exception] - Reduced exception
 * @property {Record<string, string>} [tags] - Allowlisted tags
 * @property {Record<string, number>} [extra] - Allowlisted numeric metrics
 * @property {{images: ReducedDebugImage[]}} [debug_meta] - Sourcemap debug IDs
 */

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
const DIAGNOSTIC_TAG_VALUES = Object.freeze({
    module: new Set([
        "analytics-ui",
        "app",
        "clean",
        "connections-ui",
        "data-cache",
        "insights-ui",
        "messages-insights",
        "pdf-export",
        "runtime",
        "telemetry",
        "upload",
    ]),
    operation: new Set([
        "analytics-worker-error-event",
        "analytics-worker-error-payload",
        "analytics-worker-post",
        "analytics-worker-timeout",
        "build-connections-dashboard",
        "build-messages-dashboard",
        "check-availability",
        "clear-all",
        "connections-main-thread-parse",
        "connections-message-parse",
        "connections-worker-error-event",
        "connections-worker-error-payload",
        "connections-worker-failure",
        "connections-worker-post-message",
        "connections-worker-timeout",
        "contact-keys-main-thread-parse",
        "download-without-cache",
        "excel-generate",
        "export",
        "generate",
        "global-error",
        "init-analytics-worker",
        "init-connections-worker",
        "init-messages-worker",
        "init-threads-worker",
        "init-web-vitals",
        "init-worker",
        "load-analytics",
        "load-base",
        "load-connections-file",
        "load-data",
        "load-file-metadata",
        "load-messages-file",
        "load-outreach",
        "messages-main-thread-parse",
        "messages-message-parse",
        "messages-worker-error-event",
        "messages-worker-failure",
        "messages-worker-post-message",
        "messages-worker-timeout",
        "notify-listener",
        "parse-file",
        "parse-stored-file",
        "parse-stored-file-map",
        "persist-outreach",
        "persist-processed-file",
        "prime-before-upload",
        "prime-load-text",
        "prime-post-message",
        "read-export-files",
        "read-file",
        "refresh",
        "register-fonts",
        "render-view",
        "restore-state",
        "select-threads",
        "service-worker-register",
        "session-cleanup",
        "storage-estimate",
        "storage-persist-request",
        "threads-message-parse",
        "threads-worker-error-event",
        "threads-worker-failure",
        "threads-worker-post-message",
        "threads-worker-timeout",
        "unhandled-rejection",
        "worker-error-event",
        "worker-error-payload",
        "worker-message-parse",
        "worker-post-message",
        "worker-timeout",
    ]),
    fileType: new Set(FILE_TYPES),
    expectedType: new Set(["connections", "messages"]),
    exportType: new Set(["fading-conversations", "silent-connections", "top-contacts"]),
});
// Effects tiers from web/src/platform/device/capabilities.js, sent as one tag
// on the session-metrics event.
/** @type {ReadonlySet<unknown>} */
const EFFECTS_TIER_VALUES = new Set(["lite", "standard", "rich"]);
let effectsTier = "";
// Allowlisted values for the processing-unfinished event. They match the
// buckets in run-tracker.js; anything else is dropped before transport.
const UNFINISHED_RUN_VALUES = Object.freeze({
    sizeBucket: new Set(["lt-10mb", "10-30mb", "30-60mb", "60-100mb", "gte-100mb"]),
    memoryBucket: new Set(["unknown", "le-2gb", "4gb", "ge-8gb"]),
    mode: new Set(["single", "parallel"]),
});
const ERROR_TYPES = new Set([
    "AggregateError",
    "DOMException",
    "DataCloneError",
    "Error",
    "EvalError",
    "InvalidStateError",
    "NonError",
    "QuotaExceededError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
    "URIError",
]);
const EVENT_ID_PATTERN = /^[a-f0-9]{32}$/i;
const DEBUG_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SAFE_SCRIPT_PATH_PATTERNS = [
    /^assets\/[A-Za-z0-9_./@~-]+\.(?:js|mjs)$/,
    /^src\/[A-Za-z0-9_./@~-]+\.(?:js|mjs)$/,
    /^node_modules\/\.vite\/deps\/[A-Za-z0-9_./@~-]+\.js$/,
    /^@vite\/client$/,
    /^sw\.js$/,
];
const MAX_STACK_FRAMES = 20;
const MAX_DEBUG_IMAGES = 20;

// Buffered metric datapoints for the current page lifecycle. Each entry holds the
// latest numeric value and how many times the metric was recorded. The buffer is
// flushed as one fixed-schema event on visibility loss.
/** @type {Map<string, {value: number, count: number}>} */
let metricBuffer = new Map();

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
 * Check whether a value is a non-array object.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Check whether a value is an integer.
 * @param {unknown} value
 * @returns {value is number}
 */
function isInteger(value) {
    return Number.isInteger(value);
}

/**
 * Check whether a value is an allowlisted effects tier.
 * @param {unknown} value
 * @returns {value is string}
 */
function isEffectsTier(value) {
    return EFFECTS_TIER_VALUES.has(value);
}

/**
 * Check whether an event should be dropped as known browser noise.
 * @param {unknown} event
 * @returns {boolean}
 */
function isNoisyEvent(event) {
    if (!isRecord(event)) {
        return false;
    }

    const exceptionValues =
        isRecord(event.exception) && Array.isArray(event.exception.values)
            ? event.exception.values
            : [];
    const messages = [event.message, ...exceptionValues.map((value) => value && value.value)].filter(
        (value) => typeof value === "string",
    );

    if (messages.some((message) => NOISY_EVENT_PATTERNS.some((pattern) => pattern.test(message)))) {
        return true;
    }

    for (const value of exceptionValues) {
        const frames =
            isRecord(value) && isRecord(value.stacktrace) && Array.isArray(value.stacktrace.frames)
                ? value.stacktrace.frames
                : [];
        for (const frame of frames) {
            const filename = isRecord(frame) && typeof frame.filename === "string" ? frame.filename : "";
            if (NOISY_EVENT_PATTERNS.some((pattern) => pattern.test(filename))) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Resolve the app's deployed path prefix.
 * @returns {string}
 */
function resolveAppBasePath() {
    try {
        const baseUrl = typeof import.meta.env.BASE_URL === "string" ? import.meta.env.BASE_URL : "/";
        const path = new URL(baseUrl, window.location.href).pathname;
        return path.endsWith("/") ? path : `${path}/`;
    } catch {
        return "/";
    }
}

/**
 * Normalize a same-origin app script URL to a pathname.
 * @param {unknown} filename
 * @param {string} appBasePath
 * @returns {string|null}
 */
function normalizeScriptPath(filename, appBasePath) {
    if (typeof filename !== "string" || !filename || window.location.origin === "null") {
        return null;
    }
    if (/^[A-Za-z]:[\\/]/.test(filename) || filename.startsWith("\\\\")) {
        return null;
    }

    let url;
    try {
        url = new URL(filename, window.location.href);
    } catch {
        return null;
    }

    if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.origin !== window.location.origin ||
        !url.pathname.startsWith(appBasePath)
    ) {
        return null;
    }

    const relativePath = url.pathname.slice(appBasePath.length);
    if (!SAFE_SCRIPT_PATH_PATTERNS.some((pattern) => pattern.test(relativePath))) {
        return null;
    }
    return url.pathname;
}

/**
 * Reduce arbitrary context to fixed diagnostic tags.
 * @param {unknown} context
 * @returns {Record<string, string>}
 */
function reduceDiagnosticTags(context) {
    /** @type {Record<string, string>} */
    const tags = {};
    if (!isRecord(context)) {
        return tags;
    }

    for (const [key, allowedValues] of Object.entries(DIAGNOSTIC_TAG_VALUES)) {
        const value = context[key];
        if (typeof value === "string" && allowedValues.has(value)) {
            tags[key] = value;
        }
    }
    return tags;
}

/**
 * Build the fixed metadata shared by reduced events.
 * @param {Record<string, unknown>} event
 * @param {string} environment
 * @param {string|undefined} release
 * @param {import("@sentry/browser").SeverityLevel} level
 * @returns {ReducedEvent}
 */
function reduceBaseEvent(event, environment, release, level) {
    /** @type {ReducedEvent} */
    const reduced = {
        level,
        platform: "javascript",
        environment,
    };
    if (release) {
        reduced.release = release;
    }
    if (typeof event.event_id === "string" && EVENT_ID_PATTERN.test(event.event_id)) {
        reduced.event_id = event.event_id.toLowerCase();
    }
    if (typeof event.timestamp === "number" && Number.isFinite(event.timestamp)) {
        reduced.timestamp = event.timestamp;
    }
    return reduced;
}

/**
 * Reduce one stack frame to its safe source location.
 * @param {unknown} frame
 * @param {string} appBasePath
 * @returns {ReducedFrame|null}
 */
function reduceStackFrame(frame, appBasePath) {
    if (!isRecord(frame)) {
        return null;
    }
    const filename = normalizeScriptPath(frame.filename, appBasePath);
    if (!filename) {
        return null;
    }

    /** @type {ReducedFrame} */
    const reduced = { filename };
    if (isInteger(frame.lineno) && frame.lineno >= 0) {
        reduced.lineno = frame.lineno;
    }
    if (isInteger(frame.colno) && frame.colno >= 0) {
        reduced.colno = frame.colno;
    }
    if (typeof frame.in_app === "boolean") {
        reduced.in_app = frame.in_app;
    }
    return reduced;
}

/**
 * Reduce sourcemap debug metadata to safe script paths and UUIDs.
 * @param {unknown} debugMeta
 * @param {string} appBasePath
 * @returns {{images: ReducedDebugImage[]}|undefined}
 */
function reduceDebugMeta(debugMeta, appBasePath) {
    if (!isRecord(debugMeta) || !Array.isArray(debugMeta.images)) {
        return undefined;
    }

    /** @type {ReducedDebugImage[]} */
    const images = [];
    for (const image of debugMeta.images) {
        if (
            !isRecord(image) ||
            image.type !== "sourcemap" ||
            typeof image.debug_id !== "string" ||
            !DEBUG_ID_PATTERN.test(image.debug_id)
        ) {
            continue;
        }
        const codeFile = normalizeScriptPath(image.code_file, appBasePath);
        if (!codeFile) {
            continue;
        }
        images.push({
            type: "sourcemap",
            code_file: codeFile,
            debug_id: image.debug_id.toLowerCase(),
        });
        if (images.length === MAX_DEBUG_IMAGES) {
            break;
        }
    }

    return images.length ? { images } : undefined;
}

/**
 * Normalize an exception type to a built-in name.
 * @param {unknown} type
 * @returns {string}
 */
function normalizeExceptionType(type) {
    return typeof type === "string" && ERROR_TYPES.has(type) ? type : "Error";
}

/**
 * Reduce an error event to fixed diagnostics and safe source locations.
 * @param {Record<string, unknown>} event
 * @param {string} environment
 * @param {string|undefined} release
 * @param {string} appBasePath
 * @returns {ReducedEvent|null}
 */
function reduceErrorEvent(event, environment, release, appBasePath) {
    if (!isRecord(event.exception) || !Array.isArray(event.exception.values)) {
        return null;
    }
    const originalException = event.exception.values[0];
    if (!isRecord(originalException)) {
        return null;
    }

    const tags = reduceDiagnosticTags(event.tags);
    const diagnosticId =
        tags.module && tags.operation ? `${tags.module}.${tags.operation}` : "captured-error";
    /** @type {ReducedException} */
    const reducedException = {
        type: normalizeExceptionType(originalException.type),
        value: diagnosticId,
    };
    const originalFrames =
        isRecord(originalException.stacktrace) && Array.isArray(originalException.stacktrace.frames)
            ? originalException.stacktrace.frames
            : [];
    /** @type {ReducedFrame[]} */
    const frames = [];
    for (const frame of originalFrames) {
        const reducedFrame = reduceStackFrame(frame, appBasePath);
        if (!reducedFrame) {
            continue;
        }
        frames.push(reducedFrame);
        if (frames.length === MAX_STACK_FRAMES) {
            break;
        }
    }
    if (frames.length) {
        reducedException.stacktrace = { frames };
    }

    const reduced = reduceBaseEvent(event, environment, release, "error");
    reduced.exception = { values: [reducedException] };
    if (Object.keys(tags).length) {
        reduced.tags = tags;
    }
    const debugMeta = reduceDebugMeta(event.debug_meta, appBasePath);
    if (debugMeta) {
        reduced.debug_meta = debugMeta;
    }
    return reduced;
}

/**
 * Reduce a buffered session metric event to known numeric fields.
 * @param {Record<string, unknown>} event
 * @param {string} environment
 * @param {string|undefined} release
 * @returns {ReducedEvent|null}
 */
function reduceMetricEvent(event, environment, release) {
    if (
        event.message !== "session-metrics" ||
        !isRecord(event.tags) ||
        event.tags["telemetry.type"] !== "session-metrics" ||
        !isRecord(event.extra)
    ) {
        return null;
    }

    /** @type {Record<string, number>} */
    const extra = {};
    for (const name of WIRE_METRIC_NAMES) {
        const metricKey = `metric:${name}`;
        const countKey = `${metricKey}:count`;
        const value = event.extra[metricKey];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            continue;
        }
        extra[metricKey] = value;
        const count = event.extra[countKey];
        if (isInteger(count) && count > 0) {
            extra[countKey] = count;
        }
    }
    if (!Object.keys(extra).length) {
        return null;
    }

    const reduced = reduceBaseEvent(event, environment, release, "info");
    reduced.message = "session-metrics";
    /** @type {Record<string, string>} */
    const tags = { "telemetry.type": "session-metrics" };
    reduced.tags = tags;
    if (isEffectsTier(event.tags.effects)) {
        tags.effects = event.tags.effects;
    }
    reduced.extra = extra;
    return reduced;
}

/**
 * Reduce allowlisted processing-unfinished fields, or null when any is invalid.
 * @param {unknown} fields
 * @returns {Record<string, string>|null}
 */
function reduceUnfinishedRunFields(fields) {
    if (!isRecord(fields)) {
        return null;
    }
    /** @type {Record<string, string>} */
    const reduced = {};
    for (const [key, allowedValues] of Object.entries(UNFINISHED_RUN_VALUES)) {
        const value = fields[key];
        if (typeof value !== "string" || !allowedValues.has(value)) {
            return null;
        }
        reduced[key] = value;
    }
    return reduced;
}

/**
 * Reduce a processing-unfinished event to its fixed allowlisted tags.
 * @param {Record<string, unknown>} event
 * @param {string} environment
 * @param {string|undefined} release
 * @returns {ReducedEvent|null}
 */
function reduceUnfinishedRunEvent(event, environment, release) {
    if (!isRecord(event.tags) || event.tags["telemetry.type"] !== "processing-unfinished") {
        return null;
    }
    const fields = reduceUnfinishedRunFields(event.tags);
    if (!fields) {
        return null;
    }
    const reduced = reduceBaseEvent(event, environment, release, "info");
    reduced.message = "processing-unfinished";
    reduced.tags = { "telemetry.type": "processing-unfinished", ...fields };
    return reduced;
}

/**
 * Clear SDK attachments before event transport.
 * @param {unknown} hint
 */
function clearHintAttachments(hint) {
    try {
        if (isRecord(hint) && Object.hasOwn(hint, "attachments")) {
            hint.attachments = [];
        }
    } catch {
        // Ignore malformed SDK hints. The event reducer still drops event fields.
    }
}

/**
 * Type a reduced event as the SDK event it replaces in `beforeSend`.
 * @param {ReducedEvent|null} reduced - Reduced event, or null to drop it
 * @returns {import("@sentry/browser").ErrorEvent|null}
 */
function toSentryEvent(reduced) {
    return /** @type {import("@sentry/browser").ErrorEvent|null} */ (reduced);
}

/** Initialize Sentry when DSN is configured and telemetry consent is granted. */
export function initSentry() {
    const dsn = import.meta.env.VITE_SENTRY_DSN;
    if (!dsn || !hasTelemetryConsent()) {
        sentryReady = false;
        return;
    }

    const environment = import.meta.env.MODE || "development";
    const release = resolveRelease();
    const appBasePath = resolveAppBasePath();
    Sentry.init({
        dsn,
        environment,
        release,
        defaultIntegrations: false,
        dataCollection: {
            userInfo: false,
            cookies: false,
            httpHeaders: false,
            httpBodies: [],
            urlQueryParams: false,
        },
        maxBreadcrumbs: 0,
        beforeSend(event, hint) {
            clearHintAttachments(hint);
            if (isNoisyEvent(event)) {
                return null;
            }
            if (!isRecord(event)) {
                return null;
            }
            if (event.message === "session-metrics") {
                return toSentryEvent(reduceMetricEvent(event, environment, release));
            }
            if (event.message === "processing-unfinished") {
                return toSentryEvent(reduceUnfinishedRunEvent(event, environment, release));
            }
            return toSentryEvent(reduceErrorEvent(event, environment, release, appBasePath));
        },
        beforeBreadcrumb: () => null,
    });
    sentryReady = true;
    attachMetricFlushListeners();
}

/** Flush buffered metrics when the page transitions to hidden. */
function flushMetricsOnHidden() {
    if (document.visibilityState === "hidden") {
        flushMetrics();
    }
}

/** Attach idempotent page lifecycle listeners for metric flushing. */
function attachMetricFlushListeners() {
    document.removeEventListener("visibilitychange", flushMetricsOnHidden);
    document.addEventListener("visibilitychange", flushMetricsOnHidden);
    window.removeEventListener("pagehide", flushMetrics);
    window.addEventListener("pagehide", flushMetrics);
}

/** Stop telemetry after consent is revoked and discard buffered metrics. */
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

/**
 * Store or revoke telemetry consent.
 * @param {boolean} granted - Whether the user granted consent
 */
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
 * Replace any non-Error input without inspecting or retaining it.
 * @param {unknown} error
 * @returns {Error}
 */
function normalizeCapturedError(error) {
    if (error instanceof Error) {
        return error;
    }
    const normalized = new Error("Non-Error value captured");
    normalized.name = "NonError";
    return normalized;
}

/**
 * Capture an error with fixed allowlisted diagnostic tags.
 * @param {unknown} error
 * @param {object} [context]
 */
export function captureError(error, context) {
    if (!sentryReady) {
        return;
    }
    try {
        const capturedError = normalizeCapturedError(error);
        const tags = reduceDiagnosticTags(context);
        if (Object.keys(tags).length) {
            Sentry.captureException(capturedError, { tags });
            return;
        }
        Sentry.captureException(capturedError);
    } catch {
        // Ignore Sentry failures.
    }
}

/**
 * Buffer one allowlisted nonnegative numeric metric for the current session.
 * @param {string} name
 * @param {number} value
 */
export function captureMetric(name, value) {
    if (
        !sentryReady ||
        typeof name !== "string" ||
        !WIRE_METRIC_NAMES.has(name) ||
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0
    ) {
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
 * Record the effects tier in use, sent as one allowlisted tag with session
 * metrics so the owner can see which tiers real users get.
 * @param {string} tier - lite, standard, or rich
 */
export function setTelemetryEffectsTier(tier) {
    effectsTier = EFFECTS_TIER_VALUES.has(tier) ? tier : "";
}

/** Send buffered metrics as one fixed-schema numeric session event. */
export function flushMetrics() {
    if (!sentryReady || metricBuffer.size === 0) {
        return;
    }

    const buffered = metricBuffer;
    metricBuffer = new Map();

    try {
        /** @type {Record<string, number>} */
        const extra = {};
        for (const [name, entry] of buffered) {
            extra[`metric:${name}`] = entry.value;
            if (entry.count > 1) {
                extra[`metric:${name}:count`] = entry.count;
            }
        }
        /** @type {Record<string, string>} */
        const tags = { "telemetry.type": "session-metrics" };
        if (effectsTier) {
            tags.effects = effectsTier;
        }
        Sentry.captureMessage("session-metrics", { level: "info", tags, extra });
    } catch {
        // Ignore Sentry failures.
    }
}

/**
 * Send one processing-unfinished event with allowlisted buckets only. With
 * consent granted, a test sink on window records the reduced fields, so e2e
 * tests can check the event without a build-time DSN.
 * @param {{ sizeBucket: string, memoryBucket: string, mode: string }} fields
 */
export function captureProcessingUnfinished(fields) {
    const reduced = reduceUnfinishedRunFields(fields);
    if (!reduced || !hasTelemetryConsent()) {
        return;
    }
    const sink = /** @type {Window & { __LINKEDIN_ANALYZER_TELEMETRY_SINK__?: unknown }} */ (window)
        .__LINKEDIN_ANALYZER_TELEMETRY_SINK__;
    if (Array.isArray(sink)) {
        sink.push({ message: "processing-unfinished", ...reduced });
    }
    if (!sentryReady) {
        return;
    }
    try {
        Sentry.captureMessage("processing-unfinished", {
            level: "info",
            tags: { "telemetry.type": "processing-unfinished", ...reduced },
        });
    } catch {
        // Ignore Sentry failures.
    }
}
