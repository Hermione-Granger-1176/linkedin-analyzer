/**
 * Self-detection tiebreak keys for the PDF export.
 *
 * Pure: no DOM, no storage, no worker globals, so the thread selection worker
 * and its transport's main-thread fallback share one copy of the arithmetic
 * rather than each keeping their own and drifting apart, exactly as they
 * already share `messages-parse.js`.
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

import { LinkedInCleaner } from "../cleaning/cleaner.js";
import { MessagesAnalytics } from "../messages/analytics.js";

const FILE_TYPE = "connections";

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

    const keys = new Set();
    for (const row of parsed.data) {
        const name = MessagesAnalytics.normalizeName(
            `${row["First Name"] || ""} ${row["Last Name"] || ""}`,
        );
        if (name) {
            keys.add(name);
        }
        const url = MessagesAnalytics.normalizeUrl(row.URL);
        if (url) {
            keys.add(url);
        }
    }
    return Array.from(keys);
}
