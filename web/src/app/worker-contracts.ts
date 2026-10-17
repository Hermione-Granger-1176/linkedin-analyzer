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

/** Outcome of a contract parse: the normalized value, or why it was rejected. */
export type ParseResult<T> = { valid: true; value: T } | { valid: false; error: string };

/** Correlates a worker reply with its request. */
export type RequestId = number | string;
/** A stored upload Blob, or CSV text already read. */
type CsvSource = Blob | string;
/** Opaque plain-object payload. */
export type PlainObject = Record<string, unknown>;
/** Output a cleaning request asks for. */
type CleanOutput = "preview" | "xlsx" | "csv";

export interface AddFilePayload {
    /** Uploaded file for the worker to read */
    file: Blob | null;
    /** CSV text, when the caller already holds it */
    csvText: string;
    /** Uploaded file name */
    fileName: string;
    /** Upload job ID */
    jobId: string | null;
    /** Total bytes of the upload batch */
    totalSize: number;
}

interface RestoreFilesPayload {
    sharesCsv: CsvSource;
    commentsCsv: CsvSource;
    connectionsCsv: CsvSource;
}

/** Analytics worker request (main thread -> worker), discriminated on `type`. */
export type AnalyticsWorkerRequest =
    | { type: "addFile"; payload: AddFilePayload }
    | { type: "restoreFiles"; payload: RestoreFilesPayload }
    | { type: "initBase"; payload: PlainObject | null }
    | { type: "view"; requestId: RequestId; filters: PlainObject }
    | { type: "clear" };

interface AnalyticsProgressPayload {
    jobId: string | null;
    /** File being read */
    fileName: string;
    /** Progress fraction between 0 and 1 */
    percent: number;
    bytesRead: number;
    totalBytes: number;
}

export interface FileProcessedPayload {
    /** Detected file type, or null when unrecognized */
    fileType: string | null;
    fileName: string;
    jobId: string | null;
    rowCount: number;
    /** Analytics aggregate base, if computed */
    analyticsBase: PlainObject | null;
    /** Whether analytics data is now available */
    hasData: boolean;
    /** Whether the Windows-1252 decode fallback was used */
    usedFallback: boolean;
    error: string | null;
}

interface AnalyticsErrorPayload {
    /** Bounded error description */
    message: string;
    jobId: string | null;
    /** File the error concerns */
    fileName: string;
}

/** Analytics worker message (worker -> main thread), discriminated on `type`. */
export type AnalyticsWorkerMessage = { requestId: RequestId } & (
    | { type: "restored"; payload: PlainObject }
    | { type: "init"; payload: { hasData: boolean } }
    | { type: "view"; payload: PlainObject }
    | { type: "progress"; payload: AnalyticsProgressPayload }
    | { type: "fileProcessed"; payload: FileProcessedPayload }
    | { type: "error"; payload: AnalyticsErrorPayload }
    | { type: "cleared"; payload: Record<string, never> }
);

export interface ConnectionsWorkerRequest {
    type: "process";
    requestId: RequestId;
    payload: { connectionsCsv: CsvSource };
}

export interface ConnectionsProcessedPayload {
    success: boolean;
    analytics: PlainObject | null;
    /** Parsed connection rows */
    rows: unknown[];
    error: string | null;
}

/** Connections worker message, discriminated on `type`. */
export type ConnectionsWorkerMessage = { requestId: RequestId } & (
    | { type: "error"; payload: { message: string } }
    | { type: "processed"; payload: ConnectionsProcessedPayload }
);

export interface MessagesWorkerRequest {
    type: "process";
    requestId: RequestId;
    payload: { messagesCsv: CsvSource; connectionsCsv: CsvSource };
}

export interface MessagesWorkerMessage {
    type: "processed";
    requestId: RequestId;
    payload: PlainObject | null;
}

interface ThreadsRequestPayload {
    messagesCsv: CsvSource;
    /** Optional connections source ("" when absent) */
    connectionsCsv: CsvSource;
    /** People to include */
    people: number;
    /** Messages per person to include */
    messagesPerPerson: number;
}

export interface ThreadsWorkerRequest {
    type: "threads";
    requestId: RequestId;
    payload: ThreadsRequestPayload;
}

export interface ThreadsWorkerMessage {
    type: "threads";
    requestId: RequestId;
    payload: { success: boolean; threads: unknown[]; error: string | null };
}

export interface CleaningRequestPayload {
    /** File type to clean */
    fileType: string;
    output: CleanOutput;
    source: CsvSource;
    /** Stored upload key */
    key: string;
}

export interface CleaningWorkerRequest {
    type: "clean";
    requestId: RequestId;
    payload: CleaningRequestPayload;
}

export interface CleanedPayload {
    success: boolean;
    error: string | null;
    rowCount: number;
    /** Bounded preview cells */
    previewRows: string[][];
    /** Download payload, if requested */
    blob: Blob | null;
}

export interface CleaningWorkerMessage {
    type: "cleaned";
    requestId: RequestId;
    payload: CleanedPayload;
}

export interface StoredUploadFile {
    type: string;
    name: string;
    blob: Blob | null;
    rowCount: number;
    /** Last update timestamp (ms) */
    updatedAt: number;
}

export interface CachedFileMetadata {
    type: string;
    name: string;
    rowCount: number;
    /** Last update timestamp (ms) */
    updatedAt: number;
}

/**
 * A worker request parse result. A rejected request still carries the id it
 * arrived with, so the worker answers under the id the page is waiting on.
 */
export type RequestParseResult<T> = ParseResult<T> & { requestId: RequestId };

/**
 * Build a successful contract parse result.
 * @param value - Normalized value
 */
function valid<T>(value: T): { valid: true; value: T } {
    return { valid: true, value };
}

/**
 * Build a failed contract parse result.
 * @param error - Validation error
 */
function invalid(error: string): { valid: false; error: string } {
    return { valid: false, error };
}

/**
 * Read the id a raw worker request arrived with.
 * @param message - Raw request
 */
function requestIdOf(message: unknown): RequestId {
    return isPlainObject(message) ? normalizeRequestId(message.requestId) : 0;
}

/**
 * Build a rejected worker request result under its id.
 * @param requestId - Id the request arrived with
 * @param error - Validation error
 */
function rejected(
    requestId: RequestId,
    error: string,
): { valid: false; error: string; requestId: RequestId } {
    return { ...invalid(error), requestId };
}

/**
 * Build an accepted worker request result under its id.
 * @param value - Normalized request
 */
function accepted<T extends { requestId: RequestId }>(
    value: T,
): { valid: true; value: T; requestId: RequestId } {
    return { ...valid(value), requestId: value.requestId };
}

/**
 * Read one CSV source field of a request payload: a stored upload Blob or CSV
 * text within the size ceiling. An optional field may be absent.
 * @param payload - Request payload
 * @param field - Field name, which also names it in the error
 * @param required - Whether the field must be present
 * @returns Source "" when absent
 */
function readCsvField(
    payload: PlainObject,
    field: string,
    required: boolean,
): { source: CsvSource; error: string | null } {
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
 * @param value - Candidate value
 */
function isPlainObject(value: unknown): value is PlainObject {
    if (!value || typeof value !== "object") {
        return false;
    }
    return Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Normalize a string value to a bounded string.
 * @param value - Raw value
 * @param maxLength - Maximum allowed length
 */
function normalizeString(value: unknown, maxLength: number): string {
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
 * @param value - Raw value
 * @param maxLength - Maximum allowed length
 */
function normalizeOptionalString(value: unknown, maxLength: number): string | null {
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
 * @param value - Raw value
 * @param fallback - Fallback for invalid values
 * @param min - Minimum bound
 * @param max - Maximum bound
 */
function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
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
 * @param value - Raw request id
 */
function normalizeRequestId(value: unknown): number | string {
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
 * @param value - Candidate value
 */
function isBlob(value: unknown): value is Blob {
    return typeof Blob !== "undefined" && value instanceof Blob;
}

/**
 * Accept one CSV source for a worker: the stored upload as a Blob, which the
 * worker reads itself, or text from a caller that already holds it. An empty
 * Blob counts as missing, like empty text.
 * @param value - Raw payload field
 */
function parseCsvSource(value: unknown): { source: CsvSource; tooLarge: boolean } {
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
 * @param payload - Raw payload
 */
function parseAddFilePayload(payload: unknown): ParseResult<AddFilePayload> {
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
 * @param payload - Raw payload
 */
function parseRestoreFilesPayload(payload: unknown): ParseResult<RestoreFilesPayload> {
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
 * @param message - Raw message event data
 */
export function parseAnalyticsWorkerRequest(message: unknown): ParseResult<AnalyticsWorkerRequest> {
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
 * @param message - Raw message event data
 */
export function parseAnalyticsWorkerMessage(message: unknown): ParseResult<AnalyticsWorkerMessage> {
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
 * @param message - Raw request
 */
export function parseConnectionsWorkerRequest(
    message: unknown,
): RequestParseResult<ConnectionsWorkerRequest> {
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
 * @param message - Raw worker message
 */
export function parseConnectionsWorkerMessage(
    message: unknown,
): ParseResult<ConnectionsWorkerMessage> {
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
 * @param message - Raw request
 */
export function parseMessagesWorkerRequest(
    message: unknown,
): RequestParseResult<MessagesWorkerRequest> {
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
 * @param message - Raw worker message
 */
export function parseMessagesWorkerMessage(message: unknown): ParseResult<MessagesWorkerMessage> {
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
 * @param message - Raw request
 */
export function parseThreadsWorkerRequest(
    message: unknown,
): RequestParseResult<ThreadsWorkerRequest> {
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
 * @param message - Raw worker message
 */
export function parseThreadsWorkerMessage(message: unknown): ParseResult<ThreadsWorkerMessage> {
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

const CLEAN_OUTPUTS: ReadonlySet<unknown> = new Set(["preview", "xlsx", "csv"]);

/**
 * Check whether a value names a supported cleaning output.
 * @param value - Candidate output
 */
function isCleanOutput(value: unknown): value is CleanOutput {
    return CLEAN_OUTPUTS.has(value);
}

/**
 * Parse cleaning worker request envelope. The page asks for one output of the
 * selected file: the preview, an Excel workbook, or a cleaned CSV. `key`
 * names the stored upload, so the worker can reuse the rows it cleaned for
 * the preview when the download asks for the same file.
 * @param message - Raw request
 */
export function parseCleaningWorkerRequest(
    message: unknown,
): RequestParseResult<CleaningWorkerRequest> {
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
 * @param message - Raw worker message
 */
export function parseCleaningWorkerMessage(message: unknown): ParseResult<CleaningWorkerMessage> {
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
 * @param file - Raw file object
 */
export function parseStoredUploadFile(file: unknown): ParseResult<StoredUploadFile> {
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
 * @param file - Stored file record
 */
export function toStoredFileMetadata(
    file: Partial<CachedFileMetadata> & Pick<CachedFileMetadata, "type" | "name">,
): CachedFileMetadata {
    return {
        type: file.type,
        name: file.name,
        rowCount: file.rowCount || 0,
        updatedAt: file.updatedAt || 0,
    };
}
