/**
 * Self-detection tiebreak keys for the PDF export.
 *
 * No DOM, no storage, no worker globals, so the thread selection worker and
 * its transport's main-thread fallback share one copy of the arithmetic rather
 * than each keeping their own and drifting apart, exactly as they already
 * share `messages-parse.js`.
 *
 * Used only as a self-detection tiebreak: an export holding one conversation
 * cannot say which of its two people is the account owner, but the account owner
 * does not appear in the connections list. A missing or unreadable connections
 * file leaves the tie unresolved.
 *
 * Parsed rather than cleaned, unlike the connections dashboard: the cleaner
 * drops a row with no connection date, and somebody you are connected to is
 * still not you whether or not the export recorded when it happened.
 */

import { toCsvSource } from "../../shared/csv-source.js";
import { LinkedInCleaner } from "../cleaning/cleaner.js";
import { streamCleanFile } from "../cleaning/process-source.js";
import { MessagesAnalytics } from "../messages/analytics.js";
import { canStreamFileText, readCsvSource } from "../upload/read.js";

const FILE_TYPE = "connections";

/**
 * Add one connection's normalized name and profile URL to the keys.
 * @param {Set<string>} keys - Keys collected so far
 * @param {Record<string, unknown>} record - Parsed connections record
 */
function addContactKeys(keys, record) {
    const name = MessagesAnalytics.normalizeName(
        `${record["First Name"] || ""} ${record["Last Name"] || ""}`,
    );
    if (name) {
        keys.add(name);
    }
    const url = MessagesAnalytics.normalizeUrl(record.URL);
    if (url) {
        keys.add(url);
    }
}

/**
 * Collect the normalized names and profile URLs of the user's connections.
 * @param {string} connectionsCsv - Raw connections CSV text, or an empty string
 * @returns {string[]} Normalized keys, empty when there is nothing to read
 */
export function collectContactKeys(connectionsCsv) {
    if (!connectionsCsv) {
        return [];
    }
    const parsed = LinkedInCleaner.parseCSV(connectionsCsv, FILE_TYPE);
    if (parsed.error) {
        return [];
    }

    /** @type {Set<string>} */
    const keys = new Set();
    for (const row of parsed.data) {
        addContactKeys(keys, row);
    }
    return Array.from(keys);
}

/**
 * Collect the keys from a stored connections upload or CSV text. A stored
 * upload streams, so neither its whole text nor its parsed rows are held; one
 * that cannot stream as a connections file is read whole instead.
 * @param {unknown} source - Stored connections Blob or CSV text
 * @returns {Promise<string[]>} Normalized keys, empty when there is nothing to read
 */
export async function collectContactKeysFromSource(source) {
    const value = toCsvSource(source);
    if (typeof value !== "string" && canStreamFileText(/** @type {File} */ (value))) {
        /** @type {Set<string>} */
        const keys = new Set();
        const { processed } = await streamCleanFile(/** @type {File} */ (value), {
            onRecord: (record) => addContactKeys(keys, record),
            onRestart: () => keys.clear(),
        });
        if (processed?.fileType === FILE_TYPE) {
            return Array.from(keys);
        }
    }
    return collectContactKeys(await readCsvSource(source));
}
