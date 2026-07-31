/**
 * The stored data an export is built from, and the cheap check over it.
 *
 * Split out of collect.js rather than left beside the collection it serves. The
 * export button is on every screen, so the surface that owns it is wired up on
 * load and asks this question straight away, while collect.js reaches the layout
 * engine, the charts and three worker transports. Keeping the question here is
 * what lets all of that be fetched only when someone actually exports.
 *
 * The dependency runs one way: collect.js reads through these, and nothing here
 * may reach back into the collection graph.
 */

import { captureError } from "../../platform/observability/sentry.js";
import { DataCache } from "../../platform/persistence/data-cache.js";
import { Storage } from "../../platform/persistence/storage.js";
import { INSIGHTS_EXPORT_CACHE_KEY } from "../../shared/constants.js";

const ANALYTICS_BASE_CACHE_KEY = "storage:analyticsBase";

// Stored files that produce a dashboard on their own, without contributing to
// the analytics base the insight cards are built from.
const DASHBOARD_FILE_TYPES = new Set(["connections", "messages"]);

/**
 * Read a stored value without letting a storage failure abort the export.
 *
 * The caught value is discarded rather than reported: one of these reads is the
 * stored messages CSV, so a storage error could carry a fragment of it.
 * @param {() => Promise<any>} read - Storage reader
 * @param {string} operation - Fixed identifier for diagnostics
 * @returns {Promise<any>} Stored value, or null when unavailable
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
 * @returns {Promise<any>} Analytics base carrying months, or null
 */
export async function readAnalyticsBase() {
    const cached = DataCache.get(ANALYTICS_BASE_CACHE_KEY);
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
 * @returns {Promise<any>} Outreach summary, or null
 */
export function readOutreach() {
    return readSafely(() => Storage.getOutreach(), "load-outreach");
}

/**
 * Report whether a published snapshot holds anything the document would show.
 *
 * Insight cards are not the only thing on the Insights screen: a range can
 * produce no cards while the all-time stats below them are still populated.
 * Testing the cards alone would send that screen down the cold path and export
 * the default range instead of the one the user has selected.
 * @param {object|null|undefined} snapshot - Published Insights snapshot
 * @returns {boolean} True when the snapshot carries content
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
    const snapshot = DataCache.get(INSIGHTS_EXPORT_CACHE_KEY);
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
