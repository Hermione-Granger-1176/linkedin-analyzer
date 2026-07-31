/**
 * PDF export thread selection worker.
 *
 * This worker is handed the raw messages CSV, so every failure inside it is
 * assumed to carry the user's own text. Two rules follow, and both are
 * load-bearing: the only failure strings that leave here are fixed literals
 * from this file, and every global failure event is cancelled so the browser's
 * own reporting - which writes the original message to the console - never
 * runs.
 */

import { parseThreadsWorkerRequest } from "../../app/worker-contracts.js";

import { parseMessagesForExport } from "./messages-parse.js";
import { selectRecentThreads } from "./threads.js";

const RUNTIME_FAILURE = "Threads worker runtime failure.";

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
 * Post a normalized failure payload.
 *
 * The message is always a fixed string chosen by this module. Nothing thrown
 * inside the worker is ever forwarded: this worker holds the raw messages CSV,
 * so a thrown value can carry a row, a name, a profile URL or a message body.
 * @param {number|string} requestId - Request id being answered
 * @param {string} message - Fixed failure text
 */
function postThreadsError(requestId, message) {
    self.postMessage({
        type: "threads",
        requestId,
        payload: {
            success: false,
            threads: [],
            error: message,
        },
    });
}

/**
 * Cancel a failure event so the browser's own error reporting stays silent.
 *
 * An uncancelled `error` or `unhandledrejection` event is reported by the
 * browser independently of any listener, and that report goes to the console
 * with the original message in it.
 * @param {Event} event - Failure event
 */
function silenceDefaultReporting(event) {
    event.preventDefault();
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
        } catch {
            postThreadsError(message.requestId, RUNTIME_FAILURE);
        }
    });

    self.addEventListener("error", (event) => {
        silenceDefaultReporting(event);
        postThreadsError(activeRequestId, RUNTIME_FAILURE);
    });

    self.addEventListener("unhandledrejection", (event) => {
        silenceDefaultReporting(event);
        postThreadsError(activeRequestId, RUNTIME_FAILURE);
    });
}

export { processPayload };
