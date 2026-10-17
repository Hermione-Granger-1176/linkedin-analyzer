/**
 * Shared lifecycle code for the export worker transports.
 *
 * Each transport owns a short-lived worker, watchdog, request settlement, and
 * cancellation path. The transport modules keep the worker request and response
 * formats because those differ by export type.
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
 * Distinct from the null "the worker could not answer" outcome, because the
 * main-thread fallback must not re-run the very work that was cancelled.
 */
const CANCELLED = Symbol("export-request-cancelled");

/**
 * Outcome of a request the worker answered with a definite failure.
 *
 * Also distinct from null: the worker has already run this exact CSV through
 * this exact code and reported that it cannot parse it, so the main thread would
 * only freeze the page to reach the same answer. The null outcome means the
 * worker mechanism never gave one, through no worker, a failed post or a
 * timeout, and only that is worth falling back for.
 */
export const FAILED = Symbol("export-request-failed");

/**
 * Verdict from an `interpret` that read a reply and decided to keep waiting.
 *
 * Distinct from every real outcome, null included: null is the answer "the
 * worker could not tell us", and this is the absence of an answer.
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
 * Read a reported failure by whether the worker attributed it to this request.
 *
 * The workers answer under the id they were asked under when they read the
 * request and it was the parse itself that failed, and under id 0 when they
 * fell over before or outside of that: a request the contract parser rejected,
 * a global `error`, an unhandled rejection. Real ids start at 1, so the two
 * cases are always told apart.
 *
 * Only the first is evidence about the file, so only the first is FAILED. A
 * worker that never read the request never touched the CSV, and a worker that
 * fell over says nothing about whether the file can be parsed, so both leave
 * the small-export fallback its job.
 *
 * The worker entry cancels every global failure event, so a crash reaches the
 * main thread only as that envelope under id 0, never as an `error` event on
 * the Worker object, and the fallback depends on reading id 0 as null.
 *
 * The request ends here either way rather than sitting out its watchdog: only
 * one request is ever in flight, and a worker that has reported it cannot
 * answer is not going to answer.
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
    // One name gives both the operation tags and the error messages, so a tag
    // and the message beside it can never end up naming different workers.
    const label = `${name[0].toUpperCase()}${name.slice(1)}`;

    /** @type {Worker|null} */
    let worker = null;
    let requestCount = 0;
    // Set and cleared with pendingRequest: a watchdog exists exactly while a
    // request is in flight.
    /** @type {number|null} */
    let timeoutId = null;
    /**
     * Settle hook for the one request that can be in flight, so termination can
     * end it and drop every reference the request was holding.
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
        // Settled before the handle is dropped, so the request still detaches
        // its listeners from the worker it was listening to.
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
        // The promise executor below runs synchronously, so this is the same
        // worker it attaches to and posts through.
        const activeWorker = worker;
        // Only one request can own the watchdog and the settle hook. A second
        // arriving while the first is in flight would adopt both, and the first
        // to be answered would then clear the second's watchdog and null its
        // settle hook, leaving that promise pending for the life of the page.
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
                // handleError can fire after terminate() has already nulled the
                // handle, so the guard is load-bearing.
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
                // Cancelling the event suppresses the browser's own reporting of
                // it, which would otherwise print the worker's error, and
                // anything of the user's caught up in it, to the console.
                if (event && typeof event.preventDefault === "function") {
                    event.preventDefault();
                }
                // event.error is never forwarded: these workers parse the raw
                // exports, so a runtime failure inside one can carry message
                // text, or the name and employer of one of the user's contacts.
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
                // A structured-clone failure names the value it could not clone,
                // and that value is one of the raw exports.
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
 * The three export transports used to carry this sequence each. Every early
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
    // The caller reached here through several storage reads, any of which the
    // user may have cancelled across. Creating the worker now would post the
    // whole CSV to it on behalf of a run whose answer nobody will read.
    if (!sources[0] || isCancelled()) {
        return empty;
    }

    const outcome = await transport.request(request());
    if (outcome === CANCELLED) {
        // Falling back here would redo on the UI thread precisely the work the
        // user asked to stop. Whoever cancelled owns the worker: either it is
        // already terminated, or a newer request is still using it.
        return empty;
    }
    // Every remaining outcome is final, so the worker has nothing left to do.
    transport.terminate();
    if (outcome === FAILED) {
        return empty;
    }
    if (outcome !== null) {
        return outcome;
    }

    // Every file counts toward the ceiling, because the fallback parses every
    // file: a small messages export beside a large connections one is not a
    // small job.
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
