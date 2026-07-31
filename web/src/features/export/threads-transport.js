/**
 * Transport for the PDF export's thread selection.
 *
 * Owns a short-lived dedicated Web Worker: created on demand, watchdogged, and
 * terminated as soon as the export has its threads. The worker is handed both
 * raw files, the messages export and the connections export it breaks a
 * self-detection tie with. Neither leaves this path, and nothing about either
 * is ever reported: every catch and every worker error event here discards what
 * it was handed and reports a fixed error instead.
 *
 * Termination is a settling event, not just a teardown. Killing the worker
 * removes every event that could have answered the in-flight request, so
 * `terminateThreadsWorker()` settles it explicitly. A request left pending
 * would keep `loadRecentThreads()` suspended for the life of the page, and its
 * frame holds both raw files.
 */

import { parseThreadsWorkerMessage } from "../../app/worker-contracts.js";
import { captureError } from "../../platform/observability/sentry.js";
import { computeWorkerTimeout } from "../messages/format.js";

import { collectContactKeys } from "./contact-keys.js";
import { parseMessagesForExport } from "./messages-parse.js";
import { selectRecentThreads } from "./threads.js";

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

/**
 * Outcome of a request the worker answered with a definite failure.
 *
 * Also distinct from null: the worker has already parsed this exact CSV with
 * this exact code and reported that it cannot yield threads. Re-running it on
 * the UI thread would freeze the page to arrive at the same answer. The null
 * outcome means the worker mechanism never gave one - no worker, a failed post,
 * a timeout - and only that is worth falling back for.
 */
const FAILED = Symbol("threads-request-failed");

let threadsWorker = null;
let threadsRequestId = 0;
// Set and cleared with pendingRequest: a watchdog exists exactly while a
// request is in flight.
let threadsTimeoutId = null;
/**
 * Settle hook for the one request that can be in flight, so termination can end
 * it and drop every reference the request was holding.
 * @type {{cancel: () => void}|null}
 */
let pendingRequest = null;

/** Clear any in-flight worker watchdog timeout. */
function clearWorkerTimeout() {
    if (!threadsTimeoutId) {
        return;
    }
    window.clearTimeout(threadsTimeoutId);
    threadsTimeoutId = null;
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
        captureError(new Error("Threads worker could not start during export."), {
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
 * @param {string} connectionsCsv - Raw connections CSV text, or an empty string
 * @param {{people?: number, messagesPerPerson?: number, isCancelled?: () => boolean}} [options] - Selection limits and the run's cancellation check
 * @returns {Promise<object[]>} Selected threads, newest conversation first
 */
export async function loadRecentThreads(messagesCsv, connectionsCsv, options = {}) {
    const text = typeof messagesCsv === "string" ? messagesCsv : "";
    const contacts = typeof connectionsCsv === "string" ? connectionsCsv : "";
    if (!text) {
        return [];
    }
    const isCancelled =
        typeof options.isCancelled === "function" ? options.isCancelled : () => false;
    // The caller reached here through several storage reads, any of which the
    // user may have cancelled across. Creating the worker now would post the
    // whole CSV to it on behalf of a run whose answer nobody will read.
    if (isCancelled()) {
        return [];
    }

    initWorker();
    const outcome = await requestThreadsFromWorker(text, contacts, options);
    if (outcome === CANCELLED) {
        // Falling back here would redo on the UI thread precisely the work the
        // user asked to stop, holding the CSV for as long as it took. Whoever
        // cancelled owns the worker: either it is already terminated, or a newer
        // request is still using it.
        return [];
    }
    // Every remaining outcome is final, so the worker has nothing left to do.
    terminateThreadsWorker();
    if (outcome === FAILED) {
        return [];
    }
    if (outcome !== null) {
        return outcome;
    }

    // Both files, because the fallback below parses both: the messages export
    // for the threads and the connections export for the tiebreak keys. The
    // ceiling used to count the messages file alone, from when the UI thread
    // derived those keys on every path and the fallback added nothing to what
    // was already happening. It is the only path that parses them now, so a
    // small messages file beside a large connections one would clear a ceiling
    // that no longer measured the work.
    if (text.length + contacts.length > MAIN_THREAD_FALLBACK_MAX_CHARS || isCancelled()) {
        return [];
    }
    return selectThreadsOnMainThread(text, contacts, options);
}

/**
 * Ask the worker for the thread selection.
 * @param {string} messagesCsv - Raw messages CSV text
 * @param {string} connectionsCsv - Raw connections CSV text
 * @param {{people?: number, messagesPerPerson?: number}} options - Selection limits
 * @returns {Promise<object[]|null|typeof CANCELLED|typeof FAILED>} Threads, null when the worker could not answer, CANCELLED, or FAILED when it answered that it could not
 */
function requestThreadsFromWorker(messagesCsv, connectionsCsv, options) {
    if (!threadsWorker) {
        return Promise.resolve(null);
    }
    // Only one request can own the module-level watchdog and settle hook. A
    // second arriving while the first is in flight would adopt both, and the
    // first to be answered would then clear the second's watchdog and null its
    // settle hook, leaving that promise pending for the life of the page.
    if (pendingRequest) {
        pendingRequest.cancel();
    }

    const requestId = ++threadsRequestId;

    return new Promise((resolve) => {
        clearWorkerTimeout();

        const finishRequest = () => {
            clearWorkerTimeout();
            // handleError can fire after terminateThreadsWorker() has already
            // nulled the handle, so the guard is load-bearing.
            /* v8 ignore next 3 */
            if (!threadsWorker) {
                return;
            }
            threadsWorker.removeEventListener("message", handleMessage);
            threadsWorker.removeEventListener("error", handleError);
            threadsWorker.removeEventListener("messageerror", handleError);
        };

        /**
         * End the request, dropping everything it was holding.
         *
         * Resolving twice is harmless, and detaching twice is guarded, so this
         * needs no latch of its own: the watchdog, a worker event and an
         * explicit cancellation may all reach it.
         * @param {object[]|null|typeof CANCELLED|typeof FAILED} result - Outcome for the caller
         */
        const settle = (result) => {
            // Identity-guarded, as both sibling transports' own hooks are. Every
            // settle path detaches the listeners and clears the watchdog before
            // it returns, so nothing can settle a request twice today and the
            // guard is defensive: it exists so that stops being something the
            // next reader has to re-derive before adding a path.
            /* v8 ignore next 3 */
            if (pendingRequest === request) {
                pendingRequest = null;
            }
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
            if (!message.payload.success) {
                // Settled whatever id it arrived under: only one request is ever
                // in flight, so a failure envelope is this request failing, and
                // waiting out the watchdog would look like a hang. The worker
                // declining to parse a file the user uploaded is the same event
                // under either id, so it is reported either way.
                captureError(new Error("Threads worker reported a failure."), {
                    module: "pdf-export",
                    operation: "threads-worker-failure",
                    requestId,
                });
                settle(FAILED);
                return;
            }
            // A stale success belongs to a request nobody is waiting on.
            if (message.requestId !== requestId) {
                return;
            }
            settle(message.payload.threads);
        };

        const handleError = (event) => {
            // Cancelling the event suppresses the browser's own reporting of it,
            // which would otherwise print the worker's error, and anything of the
            // user's caught up in it, to the console.
            if (event && typeof event.preventDefault === "function") {
                event.preventDefault();
            }
            // event.error is never forwarded: this worker parses both raw
            // exports, so a runtime failure inside it can carry message text, or
            // the name and employer of one of the user's connections.
            captureError(new Error("Threads worker failed during export."), {
                module: "pdf-export",
                operation: "threads-worker-error-event",
                requestId,
            });
            settle(null);
        };

        const request = { cancel: () => settle(CANCELLED) };
        pendingRequest = request;

        threadsWorker.addEventListener("message", handleMessage);
        threadsWorker.addEventListener("error", handleError);
        threadsWorker.addEventListener("messageerror", handleError);

        // The budget is the shared one rather than a formula of this module's
        // own: the messages transport watchdogs the very same pair of files, and
        // two different allowances over one export was an accident of this
        // module having been written first.
        threadsTimeoutId = window.setTimeout(() => {
            threadsTimeoutId = null;
            captureError(new Error("Threads worker timed out during export."), {
                module: "pdf-export",
                operation: "threads-worker-timeout",
                requestId,
            });
            settle(null);
        }, computeWorkerTimeout(messagesCsv, connectionsCsv));

        try {
            threadsWorker.postMessage({
                type: "threads",
                requestId,
                payload: {
                    messagesCsv,
                    // The file itself rather than the tiebreak keys read out of
                    // it. Deriving them here means parsing tens of thousands of
                    // connections on the UI thread, which is the very thing the
                    // worker exists to keep off it; deriving them in the worker
                    // costs the post one more string. Without either, the worker
                    // cannot break a self-detection tie the connections file
                    // could have settled, and every direction chip in a
                    // one-conversation export reads "unknown".
                    connectionsCsv,
                    people: options.people,
                    messagesPerPerson: options.messagesPerPerson,
                },
            });
        } catch {
            // A structured-clone failure names the value it could not clone, and
            // that value is one of the two raw exports.
            captureError(new Error("Threads worker request could not be sent."), {
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
 * @param {string} connectionsCsv - Raw connections CSV text
 * @param {{people?: number, messagesPerPerson?: number}} options - Selection limits
 * @returns {object[]} Selected threads
 */
function selectThreadsOnMainThread(messagesCsv, connectionsCsv, options) {
    const result = parseMessagesForExport(messagesCsv);
    if (!result.success) {
        return [];
    }
    return selectRecentThreads(result.rows, {
        people: options.people,
        messagesPerPerson: options.messagesPerPerson,
        contactKeys: mainThreadContactKeys(connectionsCsv),
    });
}

/**
 * Derive the tiebreak keys on the UI thread, for a small export with no worker.
 *
 * Parsing on this thread is what the transport exists to avoid, but this path
 * is already parsing the messages export here by definition, and the browser
 * that took it has no worker to move anything to. The alternative is a document
 * whose every direction chip reads "unknown" on exactly those browsers.
 * @param {string} connectionsCsv - Raw connections CSV text
 * @returns {string[]} Normalized keys, empty when there are none to be had
 */
function mainThreadContactKeys(connectionsCsv) {
    try {
        return collectContactKeys(connectionsCsv);
    } catch {
        // A tiebreak is a nicety, so this costs a direction chip rather than the
        // section. The caught value came from parsing the user's own
        // connections, so only a fixed error crosses into telemetry.
        captureError(new Error("Connections could not be read for the export's tiebreak."), {
            module: "pdf-export",
            operation: "contact-keys-main-thread-parse",
        });
        return [];
    }
}
