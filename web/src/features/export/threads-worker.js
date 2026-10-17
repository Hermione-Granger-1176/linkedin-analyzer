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
import { copyString, createValueCache } from "../cleaning/string-pool.js";
import { canStreamFileText, readCsvSource, streamFileText } from "../upload/read.js";

import { collectContactKeys } from "./contact-keys.js";
import { exportRowBody, parseMessagesForExport, toExportRow } from "./messages-parse.js";
import { selectRecentThreadRows, selectRecentThreads } from "./threads.js";

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
 * Read the connections source for the tiebreak keys. A file that will not
 * read costs the tiebreak, as one that will not parse does.
 * @param {unknown} connectionsCsv - Stored connections Blob or CSV text
 * @returns {Promise<string>}
 */
async function readConnections(connectionsCsv) {
    try {
        return await readCsvSource(connectionsCsv);
    } catch {
        return "";
    }
}

/**
 * Stream a stored messages upload through the parser, handing each record to
 * `onRecord`. When the stream restarts in another encoding, `onRestart` runs
 * first so the caller can drop what the first attempt gathered.
 * @param {File} file - Stored messages upload
 * @param {(record: Record<string, unknown>) => void} onRecord - Receives each parsed record
 * @param {() => void} onRestart - Runs before the records are sent again
 * @returns {Promise<boolean>} Whether the stream finished as a messages file
 */
async function streamRecords(file, onRecord, onRestart) {
    let processor = LinkedInCleaner.createStreamProcessor(onRecord);
    await streamFileText(file, {
        onText: (text) => {
            processor.push(text);
        },
        onRestart: () => {
            onRestart();
            processor = LinkedInCleaner.createStreamProcessor(onRecord);
        },
    });
    const streamed = processor.finish();
    return Boolean(streamed && streamed.fileType === "messages");
}

/**
 * First pass: every export row without its body, and the number of the record
 * each row came from. Selection needs every row but none of the bodies, which
 * are most of the file.
 * @param {File} file - Stored messages upload
 * @returns {Promise<{rows: import("./messages-parse.js").MessageRow[], records: number[]}|null>} Null when the stream cannot finish as a messages file
 */
async function streamRowsWithoutBodies(file) {
    /** @type {import("./messages-parse.js").MessageRow[]} */
    let rows = [];
    /** @type {number[]} */
    let records = [];
    let recordNumber = 0;
    let cache = createValueCache();
    const finished = await streamRecords(
        file,
        (record) => {
            const row = toExportRow(record, { withBody: false, cache });
            if (row) {
                rows.push(row);
                records.push(recordNumber);
            }
            recordNumber += 1;
        },
        () => {
            rows = [];
            records = [];
            recordNumber = 0;
            cache = createValueCache();
        },
    );
    return finished ? { rows, records } : null;
}

/**
 * Second pass: read the file again and take the bodies of the selected
 * messages only. The parse is the same, so record numbers match the first pass.
 * @param {File} file - Stored messages upload
 * @param {import("./threads.js").SelectedThreadRef[]} selected - Threads whose messages name their rows
 * @param {number[]} records - Record number of each first-pass row
 * @returns {Promise<import("./threads.js").SelectedThread[]>}
 */
async function fillBodies(file, selected, records) {
    /** @type {Map<number, import("./threads.js").ThreadMessage>} */
    const wanted = new Map();
    const threads = selected.map((thread) => ({
        ...thread,
        messages: thread.messages.map(({ direction, timestamp, rowIndex }) => {
            const message = { direction, timestamp, body: "" };
            wanted.set(records[rowIndex], message);
            return message;
        }),
    }));
    let recordNumber = 0;
    await streamRecords(
        file,
        (record) => {
            const message = wanted.get(recordNumber);
            recordNumber += 1;
            if (message) {
                message.body = copyString(exportRowBody(record));
            }
        },
        () => {
            recordNumber = 0;
        },
    );
    return threads;
}

/**
 * Pick the recent threads from a stored upload in two streaming passes, so
 * neither the whole text nor every message body is held at once.
 * @param {File} file - Stored messages upload
 * @param {unknown} connectionsSource - Stored connections Blob or CSV text
 * @param {{people?: number, messagesPerPerson?: number}} limits - Selection limits
 * @returns {Promise<import("./threads.js").SelectedThread[]|null>} Null when the stream cannot finish as a messages file
 */
async function selectFromStream(file, connectionsSource, limits) {
    const firstPass = await streamRowsWithoutBodies(file);
    if (!firstPass) {
        return null;
    }
    const connectionsCsv = await readConnections(connectionsSource);
    const selected = selectRecentThreadRows(firstPass.rows, {
        ...limits,
        contactKeys: contactKeysFrom(connectionsCsv),
    });
    return fillBodies(file, selected, firstPass.records);
}

/**
 * Parse the messages CSV and pick the recent threads for the export. Each
 * file arrives as the stored upload Blob, read or streamed here, or as CSV
 * text. When a stored upload cannot be streamed as a messages file, it is
 * read whole and parsed that way instead, so failures and their messages match.
 * @param {{messagesCsv?: Blob|string, connectionsCsv?: Blob|string, people?: number, messagesPerPerson?: number}} payload - Raw payload
 * @returns {Promise<{success: boolean, threads: import("./threads.js").SelectedThread[], error: string|null}>}
 */
async function processPayload(payload) {
    const limits = { people: payload.people, messagesPerPerson: payload.messagesPerPerson };
    const value = toCsvSource(payload.messagesCsv);
    if (typeof value !== "string" && canStreamFileText(/** @type {File} */ (value))) {
        const threads = await selectFromStream(
            /** @type {File} */ (value),
            payload.connectionsCsv,
            limits,
        );
        if (threads) {
            return { success: true, threads, error: null };
        }
    }

    const result = parseMessagesForExport(await readCsvSource(payload.messagesCsv));
    const connectionsCsv = await readConnections(payload.connectionsCsv);
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
            ...limits,
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
