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
import { LinkedInCleaner } from "../cleaning/cleaner.js";

import { computeWorkerTimeout } from "./format.js";

// Above this combined CSV size, re-parsing on the UI thread would freeze the
// page, so the main-thread fallback is skipped in favor of an empty state.
const MAIN_THREAD_FALLBACK_MAX_CHARS = 5 * 1024 * 1024;

let parseWorker = null;
let parseWorkerRequestId = 0;
let parseWorkerTimeoutId = null;

/** Initialize background worker for messages/connections parsing. */
export function initWorker() {
    if (parseWorker || typeof Worker === "undefined") {
        return;
    }

    try {
        parseWorker = new Worker(new URL("./messages-worker.js", import.meta.url), {
            type: "module",
        });
    } catch (error) {
        parseWorker = null;
        captureError(error, {
            module: "messages-insights",
            operation: "init-worker",
        });
    }
}

/** Terminate messages parsing worker. */
export function terminateWorker() {
    if (!parseWorker) {
        return;
    }
    parseWorker.terminate();
    parseWorker = null;
    clearWorkerTimeout();
}

/** Clear any in-flight worker watchdog timeout. */
function clearWorkerTimeout() {
    if (!parseWorkerTimeoutId) {
        return;
    }
    window.clearTimeout(parseWorkerTimeoutId);
    parseWorkerTimeoutId = null;
}

/**
 * Parse messages/connections in a worker when available.
 * Falls back to main-thread parsing if worker is unavailable or fails.
 * @param {string} messagesCsv - Raw messages CSV text
 * @param {string} connectionsCsv - Raw connections CSV text
 * @returns {Promise<object>}
 */
export async function processFiles(messagesCsv, connectionsCsv) {
    if (!parseWorker) {
        initWorker();
    }
    const workerResult = await processFilesInWorker(messagesCsv, connectionsCsv);
    if (workerResult) {
        return workerResult;
    }
    // The worker was unavailable, errored, or timed out. Re-parsing a large
    // export on the UI thread would freeze the page, so bail out with an
    // explanatory empty state above the size ceiling.
    if (messagesCsv.length + connectionsCsv.length > MAIN_THREAD_FALLBACK_MAX_CHARS) {
        return {
            success: false,
            error: "These files are too large to analyze without a background worker. Reload the page, or open it in a browser that supports Web Workers.",
        };
    }
    return processFilesOnMainThread(messagesCsv, connectionsCsv);
}

/**
 * Parse files using a dedicated Web Worker.
 * @param {string} messagesCsv - Raw messages CSV text
 * @param {string} connectionsCsv - Raw connections CSV text
 * @returns {Promise<object|null>} Parsed payload or null on worker failure
 */
function processFilesInWorker(messagesCsv, connectionsCsv) {
    if (!parseWorker) {
        return Promise.resolve(null);
    }

    const requestId = ++parseWorkerRequestId;

    return new Promise((resolve) => {
        clearWorkerTimeout();
        const handleMessage = (event) => {
            const parsed = parseMessagesWorkerMessage(event.data || {});
            if (!parsed.valid) {
                // Invalid worker responses always carry an error string, so the fallback is defensive.
                /* v8 ignore next */
                captureError(new Error(parsed.error || "Invalid messages worker response."), {
                    module: "messages-insights",
                    operation: "worker-message-parse",
                    requestId,
                });
                return;
            }

            const message = parsed.value;
            if (message.type !== "processed" || message.requestId !== requestId) {
                return;
            }
            finishRequest();
            resolve(message.payload || null);
        };

        const handleError = (event) => {
            captureError(
                event && event.error
                    ? event.error
                    : new Error(
                          `Messages worker ${event && event.type ? event.type : "error"} event`,
                      ),
                {
                    module: "messages-insights",
                    operation: "worker-error-event",
                    requestId,
                },
            );
            finishRequest();
            terminateWorker();
            resolve(null);
        };

        const removeWorkerListeners = () => {
            // A beforeunload or pagehide listener can call terminateWorker() and null the
            // worker while this request is still in flight, so the guard is load-bearing.
            /* v8 ignore next 3 */
            if (!parseWorker) {
                return;
            }
            parseWorker.removeEventListener("message", handleMessage);
            parseWorker.removeEventListener("error", handleError);
            parseWorker.removeEventListener("messageerror", handleError);
        };

        const finishRequest = () => {
            removeWorkerListeners();
            clearWorkerTimeout();
        };

        parseWorkerTimeoutId = window.setTimeout(() => {
            captureError(new Error("Messages worker request timed out."), {
                module: "messages-insights",
                operation: "worker-timeout",
                requestId,
            });
            finishRequest();
            terminateWorker();
            resolve(null);
        }, computeWorkerTimeout(messagesCsv, connectionsCsv));

        try {
            parseWorker.addEventListener("message", handleMessage);
            parseWorker.addEventListener("error", handleError);
            parseWorker.addEventListener("messageerror", handleError);
            parseWorker.postMessage({
                type: "process",
                requestId,
                payload: {
                    messagesCsv,
                    connectionsCsv,
                },
            });
        } catch (error) {
            captureError(error, {
                module: "messages-insights",
                operation: "worker-post-message",
                requestId,
            });
            finishRequest();
            terminateWorker();
            resolve(null);
        }
    });
}

/**
 * Parse files directly on main thread as fallback.
 * @param {string} messagesCsv - Raw messages CSV text
 * @param {string} connectionsCsv - Raw connections CSV text
 * @returns {object}
 */
function processFilesOnMainThread(messagesCsv, connectionsCsv) {
    const messagesResult = LinkedInCleaner.process(messagesCsv, "messages");
    if (!messagesResult.success) {
        return {
            success: false,
            error: messagesResult.error || "Unable to parse messages.csv.",
        };
    }

    let connectionsData = [];
    let connectionError = null;

    if (connectionsCsv) {
        const connectionsResult = LinkedInCleaner.process(connectionsCsv, "connections");
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
