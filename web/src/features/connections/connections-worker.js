/* LinkedIn Analyzer - Connections parsing & analytics worker */

import { parseConnectionsWorkerRequest } from "../../app/worker-contracts.js";
import { LinkedInCleaner } from "../cleaning/cleaner.js";

import { buildGrowthTimeline, computeStats } from "./view.js";

/* -- Main processing pipeline ------------------------------------------------ */

/**
 * Parse and aggregate a Connections CSV into analytics ready for the UI.
 * The cleaned rows are included in the response so the UI can apply its own
 * time-range filter and build company and position summaries without another
 * worker round-trip.
 *
 * @param {string} connectionsCsv - Raw CSV text from the Connections export
 * @returns {{success: boolean, analytics?: object, rows?: object[], error?: string}}
 */
function processConnections(connectionsCsv) {
    if (!connectionsCsv || typeof connectionsCsv !== "string") {
        return { success: false, error: "No connections CSV data provided." };
    }

    const result = LinkedInCleaner.process(connectionsCsv, "connections");
    if (!result.success) {
        return { success: false, error: result.error || "Unable to parse Connections.csv." };
    }

    const rows = result.cleanedData;
    if (!rows.length) {
        return { success: false, error: "Connections file contained no valid rows." };
    }

    const analytics = Object.freeze({
        growthTimeline: buildGrowthTimeline(rows),
        stats: computeStats(rows),
    });

    return { success: true, analytics, rows };
}

/**
 * Convert unknown error values into a message string.
 * @param {unknown} error - Error value to normalize
 * @returns {string}
 */
function toErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    if (typeof error === "string" && error) {
        return error;
    }
    return "Connections worker runtime failure.";
}

/**
 * Post a normalized worker error payload.
 * @param {number|string} requestId - Worker request identifier
 * @param {unknown} error - Error value to normalize
 */
function postWorkerError(requestId, error) {
    self.postMessage({
        type: "error",
        requestId,
        payload: {
            message: toErrorMessage(error),
        },
    });
}

/**
 * Extract an error-like value from a worker error event.
 * @param {unknown} event - Worker error event
 * @returns {unknown}
 */
function extractWorkerError(event) {
    /* v8 ignore next 3 */
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
 * Extract rejection reason from a worker unhandledrejection event.
 * @param {unknown} event - Worker rejection event
 * @returns {unknown}
 */
function extractWorkerRejection(event) {
    if (!event || typeof event !== "object" || !("reason" in event)) {
        return undefined;
    }
    return event.reason;
}

/* -- Worker message handler -------------------------------------------------- */

if (typeof self !== "undefined") {
    self.addEventListener("message", (event) => {
        const rawMessage = event.data || {};
        if (!rawMessage || rawMessage.type !== "process") {
            return;
        }

        const parsed = parseConnectionsWorkerRequest(rawMessage);
        if (!parsed.valid) {
            postWorkerError(0, parsed.error || "Invalid worker request payload.");
            return;
        }

        const message = parsed.value;
        try {
            const result = processConnections(message.payload.connectionsCsv);

            self.postMessage({
                type: "processed",
                requestId: message.requestId,
                payload: {
                    success: result.success,
                    analytics: result.analytics || null,
                    rows: result.rows || null,
                    error: result.error || null,
                },
            });
        } catch (error) {
            postWorkerError(message.requestId, error);
        }
    });

    self.addEventListener("error", (event) => {
        postWorkerError(0, extractWorkerError(event));
    });

    self.addEventListener("unhandledrejection", (event) => {
        postWorkerError(0, extractWorkerRejection(event));
    });
}

export { processConnections };
