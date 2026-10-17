/* Turn the failures a worker catches or is sent into values it can post. */

/**
 * Convert an unknown error value into a message string.
 * @param {unknown} error - Error value to normalize
 * @param {string} fallback - Message when the value carries none
 * @returns {string}
 */
export function toErrorMessage(error, fallback) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    if (typeof error === "string" && error) {
        return error;
    }
    return fallback;
}

/**
 * Extract an error-like value from a worker error event.
 * @param {unknown} event - Worker error event
 * @returns {unknown}
 */
export function extractWorkerError(event) {
    if (!event || typeof event !== "object") {
        return undefined;
    }
    if ("error" in event && event.error) {
        return event.error;
    }
    if ("message" in event && event.message) {
        return event.message;
    }
    return undefined;
}

/**
 * Extract the rejection reason from a worker unhandledrejection event.
 * @param {unknown} event - Worker rejection event
 * @returns {unknown}
 */
export function extractWorkerRejection(event) {
    if (!event || typeof event !== "object" || !("reason" in event)) {
        return undefined;
    }
    return event.reason;
}
