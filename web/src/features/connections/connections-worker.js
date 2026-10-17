/* LinkedIn Analyzer - Connections parsing & analytics worker */

import { parseConnectionsWorkerRequest } from "../../app/worker-contracts.js";
import {
    extractWorkerError,
    extractWorkerRejection,
    toErrorMessage,
} from "../../shared/worker-errors.js";
import { processCsvSource } from "../cleaning/process-source.js";

import { buildGrowthTimeline, computeStats } from "./view.js";

/** @typedef {import("./view.js").CleanedConnectionRow} CleanedConnectionRow */
/** @typedef {import("./view.js").ConnectionsAnalytics} ConnectionsAnalytics */

/* -- Main processing pipeline ------------------------------------------------ */

/**
 * Parse and aggregate a Connections CSV into analytics ready for the UI.
 * The cleaned rows are included in the response so the UI can apply its own
 * time-range filter and build company and position summaries without another
 * worker round-trip.
 *
 * A stored upload streams through the cleaner, so the whole file is never held
 * as one string.
 *
 * @param {unknown} connectionsCsv - Stored upload Blob or raw CSV text from the Connections export
 * @returns {Promise<{success: boolean, analytics?: Readonly<ConnectionsAnalytics>,
 * rows?: CleanedConnectionRow[], error?: string}>}
 */
async function processConnections(connectionsCsv) {
    if (!connectionsCsv) {
        return { success: false, error: "No connections CSV data provided." };
    }

    const result = await processCsvSource(connectionsCsv, "connections");
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
 * Post a normalized worker error payload.
 * @param {number|string} requestId - Worker request identifier
 * @param {unknown} error - Error value to normalize
 */
function postWorkerError(requestId, error) {
    self.postMessage({
        type: "error",
        requestId,
        payload: {
            message: toErrorMessage(error, "Connections worker runtime failure."),
        },
    });
}

/* -- Worker message handler -------------------------------------------------- */

if (typeof self !== "undefined") {
    self.addEventListener("message", async (event) => {
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
            // The page sends the stored upload Blob; read it here, off the main thread.
            const result = await processConnections(message.payload.connectionsCsv);

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
