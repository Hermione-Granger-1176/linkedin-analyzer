/**
 * Transport for the PDF export's thread selection.
 *
 * Owns a short-lived dedicated Web Worker: created on demand, watchdogged, and
 * terminated as soon as the export has its threads. Message bodies never leave
 * this path, and nothing about them is ever reported.
 */

import { parseThreadsWorkerMessage } from "../../app/worker-contracts.js";
import { captureError } from "../../platform/observability/sentry.js";
import { LinkedInCleaner } from "../cleaning/cleaner.js";

import { selectRecentThreads } from "./threads.js";

const WORKER_TIMEOUT_BASE_MS = 15000;
const WORKER_TIMEOUT_PER_MB_MS = 5000;
const BYTES_PER_MB = 1024 * 1024;

// Above this size, re-parsing on the UI thread would freeze the page, so the
// export drops the threads section rather than blocking on it.
const MAIN_THREAD_FALLBACK_MAX_CHARS = 5 * 1024 * 1024;

let threadsWorker = null;
let threadsRequestId = 0;
let threadsTimeoutId = null;

/**
 * Scale the watchdog with the size of the export being parsed.
 * @param {string} messagesCsv - Raw messages CSV text
 * @returns {number} Timeout in milliseconds
 */
function computeTimeout(messagesCsv) {
    const megabytes = messagesCsv.length / BYTES_PER_MB;
    return WORKER_TIMEOUT_BASE_MS + Math.floor(megabytes) * WORKER_TIMEOUT_PER_MB_MS;
}

/** Terminate the threads worker if one is running. */
export function terminateThreadsWorker() {
    if (!threadsWorker) {
        return;
    }
    threadsWorker.terminate();
    threadsWorker = null;
    clearWorkerTimeout();
}

/** Clear any in-flight worker watchdog timeout. */
function clearWorkerTimeout() {
    if (!threadsTimeoutId) {
        return;
    }
    window.clearTimeout(threadsTimeoutId);
    threadsTimeoutId = null;
}

/** Create the threads worker, leaving it null when workers are unavailable. */
function initWorker() {
    if (threadsWorker || typeof Worker === "undefined") {
        return;
    }

    try {
        threadsWorker = new Worker(new URL("./threads-worker.js", import.meta.url), {
            type: "module",
        });
    } catch (error) {
        threadsWorker = null;
        captureError(error, {
            module: "pdf-export",
            operation: "init-threads-worker",
        });
    }
}

/**
 * Select recent message threads for the export.
 *
 * Runs in a worker when one is available and falls back to the main thread for
 * small exports; a large export with no worker yields an empty list so the PDF
 * simply omits the section.
 * @param {string} messagesCsv - Raw messages CSV text
 * @param {{people?: number, messagesPerPerson?: number}} [options] - Selection limits
 * @returns {Promise<object[]>} Selected threads, newest conversation first
 */
export async function loadRecentThreads(messagesCsv, options = {}) {
    const text = typeof messagesCsv === "string" ? messagesCsv : "";
    if (!text) {
        return [];
    }

    initWorker();
    const workerThreads = await requestThreadsFromWorker(text, options);
    terminateThreadsWorker();
    if (workerThreads) {
        return workerThreads;
    }

    if (text.length > MAIN_THREAD_FALLBACK_MAX_CHARS) {
        return [];
    }
    return selectThreadsOnMainThread(text, options);
}

/**
 * Ask the worker for the thread selection.
 * @param {string} messagesCsv - Raw messages CSV text
 * @param {{people?: number, messagesPerPerson?: number}} options - Selection limits
 * @returns {Promise<object[]|null>} Threads, or null when the worker could not answer
 */
function requestThreadsFromWorker(messagesCsv, options) {
    if (!threadsWorker) {
        return Promise.resolve(null);
    }

    const requestId = ++threadsRequestId;

    return new Promise((resolve) => {
        clearWorkerTimeout();

        const handleMessage = (event) => {
            const parsed = parseThreadsWorkerMessage(event.data || {});
            if (!parsed.valid) {
                captureError(new Error("Invalid threads worker response."), {
                    module: "pdf-export",
                    operation: "threads-message-parse",
                    requestId,
                });
                return;
            }

            const message = parsed.value;
            if (message.requestId !== requestId) {
                return;
            }
            finishRequest();
            resolve(message.payload.success ? message.payload.threads : null);
        };

        const handleError = (event) => {
            captureError(
                event && event.error
                    ? event.error
                    : new Error(
                          `Threads worker ${event && event.type ? event.type : "error"} event`,
                      ),
                {
                    module: "pdf-export",
                    operation: "threads-worker-error-event",
                    requestId,
                },
            );
            finishRequest();
            resolve(null);
        };

        const finishRequest = () => {
            // handleError can fire after terminateThreadsWorker() has already
            // nulled the handle, so the guard is load-bearing.
            /* v8 ignore next 3 */
            if (threadsWorker) {
                threadsWorker.removeEventListener("message", handleMessage);
                threadsWorker.removeEventListener("error", handleError);
                threadsWorker.removeEventListener("messageerror", handleError);
            }
            clearWorkerTimeout();
        };

        threadsTimeoutId = window.setTimeout(() => {
            captureError(new Error("Threads worker request timed out."), {
                module: "pdf-export",
                operation: "threads-worker-timeout",
                requestId,
            });
            finishRequest();
            resolve(null);
        }, computeTimeout(messagesCsv));

        try {
            threadsWorker.addEventListener("message", handleMessage);
            threadsWorker.addEventListener("error", handleError);
            threadsWorker.addEventListener("messageerror", handleError);
            threadsWorker.postMessage({
                type: "threads",
                requestId,
                payload: {
                    messagesCsv,
                    people: options.people,
                    messagesPerPerson: options.messagesPerPerson,
                },
            });
        } catch (error) {
            captureError(error, {
                module: "pdf-export",
                operation: "threads-worker-post-message",
                requestId,
            });
            finishRequest();
            resolve(null);
        }
    });
}

/**
 * Select threads directly on the main thread as a fallback.
 * @param {string} messagesCsv - Raw messages CSV text
 * @param {{people?: number, messagesPerPerson?: number}} options - Selection limits
 * @returns {object[]} Selected threads
 */
function selectThreadsOnMainThread(messagesCsv, options) {
    const result = LinkedInCleaner.process(messagesCsv, "messages");
    if (!result.success) {
        return [];
    }
    return selectRecentThreads(result.cleanedData, options);
}
