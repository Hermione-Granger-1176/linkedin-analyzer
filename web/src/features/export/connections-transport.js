/**
 * Transport for the PDF export's connections dashboard.
 *
 * The dashboard used to clean and aggregate the connections export inline, on
 * the UI thread, in the middle of `collectExportData`. A real export runs to
 * tens of thousands of rows, and while that block held the thread nothing else
 * could run on it - including the Escape key handler the dialog promises will
 * cancel an export at any point, mid-generation included. The Connections screen
 * has done this same work in a worker from the start, so the export runs that
 * worker rather than a second copy of the arithmetic.
 *
 * Owned outright rather than borrowed from that screen, exactly as
 * `messages-transport.js` is: the screen keeps its worker, its watchdog and its
 * request counter in one module-level set, so a screen loading while an export
 * runs would clear the other's watchdog and leave its promise pending for the
 * life of the page, and the export could not terminate it on cancellation
 * without killing a worker the screen might be mid-request on.
 *
 * Termination is a settling event, not just a teardown. Killing the worker
 * removes every event that could have answered the in-flight request, so
 * `terminateConnectionsWorker()` settles it explicitly; a request left pending
 * would keep its frame, and the raw connections CSV inside it, alive.
 *
 * Nothing the worker was handed is ever reported. Every catch and every worker
 * error here discards what it was given and reports a fixed error instead,
 * because a failure while parsing the user's connections can carry the names,
 * employers and profile URLs of everyone they know.
 */

import { parseConnectionsWorkerMessage } from "../../app/worker-contracts.js";
import { captureError } from "../../platform/observability/sentry.js";
import { LinkedInCleaner } from "../cleaning/cleaner.js";
import { buildGrowthTimeline, computeStats, normalizeConnectionRows } from "../connections/view.js";
import { computeWorkerTimeout } from "../messages/format.js";

// Above this size, re-parsing on the UI thread would freeze the page, so the
// export drops the dashboard rather than blocking on it.
const MAIN_THREAD_FALLBACK_MAX_CHARS = 5 * 1024 * 1024;

/**
 * Outcome of a request the caller explicitly cancelled.
 *
 * Distinct from the null "the worker could not answer" outcome, because the
 * main-thread fallback must not re-run the very work that was cancelled.
 */
const CANCELLED = Symbol("connections-request-cancelled");

/**
 * Outcome of a request the worker answered with a definite failure.
 *
 * Also distinct from null: the worker has already run this exact CSV through
 * this exact code and reported that it cannot parse it, so the main thread
 * would only freeze the page to reach the same answer.
 */
const FAILED = Symbol("connections-request-failed");

let connectionsWorker = null;
let connectionsRequestId = 0;
// Set and cleared with pendingRequest: a watchdog exists exactly while a
// request is in flight.
let connectionsTimeoutId = null;
/**
 * Settle hook for the one request that can be in flight, so termination can end
 * it and drop every reference the request was holding.
 * @type {{cancel: () => void}|null}
 */
let pendingRequest = null;

/** Clear any in-flight worker watchdog timeout. */
function clearWorkerTimeout() {
    if (!connectionsTimeoutId) {
        return;
    }
    window.clearTimeout(connectionsTimeoutId);
    connectionsTimeoutId = null;
}

/**
 * Terminate the export's connections worker and end whatever it was answering.
 *
 * Safe to call when nothing is running, and safe to call twice.
 */
export function terminateConnectionsWorker() {
    if (connectionsWorker) {
        connectionsWorker.terminate();
    }
    // Settled before the handle is dropped, so the request still detaches its
    // listeners from the worker it was listening to.
    if (pendingRequest) {
        pendingRequest.cancel();
    }
    connectionsWorker = null;
    clearWorkerTimeout();
}

/** Create the connections worker, leaving it null when workers are unavailable. */
function initWorker() {
    if (connectionsWorker || typeof Worker === "undefined") {
        return;
    }

    try {
        connectionsWorker = new Worker(
            new URL("../connections/connections-worker.js", import.meta.url),
            { type: "module" },
        );
    } catch {
        connectionsWorker = null;
        captureError(new Error("Connections worker could not start during export."), {
            module: "pdf-export",
            operation: "init-connections-worker",
        });
    }
}

/**
 * @typedef {object} ConnectionsData
 * @property {import("../connections/view.js").ConnectionRow[]} rows - Cleaned rows, in the shape the view aggregates
 * @property {object[]} timeline - All-time growth timeline
 * @property {object|null} stats - Whole-network summary stats
 */

/**
 * Build the rows, timeline and stats the connections dashboard is drawn from.
 *
 * Runs in a worker when one is available and falls back to the main thread for
 * small exports; a large export with no worker yields null so the PDF simply
 * omits the dashboard.
 * @param {string} connectionsCsv - Raw connections CSV text, or an empty string
 * @param {{isCancelled?: () => boolean}} [options] - The run's cancellation check
 * @returns {Promise<ConnectionsData|null>} Dashboard data, or null when there is none
 */
export async function loadConnectionsData(connectionsCsv, options = {}) {
    const text = typeof connectionsCsv === "string" ? connectionsCsv : "";
    if (!text) {
        return null;
    }
    const isCancelled =
        typeof options.isCancelled === "function" ? options.isCancelled : () => false;
    // The caller reached here through several storage reads, any of which the
    // user may have cancelled across. Creating the worker now would post the
    // whole CSV to it on behalf of a run whose answer nobody will read.
    if (isCancelled()) {
        return null;
    }

    initWorker();
    const outcome = await requestDataFromWorker(text);
    if (outcome === CANCELLED) {
        // Falling back here would redo on the UI thread precisely the work the
        // user asked to stop. Whoever cancelled owns the worker: either it is
        // already terminated, or a newer request is still using it.
        return null;
    }
    // Every remaining outcome is final, so the worker has nothing left to do.
    terminateConnectionsWorker();
    if (outcome === FAILED) {
        return null;
    }
    if (outcome !== null) {
        return outcome;
    }

    if (text.length > MAIN_THREAD_FALLBACK_MAX_CHARS || isCancelled()) {
        return null;
    }
    return buildDataOnMainThread(text);
}

/**
 * Ask the worker for the cleaned rows and the aggregates over them.
 * @param {string} connectionsCsv - Raw connections CSV text
 * @returns {Promise<ConnectionsData|null|typeof CANCELLED|typeof FAILED>} Data, null when the worker could not answer, CANCELLED, or FAILED when it answered that it could not
 */
function requestDataFromWorker(connectionsCsv) {
    if (!connectionsWorker) {
        return Promise.resolve(null);
    }
    // Only one request can own the module-level watchdog and settle hook. A
    // second arriving while the first is in flight would adopt both, and the
    // first to be answered would then clear the second's watchdog and null its
    // settle hook, leaving that promise pending for the life of the page.
    if (pendingRequest) {
        pendingRequest.cancel();
    }

    const requestId = ++connectionsRequestId;

    return new Promise((resolve) => {
        clearWorkerTimeout();

        const finishRequest = () => {
            clearWorkerTimeout();
            // handleError can fire after terminateConnectionsWorker() has
            // already nulled the handle, so the guard is load-bearing.
            /* v8 ignore next 3 */
            if (!connectionsWorker) {
                return;
            }
            connectionsWorker.removeEventListener("message", handleMessage);
            connectionsWorker.removeEventListener("error", handleError);
            connectionsWorker.removeEventListener("messageerror", handleError);
        };

        /**
         * End the request, dropping everything it was holding.
         * @param {ConnectionsData|null|typeof CANCELLED|typeof FAILED} result - Outcome for the caller
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
            const parsed = parseConnectionsWorkerMessage(event.data || {});
            if (!parsed.valid) {
                captureError(new Error("Invalid connections worker response."), {
                    module: "pdf-export",
                    operation: "connections-message-parse",
                    requestId,
                });
                return;
            }

            const message = parsed.value;
            if (message.type === "error") {
                // The worker posts this envelope under whatever id it could
                // read, which is zero when it could not read the request at all,
                // so it settles the one request in flight whatever id it names.
                // FAILED rather than null: it either threw parsing this exact
                // file, or refused a payload so large the main-thread ceiling
                // below would turn it away anyway.
                captureError(new Error("Connections worker reported an error."), {
                    module: "pdf-export",
                    operation: "connections-worker-error-payload",
                    requestId,
                });
                settle(FAILED);
                return;
            }
            // The contract parser normalizes every field of a processed payload
            // and always hands back an object, so there is nothing to guard
            // before reading `success` - unlike its messages sibling, which
            // passes the payload through and nulls one that is not an object.
            if (!message.payload.success) {
                // Settled whatever id it arrived under: only one request is ever
                // in flight, so a failure envelope is this request failing, and
                // waiting out the watchdog would look like a hang.
                captureError(new Error("Connections worker reported a failure."), {
                    module: "pdf-export",
                    operation: "connections-worker-failure",
                    requestId,
                });
                settle(FAILED);
                return;
            }
            // A stale success belongs to a request nobody is waiting on. It is
            // dropped before the emptied-payload check below rather than after
            // it, as the messages transport does: an emptied payload settles
            // this request, and the reply that settles it has to be its own.
            if (message.requestId !== requestId) {
                return;
            }
            const data = toConnectionsData(message.payload);
            if (!data) {
                captureError(new Error("Connections worker response carried no data."), {
                    module: "pdf-export",
                    operation: "connections-message-parse",
                    requestId,
                });
                // Settled rather than left to the watchdog, for the same reason
                // the failure envelope above is. Null rather than FAILED,
                // because a reply the parser had to empty out says nothing about
                // whether the file itself can be parsed.
                settle(null);
                return;
            }
            settle(data);
        };

        const handleError = (event) => {
            // Cancelling the event suppresses the browser's own reporting of it,
            // which would otherwise print the worker's error, and anything of the
            // user's caught up in it, to the console.
            if (event && typeof event.preventDefault === "function") {
                event.preventDefault();
            }
            // event.error is never forwarded: this worker parses the raw
            // connections CSV, so a runtime failure inside it can carry the
            // names and employers it was reading.
            captureError(new Error("Connections worker failed during export."), {
                module: "pdf-export",
                operation: "connections-worker-error-event",
                requestId,
            });
            settle(null);
        };

        const request = { cancel: () => settle(CANCELLED) };
        pendingRequest = request;

        connectionsWorker.addEventListener("message", handleMessage);
        connectionsWorker.addEventListener("error", handleError);
        connectionsWorker.addEventListener("messageerror", handleError);

        connectionsTimeoutId = window.setTimeout(() => {
            connectionsTimeoutId = null;
            captureError(new Error("Connections worker timed out during export."), {
                module: "pdf-export",
                operation: "connections-worker-timeout",
                requestId,
            });
            settle(null);
            // The same size-scaled budget the messages parse is given, with no
            // messages file in it: a fixed watchdog would fire early on the
            // large connections export this transport exists for and send the
            // parse the worker was still doing to the UI thread instead.
        }, computeWorkerTimeout("", connectionsCsv));

        try {
            connectionsWorker.postMessage({
                type: "process",
                requestId,
                payload: { connectionsCsv },
            });
        } catch {
            captureError(new Error("Connections worker request could not be sent."), {
                module: "pdf-export",
                operation: "connections-worker-post-message",
                requestId,
            });
            settle(null);
        }
    });
}

/**
 * Read a successful worker payload into the shape the dashboard is drawn from.
 *
 * The rows are normalized here rather than by the caller so both paths below
 * answer with one shape, and because the worker cannot do it: it sends the
 * cleaned rows on to the Connections screen, which filters them by a range this
 * export does not have.
 * @param {object} payload - Successful worker payload
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
        rows: normalizeConnectionRows(payload.rows),
        // Neither field inside analytics is validated by the contract, which
        // checks only that the object is one, so both are taken the way the
        // Connections screen takes them.
        timeline: Array.isArray(payload.analytics.growthTimeline)
            ? payload.analytics.growthTimeline
            : [],
        stats: payload.analytics.stats || null,
    };
}

/**
 * Parse and aggregate on the UI thread, for a small export with no worker.
 * @param {string} connectionsCsv - Raw connections CSV text
 * @returns {ConnectionsData|null} Data, or null when the file cannot be parsed
 */
function buildDataOnMainThread(connectionsCsv) {
    try {
        const processed = LinkedInCleaner.process(connectionsCsv, "connections");
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
