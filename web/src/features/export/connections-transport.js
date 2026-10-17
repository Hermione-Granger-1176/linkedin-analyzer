/**
 * Transport for the PDF export's connections dashboard.
 *
 * The dashboard used to clean and aggregate the connections export inline, on
 * the UI thread, in the middle of `collectExportData`. A real export runs to
 * tens of thousands of rows, and while that block held the thread nothing else
 * could run on it, including the Escape key handler the dialog promises will
 * cancel an export at any point, mid-generation included. The Connections screen
 * has done this same work in a worker from the start, so the export runs that
 * worker rather than a second copy of the arithmetic.
 *
 * The worker is owned outright rather than borrowed from that screen;
 * `worker-transport.js` carries why, and everything about owning it. What is
 * here is what the connections dashboard asks for and how it reads the reply.
 *
 * Nothing the worker was handed is ever reported. Every catch here discards what
 * it was given and reports a fixed error instead, because a failure while
 * parsing the user's connections can carry the names, employers and profile URLs
 * of everyone they know.
 */

import { parseConnectionsWorkerMessage } from "../../app/worker-contracts.js";
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
 * @returns {import("./worker-transport.js").RequestOptions<import("../../app/worker-contracts.js").ConnectionsWorkerMessage, ConnectionsData|null|typeof import("./worker-transport.js").FAILED>}
 */
function connectionsRequest(connectionsCsv) {
    return {
        envelope: { type: "process", payload: { connectionsCsv } },
        parse: parseConnectionsWorkerMessage,
        interpret: interpretReply,
        // The same size-scaled budget the messages parse is given, over the one
        // file this transport holds: a fixed watchdog would fire early on the
        // large connections export this transport exists for and send the parse
        // the worker was still doing to the UI thread instead.
        timeoutMs: computeWorkerTimeout(connectionsCsv),
    };
}

/**
 * Read one valid worker reply into an outcome for the request in flight.
 * @param {import("../../app/worker-contracts.js").ConnectionsWorkerMessage} message - Parsed worker message
 * @param {import("./worker-transport.js").ReplyContext} context - The request's id and error reporter
 * @returns {ConnectionsData|null|typeof import("./worker-transport.js").FAILED|typeof PENDING} Outcome, or PENDING to keep waiting
 */
function interpretReply(message, context) {
    if (message.type === "error") {
        // This worker answers a request it threw on under that request's own id,
        // and a global failure or a request it could not read at all under id
        // zero. It settles the one request in flight either way; which of the
        // two it is decides what it settles as, per `failureOutcome`.
        context.report("Connections worker reported an error.", "connections-worker-error-payload");
        return failureOutcome(message, context);
    }
    // The contract parser normalizes every field of a processed payload and
    // always hands back an object, so there is nothing to guard before reading
    // `success`, unlike its messages sibling, which passes the payload through
    // and nulls one that is not an object.
    if (!message.payload.success) {
        // Settled whatever id it arrived under, because only one request is ever
        // in flight and waiting out the watchdog would look like a hang. What it
        // settles as does turn on the id: see `failureOutcome`.
        context.report("Connections worker reported a failure.", "connections-worker-failure");
        return failureOutcome(message, context);
    }
    // A stale success belongs to a request nobody is waiting on. It is dropped
    // before the emptied-payload check below rather than after it, as the
    // messages transport does: an emptied payload settles this request, and the
    // reply that settles it has to be its own.
    if (message.requestId !== context.requestId) {
        return PENDING;
    }
    const data = toConnectionsData(message.payload);
    if (!data) {
        context.report("Connections worker response carried no data.", "connections-message-parse");
        // Settled rather than left to the watchdog, for the same reason the
        // failure envelope above is. Null rather than FAILED, because a reply the
        // parser had to empty out says nothing about whether the file itself can
        // be parsed.
        return null;
    }
    return data;
}

/**
 * Read a successful worker payload into the shape the dashboard is drawn from.
 *
 * The rows are normalized here rather than by the caller so both paths below
 * answer with one shape, and because the worker cannot do it: it sends the
 * cleaned rows on to the Connections screen, which filters them by a range this
 * export does not have.
 * @param {import("../../app/worker-contracts.js").ConnectionsProcessedPayload} payload - Successful worker payload
 * @returns {ConnectionsData|null} Data, or null when the reply holds nothing to draw
 */
function toConnectionsData(payload) {
    // The parser nulls an analytics payload that is not a plain object and
    // normalizes a missing row list to an empty array, so a reply can be
    // well-formed enough to accept and still carry nothing at all.
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
        // Neither field inside analytics is validated by the contract, which
        // checks only that the object is one, so both are taken the way the
        // Connections screen takes them.
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
        // The caught value came from parsing the user's own connections, so only
        // a fixed error crosses into telemetry.
        captureError(new Error("Connections could not be parsed for the export."), {
            module: "pdf-export",
            operation: "connections-main-thread-parse",
        });
        return null;
    }
}
