/**
 * Select PDF message threads through an export-owned worker.
 *
 * Passes the stored messages and connections sources to the worker. Reports
 * fixed error text only, since thrown values can contain either source.
 * worker-transport.js manages the worker, timeout, and cancellation.
 */

import { parseThreadsWorkerMessage } from "../../app/worker-contracts.ts";
import { captureError } from "../../platform/observability/sentry.js";
import { toCsvSource } from "../../shared/csv-source.js";
import { computeWorkerTimeout } from "../../shared/worker-timeout.js";

import { collectContactKeys } from "./contact-keys.js";
import { parseMessagesForExport } from "./messages-parse.js";
import { selectRecentThreads } from "./threads.js";
import {
    createWorkerTransport,
    failureOutcome,
    loadWithFallback,
    PENDING,
} from "./worker-transport.js";

const transport = createWorkerTransport({
    name: "threads",
    createWorker: () =>
        new Worker(new URL("./threads-worker.js", import.meta.url), { type: "module" }),
});

/**
 * Terminate the threads worker and end whatever it was answering.
 *
 * Safe to call when nothing is running, and safe to call twice.
 */
export function terminateThreadsWorker() {
    transport.terminate();
}

/** @typedef {import("./threads.js").SelectedThread} SelectedThread */

/**
 * Select recent message threads for the export.
 *
 * Runs in a worker when one is available and falls back to the main thread for
 * small exports; a large export with no worker yields an empty list so the PDF
 * omits the section.
 * @param {Blob|string} messagesCsv - Stored messages upload, or CSV text
 * @param {Blob|string|null} connectionsCsv - Stored connections upload, CSV text, or nothing
 * @param {{people?: number, messagesPerPerson?: number, isCancelled?: () => boolean}} [options] - Selection limits and the run's cancellation check
 * @returns {Promise<SelectedThread[]>} Selected threads, newest conversation first
 */
export function loadRecentThreads(messagesCsv, connectionsCsv, options = {}) {
    const text = toCsvSource(messagesCsv);
    const contacts = toCsvSource(connectionsCsv);
    return loadWithFallback(transport, {
        sources: [text, contacts],
        isCancelled: options.isCancelled,
        request: () => threadsRequest(text, contacts, options),
        mainThread: (messagesText, contactsText) =>
            selectThreadsOnMainThread(messagesText, contactsText, options),
        empty: /** @type {SelectedThread[]} */ ([]),
    });
}

/**
 * The worker request for the thread selection.
 * @param {Blob|string} messagesCsv - Stored messages upload, or CSV text
 * @param {Blob|string} connectionsCsv - Stored connections upload, CSV text, or an empty string
 * @param {{people?: number, messagesPerPerson?: number}} options - Selection limits
 * @returns {import("./worker-transport.js").RequestOptions<import("../../app/worker-contracts.ts").ThreadsWorkerMessage, SelectedThread[]|null|typeof import("./worker-transport.js").FAILED>}
 */
function threadsRequest(messagesCsv, connectionsCsv, options) {
    return {
        envelope: {
            type: "threads",
            payload: {
                messagesCsv,
                // The raw connections CSV. The worker derives the tiebreak keys
                // from it.
                connectionsCsv,
                people: options.people,
                messagesPerPerson: options.messagesPerPerson,
            },
        },
        parse: parseThreadsWorkerMessage,
        interpret: interpretReply,
        // The shared budget from computeWorkerTimeout, which the messages
        // transport also uses for the same pair of files.
        timeoutMs: computeWorkerTimeout(messagesCsv, connectionsCsv),
    };
}

/**
 * Read one valid worker reply into an outcome for the request in flight.
 * @param {import("../../app/worker-contracts.ts").ThreadsWorkerMessage} message - Parsed worker message
 * @param {import("./worker-transport.js").ReplyContext} context - The request's id and error reporter
 * @returns {SelectedThread[]|null|typeof import("./worker-transport.js").FAILED|typeof PENDING} Outcome, or PENDING to keep waiting
 */
function interpretReply(message, context) {
    if (!message.payload.success) {
        // A failure settles the request in flight whatever id it arrived under.
        // The outcome depends on the id, per `failureOutcome`.
        context.report("Threads worker reported a failure.", "threads-worker-failure");
        return failureOutcome(message, context);
    }
    // A stale success belongs to a request nobody is waiting on.
    if (message.requestId !== context.requestId) {
        return PENDING;
    }
    // The contract checks only that this is an array; the worker built it with
    // `selectRecentThreads`, the same selector the fallback below runs.
    return /** @type {SelectedThread[]} */ (message.payload.threads);
}

/**
 * Select threads directly on the main thread as a fallback.
 * @param {string} messagesCsv - Raw messages CSV text
 * @param {string} connectionsCsv - Raw connections CSV text
 * @param {{people?: number, messagesPerPerson?: number}} options - Selection limits
 * @returns {SelectedThread[]} Selected threads
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
 * Derive account-owner tiebreak keys on the main thread for a small export
 * when workers are unavailable. This fallback already parses messages here.
 * @param {string} connectionsCsv - Raw connections CSV text
 * @returns {string[]} Normalized keys, empty when there are none to be had
 */
function mainThreadContactKeys(connectionsCsv) {
    try {
        return collectContactKeys(connectionsCsv);
    } catch {
        // A failed tiebreak costs a direction chip, not the section. Only a fixed
        // error is reported to telemetry.
        captureError(new Error("Connections could not be read for the export's tiebreak."), {
            module: "pdf-export",
            operation: "contact-keys-main-thread-parse",
        });
        return [];
    }
}
