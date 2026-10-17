/* Runtime contracts for worker request/response payloads */

import { FILE_TYPES as FILE_TYPE_LIST } from "../shared/constants.js";
import { MAX_CSV_CHARS, MAX_FILE_BYTES } from "../shared/limits.js";

const FILE_TYPES = new Set(FILE_TYPE_LIST);

/** Rows of a cleaned file the Clean screen previews. */
export const CLEAN_PREVIEW_MAX_ROWS = 5;

const LIMITS = Object.freeze({
    maxCsvChars: MAX_CSV_CHARS,
    maxFileBytes: MAX_FILE_BYTES,
    maxFileNameChars: 255,
    maxJobIdChars: 128,
    maxMessageChars: 500,
    // Ceilings for the PDF export's thread selection. They bound the work the
    // worker will do, and double as the defaults, so they must match
    // DEFAULT_PEOPLE and DEFAULT_MESSAGES_PER_PERSON in features/export/threads.js.
    maxThreadPeople: 10,
    maxThreadMessagesPerPerson: 5,
});

/**
 * Outcome of a contract parse: the normalized value, or why it was rejected.
 * @template T
 * @typedef {{valid: true, value: T} | {valid: false, error: string}} ParseResult
 */

/** @typedef {number|string} RequestId - Correlates a worker reply with its request */
/** @typedef {Blob|string} CsvSource - A stored upload Blob, or CSV text already read */
/** @typedef {Record<string, unknown>} PlainObject - Opaque plain-object payload */
/** @typedef {"preview"|"xlsx"|"csv"} CleanOutput - Output a cleaning request asks for */

/**
 * @typedef {object} AddFilePayload
 * @property {Blob|null} file - Uploaded file for the worker to read
 * @property {string} csvText - CSV text, when the caller already holds it
 * @property {string} fileName - Uploaded file name
 * @property {string|null} jobId - Upload job ID
 * @property {number} totalSize - Total bytes of the upload batch
 */

/**
 * @typedef {object} RestoreFilesPayload
 * @property {CsvSource} sharesCsv - Stored shares source
 * @property {CsvSource} commentsCsv - Stored comments source
 * @property {CsvSource} connectionsCsv - Stored connections source
 */

/**
 * Analytics worker request (main thread -> worker), discriminated on `type`.
 * @typedef {{type: "addFile", payload: AddFilePayload}
 * | {type: "restoreFiles", payload: RestoreFilesPayload}
 * | {type: "initBase", payload: PlainObject|null}
 * | {type: "view", requestId: RequestId, filters: PlainObject}
 * | {type: "clear"}} AnalyticsWorkerRequest
 */

/**
 * @typedef {object} AnalyticsProgressPayload
 * @property {string|null} jobId - Upload job ID
 * @property {string} fileName - File being read
 * @property {number} percent - Progress fraction between 0 and 1
 * @property {number} bytesRead - Bytes read so far
 * @property {number} totalBytes - Total bytes to read
 */

/**
 * @typedef {object} FileProcessedPayload
 * @property {string|null} fileType - Detected file type, or null when unrecognized
 * @property {string} fileName - Processed file name
 * @property {string|null} jobId - Upload job ID
 * @property {number} rowCount - Rows processed
 * @property {PlainObject|null} analyticsBase - Analytics aggregate base, if computed
 * @property {boolean} hasData - Whether analytics data is now available
 * @property {boolean} usedFallback - Whether the Windows-1252 decode fallback was used
 * @property {string|null} error - Processing error, if any
 */

/**
 * @typedef {object} AnalyticsErrorPayload
 * @property {string} message - Bounded error description
 * @property {string|null} jobId - Upload job ID
 * @property {string} fileName - File the error concerns
 */

/**
 * Analytics worker message (worker -> main thread), discriminated on `type`.
 * @typedef {{type: "restored", requestId: RequestId, payload: PlainObject}
 * | {type: "init", requestId: RequestId, payload: {hasData: boolean}}
 * | {type: "view", requestId: RequestId, payload: PlainObject}
 * | {type: "progress", requestId: RequestId, payload: AnalyticsProgressPayload}
 * | {type: "fileProcessed", requestId: RequestId, payload: FileProcessedPayload}
 * | {type: "error", requestId: RequestId, payload: AnalyticsErrorPayload}
 * | {type: "cleared", requestId: RequestId, payload: Record<string, never>}
 * } AnalyticsWorkerMessage
 */

/**
 * @typedef {object} ConnectionsWorkerRequest
 * @property {"process"} type - Request type
 * @property {RequestId} requestId - Request correlation ID
 * @property {{connectionsCsv: CsvSource}} payload - Connections source
 */

/**
 * @typedef {object} ConnectionsProcessedPayload
 * @property {boolean} success - Whether processing succeeded
 * @property {PlainObject|null} analytics - Connections analytics
 * @property {unknown[]} rows - Parsed connection rows
 * @property {string|null} error - Processing error, if any
 */

/**
 * Connections worker message, discriminated on `type`.
 * @typedef {{type: "error", requestId: RequestId, payload: {message: string}}
 * | {type: "processed", requestId: RequestId, payload: ConnectionsProcessedPayload}
 * } ConnectionsWorkerMessage
 */

/**
 * @typedef {object} MessagesWorkerRequest
 * @property {"process"} type - Request type
 * @property {RequestId} requestId - Request correlation ID
 * @property {{messagesCsv: CsvSource, connectionsCsv: CsvSource}} payload - CSV sources
 */

/**
 * @typedef {object} MessagesWorkerMessage
 * @property {"processed"} type - Message type
 * @property {RequestId} requestId - Request correlation ID
 * @property {PlainObject|null} payload - Processed messages payload
 */

/**
 * @typedef {object} ThreadsRequestPayload
 * @property {CsvSource} messagesCsv - Messages source
 * @property {CsvSource} connectionsCsv - Optional connections source ("" when absent)
 * @property {number} people - People to include
 * @property {number} messagesPerPerson - Messages per person to include
 */

/**
 * @typedef {object} ThreadsWorkerRequest
 * @property {"threads"} type - Request type
 * @property {RequestId} requestId - Request correlation ID
 * @property {ThreadsRequestPayload} payload - Thread selection request
 */

/**
 * @typedef {object} ThreadsWorkerMessage
 * @property {"threads"} type - Message type
 * @property {RequestId} requestId - Request correlation ID
 * @property {{success: boolean, threads: unknown[], error: string|null}} payload - Threads
 */

/**
 * @typedef {object} CleaningRequestPayload
 * @property {string} fileType - File type to clean
 * @property {CleanOutput} output - Requested output
 * @property {CsvSource} source - File source
 * @property {string} key - Stored upload key
 */

/**
 * @typedef {object} CleaningWorkerRequest
 * @property {"clean"} type - Request type
 * @property {RequestId} requestId - Request correlation ID
 * @property {CleaningRequestPayload} payload - Cleaning request
 */

/**
 * @typedef {object} CleanedPayload
 * @property {boolean} success - Whether cleaning succeeded
 * @property {string|null} error - Cleaning error, if any
 * @property {number} rowCount - Cleaned row count
 * @property {string[][]} previewRows - Bounded preview cells
 * @property {Blob|null} blob - Download payload, if requested
 */

/**
 * @typedef {object} CleaningWorkerMessage
 * @property {"cleaned"} type - Message type
 * @property {RequestId} requestId - Request correlation ID
 * @property {CleanedPayload} payload - Cleaning result
 */

/**
 * @typedef {object} StoredUploadFile
 * @property {string} type - File type
 * @property {string} name - File name
 * @property {Blob|null} blob - File contents
 * @property {number} rowCount - Stored row count
 * @property {number} updatedAt - Last update timestamp (ms)
 */

/**
 * @typedef {object} CachedFileMetadata
 * @property {string} type - File type
 * @property {string} name - File name
 * @property {number} rowCount - Stored row count
 * @property {number} updatedAt - Last update timestamp (ms)
 */

/**
 * Build a successful contract parse result.
 * @template T
 * @param {T} value - Normalized value
 * @returns {{valid: true, value: T}}
 */
function valid(value) {
    return { valid: true, value };
}

/**
 * Build a failed contract parse result.
 * @param {string} error - Validation error
 * @returns {{valid: false, error: string}}
 */
function invalid(error) {
    return { valid: false, error };
}

/**
 * A worker request parse result. A rejected request still carries the id it
 * arrived with, so the worker answers under the id the page is waiting on.
 * @template T
 * @typedef {({valid: true, value: T} | {valid: false, error: string}) & {requestId: RequestId}} RequestParseResult
 */

/**
 * Read the id a raw worker request arrived with.
 * @param {unknown} message - Raw request
 * @returns {RequestId}
 */
function requestIdOf(message) {
    return isPlainObject(message) ? normalizeRequestId(message.requestId) : 0;
}

/**
 * Build a rejected worker request result under its id.
 * @param {RequestId} requestId - Id the request arrived with
 * @param {string} error - Validation error
 * @returns {{valid: false, error: string, requestId: RequestId}}
 */
function rejected(requestId, error) {
    return { ...invalid(error), requestId };
}

/**
 * Build an accepted worker request result under its id.
 * @template {{requestId: RequestId}} T
 * @param {T} value - Normalized request
 * @returns {{valid: true, value: T, requestId: RequestId}}
 */
function accepted(value) {
    return { ...valid(value), requestId: value.requestId };
}

/**
 * Read one CSV source field of a request payload: a stored upload Blob or CSV
 * text within the size ceiling. An optional field may be absent.
 * @param {PlainObject} payload - Request payload
 * @param {string} field - Field name, which also names it in the error
 * @param {boolean} required - Whether the field must be present
 * @returns {{source: CsvSource, error: string|null}} Source "" when absent
 */
function readCsvField(payload, field, required) {
    const parsed = parseCsvSource(payload[field]);
    if (required && !parsed.source) {
        return { source: "", error: `Missing ${field} payload` };
    }
    // When present it must respect the same size ceiling as every other CSV
    // payload rather than being silently truncated.
    if (parsed.tooLarge) {
        return { source: "", error: `${field} payload exceeds allowed size` };
    }
    return { source: parsed.source, error: null };
}

/**
 * Check whether a value is a plain object.
 * @param {unknown} value - Candidate value
 * @returns {value is PlainObject}
 */
function isPlainObject(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    return Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Normalize a string value to a bounded string.
 * @param {unknown} value - Raw value
 * @param {number} maxLength - Maximum allowed length
 * @returns {string}
 */
function normalizeString(value, maxLength) {
    if (typeof value !== "string") {
        return "";
    }
    if (value.length > maxLength) {
        return value.slice(0, maxLength);
    }
    return value;
}

/**
 * Normalize optional string value to bounded string or null.
 * @param {unknown} value - Raw value
 * @param {number} maxLength - Maximum allowed length
 * @returns {string|null}
 */
function normalizeOptionalString(value, maxLength) {
    if (typeof value !== "string") {
        return null;
    }
    if (!value) {
        return null;
    }
    if (value.length > maxLength) {
        return value.slice(0, maxLength);
    }
    return value;
}

/**
 * Normalize a number to a finite range.
 * @param {unknown} value - Raw value
 * @param {number} fallback - Fallback for invalid values
 * @param {number} min - Minimum bound
 * @param {number} max - Maximum bound
 * @returns {number}
 */
function normalizeNumber(value, fallback, min, max) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    if (value < min) {
        return min;
    }
    if (value > max) {
        return max;
    }
    return value;
}

/**
 * Normalize a request id.
 * @param {unknown} value - Raw request id
 * @returns {number|string}
 */
function normalizeRequestId(value) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        return value;
    }
    if (typeof value === "string" && value) {
        return value;
    }
    return 0;
}

/**
 * Check whether a value is a Blob (a File is one), without relying on a
 * same-realm instanceof where the global is missing.
 * @param {unknown} value - Candidate value
 * @returns {value is Blob}
 */
function isBlob(value) {
    return typeof Blob !== "undefined" && value instanceof Blob;
}

/**
 * Accept one CSV source for a worker: the stored upload as a Blob, which the
 * worker reads itself, or text from a caller that already holds it. An empty
 * Blob counts as missing, like empty text.
 * @param {unknown} value - Raw payload field
 * @returns {{source: CsvSource, tooLarge: boolean}}
 */
function parseCsvSource(value) {
    if (isBlob(value)) {
        return {
            source: value.size > 0 ? value : "",
            tooLarge: value.size > LIMITS.maxFileBytes,
        };
    }
    const text = normalizeString(value, LIMITS.maxCsvChars + 1);
    return { source: text, tooLarge: text.length > LIMITS.maxCsvChars };
}

/**
 * Parse upload worker addFile payload. The page posts the uploaded `file` so
 * the worker reads it; `csvText` remains for callers that already hold text.
 * @param {unknown} payload - Raw payload
 * @returns {ParseResult<AddFilePayload>}
 */
function parseAddFilePayload(payload) {
    if (!isPlainObject(payload)) {
        return invalid("Invalid addFile payload");
    }

    const file = isBlob(payload.file) ? payload.file : null;
    if (file && file.size > LIMITS.maxFileBytes) {
        return invalid("File payload exceeds allowed size");
    }
    const csvText = file ? "" : normalizeString(payload.csvText, LIMITS.maxCsvChars + 1);
    if (!file && !csvText) {
        return invalid("Missing file payload");
    }
    if (csvText.length > LIMITS.maxCsvChars) {
        return invalid("CSV payload exceeds allowed size");
    }

    const fileName = normalizeString(payload.fileName, LIMITS.maxFileNameChars);
    if (!fileName) {
        return invalid("Missing fileName payload");
    }

    const jobId = normalizeOptionalString(payload.jobId, LIMITS.maxJobIdChars);
    const totalSize = normalizeNumber(payload.totalSize, 0, 0, Number.MAX_SAFE_INTEGER);

    return valid({
        file,
        csvText,
        fileName,
        jobId,
        totalSize,
    });
}

/**
 * Parse analytics worker restoreFiles payload.
 * @param {unknown} payload - Raw payload
 * @returns {ParseResult<RestoreFilesPayload>}
 */
function parseRestoreFilesPayload(payload) {
    if (!isPlainObject(payload)) {
        return invalid("Invalid restoreFiles payload");
    }

    const shares = parseCsvSource(payload.sharesCsv);
    const comments = parseCsvSource(payload.commentsCsv);
    const connections = parseCsvSource(payload.connectionsCsv);

    if (shares.tooLarge || comments.tooLarge || connections.tooLarge) {
        return invalid("CSV payload exceeds allowed size");
    }

    return valid({
        sharesCsv: shares.source,
        commentsCsv: comments.source,
        connectionsCsv: connections.source,
    });
}

/**
 * Parse analytics worker inbound message (main thread -> worker).
 * @param {unknown} message - Raw message event data
 * @returns {ParseResult<AnalyticsWorkerRequest>}
 */
export function parseAnalyticsWorkerRequest(message) {
    if (!isPlainObject(message) || typeof message.type !== "string") {
        return invalid("Invalid analytics worker request envelope");
    }

    switch (message.type) {
        case "addFile": {
            const payloadResult = parseAddFilePayload(message.payload);
            if (!payloadResult.valid) {
                return payloadResult;
            }
            return valid({ type: "addFile", payload: payloadResult.value });
        }
        case "restoreFiles": {
            const payloadResult = parseRestoreFilesPayload(message.payload);
            if (!payloadResult.valid) {
                return payloadResult;
            }
            return valid({ type: "restoreFiles", payload: payloadResult.value });
        }
        case "initBase":
            return valid({
                type: "initBase",
                payload: isPlainObject(message.payload) ? message.payload : null,
            });
        case "view":
            return valid({
                type: "view",
                requestId: normalizeRequestId(message.requestId),
                filters: isPlainObject(message.filters) ? message.filters : {},
            });
        case "clear":
            return valid({ type: "clear" });
        default:
            return invalid("Unknown analytics worker request type");
    }
}

/**
 * Parse analytics worker outbound message (worker -> main thread).
 * @param {unknown} message - Raw message event data
 * @returns {ParseResult<AnalyticsWorkerMessage>}
 */
export function parseAnalyticsWorkerMessage(message) {
    if (!isPlainObject(message) || typeof message.type !== "string") {
        return invalid("Invalid analytics worker message envelope");
    }

    const requestId = normalizeRequestId(message.requestId);

    switch (message.type) {
        case "restored":
            return valid({
                type: "restored",
                requestId,
                payload: isPlainObject(message.payload) ? message.payload : { hasData: false },
            });
        case "init":
            return valid({
                type: "init",
                requestId,
                payload: {
                    hasData: Boolean(isPlainObject(message.payload) && message.payload.hasData),
                },
            });
        case "view":
            return valid({
                type: "view",
                requestId,
                payload: isPlainObject(message.payload) ? message.payload : {},
            });
        case "progress": {
            const payload = isPlainObject(message.payload) ? message.payload : {};
            return valid({
                type: "progress",
                requestId,
                payload: {
                    jobId: normalizeOptionalString(payload.jobId, LIMITS.maxJobIdChars),
                    fileName: normalizeString(payload.fileName, LIMITS.maxFileNameChars),
                    percent: normalizeNumber(payload.percent, 0, 0, 1),
                    bytesRead: normalizeNumber(payload.bytesRead, 0, 0, Number.MAX_SAFE_INTEGER),
                    totalBytes: normalizeNumber(payload.totalBytes, 0, 0, Number.MAX_SAFE_INTEGER),
                },
            });
        }
        case "fileProcessed": {
            const payload = isPlainObject(message.payload) ? message.payload : {};
            const fileType = normalizeString(payload.fileType, 32);
            return valid({
                type: "fileProcessed",
                requestId,
                payload: {
                    fileType: FILE_TYPES.has(fileType) ? fileType : null,
                    fileName: normalizeString(payload.fileName, LIMITS.maxFileNameChars),
                    jobId: normalizeOptionalString(payload.jobId, LIMITS.maxJobIdChars),
                    rowCount: normalizeNumber(payload.rowCount, 0, 0, Number.MAX_SAFE_INTEGER),
                    analyticsBase: isPlainObject(payload.analyticsBase)
                        ? payload.analyticsBase
                        : null,
                    hasData: Boolean(payload.hasData),
                    usedFallback: Boolean(payload.usedFallback),
                    error: normalizeOptionalString(payload.error, LIMITS.maxMessageChars),
                },
            });
        }
        case "error": {
            const payload = isPlainObject(message.payload) ? message.payload : {};
            return valid({
                type: "error",
                requestId,
                payload: {
                    message:
                        normalizeString(payload.message, LIMITS.maxMessageChars) || "Worker error.",
                    jobId: normalizeOptionalString(payload.jobId, LIMITS.maxJobIdChars),
                    fileName: normalizeString(payload.fileName, LIMITS.maxFileNameChars),
                },
            });
        }
        case "cleared":
            return valid({ type: "cleared", requestId, payload: {} });
        default:
            return invalid("Unknown analytics worker message type");
    }
}

/**
 * Parse connections worker request envelope.
 * @param {unknown} message - Raw request
 * @returns {RequestParseResult<ConnectionsWorkerRequest>}
 */
export function parseConnectionsWorkerRequest(message) {
    const requestId = requestIdOf(message);
    if (!isPlainObject(message) || message.type !== "process") {
        return rejected(requestId, "Invalid connections worker request envelope");
    }
    const payload = isPlainObject(message.payload) ? message.payload : {};
    const connections = readCsvField(payload, "connectionsCsv", true);
    if (connections.error) {
        return rejected(requestId, connections.error);
    }
    return accepted({
        type: "process",
        requestId,
        payload: { connectionsCsv: connections.source },
    });
}

/**
 * Parse connections worker outbound message.
 * @param {unknown} message - Raw worker message
 * @returns {ParseResult<ConnectionsWorkerMessage>}
 */
export function parseConnectionsWorkerMessage(message) {
    if (!isPlainObject(message) || typeof message.type !== "string") {
        return invalid("Invalid connections worker message envelope");
    }

    switch (message.type) {
        case "error": {
            const payload = isPlainObject(message.payload) ? message.payload : {};
            return valid({
                type: "error",
                requestId: normalizeRequestId(message.requestId),
                payload: {
                    message:
                        normalizeString(payload.message, LIMITS.maxMessageChars) || "Worker error.",
                },
            });
        }
        case "processed": {
            const payload = isPlainObject(message.payload) ? message.payload : {};
            return valid({
                type: "processed",
                requestId: normalizeRequestId(message.requestId),
                payload: {
                    success: Boolean(payload.success),
                    analytics: isPlainObject(payload.analytics) ? payload.analytics : null,
                    rows: Array.isArray(payload.rows) ? payload.rows : [],
                    error: normalizeOptionalString(payload.error, LIMITS.maxMessageChars),
                },
            });
        }
        default:
            return invalid("Unknown connections worker message type");
    }
}

/**
 * Parse messages worker request envelope.
 * @param {unknown} message - Raw request
 * @returns {RequestParseResult<MessagesWorkerRequest>}
 */
export function parseMessagesWorkerRequest(message) {
    const requestId = requestIdOf(message);
    if (!isPlainObject(message) || message.type !== "process") {
        return rejected(requestId, "Invalid messages worker request envelope");
    }
    const payload = isPlainObject(message.payload) ? message.payload : {};
    const messages = readCsvField(payload, "messagesCsv", true);
    const connections = readCsvField(payload, "connectionsCsv", false);
    const error = messages.error || connections.error;
    if (error) {
        return rejected(requestId, error);
    }
    return accepted({
        type: "process",
        requestId,
        payload: {
            messagesCsv: messages.source,
            connectionsCsv: connections.source,
        },
    });
}

/**
 * Parse messages worker outbound message.
 * @param {unknown} message - Raw worker message
 * @returns {ParseResult<MessagesWorkerMessage>}
 */
export function parseMessagesWorkerMessage(message) {
    if (!isPlainObject(message) || message.type !== "processed") {
        return invalid("Invalid messages worker message envelope");
    }
    return valid({
        type: "processed",
        requestId: normalizeRequestId(message.requestId),
        payload: isPlainObject(message.payload) ? message.payload : null,
    });
}

/**
 * Parse threads worker request envelope.
 * @param {unknown} message - Raw request
 * @returns {RequestParseResult<ThreadsWorkerRequest>}
 */
export function parseThreadsWorkerRequest(message) {
    const requestId = requestIdOf(message);
    if (!isPlainObject(message) || message.type !== "threads") {
        return rejected(requestId, "Invalid threads worker request envelope");
    }
    const payload = isPlainObject(message.payload) ? message.payload : {};
    const messages = readCsvField(payload, "messagesCsv", true);
    // The connections file the worker derives its self-detection tiebreak keys
    // from. Optional, as it is on the messages worker's own request. Half a
    // connections file names half the people in it, and the tiebreak would then
    // be wrong rather than absent, so an oversized one is refused, not truncated.
    const connections = readCsvField(payload, "connectionsCsv", false);
    const error = messages.error || connections.error;
    if (error) {
        return rejected(requestId, error);
    }
    return accepted({
        type: "threads",
        requestId,
        payload: {
            messagesCsv: messages.source,
            connectionsCsv: connections.source,
            people: normalizeNumber(
                payload.people,
                LIMITS.maxThreadPeople,
                1,
                LIMITS.maxThreadPeople,
            ),
            messagesPerPerson: normalizeNumber(
                payload.messagesPerPerson,
                LIMITS.maxThreadMessagesPerPerson,
                1,
                LIMITS.maxThreadMessagesPerPerson,
            ),
        },
    });
}

/**
 * Parse threads worker outbound message.
 *
 * The thread payload carries the user's own message bodies verbatim, so it is
 * checked for shape only and never truncated or rewritten.
 * @param {unknown} message - Raw worker message
 * @returns {ParseResult<ThreadsWorkerMessage>}
 */
export function parseThreadsWorkerMessage(message) {
    if (!isPlainObject(message) || message.type !== "threads") {
        return invalid("Invalid threads worker message envelope");
    }
    const payload = isPlainObject(message.payload) ? message.payload : {};
    return valid({
        type: "threads",
        requestId: normalizeRequestId(message.requestId),
        payload: {
            success: Boolean(payload.success),
            threads: Array.isArray(payload.threads) ? payload.threads : [],
            error: normalizeOptionalString(payload.error, LIMITS.maxMessageChars),
        },
    });
}

/** @type {ReadonlySet<unknown>} */
const CLEAN_OUTPUTS = new Set(["preview", "xlsx", "csv"]);

/**
 * Check whether a value names a supported cleaning output.
 * @param {unknown} value - Candidate output
 * @returns {value is CleanOutput}
 */
function isCleanOutput(value) {
    return CLEAN_OUTPUTS.has(value);
}

/**
 * Parse cleaning worker request envelope. The page asks for one output of the
 * selected file: the preview, an Excel workbook, or a cleaned CSV. `key`
 * names the stored upload, so the worker can reuse the rows it cleaned for
 * the preview when the download asks for the same file.
 * @param {unknown} message - Raw request
 * @returns {RequestParseResult<CleaningWorkerRequest>}
 */
export function parseCleaningWorkerRequest(message) {
    const requestId = requestIdOf(message);
    if (!isPlainObject(message) || message.type !== "clean") {
        return rejected(requestId, "Invalid cleaning worker request envelope");
    }
    const payload = isPlainObject(message.payload) ? message.payload : {};
    const fileType = normalizeString(payload.fileType, 32);
    if (!FILE_TYPES.has(fileType)) {
        return rejected(requestId, "Invalid cleaning file type");
    }
    const output = payload.output;
    if (!isCleanOutput(output)) {
        return rejected(requestId, "Invalid cleaning output");
    }
    const file = parseCsvSource(payload.source);
    if (!file.source) {
        return rejected(requestId, "Missing cleaning source payload");
    }
    if (file.tooLarge) {
        return rejected(requestId, "Cleaning source payload exceeds allowed size");
    }
    return accepted({
        type: "clean",
        requestId,
        payload: {
            fileType,
            output,
            source: file.source,
            key: normalizeString(payload.key, LIMITS.maxJobIdChars),
        },
    });
}

/**
 * Parse cleaning worker outbound message. The preview keeps at most
 * `CLEAN_PREVIEW_MAX_ROWS` rows of strings, each cut to the CSV text limit;
 * any other cell value reads as empty. A download carries its Blob.
 * @param {unknown} message - Raw worker message
 * @returns {ParseResult<CleaningWorkerMessage>}
 */
export function parseCleaningWorkerMessage(message) {
    if (!isPlainObject(message) || message.type !== "cleaned") {
        return invalid("Invalid cleaning worker message envelope");
    }
    const payload = isPlainObject(message.payload) ? message.payload : {};
    const previewRows = Array.isArray(payload.previewRows)
        ? payload.previewRows
              .filter(Array.isArray)
              .slice(0, CLEAN_PREVIEW_MAX_ROWS)
              .map((row) => row.map((cell) => normalizeString(cell, LIMITS.maxCsvChars)))
        : [];
    return valid({
        type: "cleaned",
        requestId: normalizeRequestId(message.requestId),
        payload: {
            success: Boolean(payload.success),
            error: normalizeOptionalString(payload.error, LIMITS.maxMessageChars),
            rowCount: normalizeNumber(payload.rowCount, 0, 0, Number.MAX_SAFE_INTEGER),
            previewRows,
            blob: isBlob(payload.blob) ? payload.blob : null,
        },
    });
}

/**
 * Parse a persisted upload record loaded from cache/storage.
 * @param {unknown} file - Raw file object
 * @returns {ParseResult<StoredUploadFile>}
 */
export function parseStoredUploadFile(file) {
    if (!isPlainObject(file)) {
        return invalid("Invalid stored file payload");
    }

    const type = normalizeString(file.type, 32);
    if (!FILE_TYPES.has(type)) {
        return invalid("Invalid stored file type");
    }

    return valid({
        type,
        name: normalizeString(file.name, LIMITS.maxFileNameChars),
        blob: isBlob(file.blob) ? file.blob : null,
        rowCount: normalizeNumber(file.rowCount, 0, 0, Number.MAX_SAFE_INTEGER),
        updatedAt: normalizeNumber(file.updatedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
    });
}

/**
 * Strip the stored upload from a file record, keeping only the metadata the
 * in-memory caches need (status, counts, dataset signatures). The upload stays
 * in IndexedDB as a Blob that workers read on demand, so large exports aren't
 * retained in memory across the whole session.
 * @param {{type: string, name: string, rowCount?: number, updatedAt?: number}} file - Stored
 * file record
 * @returns {CachedFileMetadata}
 */
export function toStoredFileMetadata(file) {
    return {
        type: file.type,
        name: file.name,
        rowCount: file.rowCount || 0,
        updatedAt: file.updatedAt || 0,
    };
}
