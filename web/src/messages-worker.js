/* LinkedIn Analyzer - Messages parsing worker */

import { LinkedInCleaner } from "./cleaner.js";
import { MessagesAnalytics } from "./messages-analytics.js";
import { parseMessagesWorkerRequest } from "./worker-contracts.js";

/**
 * Parse messages and connections CSV payload.
 * @param {{messagesCsv?: string, connectionsCsv?: string}} payload - Raw CSV payload
 * @returns {{success: boolean, messageState?: object, connectionState?: object, totalInputRows?: number, connectionError?: string|null, error?: string, messagesData?: object[], connectionsData?: object[]}}
 */
function processPayload(payload) {
    /* v8 ignore next */
    const messagesCsv = typeof payload.messagesCsv === "string" ? payload.messagesCsv : "";
    /* v8 ignore next */
    const connectionsCsv = typeof payload.connectionsCsv === "string" ? payload.connectionsCsv : "";

    const messagesResult = LinkedInCleaner.process(messagesCsv, "messages");
    if (!messagesResult.success) {
        return {
            success: false,
            /* v8 ignore next */
            error: messagesResult.error || "Unable to parse messages.csv.",
        };
    }

    let connectionsData = [];
    let connectionError = null;

    if (connectionsCsv) {
        const connectionsResult = LinkedInCleaner.process(connectionsCsv, "connections");
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
 * @param {object} state - Message state with Maps/Sets
 * @returns {object}
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
    };
}

/**
 * Serialize connection state for structured clone.
 * @param {object} state - Connection state with Maps
 * @returns {object}
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

/* v8 ignore next 16 */
if (typeof self !== "undefined") {
    self.addEventListener("message", (event) => {
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
            const payload = processPayload(message.payload);
            self.postMessage({
                type: "processed",
                requestId: message.requestId,
                payload,
            });
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

export { processPayload };
