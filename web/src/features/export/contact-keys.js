/**
 * Self-detection tiebreak keys for the PDF export.
 *
 * The thread worker and main-thread fallback share this module. It has no DOM,
 * storage, or worker-global dependencies.
 *
 * A single conversation cannot identify which participant owns the account.
 * The owner is absent from the connections list, which can resolve that tie.
 * A missing or unreadable connections file leaves it unresolved.
 *
 * Use parsed rows because the cleaner drops rows without connection dates.
 * Those rows can still identify participants who are not the account owner.
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
