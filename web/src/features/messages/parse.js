/**
 * Messages/connections parsing transport for the messages insights page.
 *
 * Owns the dedicated Web Worker lifecycle (creation, watchdog timeout,
 * teardown) and the main-thread parsing fallback used when the worker is
 * unavailable, errors, or times out. The worker handle and its request
 * bookkeeping are module-private so no other module can reassign them.
 */

import { parseMessagesWorkerMessage } from "../../app/worker-contracts.js";
import { captureError } from "../../platform/observability/sentry.js";
import { csvSourceSize } from "../../shared/csv-source.js";
import { MAIN_THREAD_FALLBACK_MAX_CHARS } from "../../shared/limits.js";
import { createWorkerHandle } from "../../shared/worker-handle.js";
import { computeWorkerTimeout } from "../../shared/worker-timeout.js";
import { LinkedInCleaner } from "../cleaning/cleaner.js";
import { readCsvSource, readOptionalCsvSource } from "../upload/read.js";

/** @typedef {import("./messages-worker.js").MessagesProcessedPayload} MessagesProcessedPayload */
/** @typedef {import("./analytics.js").MessageRow} MessageRow */
/** @typedef {import("./analytics.js").ConnectionRow} ConnectionRow */
/**
 * @template Row
 * @typedef {import("./messages-worker.js").CleanedRows<Row>} CleanedRows
 */

/**
 * Resolvers for the requests the worker has not answered yet, by request id.
 * More than one can be in flight: the screen re-parses when the files change.
 * @type {Map<import("../../app/worker-contracts.js").RequestId, (payload: MessagesProcessedPayload|null) => void>}
 */
const pendingRequests = new Map();
let requestCount = 0;

const workers = createWorkerHandle({
    create: () => new Worker(new URL("./messages-worker.js", import.meta.url), { type: "module" }),
    onMessage: handleWorkerMessage,
    onError: handleWorkerError,
    onStartError: (error) => {
        captureError(error, {
            module: "messages-insights",
            operation: "init-worker",
        });
    },
});

/** Initialize background worker for messages/connections parsing. */
export function initWorker() {
    workers.ensure();
}

/**
 * Terminate messages parsing worker.
 *
 * Requests still in flight are dropped, not failed: this runs when the page is
 * leaving, and failing them would start the main-thread fallback parse.
 */
export function terminateWorker() {
    pendingRequests.clear();
    workers.terminate();
}

/**
 * End every request in flight as unanswered, so each falls back, and let the
 * worker go: one that failed or stalled is not going to answer.
 */
function failPendingRequests() {
    const resolvers = [...pendingRequests.values()];
    pendingRequests.clear();
    workers.terminate();
    resolvers.forEach((resolve) => resolve(null));
}

/**
 * Settle the request a worker reply answers.
 * @param {MessageEvent} event - Worker message event
 */
function handleWorkerMessage(event) {
    const parsed = parseMessagesWorkerMessage(event.data || {});
    if (!parsed.valid) {
        // Invalid worker responses normally include an error string. Keep the fallback for malformed responses.
        /* v8 ignore next */
        captureError(new Error(parsed.error || "Invalid messages worker response."), {
            module: "messages-insights",
            operation: "worker-message-parse",
        });
        return;
    }

    const message = parsed.value;
    const resolve = message.type === "processed" && pendingRequests.get(message.requestId);
    if (!resolve) {
        return;
    }
    pendingRequests.delete(message.requestId);
    // The page keeps the state it was sent, and an idle worker can hold the
    // parse's garbage for minutes, so let it go unless a newer request is
    // still on its way to it.
    if (pendingRequests.size === 0) {
        workers.terminate();
    }
    resolve(/** @type {MessagesProcessedPayload|null} */ (message.payload) || null);
}

/**
 * A worker that fell over cannot answer anything it was asked.
 * @param {Event} event - Worker error or messageerror event
 */
function handleWorkerError(event) {
    // Fixed text: the worker parses the user's messages, so its own error can
    // carry a line of one.
    captureError(new Error(`Messages worker ${event && event.type ? event.type : "error"} event`), {
        module: "messages-insights",
        operation: "worker-error-event",
    });
    failPendingRequests();
}

/**
 * Parse messages/connections in a worker when available.
 * Falls back to main-thread parsing if worker is unavailable or fails.
 * @param {Blob|string} messagesCsv - Stored messages upload, or CSV text
 * @param {Blob|string|null} connectionsCsv - Stored connections upload, or CSV text
 * @returns {Promise<MessagesProcessedPayload>}
 */
export async function processFiles(messagesCsv, connectionsCsv) {
    workers.ensure();
    const workerResult = await processFilesInWorker(messagesCsv, connectionsCsv);
    if (workerResult) {
        return workerResult;
    }
    // The worker was unavailable, errored, or timed out. Re-parsing a large
    // export on the UI thread would freeze the page, so bail out with an
    // explanatory empty state above the size ceiling.
    if (
        csvSourceSize(messagesCsv) + csvSourceSize(connectionsCsv) >
        MAIN_THREAD_FALLBACK_MAX_CHARS
    ) {
        return {
            success: false,
            error: "These files are too large to analyze without a background worker. Reload the page, or open it in a browser that supports Web Workers.",
        };
    }
    let messagesText;
    try {
        messagesText = await readCsvSource(messagesCsv);
    } catch {
        return { success: false, error: "Unable to read messages.csv." };
    }
    const connections = await readOptionalCsvSource(connectionsCsv);
    const result = processFilesOnMainThread(messagesText, connections.text);
    if (result.success && connections.failed) {
        result.connectionError = "Unable to read Connections.csv.";
    }
    return result;
}

/**
 * Parse files using a dedicated Web Worker.
 * @param {Blob|string} messagesCsv - Stored messages upload, or CSV text
 * @param {Blob|string|null} connectionsCsv - Stored connections upload, or CSV text
 * @returns {Promise<MessagesProcessedPayload|null>} Parsed payload or null on worker failure
 */
function processFilesInWorker(messagesCsv, connectionsCsv) {
    const worker = workers.current();
    if (!worker) {
        return Promise.resolve(null);
    }

    const requestId = ++requestCount;
    return new Promise((resolve) => {
        pendingRequests.set(requestId, resolve);
        workers.watch(computeWorkerTimeout(messagesCsv, connectionsCsv), () => {
            captureError(new Error("Messages worker request timed out."), {
                module: "messages-insights",
                operation: "worker-timeout",
                requestId,
            });
            failPendingRequests();
        });

        try {
            worker.postMessage({
                type: "process",
                requestId,
                payload: {
                    messagesCsv,
                    connectionsCsv,
                },
            });
        } catch {
            // A structured-clone failure names the value it could not clone,
            // and that value is one of the raw exports.
            captureError(new Error("Messages worker request could not be sent."), {
                module: "messages-insights",
                operation: "worker-post-message",
                requestId,
            });
            failPendingRequests();
        }
    });
}

/**
 * Parse files directly on main thread as fallback.
 * @param {string} messagesCsv - Raw messages CSV text
 * @param {string} connectionsCsv - Raw connections CSV text
 * @returns {MessagesProcessedPayload}
 */
function processFilesOnMainThread(messagesCsv, connectionsCsv) {
    const messagesResult = /** @type {CleanedRows<MessageRow>} */ (
        LinkedInCleaner.process(messagesCsv, "messages")
    );
    if (!messagesResult.success) {
        return {
            success: false,
            error: messagesResult.error || "Unable to parse messages.csv.",
        };
    }

    /** @type {ConnectionRow[]} */
    let connectionsData = [];
    /** @type {string|null} */
    let connectionError = null;

    if (connectionsCsv) {
        const connectionsResult = /** @type {CleanedRows<ConnectionRow>} */ (
            LinkedInCleaner.process(connectionsCsv, "connections")
        );
        if (connectionsResult.success) {
            connectionsData = connectionsResult.cleanedData;
        } else {
            connectionError = connectionsResult.error || "Unable to parse Connections.csv.";
        }
    }

    const messagesData = messagesResult.cleanedData;
    return {
        success: true,
        messagesData,
        connectionsData,
        connectionError,
        totalInputRows: messagesData.length,
    };
}
