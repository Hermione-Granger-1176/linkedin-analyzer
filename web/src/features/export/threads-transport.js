/**
 * Transport for the PDF export's thread selection.
 *
 * The worker is handed both raw files, the messages export and the connections
 * export it breaks a self-detection tie with. Neither leaves this path, and
 * nothing about either is ever reported: every catch here discards what it was
 * handed and reports a fixed error instead.
 *
 * `worker-transport.js` owns the worker, its watchdog and its lifetime. What is
 * here is what the threads section asks for and how it reads the reply.
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
                // The file itself rather than the tiebreak keys read out of it.
                // Deriving them here means parsing tens of thousands of
                // connections on the UI thread, which is the very thing the
                // worker exists to keep off it; deriving them in the worker
                // costs the post one more string. Without either, the worker
                // cannot break a self-detection tie the connections file could
                // have settled, and every direction chip in a one-conversation
                // export reads "unknown".
                connectionsCsv,
                people: options.people,
                messagesPerPerson: options.messagesPerPerson,
            },
        },
        parse: parseThreadsWorkerMessage,
        interpret: interpretReply,
        // The budget is the shared one rather than a formula of this module's
        // own: the messages transport watchdogs the very same pair of files, and
        // two different allowances over one export was an accident of this
        // module having been written first.
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
        // Settled whatever id it arrived under, because only one request is ever
        // in flight and waiting out the watchdog would look like a hang. The
        // worker declining to parse a file the user uploaded is the same event
        // under either id, so it is reported either way; what it settles as
        // turns on the id, per `failureOutcome`.
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
