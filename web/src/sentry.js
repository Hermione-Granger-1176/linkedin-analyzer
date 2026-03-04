import * as Sentry from '@sentry/browser';

let sentryReady = false;

/** Initialize Sentry when DSN is configured. */
export function initSentry() {
    const dsn = import.meta.env.VITE_SENTRY_DSN;
    if (!dsn) {
        sentryReady = false;
        return;
    }
    Sentry.init({
        dsn,
        environment: import.meta.env.MODE || 'development',
        tracesSampleRate: 0.1
    });
    sentryReady = true;
}

/** Capture an error if Sentry is configured. */
export function captureError(error) {
    if (!sentryReady) {
        return;
    }
    try {
        Sentry.captureException(error);
    } catch {
        // Ignore Sentry failures.
    }
}
