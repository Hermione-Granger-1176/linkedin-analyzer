/**
 * Transport for the PDF export's messages dashboard.
 *
 * The Messages screen has a transport of its own, and the export used to borrow
 * it; `worker-transport.js` carries why owning one outright was the answer, and
 * everything about owning it. What is here is what the messages dashboard asks
 * for and how it reads the reply.
 *
 * Nothing the worker was handed is ever reported. Every catch here discards what
 * it was given and reports a fixed error instead, because a failure while
 * parsing the user's messages can carry their text.
 */

import { parseMessagesWorkerMessage } from "../../app/worker-contracts.js";
import { captureError } from "../../platform/observability/sentry.js";
import { computeWorkerTimeout } from "../../shared/worker-timeout.js";
import { LinkedInCleaner } from "../cleaning/cleaner.js";
import { MessagesAnalytics } from "../messages/analytics.js";
import { hydrateConnectionState, hydrateMessageState } from "../messages/hydrate.js";

import {
    CANCELLED,
    createWorkerTransport,
    FAILED,
    failureOutcome,
    MAIN_THREAD_FALLBACK_MAX_CHARS,
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
 * @typedef {{messageState: object, connectionState: object|null}} MessagesState
 */

/**
 * Build the message and connection state the messages dashboard is drawn from.
 *
 * Runs in a worker when one is available and falls back to the main thread for
 * small exports. A large export without a worker returns null, so the PDF omits
 * the dashboard.
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
    return transport.request({
        envelope: { type: "process", payload: { messagesCsv, connectionsCsv } },
        parse: parseMessagesWorkerMessage,
        interpret: interpretReply,
        // The Messages screen's own budget for this same worker, which parses
        // both files: a watchdog scaled to the messages export alone would fire
        // early on a large connections file and send a parse the worker was
        // still doing to the UI thread instead.
        timeoutMs: computeWorkerTimeout(messagesCsv, connectionsCsv),
    });
}

/**
 * Read one valid worker reply into an outcome for the request in flight.
 * @param {object} message - Parsed worker message
 * @param {import("./worker-transport.js").ReplyContext} context - The request's id and error reporter
 * @returns {MessagesState|null|typeof FAILED|typeof PENDING} Outcome, or PENDING to keep waiting
 */
function interpretReply(message, context) {
    // The contract parser accepts the envelope and nulls a payload that is not a
    // plain object, so an otherwise well-formed reply can still arrive with
    // nothing on it. Reading through that would throw inside a listener, where
    // nothing is waiting to catch it, and leave the request to time out.
    if (!message.payload) {
        context.report("Messages worker response carried no payload.", "messages-message-parse");
        // Settled rather than left to the watchdog, for the same reason the
        // failure envelope below is: only one request is ever in flight, so a
        // reply this worker cannot answer under is this request failing, and
        // waiting it out would look like a hang. Null rather than FAILED,
        // because a malformed envelope says nothing about whether the file can
        // be parsed.
        return null;
    }
    if (!message.payload.success) {
        // Settled whatever id it arrived under, because only one request is ever
        // in flight and waiting out the watchdog would look like a hang. What it
        // settles as does turn on the id: see `failureOutcome`.
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
