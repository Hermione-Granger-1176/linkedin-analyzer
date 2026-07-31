/**
 * Transport for the PDF export's messages dashboard.
 *
 * The Messages screen has a transport of its own, and the export used to borrow
 * it. That was wrong twice over. Its worker, watchdog and request counter are
 * one module-level set, so a screen loading while an export runs would clear the
 * other's watchdog and leave its promise pending for the life of the page; and
 * the export could not terminate it on cancellation without killing a worker the
 * screen might be mid-request on. So the export owns this one outright, the way
 * it already owns `threads-transport.js`: created on demand, watchdogged, and
 * terminated as soon as the dashboard has its numbers.
 *
 * Termination is a settling event, not just a teardown. Killing the worker
 * removes every event that could have answered the in-flight request, so
 * `terminateMessagesWorker()` settles it explicitly; a request left pending
 * would keep its frame, and the raw messages CSV inside it, alive.
 *
 * Nothing the worker was handed is ever reported. Every catch and every worker
 * error here discards what it was given and reports a fixed error instead,
 * because a failure while parsing the user's messages can carry their text.
 */

import { parseMessagesWorkerMessage } from "../../app/worker-contracts.js";
import { captureError } from "../../platform/observability/sentry.js";
import { LinkedInCleaner } from "../cleaning/cleaner.js";
import { MessagesAnalytics } from "../messages/analytics.js";
import { computeWorkerTimeout } from "../messages/format.js";
import { hydrateConnectionState, hydrateMessageState } from "../messages/hydrate.js";

// Above this size, re-parsing on the UI thread would freeze the page, so the
// export drops the dashboard rather than blocking on it.
const MAIN_THREAD_FALLBACK_MAX_CHARS = 5 * 1024 * 1024;

/**
 * Outcome of a request the caller explicitly cancelled.
 *
 * Distinct from the null "the worker could not answer" outcome, because the
 * main-thread fallback must not re-run the very work that was cancelled.
 */
const CANCELLED = Symbol("messages-request-cancelled");

/**
 * Outcome of a request the worker answered with a definite failure.
 *
 * Also distinct from null: the worker has already run this exact CSV through
 * this exact code and reported that it cannot parse it, so the main thread
 * would only freeze the page to reach the same answer.
 */
const FAILED = Symbol("messages-request-failed");

let messagesWorker = null;
let messagesRequestId = 0;
// Set and cleared with pendingRequest: a watchdog exists exactly while a
// request is in flight.
let messagesTimeoutId = null;
/**
 * Settle hook for the one request that can be in flight, so termination can end
 * it and drop every reference the request was holding.
 * @type {{cancel: () => void}|null}
 */
let pendingRequest = null;

/** Clear any in-flight worker watchdog timeout. */
function clearWorkerTimeout() {
    if (!messagesTimeoutId) {
        return;
    }
    window.clearTimeout(messagesTimeoutId);
    messagesTimeoutId = null;
}

/**
 * Terminate the export's messages worker and end whatever it was answering.
 *
 * Safe to call when nothing is running, and safe to call twice.
 */
export function terminateMessagesWorker() {
    if (messagesWorker) {
        messagesWorker.terminate();
    }
    // Settled before the handle is dropped, so the request still detaches its
    // listeners from the worker it was listening to.
    if (pendingRequest) {
        pendingRequest.cancel();
    }
    messagesWorker = null;
    clearWorkerTimeout();
}

/** Create the messages worker, leaving it null when workers are unavailable. */
function initWorker() {
    if (messagesWorker || typeof Worker === "undefined") {
        return;
    }

    try {
        messagesWorker = new Worker(new URL("../messages/messages-worker.js", import.meta.url), {
            type: "module",
        });
    } catch {
        messagesWorker = null;
        captureError(new Error("Messages worker could not start during export."), {
            module: "pdf-export",
            operation: "init-messages-worker",
        });
    }
}

/**
 * @typedef {{messageState: object, connectionState: object|null}} MessagesState
 */

/**
 * Build the message and connection state the messages dashboard is drawn from.
 *
 * Runs in a worker when one is available and falls back to the main thread for
 * small exports; a large export with no worker yields null so the PDF simply
 * omits the dashboard.
 * @param {string} messagesCsv - Raw messages CSV text
 * @param {string} connectionsCsv - Raw connections CSV text, or an empty string
 * @param {{isCancelled?: () => boolean}} [options] - The run's cancellation check
 * @returns {Promise<MessagesState|null>} Hydrated state, or null when there is none
 */
export async function loadMessagesState(messagesCsv, connectionsCsv, options = {}) {
    const text = typeof messagesCsv === "string" ? messagesCsv : "";
    const contacts = typeof connectionsCsv === "string" ? connectionsCsv : "";
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
    const outcome = await requestStateFromWorker(text, contacts);
    if (outcome === CANCELLED) {
        // Falling back here would redo on the UI thread precisely the work the
        // user asked to stop. Whoever cancelled owns the worker: either it is
        // already terminated, or a newer request is still using it.
        return null;
    }
    // Every remaining outcome is final, so the worker has nothing left to do.
    terminateMessagesWorker();
    if (outcome === FAILED) {
        return null;
    }
    if (outcome !== null) {
        return outcome;
    }

    if (text.length + contacts.length > MAIN_THREAD_FALLBACK_MAX_CHARS || isCancelled()) {
        return null;
    }
    return buildStateOnMainThread(text, contacts);
}

/**
 * Ask the worker for the parsed message and connection state.
 * @param {string} messagesCsv - Raw messages CSV text
 * @param {string} connectionsCsv - Raw connections CSV text
 * @returns {Promise<MessagesState|null|typeof CANCELLED|typeof FAILED>} State, null when the worker could not answer, CANCELLED, or FAILED when it answered that it could not
 */
function requestStateFromWorker(messagesCsv, connectionsCsv) {
    if (!messagesWorker) {
        return Promise.resolve(null);
    }
    // Only one request can own the module-level watchdog and settle hook. A
    // second arriving while the first is in flight would adopt both, and the
    // first to be answered would then clear the second's watchdog and null its
    // settle hook, leaving that promise pending for the life of the page.
    if (pendingRequest) {
        pendingRequest.cancel();
    }

    const requestId = ++messagesRequestId;

    return new Promise((resolve) => {
        clearWorkerTimeout();

        const finishRequest = () => {
            clearWorkerTimeout();
            // handleError can fire after terminateMessagesWorker() has already
            // nulled the handle, so the guard is load-bearing.
            /* v8 ignore next 3 */
            if (!messagesWorker) {
                return;
            }
            messagesWorker.removeEventListener("message", handleMessage);
            messagesWorker.removeEventListener("error", handleError);
            messagesWorker.removeEventListener("messageerror", handleError);
        };

        /**
         * End the request, dropping everything it was holding.
         * @param {MessagesState|null|typeof CANCELLED|typeof FAILED} result - Outcome for the caller
         */
        const settle = (result) => {
            // Identity-guarded, as the threads transport's own hook is. Every
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
            const parsed = parseMessagesWorkerMessage(event.data || {});
            if (!parsed.valid) {
                captureError(new Error("Invalid messages worker response."), {
                    module: "pdf-export",
                    operation: "messages-message-parse",
                    requestId,
                });
                return;
            }

            const message = parsed.value;
            // The contract parser accepts the envelope and nulls a payload that
            // is not a plain object, so an otherwise well-formed reply can still
            // arrive with nothing on it. Reading through that would throw inside
            // a listener, where nothing is waiting to catch it, and leave the
            // request to time out.
            if (!message.payload) {
                captureError(new Error("Messages worker response carried no payload."), {
                    module: "pdf-export",
                    operation: "messages-message-parse",
                    requestId,
                });
                // Settled rather than left to the watchdog, for the same reason
                // the failure envelope below is: only one request is ever in
                // flight, so a reply this worker cannot answer under is this
                // request failing, and waiting it out would look like a hang.
                // Null rather than FAILED, because a malformed envelope says
                // nothing about whether the file can be parsed.
                settle(null);
                return;
            }
            if (!message.payload.success) {
                // Settled whatever id it arrived under: only one request is ever
                // in flight, so a failure envelope is this request failing, and
                // waiting out the watchdog would look like a hang.
                captureError(new Error("Messages worker reported a failure."), {
                    module: "pdf-export",
                    operation: "messages-worker-failure",
                    requestId,
                });
                settle(FAILED);
                return;
            }
            // A stale success belongs to a request nobody is waiting on.
            if (message.requestId !== requestId) {
                return;
            }
            settle(hydrateWorkerPayload(message.payload));
        };

        const handleError = (event) => {
            // Cancelling the event suppresses the browser's own reporting of it,
            // which would otherwise print the worker's error, and anything of the
            // user's caught up in it, to the console.
            if (event && typeof event.preventDefault === "function") {
                event.preventDefault();
            }
            // event.error is never forwarded: this worker parses the raw messages
            // CSV, so a runtime failure inside it can carry message text.
            captureError(new Error("Messages worker failed during export."), {
                module: "pdf-export",
                operation: "messages-worker-error-event",
                requestId,
            });
            settle(null);
        };

        const request = { cancel: () => settle(CANCELLED) };
        pendingRequest = request;

        messagesWorker.addEventListener("message", handleMessage);
        messagesWorker.addEventListener("error", handleError);
        messagesWorker.addEventListener("messageerror", handleError);

        messagesTimeoutId = window.setTimeout(() => {
            messagesTimeoutId = null;
            captureError(new Error("Messages worker timed out during export."), {
                module: "pdf-export",
                operation: "messages-worker-timeout",
                requestId,
            });
            settle(null);
            // The Messages screen's own budget for this same worker, which
            // parses both files: a watchdog scaled to the messages export alone
            // would fire early on a large connections file and send a parse the
            // worker was still doing to the UI thread instead.
        }, computeWorkerTimeout(messagesCsv, connectionsCsv));

        try {
            messagesWorker.postMessage({
                type: "process",
                requestId,
                payload: { messagesCsv, connectionsCsv },
            });
        } catch {
            captureError(new Error("Messages worker request could not be sent."), {
                module: "pdf-export",
                operation: "messages-worker-post-message",
                requestId,
            });
            settle(null);
        }
    });
}

/**
 * Rehydrate the Maps and Sets the worker had to flatten to send.
 * @param {object} payload - Successful worker payload
 * @returns {MessagesState|typeof FAILED} Hydrated state, or FAILED when it holds no messages
 */
function hydrateWorkerPayload(payload) {
    if (!payload.messageState) {
        // FAILED, not null: the worker parsed this exact file with this exact
        // code and produced no state, so the main thread would only freeze the
        // page to reach the same answer.
        return FAILED;
    }
    return {
        messageState: hydrateMessageState(payload.messageState),
        connectionState: payload.connectionState
            ? hydrateConnectionState(payload.connectionState)
            : null,
    };
}

/**
 * Parse and build the state on the UI thread, for a small export with no worker.
 *
 * Built here rather than by borrowing the Messages screen's fallback, which
 * answers with cleaned rows and leaves the state to its caller: a dashboard that
 * quietly disappeared whenever the browser had no worker is the bug this exists
 * to prevent.
 * @param {string} messagesCsv - Raw messages CSV text
 * @param {string} connectionsCsv - Raw connections CSV text
 * @returns {MessagesState|null} State, or null when the file cannot be parsed
 */
function buildStateOnMainThread(messagesCsv, connectionsCsv) {
    try {
        const messages = LinkedInCleaner.process(messagesCsv, "messages");
        if (!messages.success) {
            return null;
        }
        const messageState = MessagesAnalytics.buildMessageState(messages.cleanedData);
        if (!messageState) {
            return null;
        }

        // A connections file is optional, and one that will not parse costs the
        // lists that need it rather than the whole dashboard.
        const connections = connectionsCsv
            ? LinkedInCleaner.process(connectionsCsv, "connections")
            : null;
        const connectionState =
            connections && connections.success
                ? MessagesAnalytics.buildConnectionState(connections.cleanedData)
                : null;

        return { messageState, connectionState };
    } catch {
        // The caught value came from parsing the user's own messages, so only a
        // fixed error crosses into telemetry.
        captureError(new Error("Messages could not be parsed for the export."), {
            module: "pdf-export",
            operation: "messages-main-thread-parse",
        });
        return null;
    }
}
