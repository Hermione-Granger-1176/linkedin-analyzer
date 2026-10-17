/**
 * PDF export thread selection worker.
 *
 * This worker is handed the raw messages CSV and the raw connections CSV, so
 * every failure inside it is assumed to carry the user's own text: a message
 * body, or the name, employer and profile URL of somebody they know. Two rules
 * follow, and both are load-bearing: the only failure strings that leave here
 * are fixed literals from this file, and every global failure event is
 * cancelled so the browser's own reporting, which writes the original message
 * to the console, never runs.
 */

import { parseThreadsWorkerRequest } from "../../app/worker-contracts.js";
import { toCsvSource } from "../../shared/csv-source.js";
import { LinkedInCleaner } from "../cleaning/cleaner.js";
import {
    canStreamFileText,
    readCsvSource,
    readOptionalCsvSource,
    streamFileText,
} from "../upload/read.js";

import { collectContactKeys } from "./contact-keys.js";
import { parseMessagesForExport, toExportRow } from "./messages-parse.js";
import { selectRecentThreads } from "./threads.js";

const RUNTIME_FAILURE = "Threads worker runtime failure.";

// The id of the request being served, so a runtime failure is answered under an
// id the main thread is actually waiting on rather than a placeholder it drops.
/** @type {import("../../app/worker-contracts.js").RequestId} */
let activeRequestId = 0;

/**
 * Derive the self-detection tiebreak keys, or none when they cannot be had.
 *
 * The connections file is parsed here rather than by the caller because the
 * caller is the UI thread, and a real connections export runs to tens of
 * thousands of rows: parsing it there held that thread long enough that the
 * Escape key which cancels an export could not reach its own handler.
 *
 * A tiebreak is a nicety, so a file that will not parse costs a direction chip
 * on a one-conversation export rather than the thread selection. Nothing about
 * the failure is described, here or anywhere else in this worker, because the
 * value that caused it came from the user's own connections.
 * @param {string} connectionsCsv - Raw connections CSV text, empty when there is none
 * @returns {string[]} Normalized keys, empty when there are none to be had
 */
function contactKeysFrom(connectionsCsv) {
    try {
        return collectContactKeys(connectionsCsv);
    } catch {
        return [];
    }
}

/**
 * Parse the messages source into export rows. A stored upload streams through
 * the parser, so neither its whole text nor a second copy of every record is
 * held. When the stream cannot finish as a messages file, the source is read
 * whole and parsed that way instead, so failures and their messages match.
 * @param {unknown} source - Stored messages Blob or CSV text
 * @returns {Promise<{success: boolean, rows: import("./messages-parse.js").MessageRow[], error: string|null}>}
 */
async function parseMessagesSource(source) {
    const value = toCsvSource(source);
    if (typeof value !== "string" && canStreamFileText(/** @type {File} */ (value))) {
        /** @type {import("./messages-parse.js").MessageRow[]} */
        let rows = [];
        /** @param {Record<string, unknown>} record */
        const onRecord = (record) => {
            const row = toExportRow(record);
            if (row) {
                rows.push(row);
            }
        };
        let processor = LinkedInCleaner.createStreamProcessor(onRecord);
        await streamFileText(/** @type {File} */ (value), {
            onText: (text) => {
                processor.push(text);
            },
            onRestart: () => {
                rows = [];
                processor = LinkedInCleaner.createStreamProcessor(onRecord);
            },
        });
        const streamed = processor.finish();
        if (streamed && streamed.fileType === "messages") {
            return { success: true, rows, error: null };
        }
        rows = [];
    }
    return parseMessagesForExport(await readCsvSource(source));
}

/**
 * Parse the messages CSV and pick the recent threads for the export. Each
 * file arrives as the stored upload Blob, read or streamed here, or as CSV
 * text.
 * @param {{messagesCsv?: Blob|string, connectionsCsv?: Blob|string, people?: number, messagesPerPerson?: number}} payload - Raw payload
 * @returns {Promise<{success: boolean, threads: import("./threads.js").SelectedThread[], error: string|null}>}
 */
async function processPayload(payload) {
    const result = await parseMessagesSource(payload.messagesCsv);
    // A Connections file that will not read costs the tiebreak, as one that
    // will not parse does.
    const { text: connectionsCsv } = await readOptionalCsvSource(payload.connectionsCsv);
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
            contactKeys: contactKeysFrom(connectionsCsv),
        }),
        error: null,
    };
}

/**
 * Post a normalized failure payload.
 *
 * The message is always a fixed string chosen by this module. Nothing thrown
 * inside the worker is ever forwarded: this worker holds the raw messages CSV
 * and the raw connections CSV, so a thrown value can carry a row, a name, an
 * employer, a profile URL or a message body.
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

/* v8 ignore next 17 */
if (typeof self !== "undefined") {
    self.addEventListener("message", async (event) => {
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
                payload: await processPayload(message.payload),
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
