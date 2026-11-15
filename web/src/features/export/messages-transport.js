/**
 * Load the PDF messages dashboard through an export-owned worker.
 *
 * worker-transport.js manages its lifecycle. This module builds messages
 * requests and reads replies. Reports fixed error text only.
 */

import { parseMessagesWorkerMessage } from "../../app/worker-contracts.ts";
import { captureError } from "../../platform/observability/sentry.js";
import { toCsvSource } from "../../shared/csv-source.js";
import { computeWorkerTimeout } from "../../shared/worker-timeout.js";
import { LinkedInCleaner } from "../cleaning/cleaner.js";
import { MessagesAnalytics } from "../messages/analytics.js";
import { hydrateConnectionState, hydrateMessageState } from "../messages/hydrate.js";

import {
    createWorkerTransport,
    FAILED,
    failureOutcome,
    loadWithFallback,
    PENDING,
} from "./worker-transport.js";

const transport = createWorkerTransport({
    name: "messages",
    createWorker: () =>
        new Worker(new URL("../messages/messages-worker.js", import.meta.url), {
            type: "module",
        }),
});

/**
 * Terminate the export's messages worker and end whatever it was answering.
 *
 * Safe to call when nothing is running, and safe to call twice.
 */
export function terminateMessagesWorker() {
    transport.terminate();
}

/**
 * @typedef {import("../messages/analytics.js").MessageState} MessageState
 * @typedef {import("../messages/analytics.js").ConnectionState} ConnectionState
 * @typedef {{messageState: MessageState, connectionState: ConnectionState|null}} MessagesState
 */

/**
 * A LinkedInCleaner.process() result whose rows are string records.
 * @typedef {import("../cleaning/cleaner.js").ProcessResult & {cleanedData: Array<Record<string, string>>}} CleanedRows
 */

/**
 * Build the message and connection state the messages dashboard is drawn from.
 *
 * Runs in a worker when one is available and falls back to the main thread for
 * small exports. A large export without a worker returns null, so the PDF omits
 * the dashboard.
 * @param {Blob|string} messagesCsv - Stored messages upload, or CSV text
 * @param {Blob|string|null} connectionsCsv - Stored connections upload, CSV text, or nothing
 * @param {{isCancelled?: () => boolean}} [options] - The run's cancellation check
 * @returns {Promise<MessagesState|null>} Hydrated state, or null when there is none
 */
export function loadMessagesState(messagesCsv, connectionsCsv, options = {}) {
    const text = toCsvSource(messagesCsv);
    const contacts = toCsvSource(connectionsCsv);
    return loadWithFallback(transport, {
        sources: [text, contacts],
        isCancelled: options.isCancelled,
        request: () => messagesRequest(text, contacts),
        mainThread: buildStateOnMainThread,
        empty: null,
    });
}

/**
 * The worker request for the parsed message and connection state.
 * @param {Blob|string} messagesCsv - Stored messages upload, or CSV text
 * @param {Blob|string} connectionsCsv - Stored connections upload, CSV text, or an empty string
 * @returns {import("./worker-transport.js").RequestOptions<import("../../app/worker-contracts.ts").MessagesWorkerMessage, MessagesState|null|typeof FAILED>}
 */
function messagesRequest(messagesCsv, connectionsCsv) {
    return {
        envelope: { type: "process", payload: { messagesCsv, connectionsCsv } },
        parse: parseMessagesWorkerMessage,
        interpret: interpretReply,
        // The Messages screen's budget for this worker. It is scaled to both
        // files the worker parses, not to the messages file alone.
        timeoutMs: computeWorkerTimeout(messagesCsv, connectionsCsv),
    };
}

/**
 * Read one valid worker reply into an outcome for the request in flight.
 * @param {import("../../app/worker-contracts.ts").MessagesWorkerMessage} message - Parsed worker message
 * @param {import("./worker-transport.js").ReplyContext} context - The request's id and error reporter
 * @returns {MessagesState|null|typeof FAILED|typeof PENDING} Outcome, or PENDING to keep waiting
 */
function interpretReply(message, context) {
    // The contract parser nulls a payload that is not a plain object. Reading
    // through a null payload would throw inside the listener.
    if (!message.payload) {
        context.report("Messages worker response carried no payload.", "messages-message-parse");
        // Settled here rather than left to the watchdog. Returns null rather than
        // FAILED: a malformed envelope says nothing about whether the file can be
        // parsed.
        return null;
    }
    if (!message.payload.success) {
        // A failure settles the request in flight whatever id it arrived under.
        // The outcome depends on the id: see `failureOutcome`.
        context.report("Messages worker reported a failure.", "messages-worker-failure");
        return failureOutcome(message, context);
    }
    // A stale success belongs to a request nobody is waiting on.
    if (message.requestId !== context.requestId) {
        return PENDING;
    }
    return hydrateWorkerPayload(message.payload);
}

/**
 * Rehydrate the Maps and Sets the worker had to flatten to send.
 * @param {import("../../app/worker-contracts.ts").PlainObject} payload - Successful worker payload
 * @returns {MessagesState|typeof FAILED} Hydrated state, or FAILED when it holds no messages
 */
function hydrateWorkerPayload(payload) {
    if (!payload.messageState) {
        // Returns FAILED rather than null, so the main-thread fallback does not
        // run for a file the worker already parsed without producing state.
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
 * Parse and build message state on the main thread for a small export
 * when no worker is available. Return the hydrated state the dashboard needs.
 * @param {string} messagesCsv - Raw messages CSV text
 * @param {string} connectionsCsv - Raw connections CSV text
 * @returns {MessagesState|null} State, or null when the file cannot be parsed
 */
function buildStateOnMainThread(messagesCsv, connectionsCsv) {
    try {
        const messages = /** @type {CleanedRows} */ (
            LinkedInCleaner.process(messagesCsv, "messages")
        );
        if (!messages.success) {
            return null;
        }
        const messageState = MessagesAnalytics.buildMessageState(messages.cleanedData);

        // A connections file is optional, and one that will not parse costs the
        // lists that need it rather than the whole dashboard.
        const connections = connectionsCsv
            ? /** @type {CleanedRows} */ (LinkedInCleaner.process(connectionsCsv, "connections"))
            : null;
        const connectionState =
            connections && connections.success
                ? MessagesAnalytics.buildConnectionState(connections.cleanedData)
                : null;

        return { messageState, connectionState };
    } catch {
        // Only a fixed error is reported to telemetry.
        captureError(new Error("Messages could not be parsed for the export."), {
            module: "pdf-export",
            operation: "messages-main-thread-parse",
        });
        return null;
    }
}
