/**
 * The stored data an export is built from, and the cheap check over it.
 *
 * Split this module out of collect.js because the export button is on every
 * screen. The button needs a cheap availability check on load, while collect.js
 * loads the layout engine, charts, and worker transports only for an export.
 *
 * The dependency runs one way: collect.js reads through these, and nothing here
 * may reach back into the collection graph.
 */

import { captureError } from "../../platform/observability/sentry.js";
import { DataCache } from "../../platform/persistence/data-cache.js";
import { Storage } from "../../platform/persistence/storage.js";
import { INSIGHTS_EXPORT_CACHE_KEY } from "../../shared/constants.js";

const ANALYTICS_BASE_CACHE_KEY = "storage:analyticsBase";

/** @typedef {import("../../platform/persistence/storage.js").StoredAnalytics} StoredAnalytics */
/** @typedef {import("../messages/analytics.js").OutreachSummary} OutreachSummary */

/**
 * Lifetime network growth, as an analytics view carries it.
 * @typedef {{multiplier?: number}} NetworkGrowth
 */

/**
 * The parts of a filtered analytics view the export reads.
 *
 * It crosses a worker boundary unvalidated, so the fields the export guards are
 * optional; the plotted series it hands straight to the charts are not.
 * @typedef {object} ExportAnalyticsView
 * @property {Array<{key: string, label: string, value: number}>} timeline - Activity timeline, keyed by date
 * @property {import("./pdf-charts.js").BarItem[]} topics - Top topics
 * @property {number[][]} heatmap - Day-by-hour activity counts
 * @property {{posts: number, comments: number, total: number}|null} [totals] - Activity totals
 * @property {{hour: number}|null} [peakHour] - Busiest hour of the day
 * @property {{current: number}|null} [streaks] - Activity streaks
 * @property {NetworkGrowth|null} [networkGrowth] - Lifetime network growth
 */

/**
 * The snapshot the Insights screen publishes for the export.
 * @typedef {object} InsightsSnapshot
 * @property {string} timeRange - Range key the snapshot describes
 * @property {import("./pdf-document.js").Insight[]} insights - Insight cards
 * @property {string|null} tip - Closing tip
 * @property {NetworkGrowth|null} networkGrowth - Lifetime network growth
 * @property {OutreachSummary|null} outreach - Persisted outreach summary
 * @property {ExportAnalyticsView|null} view - Filtered view the cards were built from
 */

// Stored files that produce a dashboard on their own, without contributing to
// the analytics base the insight cards are built from.
const DASHBOARD_FILE_TYPES = new Set(["connections", "messages"]);

/**
 * Read a stored value without letting a storage failure abort the export.
 *
 * The caught value is discarded rather than reported: one of these reads is the
 * stored messages CSV, so a storage error could carry a fragment of it.
 * @template T
 * @param {() => Promise<T>} read - Storage reader
 * @param {string} operation - Fixed identifier for diagnostics
 * @returns {Promise<T|null>} Stored value, or null when unavailable
 */
export async function readSafely(read, operation) {
    try {
        return await read();
    } catch {
        captureError(new Error("Export storage read failed."), {
            module: "pdf-export",
            operation,
        });
        return null;
    }
}

/**
 * Read the analytics base an export computes from, cache first.
 *
 * Shared so the availability check and the collection itself answer the same
 * question the same way: a cached base with no months used to make the button
 * read the stored one and say yes, while collection gave up without looking and
 * exported nothing.
 * @returns {Promise<StoredAnalytics|null>} Analytics base carrying months, or null
 */
export async function readAnalyticsBase() {
    const cached = /** @type {StoredAnalytics|undefined} */ (
        DataCache.get(ANALYTICS_BASE_CACHE_KEY)
    );
    if (cached && cached.months) {
        return cached;
    }
    const stored = await readSafely(() => Storage.getAnalytics(), "load-analytics");
    return stored && stored.months ? stored : null;
}

/**
 * Read the persisted outreach summary, treating a storage failure as absent.
 *
 * Shared with the collection itself for the same reason the analytics base is:
 * one statement of where the summary comes from, and of what it is reported as
 * when the read fails.
 * @returns {Promise<OutreachSummary|null>} Outreach summary, or null
 */
export function readOutreach() {
    // Stored records are normalized only to plain objects; the summary inside
    // is the one the messages worker computed.
    return /** @type {Promise<OutreachSummary|null>} */ (
        readSafely(() => Storage.getOutreach(), "load-outreach")
    );
}

/**
 * Report whether a published snapshot holds anything the document would show.
 *
 * Insight cards are not the only thing on the Insights screen: a range can
 * produce no cards while the all-time stats below them are still populated.
 * Testing the cards alone would send that screen down the cold path and export
 * the default range instead of the one the user has selected.
 * @param {InsightsSnapshot|null|undefined} snapshot - Published Insights snapshot
 * @returns {snapshot is InsightsSnapshot} True when the snapshot carries content
 */
export function hasSnapshotContent(snapshot) {
    if (!snapshot) {
        return false;
    }
    if (Array.isArray(snapshot.insights) && snapshot.insights.length) {
        return true;
    }
    return Boolean(snapshot.networkGrowth || snapshot.outreach);
}

/**
 * Check whether there is anything worth exporting.
 *
 * Used to disable the export button before the user opens the dialog, so it is
 * deliberately cheap: caches first, one small storage read otherwise, and no
 * part of the export's own machinery loaded to answer it.
 * @returns {Promise<boolean>} True when a PDF would contain something
 */
export async function hasExportableData() {
    const snapshot = /** @type {InsightsSnapshot|undefined} */ (
        DataCache.get(INSIGHTS_EXPORT_CACHE_KEY)
    );
    if (hasSnapshotContent(snapshot)) {
        return true;
    }
    if (await readAnalyticsBase()) {
        return true;
    }
    if (await readOutreach()) {
        return true;
    }
    // A connections or messages export produces a dashboard of its own without
    // ever reaching the analytics base, which only shares and comments fill. The
    // read is metadata only, so this stays as cheap as the checks above it.
    //
    // A row count rather than mere presence: an upload that stored no rows, or a
    // record whose text has since gone, is a file the dashboards will find
    // nothing in, and enabling the button for it promises a document that comes
    // back empty.
    const files = await readSafely(() => Storage.getAllFiles(), "load-file-metadata");
    return (
        Array.isArray(files) &&
        files.some((file) => DASHBOARD_FILE_TYPES.has(file.type) && file.rowCount > 0)
    );
}
