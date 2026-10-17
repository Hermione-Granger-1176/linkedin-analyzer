/* Pure formatting, range, and signature helpers for the messages page.
 *
 * Everything here is stateless: each function takes its inputs and returns a
 * value with no reads or writes of worker, DOM, or cache state. The messages
 * page engine (screen.js) wires these into its controller lifecycle.
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
    if (range === "all" || Object.prototype.hasOwnProperty.call(RANGE_MONTHS, range)) {
        return range;
    }
    return fallback;
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
    const months = /** @type {Record<string, number>} */ (RANGE_MONTHS)[range];
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
 * Format an outreach reply rate as a percentage.
 * @param {number|null|undefined} replyRate - Fraction in [0, 1], or null when nothing was measured
 * @returns {string} Percentage text, or "N/A"
 */
export function formatReplyRate(replyRate) {
    return typeof replyRate === "number" ? `${Math.round(replyRate * 100)}%` : "N/A";
}

/**
 * Format a sent-to-received ratio.
 * @param {number|null|undefined} ratio - Sent over received, or null when nothing was received
 * @returns {string} Ratio text, or "N/A"
 */
export function formatSentRatio(ratio) {
    return typeof ratio === "number" ? `${ratio.toFixed(1)} : 1` : "N/A";
}

/**
 * Format timestamp as human-readable date.
 * @param {number} timestamp - Timestamp in milliseconds
 * @returns {string}
 */
export function formatShortDate(timestamp) {
    return SHORT_DATE_FORMATTER.format(new Date(timestamp));
}

/** @typedef {import("../../app/worker-contracts.js").CachedFileMetadata} CachedFileMetadata */

/**
 * Uploaded file fields that identify one version of an upload.
 * @typedef {Pick<CachedFileMetadata, "name" | "updatedAt" | "rowCount">} FileSignatureSource
 */

/**
 * Build a cache signature from uploaded file metadata.
 * @param {FileSignatureSource|null} messagesFile - Stored messages file
 * @param {FileSignatureSource|null} connectionsFile - Stored connections file
 * @returns {string}
 */
export function buildDataSignature(messagesFile, connectionsFile) {
    /**
     * @param {FileSignatureSource|null} file - Stored file, if any
     * @param {string} type - File type label
     * @returns {string}
     */
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
