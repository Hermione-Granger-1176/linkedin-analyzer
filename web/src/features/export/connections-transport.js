/**
 * Load the PDF connections dashboard through an export-owned worker.
 *
 * Parsing and aggregation run in the Connections screen's worker, off the main
 * thread. worker-transport.js manages the separate worker instance. Reports
 * fixed error text only: thrown values can contain connection names, employers,
 * or profile URLs.
 */

import { parseConnectionsWorkerMessage } from "../../app/worker-contracts.ts";
import { captureError } from "../../platform/observability/sentry.js";
import { toCsvSource } from "../../shared/csv-source.js";
import { computeWorkerTimeout } from "../../shared/worker-timeout.js";
import { LinkedInCleaner } from "../cleaning/cleaner.js";
import { buildGrowthTimeline, computeStats, normalizeConnectionRows } from "../connections/view.js";

import {
    createWorkerTransport,
    failureOutcome,
    loadWithFallback,
    PENDING,
} from "./worker-transport.js";

const transport = createWorkerTransport({
    name: "connections",
    createWorker: () =>
        new Worker(new URL("../connections/connections-worker.js", import.meta.url), {
            type: "module",
        }),
});

/**
 * Terminate the export's connections worker and end whatever it was answering.
 *
 * Safe to call when nothing is running, and safe to call twice.
 */
export function terminateConnectionsWorker() {
    transport.terminate();
}

/**
 * @typedef {{key: string, label: string, value: number}} GrowthPoint - One month of network growth
 * @typedef {{total?: number, networkAgeMonths?: number}} NetworkStats - Whole-network summary stats
 */

/**
 * Result of `LinkedInCleaner.process`, as far as this transport reads it.
 * @typedef {{success: boolean, cleanedData: Array<Record<string, string>>}} CleanedConnections
 */

/**
 * @typedef {object} ConnectionsData
 * @property {import("../connections/view.js").ConnectionRow[]} rows - Cleaned rows, in the shape the view aggregates
 * @property {GrowthPoint[]} timeline - All-time growth timeline
 * @property {NetworkStats|null} stats - Whole-network summary stats
 */

/**
 * Build the rows, timeline and stats the connections dashboard is drawn from.
 *
 * Runs in a worker when one is available and falls back to the main thread for
 * small exports. A large export without a worker returns null, so the PDF omits
 * the dashboard.
 * @param {Blob|string|null} connectionsCsv - Stored connections upload, CSV text, or nothing
 * @param {{isCancelled?: () => boolean}} [options] - The run's cancellation check
 * @returns {Promise<ConnectionsData|null>} Dashboard data, or null when there is none
 */
export function loadConnectionsData(connectionsCsv, options = {}) {
    const text = toCsvSource(connectionsCsv);
    return loadWithFallback(transport, {
        sources: [text],
        isCancelled: options.isCancelled,
        request: () => connectionsRequest(text),
        mainThread: buildDataOnMainThread,
        empty: null,
    });
}

/**
 * The worker request for the cleaned rows and the aggregates over them.
 * @param {Blob|string} connectionsCsv - Stored connections upload, or CSV text
 * @returns {import("./worker-transport.js").RequestOptions<import("../../app/worker-contracts.ts").ConnectionsWorkerMessage, ConnectionsData|null|typeof import("./worker-transport.js").FAILED>}
 */
function connectionsRequest(connectionsCsv) {
    return {
        envelope: { type: "process", payload: { connectionsCsv } },
        parse: parseConnectionsWorkerMessage,
        interpret: interpretReply,
        // Scaled to the file size, like the messages budget, over the one file
        // this transport holds.
        timeoutMs: computeWorkerTimeout(connectionsCsv),
    };
}

/**
 * Read one valid worker reply into an outcome for the request in flight.
 * @param {import("../../app/worker-contracts.ts").ConnectionsWorkerMessage} message - Parsed worker message
 * @param {import("./worker-transport.js").ReplyContext} context - The request's id and error reporter
 * @returns {ConnectionsData|null|typeof import("./worker-transport.js").FAILED|typeof PENDING} Outcome, or PENDING to keep waiting
 */
function interpretReply(message, context) {
    if (message.type === "error") {
        // The worker answers a failed request under its own id, or under id zero
        // when the request could not be read. Either way it settles the request
        // in flight. The outcome depends on which, per `failureOutcome`.
        context.report("Connections worker reported an error.", "connections-worker-error-payload");
        return failureOutcome(message, context);
    }
    // The contract parser always returns an object for a processed payload, so
    // `success` is read without a guard.
    if (!message.payload.success) {
        // A failure settles the request in flight whatever id it arrived under.
        // The outcome depends on the id: see `failureOutcome`.
        context.report("Connections worker reported a failure.", "connections-worker-failure");
        return failureOutcome(message, context);
    }
    // A stale success belongs to a request nobody is waiting on, so it is dropped
    // before the empty-payload check below. An empty payload settles the request
    // in flight, so only this request's reply may do that.
    if (message.requestId !== context.requestId) {
        return PENDING;
    }
    const data = toConnectionsData(message.payload);
    if (!data) {
        context.report("Connections worker response carried no data.", "connections-message-parse");
        // Settled here rather than left to the watchdog. Returns null rather than
        // FAILED: a reply the parser emptied says nothing about whether the file
        // can be parsed.
        return null;
    }
    return data;
}

/**
 * Normalize a successful worker payload for the dashboard.
 * The worker returns the cleaned rows used by the Connections screen.
 * Worker and main-thread results share one shape.
 * @param {import("../../app/worker-contracts.ts").ConnectionsProcessedPayload} payload - Successful worker payload
 * @returns {ConnectionsData|null} Data, or null when the reply holds nothing to draw
 */
function toConnectionsData(payload) {
    // A reply can pass the parser and still carry no analytics or rows.
    if (!payload.analytics || !payload.rows.length) {
        return null;
    }
    return {
        // The contract checks only that the rows are an array; they are the
        // cleaned rows the worker produced, in the shape the main thread's own
        // cleaner returns.
        rows: normalizeConnectionRows(
            /** @type {CleanedConnections["cleanedData"]} */ (payload.rows),
        ),
        // The contract checks only that analytics is an object. Both fields are
        // read the way the Connections screen reads them.
        timeline: Array.isArray(payload.analytics.growthTimeline)
            ? payload.analytics.growthTimeline
            : [],
        stats: /** @type {NetworkStats|null} */ (payload.analytics.stats || null),
    };
}

/**
 * Parse and aggregate on the UI thread, for a small export with no worker.
 * @param {string} connectionsCsv - Raw connections CSV text
 * @returns {ConnectionsData|null} Data, or null when the file cannot be parsed
 */
function buildDataOnMainThread(connectionsCsv) {
    try {
        const processed = /** @type {CleanedConnections} */ (
            LinkedInCleaner.process(connectionsCsv, "connections")
        );
        if (!processed.success || !processed.cleanedData.length) {
            return null;
        }
        return {
            rows: normalizeConnectionRows(processed.cleanedData),
            timeline: buildGrowthTimeline(processed.cleanedData),
            stats: computeStats(processed.cleanedData),
        };
    } catch {
        // Only a fixed error is reported to telemetry.
        captureError(new Error("Connections could not be parsed for the export."), {
            module: "pdf-export",
            operation: "connections-main-thread-parse",
        });
        return null;
    }
}
