/* LinkedIn Analyzer: Messages parsing worker */

import { parseMessagesWorkerRequest } from "../../app/worker-contracts.ts";
import { toCsvSource } from "../../shared/csv-source.js";
import { serveWorker } from "../../shared/worker-entry.js";
import { processCsvSource } from "../cleaning/process-source.js";

import { MessagesAnalytics } from "./analytics.js";

const CONNECTIONS_READ_ERROR = "Unable to read Connections.csv.";

/** @typedef {import("./analytics.js").MessageRow} MessageRow */
/** @typedef {import("./analytics.js").ConnectionRow} ConnectionRow */
/** @typedef {import("./analytics.js").MessageState} MessageState */
/** @typedef {import("./analytics.js").ConnectionState} ConnectionState */

/**
 * A LinkedInCleaner.process() result whose rows are typed for this feature.
 * @template Row
 * @typedef {import("../cleaning/cleaner.js").ProcessResult & {cleanedData: Row[]}} CleanedRows
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
 * upload Blob, streamed through the cleaner here off the main thread, or as
 * CSV text.
 * @param {{messagesCsv?: Blob|string, connectionsCsv?: Blob|string}} payload - Raw payload
 * @returns {Promise<MessagesProcessedPayload>}
 */
async function processPayload(payload) {
    const messagesResult = /** @type {CleanedRows<MessageRow>} */ (
        await processCsvSource(payload.messagesCsv, "messages")
    );
    if (!messagesResult.success) {
        return {
            success: false,
            error: messagesResult.error,
        };
    }

    /** @type {ConnectionRow[]} */
    let connectionsData = [];
    /** @type {string|null} */
    let connectionError = null;

    if (toCsvSource(payload.connectionsCsv)) {
        /** @type {CleanedRows<ConnectionRow>|null} */
        let connectionsResult = null;
        try {
            connectionsResult = /** @type {CleanedRows<ConnectionRow>} */ (
                await processCsvSource(payload.connectionsCsv, "connections")
            );
        } catch {
            connectionsResult = null;
        }
        if (!connectionsResult) {
            // Connections is optional. A file that cannot be read is reported like
            // one that fails to parse, and the messages still load.
            connectionError = CONNECTIONS_READ_ERROR;
        } else if (connectionsResult.success) {
            connectionsData = connectionsResult.cleanedData;
        } else {
            connectionError = connectionsResult.error;
        }
    }

    const messagesData = messagesResult.cleanedData;
    const messageState = MessagesAnalytics.buildMessageState(messagesData);
    const connectionState = MessagesAnalytics.buildConnectionState(connectionsData);

    return {
        success: true,
        totalInputRows: messagesData.length,
        messageState: serializeMessageState(messageState),
        connectionState: serializeConnectionState(connectionState),
        connectionError,
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
 * List the typed-array buffers in a processed payload for transfer. Posting
 * with them moves the buffers to the page instead of copying them.
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
 * Post a failed processed payload carrying fixed text.
 * @param {import("../../app/worker-contracts.ts").RequestId} requestId - Request id being answered
 * @param {string} error - Fixed failure text
 */
function postProcessedError(requestId, error) {
    self.postMessage({ type: "processed", requestId, payload: { success: false, error } });
}

serveWorker({
    requestType: "process",
    parse: parseMessagesWorkerRequest,
    handle: async (request) => {
        const payload = await processPayload(request.payload);
        self.postMessage(
            { type: "processed", requestId: request.requestId, payload },
            transferablesOf(payload),
        );
    },
    postFailure: postProcessedError,
    runtimeFailure: "Messages worker runtime failure.",
});

export { processPayload, transferablesOf };
