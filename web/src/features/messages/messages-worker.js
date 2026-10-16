/* LinkedIn Analyzer - Messages parsing worker */

import { parseMessagesWorkerRequest } from "../../app/worker-contracts.js";
import { LinkedInCleaner } from "../cleaning/cleaner.js";
import { readCsvSource } from "../upload/read.js";

import { MessagesAnalytics } from "./analytics.js";

/** @typedef {import("./analytics.js").MessageRow} MessageRow */
/** @typedef {import("./analytics.js").ConnectionRow} ConnectionRow */
/** @typedef {import("./analytics.js").MessageState} MessageState */
/** @typedef {import("./analytics.js").ConnectionState} ConnectionState */

/**
 * The fields of a LinkedInCleaner.process() result this feature reads.
 * @template Row
 * @typedef {object} CleanedRows
 * @property {boolean} success - Whether the file parsed and validated
 * @property {string|null} error - Parse error, if any
 * @property {Row[]} cleanedData - Cleaned rows
 */

/**
 * Message state flattened for structured clone: Maps and Sets become arrays.
 * @typedef {object} SerializedMessageState
 * @property {import("./analytics.js").MessageContact[]} contacts - Contacts, in insertion order
 * @property {import("./analytics.js").MessageEvents} events - Event columns (transferred)
 * @property {Float64Array<ArrayBuffer>} rowTimestamps - Row timestamps (transferred)
 * @property {number} skippedRows - Rows without a date or a participant
 * @property {string[]} talkedNameKeys - Normalized names of everyone messaged
 * @property {string[]} talkedUrlKeys - Normalized URLs of everyone messaged
 * @property {number} latestTimestamp - Latest counted message timestamp (ms)
 * @property {import("./analytics.js").OutreachSummary|null} outreach - Outreach summary
 */

/**
 * Connection state flattened for structured clone; the indexes are rebuilt on receipt.
 * @typedef {object} SerializedConnectionState
 * @property {import("./analytics.js").Connection[]} list - All connections
 */

/**
 * Processed messages payload, from the worker or the main-thread fallback.
 * The worker sends serialized state; the fallback sends cleaned rows instead.
 * @typedef {object} MessagesProcessedPayload
 * @property {boolean} success - Whether the messages file parsed
 * @property {SerializedMessageState|null} [messageState] - Serialized message state
 * @property {SerializedConnectionState|null} [connectionState] - Serialized connection state
 * @property {number} [totalInputRows] - Cleaned message rows
 * @property {string|null} [connectionError] - Connections parse error, if any
 * @property {string} [error] - Messages parse error, when success is false
 * @property {MessageRow[]} [messagesData] - Cleaned message rows (fallback only)
 * @property {ConnectionRow[]} [connectionsData] - Cleaned connection rows (fallback only)
 */

/**
 * Parse messages and connections payload. Each file arrives as the stored
 * upload Blob, read here off the main thread, or as CSV text.
 * @param {{messagesCsv?: Blob|string, connectionsCsv?: Blob|string}} payload - Raw payload
 * @returns {Promise<MessagesProcessedPayload>}
 */
async function processPayload(payload) {
    const messagesCsv = await readCsvSource(payload.messagesCsv);
    const connectionsCsv = await readCsvSource(payload.connectionsCsv);

    const messagesResult = /** @type {CleanedRows<MessageRow>} */ (
        LinkedInCleaner.process(messagesCsv, "messages")
    );
    if (!messagesResult.success) {
        return {
            success: false,
            /* v8 ignore next */
            error: messagesResult.error || "Unable to parse messages.csv.",
        };
    }

    /** @type {ConnectionRow[]} */
    let connectionsData = [];
    /** @type {string|null} */
    let connectionError = null;

    if (connectionsCsv) {
        const connectionsResult = /** @type {CleanedRows<ConnectionRow>} */ (
            LinkedInCleaner.process(connectionsCsv, "connections")
        );
        if (connectionsResult.success) {
            connectionsData = connectionsResult.cleanedData;
        } else {
            /* v8 ignore next */
            connectionError = connectionsResult.error || "Unable to parse Connections.csv.";
        }
    }

    const messagesData = messagesResult.cleanedData;
    const messageState = MessagesAnalytics.buildMessageState(messagesData);
    const connectionState = MessagesAnalytics.buildConnectionState(connectionsData);

    return {
        success: true,
        totalInputRows: messagesData.length,
        /* v8 ignore next */
        messageState: messageState ? serializeMessageState(messageState) : null,
        /* v8 ignore next */
        connectionState: connectionState ? serializeConnectionState(connectionState) : null,
        connectionError,
        /* v8 ignore next */
        messagesData: messageState ? [] : messagesData,
        /* v8 ignore next */
        connectionsData: connectionState ? [] : connectionsData,
    };
}

/**
 * Serialize message state for structured clone.
 * @param {MessageState} state - Message state with Maps/Sets
 * @returns {SerializedMessageState}
 */
function serializeMessageState(state) {
    return {
        contacts: Array.from(state.contacts.values()),
        events: state.events,
        rowTimestamps: state.rowTimestamps,
        skippedRows: state.skippedRows,
        talkedNameKeys: Array.from(state.talkedNameKeys),
        talkedUrlKeys: Array.from(state.talkedUrlKeys),
        latestTimestamp: state.latestTimestamp,
        outreach: state.outreach,
    };
}

/**
 * List the typed-array buffers in a processed payload, so posting it moves
 * them to the page instead of copying them.
 * @param {{messageState?: SerializedMessageState|null}} payload - Processed payload
 * @returns {ArrayBuffer[]}
 */
function transferablesOf(payload) {
    if (!payload.messageState) {
        return [];
    }
    const { events, rowTimestamps } = payload.messageState;
    return [events.contactIds.buffer, events.timestamps.buffer, rowTimestamps.buffer];
}

/**
 * Serialize connection state for structured clone.
 * @param {ConnectionState} state - Connection state with Maps
 * @returns {SerializedConnectionState}
 */
function serializeConnectionState(state) {
    return {
        list: state.list,
    };
}

/**
 * Convert unknown error values into a message string.
 * @param {unknown} error
 * @returns {string}
 */
function toErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    if (typeof error === "string" && error) {
        return error;
    }
    return "Messages worker runtime failure.";
}

/**
 * Post a normalized processed error payload.
 * @param {number|string} requestId
 * @param {unknown} error
 */
function postProcessedError(requestId, error) {
    self.postMessage({
        type: "processed",
        requestId,
        payload: {
            success: false,
            error: toErrorMessage(error),
        },
    });
}

/**
 * Extract an error-like value from a worker error event.
 * @param {unknown} event
 * @returns {unknown}
 */
function extractWorkerError(event) {
    /* v8 ignore next 3 */
    if (!event || typeof event !== "object") {
        return undefined;
    }
    if ("error" in event && event.error) {
        return event.error;
    }
    if ("message" in event && event.message) {
        return event.message;
    }
    return undefined;
}

/**
 * Extract rejection reason from a worker unhandledrejection event.
 * @param {unknown} event
 * @returns {unknown}
 */
function extractWorkerRejection(event) {
    if (!event || typeof event !== "object" || !("reason" in event)) {
        return undefined;
    }
    return event.reason;
}

/* v8 ignore next 19 */
if (typeof self !== "undefined") {
    self.addEventListener("message", async (event) => {
        const rawMessage = event.data || {};
        if (!rawMessage || rawMessage.type !== "process") {
            return;
        }

        const parsed = parseMessagesWorkerRequest(rawMessage);
        if (!parsed.valid) {
            postProcessedError(0, parsed.error || "Invalid worker request payload.");
            return;
        }

        const message = parsed.value;
        try {
            const payload = await processPayload(message.payload);
            self.postMessage(
                {
                    type: "processed",
                    requestId: message.requestId,
                    payload,
                },
                transferablesOf(payload),
            );
        } catch (error) {
            postProcessedError(message.requestId, error);
        }
    });

    self.addEventListener("error", (event) => {
        postProcessedError(0, extractWorkerError(event));
    });

    self.addEventListener("unhandledrejection", (event) => {
        postProcessedError(0, extractWorkerRejection(event));
    });
}

export { processPayload, transferablesOf };
