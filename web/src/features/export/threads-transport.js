/**
 * Transport for the PDF export's thread selection.
 *
 * Owns a short-lived dedicated Web Worker: created on demand, watchdogged, and
 * terminated as soon as the export has its threads. Message bodies never leave
 * this path, and nothing about them is ever reported: every catch and every
 * worker error event here discards what it was handed and reports a fixed
 * error instead.
 *
 * Termination is a settling event, not just a teardown. Killing the worker
 * removes every event that could have answered the in-flight request, so
 * `terminateThreadsWorker()` settles it explicitly. A request left pending
 * would keep `loadRecentThreads()` suspended for the life of the page, and its
 * frame holds the raw messages CSV.
 */

import { parseThreadsWorkerMessage } from "../../app/worker-contracts.js";
import { captureError } from "../../platform/observability/sentry.js";

import { parseMessagesForExport } from "./messages-parse.js";
import { selectRecentThreads } from "./threads.js";

const WORKER_TIMEOUT_BASE_MS = 15000;
const WORKER_TIMEOUT_PER_MB_MS = 5000;
const BYTES_PER_MB = 1024 * 1024;

// Above this size, re-parsing on the UI thread would freeze the page, so the
// export drops the threads section rather than blocking on it.
const MAIN_THREAD_FALLBACK_MAX_CHARS = 5 * 1024 * 1024;

/**
 * Outcome of a request the caller explicitly cancelled.
 *
 * Distinct from the null "the worker could not answer" outcome, because the
 * main-thread fallback must not re-run the very work that was cancelled.
 */
const CANCELLED = Symbol("threads-request-cancelled");

let threadsWorker = null;
let threadsRequestId = 0;
let threadsTimeoutId = null;
// Settle hook for the one request that can be in flight, so termination can end
// it and drop every reference the request was holding.
let pendingRequest = null;

/**
 * Scale the watchdog with the size of the export being parsed.
 * @param {string} messagesCsv - Raw messages CSV text
 * @returns {number} Timeout in milliseconds
 */
function computeTimeout(messagesCsv) {
    const megabytes = messagesCsv.length / BYTES_PER_MB;
    return WORKER_TIMEOUT_BASE_MS + Math.floor(megabytes) * WORKER_TIMEOUT_PER_MB_MS;
}

/**
 * Terminate the threads worker and end whatever it was answering.
 *
 * Safe to call when nothing is running, and safe to call twice.
 */
export function terminateThreadsWorker() {
    if (threadsWorker) {
        threadsWorker.terminate();
    }
    // Settled before the handle is dropped, so the request still detaches its
    // listeners from the worker it was listening to.
    if (pendingRequest) {
        pendingRequest.cancel();
    }
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
    } catch {
        threadsWorker = null;
        captureError(new Error("Threads worker could not start."), {
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
 * @param {{people?: number, messagesPerPerson?: number, contactKeys?: string[]}} [options] - Selection limits and known connections
 * @returns {Promise<object[]>} Selected threads, newest conversation first
 */
export async function loadRecentThreads(messagesCsv, options = {}) {
    const text = typeof messagesCsv === "string" ? messagesCsv : "";
    if (!text) {
        return [];
    }

    initWorker();
    const workerThreads = await requestThreadsFromWorker(text, options);
    if (workerThreads === CANCELLED) {
        // Falling back here would redo on the UI thread precisely the work the
        // user asked to stop, holding the CSV for as long as it took.
        return [];
    }
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
 * @param {{people?: number, messagesPerPerson?: number, contactKeys?: string[]}} options - Selection limits and known connections
 * @returns {Promise<object[]|null|typeof CANCELLED>} Threads, null when the worker could not answer, or CANCELLED
 */
function requestThreadsFromWorker(messagesCsv, options) {
    if (!threadsWorker) {
        return Promise.resolve(null);
    }

    const requestId = ++threadsRequestId;

    return new Promise((resolve) => {
        clearWorkerTimeout();

        /**
         * End the request, dropping everything it was holding.
         *
         * Resolving twice is harmless, and detaching twice is guarded, so this
         * needs no latch of its own: the watchdog, a worker event and an
         * explicit cancellation may all reach it.
         * @param {object[]|null|typeof CANCELLED} result - Outcome for the caller
         */
        const settle = (result) => {
            pendingRequest = null;
            finishRequest();
            resolve(result);
        };

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
                // A stale success belongs to a request nobody is waiting on. A
                // failure is different: only one request is ever in flight, so a
                // failure envelope under any id is this request failing, and
                // waiting out the watchdog would look like a hang.
                if (message.payload.success) {
                    return;
                }
                captureError(new Error("Threads worker reported a failure."), {
                    module: "pdf-export",
                    operation: "threads-worker-failure",
                    requestId,
                });
            }
            settle(message.payload.success ? message.payload.threads : null);
        };

        const handleError = (event) => {
            // Cancelling the event suppresses the browser's own reporting of it,
            // which would otherwise print the worker's error - and anything of
            // the user's caught up in it - to the console.
            if (event && typeof event.preventDefault === "function") {
                event.preventDefault();
            }
            // event.error is never forwarded: this worker parses the raw messages
            // CSV, so a runtime failure inside it can carry message text.
            captureError(new Error("Threads worker failed."), {
                module: "pdf-export",
                operation: "threads-worker-error-event",
                requestId,
            });
            settle(null);
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

        pendingRequest = { cancel: () => settle(CANCELLED) };

        threadsTimeoutId = window.setTimeout(() => {
            captureError(new Error("Threads worker request timed out."), {
                module: "pdf-export",
                operation: "threads-worker-timeout",
                requestId,
            });
            settle(null);
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
        } catch {
            // A structured-clone failure names the value it could not clone, and
            // that value is the messages CSV.
            captureError(new Error("Threads worker request could not be posted."), {
                module: "pdf-export",
                operation: "threads-worker-post-message",
                requestId,
            });
            settle(null);
        }
    });
}

/**
 * Select threads directly on the main thread as a fallback.
 * @param {string} messagesCsv - Raw messages CSV text
 * @param {{people?: number, messagesPerPerson?: number, contactKeys?: string[]}} options - Selection limits and known connections
 * @returns {object[]} Selected threads
 */
function selectThreadsOnMainThread(messagesCsv, options) {
    const result = parseMessagesForExport(messagesCsv);
    if (!result.success) {
        return [];
    }
    return selectRecentThreads(result.rows, options);
}
