/* LinkedIn Analyzer - PDF export thread selection worker */

import { parseThreadsWorkerRequest } from "../../app/worker-contracts.js";

import { parseMessagesForExport } from "./messages-parse.js";
import { selectRecentThreads } from "./threads.js";

/**
 * Parse the messages CSV and pick the recent threads for the export.
 * @param {{messagesCsv?: string, people?: number, messagesPerPerson?: number}} payload - Raw payload
 * @returns {{success: boolean, threads: object[], error: string|null}}
 */
function processPayload(payload) {
    /* v8 ignore next */
    const messagesCsv = typeof payload.messagesCsv === "string" ? payload.messagesCsv : "";
    const result = parseMessagesForExport(messagesCsv);
    if (!result.success) {
        return {
            success: false,
            threads: [],
            /* v8 ignore next */
            error: result.error || "Unable to parse messages.csv.",
        };
    }

    return {
        success: true,
        threads: selectRecentThreads(result.rows, {
            people: payload.people,
            messagesPerPerson: payload.messagesPerPerson,
        }),
        error: null,
    };
}

/**
 * Convert unknown error values into a message string.
 * @param {unknown} error - Thrown value
 * @returns {string}
 */
function toErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    if (typeof error === "string" && error) {
        return error;
    }
    return "Threads worker runtime failure.";
}

/**
 * Post a normalized failure payload.
 * @param {number|string} requestId - Request id being answered
 * @param {unknown} error - Thrown value
 */
function postThreadsError(requestId, error) {
    self.postMessage({
        type: "threads",
        requestId,
        payload: {
            success: false,
            threads: [],
            error: toErrorMessage(error),
        },
    });
}

/**
 * Extract an error-like value from a worker error event.
 * @param {unknown} event - Error event
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
 * @param {unknown} event - Rejection event
 * @returns {unknown}
 */
function extractWorkerRejection(event) {
    if (!event || typeof event !== "object" || !("reason" in event)) {
        return undefined;
    }
    return event.reason;
}

// The id of the request being served, so a runtime failure is answered under an
// id the main thread is actually waiting on rather than a placeholder it drops.
let activeRequestId = 0;

/* v8 ignore next 17 */
if (typeof self !== "undefined") {
    self.addEventListener("message", (event) => {
        const rawMessage = event.data || {};
        if (!rawMessage || rawMessage.type !== "threads") {
            return;
        }

        const parsed = parseThreadsWorkerRequest(rawMessage);
        activeRequestId = parsed.valid ? parsed.value.requestId : parsed.requestId;
        if (!parsed.valid) {
            postThreadsError(activeRequestId, parsed.error || "Invalid worker request payload.");
            return;
        }

        const message = parsed.value;
        try {
            self.postMessage({
                type: "threads",
                requestId: message.requestId,
                payload: processPayload(message.payload),
            });
        } catch (error) {
            postThreadsError(message.requestId, error);
        }
    });

    self.addEventListener("error", (event) => {
        postThreadsError(activeRequestId, extractWorkerError(event));
    });

    self.addEventListener("unhandledrejection", (event) => {
        postThreadsError(activeRequestId, extractWorkerRejection(event));
    });
}

export { processPayload };
