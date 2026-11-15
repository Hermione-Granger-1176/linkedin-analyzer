/**
 * Shared lifecycle code for the export worker transports.
 *
 * Each transport owns a short-lived worker, watchdog, request settlement, and
 * cancellation path. The transport modules define the worker request and
 * response formats, which differ by export type.
 *
 * Worker errors use fixed messages. They must not include uploaded message text,
 * names, employers, or other export data.
 */

import { captureError } from "../../platform/observability/sentry.js";
import { csvSourceSize } from "../../shared/csv-source.js";
import { MAIN_THREAD_FALLBACK_MAX_CHARS } from "../../shared/limits.js";
import { readCsvSourcesOrNull, readOptionalCsvSource } from "../upload/read.js";

/**
 * Outcome of a request the caller explicitly cancelled.
 *
 * Distinct from null, which means the worker could not answer. A cancelled
 * request never falls back to the main thread.
 */
const CANCELLED = Symbol("export-request-cancelled");

/**
 * Outcome of a request the worker answered with a definite failure.
 *
 * Also distinct from null. The worker parsed the file and reported that it cannot
 * be parsed. Null means the worker mechanism gave no answer (no worker, a failed
 * post, or a timeout), and only null falls back to the main thread.
 */
export const FAILED = Symbol("export-request-failed");

/**
 * Verdict from an `interpret` that read a reply and decided to keep waiting.
 *
 * Not an outcome. The request keeps waiting for another reply.
 */
export const PENDING = Symbol("export-request-pending");

/**
 * @typedef {object} ReplyContext
 * @property {number} requestId - Id the in-flight request was posted under, to recognize its own replies
 * @property {(message: string, operation: string) => void} report - Report a fixed error against this request
 */

/**
 * @template M, R
 * @typedef {object} RequestOptions
 * @property {{type: string, payload: object}} envelope - Message to post, which the transport stamps with the request id
 * @property {(data: unknown) => import("../../app/worker-contracts.ts").ParseResult<M>} parse - Contract parser for replies
 * @property {(message: M, context: ReplyContext) => R|typeof PENDING} interpret - Read one valid reply into an outcome, or PENDING to keep waiting
 * @property {number} timeoutMs - Watchdog budget for this request
 */

/**
 * @typedef {object} WorkerTransport
 * @property {() => void} terminate - Terminate the worker and settle whatever it was answering
 * @property {<M, R>(options: RequestOptions<M, R>) => Promise<R|null|typeof CANCELLED>} request - Post one request and wait for its outcome
 */

/**
 * Distinguish a failed parse from a worker failure outside the request.
 *
 * A failed parse uses the request's id, which starts at 1. Contract rejection,
 * a global error, or an unhandled rejection uses id 0.
 *
 * Returns FAILED for a parse failure attributed to this request. Returns null
 * for id 0, which permits the main-thread fallback. A failure outside the
 * request does not establish whether the file can be parsed.
 *
 * The worker entry cancels global failure events and sends an id 0 envelope,
 * which is read as null.
 *
 * Settle the request right after either failure. Only one request is active,
 * so no other request can own the failure.
 * @param {{requestId: import("../../app/worker-contracts.ts").RequestId}} message - Parsed reply reporting a failure
 * @param {ReplyContext} context - The request's id and error reporter
 * @returns {null|typeof FAILED} FAILED when the worker attributed the failure to this request, null otherwise
 */
export function failureOutcome(message, context) {
    return message.requestId === context.requestId ? FAILED : null;
}

/**
 * Create the worker-owning half of an export transport.
 * @param {{name: string, createWorker: () => Worker}} config - Lowercase transport name, and how to construct its worker
 * @returns {WorkerTransport} A transport owning one worker at a time
 */
export function createWorkerTransport(config) {
    const { name, createWorker } = config;
    // One name gives both the operation tags and the error messages.
    const label = `${name[0].toUpperCase()}${name.slice(1)}`;

    /** @type {Worker|null} */
    let worker = null;
    let requestCount = 0;
    // Set and cleared with pendingRequest: a watchdog exists exactly while a
    // request is in flight.
    /** @type {number|null} */
    let timeoutId = null;
    /**
     * Settle hook for the in-flight request. Termination uses it to end the
     * request and release its references.
     * @type {{cancel: () => void}|null}
     */
    let pendingRequest = null;

    /**
     * Report a fixed error, never the value that prompted it.
     * @param {string} message - Fixed error text
     * @param {string} operation - Sentry operation tag
     * @param {object} [context] - Extra tags, such as the request id
     */
    const report = (message, operation, context) => {
        captureError(new Error(message), { module: "pdf-export", operation, ...context });
    };

    /** Clear any in-flight worker watchdog timeout. */
    const clearWorkerTimeout = () => {
        if (!timeoutId) {
            return;
        }
        window.clearTimeout(timeoutId);
        timeoutId = null;
    };

    /**
     * Terminate the worker and end whatever it was answering.
     *
     * Safe to call when nothing is running, and safe to call twice.
     */
    const terminate = () => {
        if (worker) {
            worker.terminate();
        }
        // Settled before the handle is dropped, so the request detaches its
        // listeners from that worker.
        if (pendingRequest) {
            pendingRequest.cancel();
        }
        worker = null;
        clearWorkerTimeout();
    };

    /** Create the worker, leaving it null when workers are unavailable. */
    const initWorker = () => {
        if (worker || typeof Worker === "undefined") {
            return;
        }

        try {
            worker = createWorker();
        } catch {
            worker = null;
            report(`${label} worker could not start during export.`, `init-${name}-worker`);
        }
    };

    /**
     * Post one request to the worker and wait for whatever settles it.
     * @template M, R
     * @param {RequestOptions<M, R>} options - What to ask, how to read the reply, and how long to wait
     * @returns {Promise<R|null|typeof CANCELLED>} The interpreted outcome, CANCELLED, or null when the mechanism never got an answer
     */
    const request = (options) => {
        const { envelope, parse, interpret, timeoutMs } = options;

        initWorker();
        if (!worker) {
            return Promise.resolve(null);
        }
        // Captured so the promise executor uses the same worker it attaches to and
        // posts through.
        const activeWorker = worker;
        // Only one request owns the watchdog and settle hook, so an in-flight
        // request is cancelled before a new one starts.
        if (pendingRequest) {
            pendingRequest.cancel();
        }

        const requestId = ++requestCount;

        /**
         * Report a fixed error tagged with the request it belongs to.
         * @param {string} message - Fixed error text
         * @param {string} operation - Sentry operation tag
         */
        const reportRequest = (message, operation) => {
            report(message, operation, { requestId });
        };

        return new Promise((resolve) => {
            clearWorkerTimeout();

            const finishRequest = () => {
                clearWorkerTimeout();
                // handleError can run after terminate() has cleared the handle, so
                // the handle is checked first.
                /* v8 ignore next 3 */
                if (!worker) {
                    return;
                }
                worker.removeEventListener("message", handleMessage);
                worker.removeEventListener("error", handleError);
                worker.removeEventListener("messageerror", handleError);
            };

            /**
             * End the request, dropping everything it was holding.
             * @param {R|null|typeof CANCELLED} result - Outcome for the caller
             */
            const settle = (result) => {
                // Every completion path removes listeners and clears the watchdog.
                // Only the current request may clear pendingRequest, so stale
                // completion paths cannot clear the newer request's pointer.
                /* v8 ignore next 3 */
                if (pendingRequest === entry) {
                    pendingRequest = null;
                }
                finishRequest();
                resolve(result);
            };

            /** @param {MessageEvent} event - Worker reply */
            const handleMessage = (event) => {
                const parsed = parse(event.data || {});
                if (!parsed.valid) {
                    reportRequest(`Invalid ${name} worker response.`, `${name}-message-parse`);
                    return;
                }

                const outcome = interpret(parsed.value, {
                    requestId,
                    report: reportRequest,
                });
                if (outcome !== PENDING) {
                    settle(outcome);
                }
            };

            /** @param {Event} event - Worker error or messageerror event */
            const handleError = (event) => {
                // Cancels the event so the browser does not log it to the console.
                if (event && typeof event.preventDefault === "function") {
                    event.preventDefault();
                }
                // event.error is never forwarded, since it can carry export data.
                reportRequest(
                    `${label} worker failed during export.`,
                    `${name}-worker-error-event`,
                );
                settle(null);
            };

            const entry = { cancel: () => settle(CANCELLED) };
            pendingRequest = entry;

            activeWorker.addEventListener("message", handleMessage);
            activeWorker.addEventListener("error", handleError);
            activeWorker.addEventListener("messageerror", handleError);

            timeoutId = window.setTimeout(() => {
                timeoutId = null;
                reportRequest(`${label} worker timed out during export.`, `${name}-worker-timeout`);
                settle(null);
            }, timeoutMs);

            try {
                activeWorker.postMessage({ ...envelope, requestId });
            } catch {
                // The thrown error is not forwarded, since it can name an uploaded value.
                reportRequest(
                    `${label} worker request could not be sent.`,
                    `${name}-worker-post-message`,
                );
                settle(null);
            }
        });
    };

    return { terminate, request };
}

/**
 * @template R, E
 * @typedef {object} LoadOptions
 * @property {Array<Blob|string>} sources - The files the load reads, the required one first; "" for an absent optional one
 * @property {(() => boolean)|undefined} [isCancelled] - The run's cancellation check
 * @property {() => RequestOptions<any, R|null|typeof FAILED>} request - The worker request for these sources
 * @property {(...texts: string[]) => R|E} mainThread - The same work on the UI thread, over the sources read as text
 * @property {E} empty - The answer when there is nothing to draw
 */

/**
 * Run one export load: the worker first, then the UI thread for a small export
 * the worker mechanism could not answer.
 *
 * Shared by the threads, messages, and connections transports. Every early
 * return lands on `empty`, so the PDF omits the section rather than failing.
 * @template R, E
 * @param {WorkerTransport} transport - The transport owning the worker
 * @param {LoadOptions<R, E>} options - What to load and how
 * @returns {Promise<R|E>} The loaded data, or `empty`
 */
export async function loadWithFallback(transport, options) {
    const { sources, request, mainThread, empty } = options;
    const isCancelled =
        typeof options.isCancelled === "function" ? options.isCancelled : () => false;
    // Checked before a worker is created, so a cancelled run posts nothing.
    if (!sources[0] || isCancelled()) {
        return empty;
    }

    const outcome = await transport.request(request());
    if (outcome === CANCELLED) {
        // A cancelled request does not fall back to the main thread. Whoever
        // cancelled owns the worker: it is already terminated, or a newer request
        // is using it.
        return empty;
    }
    // Any other outcome is final, so the worker is terminated.
    transport.terminate();
    if (outcome === FAILED) {
        return empty;
    }
    if (outcome !== null) {
        return outcome;
    }

    // Every file counts toward the size ceiling, since the fallback parses all of them.
    const size = sources.reduce((total, source) => total + csvSourceSize(source), 0);
    if (size > MAIN_THREAD_FALLBACK_MAX_CHARS || isCancelled()) {
        return empty;
    }
    // Only the first file is required; an unreadable optional one reads as
    // absent rather than dropping the section.
    const [required, ...optional] = sources;
    const texts = await readCsvSourcesOrNull(required);
    const extras = await Promise.all(optional.map((source) => readOptionalCsvSource(source)));
    if (!texts || isCancelled()) {
        return empty;
    }
    return mainThread(texts[0], ...extras.map((extra) => extra.text));
}
