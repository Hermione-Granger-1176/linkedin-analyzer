import * as Sentry from '@sentry/browser';

let sentryReady = false;
const NOISY_EVENT_PATTERNS = [
    /ResizeObserver loop limit exceeded/i,
    /ResizeObserver loop completed with undelivered notifications/i,
    /chrome-extension:\/\//i,
    /moz-extension:\/\//i,
    /safari-extension:\/\//i,
    /Non-Error promise rejection captured/i
];

/**
 * Resolve a release tag for Sentry events.
 * @returns {string|undefined}
 */
function resolveRelease() {
    const release = import.meta.env.VITE_APP_RELEASE;
    if (typeof release !== 'string') {
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
    if (!event || typeof event !== 'object') {
        return false;
    }

    const exceptionValues = event.exception
        && Array.isArray(event.exception.values)
        ? event.exception.values
        : [];
    const messages = [event.message, ...exceptionValues.map(value => value && value.value)]
        .filter(value => typeof value === 'string');

    if (messages.some(message => NOISY_EVENT_PATTERNS.some(pattern => pattern.test(message)))) {
        return true;
    }

    for (const value of exceptionValues) {
        const frames = value
            && value.stacktrace
            && Array.isArray(value.stacktrace.frames)
            ? value.stacktrace.frames
            : [];
        for (const frame of frames) {
            const filename = frame && typeof frame.filename === 'string' ? frame.filename : '';
            if (NOISY_EVENT_PATTERNS.some(pattern => pattern.test(filename))) {
                return true;
            }
        }
    }

    return false;
}

/** Initialize Sentry when DSN is configured. */
export function initSentry() {
    const dsn = import.meta.env.VITE_SENTRY_DSN;
    if (!dsn) {
        sentryReady = false;
        return;
    }
    Sentry.init({
        dsn,
        /* v8 ignore next */
        environment: import.meta.env.MODE || 'development',
        release: resolveRelease(),
        tracesSampleRate: 0.1,
        beforeSend(event) {
            return isNoisyEvent(event) ? null : event;
        }
    });
    sentryReady = true;
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
        if (context && typeof context === 'object') {
            Sentry.withScope(scope => {
                Object.entries(context).forEach(([key, value]) => {
                    scope.setExtra(key, value === undefined ? null : value);
                });
                Sentry.captureException(error);
            });
            return;
        }
        Sentry.captureException(error);
    } catch {
        // Ignore Sentry failures.
    }
}

/**
 * Capture a lightweight metric datapoint for diagnostics.
 * @param {string} name
 * @param {number} value
 * @param {object} [context]
 */
export function captureMetric(name, value, context) {
    if (!sentryReady || typeof name !== 'string' || !name) {
        return;
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return;
    }

    try {
        Sentry.withScope(scope => {
            scope.setTag('telemetry.type', 'metric');
            scope.setTag('metric.name', name);
            scope.setLevel('info');
            scope.setExtra('metric.value', value);

            if (context && typeof context === 'object') {
                Object.entries(context).forEach(([key, metricContextValue]) => {
                    scope.setExtra(key, metricContextValue === undefined ? null : metricContextValue);
                });
            }

            Sentry.captureMessage(`metric:${name}`);
        });
    } catch {
        // Ignore Sentry failures.
    }
}
