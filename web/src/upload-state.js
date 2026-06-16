/**
 * Pure file-state and hint helpers for the upload page.
 *
 * These functions build the empty tracked-file map, resolve the upload hint
 * message, test analytics readiness, and map a file type to its cache key. They
 * are stateless and depend only on their arguments, so the UploadPage engine
 * imports them back and they are unit-tested directly in upload-state.test.js.
 */

const UPLOAD_HINT_BY_STATE = Object.freeze({
    "0-0-0": "Upload at least one file to start.",
    "0-0-1": "Upload at least one file to start.",
    "0-1-0": "Upload at least one file to start.",
    "0-1-1": "Upload at least one file to start.",
    "1-1-0": "Processing analytics in the background.",
    "1-1-1": "Analytics are ready. Open the dashboard.",
    "1-0-0": "Files loaded. Open Messages tab for conversation insights.",
    "1-0-1": "Files loaded. Open Messages tab for conversation insights.",
});

/**
 * Create an empty file map.
 * @returns {{shares: null, comments: null, messages: null, connections: null}}
 */
export function createEmptyFileMap() {
    return {
        shares: null,
        comments: null,
        messages: null,
        connections: null,
    };
}

/**
 * Resolve current upload hint message.
 * @param {boolean} hasAny - Whether any tracked file exists
 * @param {boolean} hasAnalyticsFiles - Whether shares/comments exist
 * @param {boolean} analyticsReady - Whether analytics base is available
 * @returns {string}
 */
export function getUploadHint(hasAny, hasAnalyticsFiles, analyticsReady) {
    const stateKey = `${hasAny ? 1 : 0}-${hasAnalyticsFiles ? 1 : 0}-${analyticsReady ? 1 : 0}`;
    return (
        UPLOAD_HINT_BY_STATE[stateKey] ||
        "Files loaded. Open Messages tab for conversation insights."
    );
}

/**
 * Check whether analytics base contains at least one month bucket.
 * @param {object|null} analyticsBase - Analytics aggregate base
 * @returns {boolean}
 */
export function hasAnalyticsMonths(analyticsBase) {
    return Boolean(
        analyticsBase && analyticsBase.months && Object.keys(analyticsBase.months).length,
    );
}

/**
 * Resolve per-file cache key for messages/connections datasets.
 * @param {string} fileType - Processed file type
 * @returns {string|null}
 */
export function getTypeSpecificFileCacheKey(fileType) {
    switch (fileType) {
        case "messages":
            return "storage:file:messages";
        case "connections":
            return "storage:file:connections";
        default:
            return null;
    }
}
