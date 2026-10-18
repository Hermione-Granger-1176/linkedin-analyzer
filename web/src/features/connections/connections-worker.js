/* LinkedIn Analyzer: Connections parsing & analytics worker */

import { parseConnectionsWorkerRequest } from "../../app/worker-contracts.ts";
import { serveWorker } from "../../shared/worker-entry.js";
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
 * Post a worker error payload carrying fixed text.
 * @param {import("../../app/worker-contracts.ts").RequestId} requestId - Request id being answered
 * @param {string} message - Fixed failure text
 */
function postWorkerError(requestId, message) {
    self.postMessage({ type: "error", requestId, payload: { message } });
}

/* -- Worker message handler -------------------------------------------------- */

serveWorker({
    requestType: "process",
    parse: parseConnectionsWorkerRequest,
    handle: async (request) => {
        // The page sends the stored upload Blob; read it here, off the main thread.
        const result = await processConnections(request.payload.connectionsCsv);
        self.postMessage({
            type: "processed",
            requestId: request.requestId,
            payload: {
                success: result.success,
                analytics: result.analytics || null,
                rows: result.rows || null,
                error: result.error || null,
            },
        });
    },
    postFailure: postWorkerError,
    runtimeFailure: "Connections worker runtime failure.",
});

export { processConnections };
