/* Pure formatting, range, and signature helpers for the messages page.
 *
 * Everything here is stateless: each function takes its inputs and returns a
 * value with no reads or writes of worker, DOM, or cache state. The messages
 * page engine (messages-insights.js) wires these into its controller lifecycle.
 */

/** Default time range used when no valid range is provided. */
export const DEFAULT_TIME_RANGE = "12m";

/** Month spans for each named time range. */
const RANGE_MONTHS = Object.freeze({
    "1m": 1,
    "3m": 3,
    "6m": 6,
    "12m": 12,
});

/** Milliseconds in one day. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Worker watchdog scales with input size: a base allowance plus more time per
// megabyte of CSV so large exports are not cut off prematurely.
const WORKER_TIMEOUT_BASE_MS = 30000;
const WORKER_TIMEOUT_PER_MB_MS = 5000;
const BYTES_PER_MB = 1024 * 1024;

const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
});

/**
 * Parse route range query value.
 * @param {string} value - Raw route value
 * @param {string} fallback - Range to use when the value is not recognized
 * @returns {string}
 */
export function parseRangeParam(value, fallback) {
    const range = String(value || "").toLowerCase();
    return RANGE_MONTHS[range] || range === "all" ? range : fallback;
}

/**
 * Get range start timestamp from the selected range.
 * @param {string} range - Range key
 * @param {number} latestTimestamp - Latest message timestamp
 * @returns {number|null}
 */
export function getRangeStart(range, latestTimestamp) {
    if (range === "all") {
        return null;
    }
    const months = RANGE_MONTHS[range];
    if (!months || !latestTimestamp) {
        return null;
    }
    const latestDate = new Date(latestTimestamp);
    return new Date(
        latestDate.getFullYear(),
        latestDate.getMonth() - (months - 1),
        1,
        0,
        0,
        0,
        0,
    ).getTime();
}

/**
 * Format timestamp as human-readable date.
 * @param {number} timestamp - Timestamp in milliseconds
 * @returns {string}
 */
export function formatShortDate(timestamp) {
    return SHORT_DATE_FORMATTER.format(new Date(timestamp));
}

/**
 * Compute a size-scaled worker watchdog timeout.
 * @param {string} messagesCsv - Raw messages CSV text
 * @param {string} connectionsCsv - Raw connections CSV text
 * @returns {number} Timeout in milliseconds
 */
export function computeWorkerTimeout(messagesCsv, connectionsCsv) {
    const megabytes = (messagesCsv.length + connectionsCsv.length) / BYTES_PER_MB;
    return WORKER_TIMEOUT_BASE_MS + Math.floor(megabytes) * WORKER_TIMEOUT_PER_MB_MS;
}

/**
 * Build a cache signature from uploaded file metadata.
 * @param {object|null} messagesFile - Stored messages file
 * @param {object|null} connectionsFile - Stored connections file
 * @returns {string}
 */
export function buildDataSignature(messagesFile, connectionsFile) {
    const toPart = (file, type) => {
        if (!file) {
            return `${type}:none`;
        }
        const updatedAt = file.updatedAt || 0;
        const rowCount = file.rowCount || 0;
        const name = file.name || "unknown";
        return `${type}:${name}:${updatedAt}:${rowCount}`;
    };

    return [toPart(messagesFile, "messages"), toPart(connectionsFile, "connections")].join("|");
}
