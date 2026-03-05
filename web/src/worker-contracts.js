/* Runtime contracts for worker request/response payloads */

const FILE_TYPES = new Set(['shares', 'comments', 'messages', 'connections']);

const LIMITS = Object.freeze({
    maxCsvChars: 30 * 1024 * 1024,
    maxFileNameChars: 255,
    maxJobIdChars: 128,
    maxMessageChars: 500
});

/**
 * Build a successful contract parse result.
 * @param {object} value - Normalized value
 * @returns {{valid: true, value: object}}
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
 * Check whether a value is a plain object.
 * @param {unknown} value - Candidate value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
    if (!value || typeof value !== 'object') {
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
    if (typeof value !== 'string') {
        return '';
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
    if (typeof value !== 'string') {
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
    if (typeof value !== 'number' || !Number.isFinite(value)) {
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
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        return value;
    }
    if (typeof value === 'string' && value) {
        return value;
    }
    return 0;
}

/**
 * Parse upload worker addFile payload.
 * @param {unknown} payload - Raw payload
 * @returns {{valid: boolean, value?: object, error?: string}}
 */
function parseAddFilePayload(payload) {
    if (!isPlainObject(payload)) {
        return invalid('Invalid addFile payload');
    }

    const csvText = normalizeString(payload.csvText, LIMITS.maxCsvChars + 1);
    if (!csvText) {
        return invalid('Missing csvText payload');
    }
    if (csvText.length > LIMITS.maxCsvChars) {
        return invalid('CSV payload exceeds allowed size');
    }

    const fileName = normalizeString(payload.fileName, LIMITS.maxFileNameChars);
    if (!fileName) {
        return invalid('Missing fileName payload');
    }

    const jobId = normalizeOptionalString(payload.jobId, LIMITS.maxJobIdChars);
    const totalSize = normalizeNumber(payload.totalSize, 0, 0, Number.MAX_SAFE_INTEGER);

    return valid({
        csvText,
        fileName,
        jobId,
        totalSize
    });
}

/**
 * Parse analytics worker restoreFiles payload.
 * @param {unknown} payload - Raw payload
 * @returns {{valid: boolean, value?: object, error?: string}}
 */
function parseRestoreFilesPayload(payload) {
    if (!isPlainObject(payload)) {
        return invalid('Invalid restoreFiles payload');
    }

    const sharesCsv = normalizeString(payload.sharesCsv, LIMITS.maxCsvChars);
    const commentsCsv = normalizeString(payload.commentsCsv, LIMITS.maxCsvChars);
    return valid({ sharesCsv, commentsCsv });
}

/**
 * Parse analytics worker inbound message (main thread -> worker).
 * @param {unknown} message - Raw message event data
 * @returns {{valid: boolean, value?: object, error?: string}}
 */
export function parseAnalyticsWorkerRequest(message) {
    if (!isPlainObject(message) || typeof message.type !== 'string') {
        return invalid('Invalid analytics worker request envelope');
    }

    switch (message.type) {
        case 'addFile': {
            const payloadResult = parseAddFilePayload(message.payload);
            if (!payloadResult.valid) {
                return payloadResult;
            }
            return valid({ type: 'addFile', payload: payloadResult.value });
        }
        case 'restoreFiles': {
            const payloadResult = parseRestoreFilesPayload(message.payload);
            if (!payloadResult.valid) {
                return payloadResult;
            }
            return valid({ type: 'restoreFiles', payload: payloadResult.value });
        }
        case 'initBase':
            return valid({
                type: 'initBase',
                payload: isPlainObject(message.payload) ? message.payload : null
            });
        case 'view':
            return valid({
                type: 'view',
                requestId: normalizeRequestId(message.requestId),
                filters: isPlainObject(message.filters) ? message.filters : {}
            });
        case 'clear':
            return valid({ type: 'clear' });
        default:
            return invalid('Unknown analytics worker request type');
    }
}

/**
 * Parse analytics worker outbound message (worker -> main thread).
 * @param {unknown} message - Raw message event data
 * @returns {{valid: boolean, value?: object, error?: string}}
 */
export function parseAnalyticsWorkerMessage(message) {
    if (!isPlainObject(message) || typeof message.type !== 'string') {
        return invalid('Invalid analytics worker message envelope');
    }

    const base = {
        type: message.type,
        requestId: normalizeRequestId(message.requestId)
    };

    switch (message.type) {
        case 'restored':
            return valid({
                ...base,
                payload: isPlainObject(message.payload) ? message.payload : { hasData: false }
            });
        case 'init':
            return valid({
                ...base,
                payload: {
                    hasData: Boolean(isPlainObject(message.payload) && message.payload.hasData)
                }
            });
        case 'view':
            return valid({
                ...base,
                payload: isPlainObject(message.payload) ? message.payload : {}
            });
        case 'progress': {
            const payload = isPlainObject(message.payload) ? message.payload : {};
            return valid({
                ...base,
                payload: {
                    jobId: normalizeOptionalString(payload.jobId, LIMITS.maxJobIdChars),
                    fileName: normalizeString(payload.fileName, LIMITS.maxFileNameChars),
                    percent: normalizeNumber(payload.percent, 0, 0, 1)
                }
            });
        }
        case 'fileProcessed': {
            const payload = isPlainObject(message.payload) ? message.payload : {};
            const fileType = normalizeString(payload.fileType, 32);
            return valid({
                ...base,
                payload: {
                    fileType: FILE_TYPES.has(fileType) ? fileType : null,
                    fileName: normalizeString(payload.fileName, LIMITS.maxFileNameChars),
                    jobId: normalizeOptionalString(payload.jobId, LIMITS.maxJobIdChars),
                    rowCount: normalizeNumber(payload.rowCount, 0, 0, Number.MAX_SAFE_INTEGER),
                    analyticsBase: isPlainObject(payload.analyticsBase) ? payload.analyticsBase : null,
                    hasData: Boolean(payload.hasData),
                    error: normalizeOptionalString(payload.error, LIMITS.maxMessageChars)
                }
            });
        }
        case 'error': {
            const payload = isPlainObject(message.payload) ? message.payload : {};
            return valid({
                ...base,
                payload: {
                    message: normalizeString(payload.message, LIMITS.maxMessageChars) || 'Worker error.',
                    jobId: normalizeOptionalString(payload.jobId, LIMITS.maxJobIdChars),
                    fileName: normalizeString(payload.fileName, LIMITS.maxFileNameChars)
                }
            });
        }
        case 'cleared':
            return valid({ ...base, payload: {} });
        default:
            return invalid('Unknown analytics worker message type');
    }
}

/**
 * Parse connections worker request envelope.
 * @param {unknown} message - Raw request
 * @returns {{valid: boolean, value?: object, error?: string}}
 */
export function parseConnectionsWorkerRequest(message) {
    if (!isPlainObject(message) || message.type !== 'process') {
        return invalid('Invalid connections worker request envelope');
    }
    const payload = isPlainObject(message.payload) ? message.payload : {};
    const connectionsCsv = normalizeString(payload.connectionsCsv, LIMITS.maxCsvChars + 1);
    if (!connectionsCsv) {
        return invalid('Missing connectionsCsv payload');
    }
    if (connectionsCsv.length > LIMITS.maxCsvChars) {
        return invalid('connectionsCsv payload exceeds allowed size');
    }
    return valid({
        type: 'process',
        requestId: normalizeRequestId(message.requestId),
        payload: { connectionsCsv }
    });
}

/**
 * Parse connections worker outbound message.
 * @param {unknown} message - Raw worker message
 * @returns {{valid: boolean, value?: object, error?: string}}
 */
export function parseConnectionsWorkerMessage(message) {
    if (!isPlainObject(message) || typeof message.type !== 'string') {
        return invalid('Invalid connections worker message envelope');
    }

    if (message.type === 'error') {
        const payload = isPlainObject(message.payload) ? message.payload : {};
        return valid({
            type: 'error',
            requestId: normalizeRequestId(message.requestId),
            payload: {
                message: normalizeString(payload.message, LIMITS.maxMessageChars) || 'Worker error.'
            }
        });
    }

    if (message.type !== 'processed') {
        return invalid('Unknown connections worker message type');
    }

    const payload = isPlainObject(message.payload) ? message.payload : {};
    return valid({
        type: 'processed',
        requestId: normalizeRequestId(message.requestId),
        payload: {
            success: Boolean(payload.success),
            analytics: isPlainObject(payload.analytics) ? payload.analytics : null,
            rows: Array.isArray(payload.rows) ? payload.rows : [],
            error: normalizeOptionalString(payload.error, LIMITS.maxMessageChars)
        }
    });
}

/**
 * Parse messages worker request envelope.
 * @param {unknown} message - Raw request
 * @returns {{valid: boolean, value?: object, error?: string}}
 */
export function parseMessagesWorkerRequest(message) {
    if (!isPlainObject(message) || message.type !== 'process') {
        return invalid('Invalid messages worker request envelope');
    }
    const payload = isPlainObject(message.payload) ? message.payload : {};
    const messagesCsv = normalizeString(payload.messagesCsv, LIMITS.maxCsvChars + 1);
    if (!messagesCsv) {
        return invalid('Missing messagesCsv payload');
    }
    if (messagesCsv.length > LIMITS.maxCsvChars) {
        return invalid('messagesCsv payload exceeds allowed size');
    }
    const connectionsCsv = normalizeString(payload.connectionsCsv, LIMITS.maxCsvChars);
    return valid({
        type: 'process',
        requestId: normalizeRequestId(message.requestId),
        payload: {
            messagesCsv,
            connectionsCsv
        }
    });
}

/**
 * Parse messages worker outbound message.
 * @param {unknown} message - Raw worker message
 * @returns {{valid: boolean, value?: object, error?: string}}
 */
export function parseMessagesWorkerMessage(message) {
    if (!isPlainObject(message) || message.type !== 'processed') {
        return invalid('Invalid messages worker message envelope');
    }
    return valid({
        type: 'processed',
        requestId: normalizeRequestId(message.requestId),
        payload: isPlainObject(message.payload) ? message.payload : null
    });
}

/**
 * Parse a persisted upload record loaded from cache/storage.
 * @param {unknown} file - Raw file object
 * @returns {{valid: boolean, value?: object, error?: string}}
 */
export function parseStoredUploadFile(file) {
    if (!isPlainObject(file)) {
        return invalid('Invalid stored file payload');
    }

    const type = normalizeString(file.type, 32);
    if (!FILE_TYPES.has(type)) {
        return invalid('Invalid stored file type');
    }

    return valid({
        type,
        name: normalizeString(file.name, LIMITS.maxFileNameChars),
        text: normalizeString(file.text, LIMITS.maxCsvChars),
        rowCount: normalizeNumber(file.rowCount, 0, 0, Number.MAX_SAFE_INTEGER),
        updatedAt: normalizeNumber(file.updatedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER)
    });
}
