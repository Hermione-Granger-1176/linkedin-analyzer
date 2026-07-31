/**
 * Messages parsing for the PDF export.
 *
 * `LinkedInCleaner` exists to make a workbook safe: it quote-prefixes anything a
 * spreadsheet would evaluate as a formula, strips XML-illegal control characters
 * and trims every cell. None of that applies to a programmatically drawn PDF,
 * and all of it corrupts ordinary messages - "+1, that works for me" comes back
 * as "'+1, that works for me".
 *
 * So the export reuses the same CSV parser and the same date, name and URL
 * normalizers, and leaves `CONTENT` exactly as the parser produced it. The Excel
 * path keeps the full spreadsheet-oriented cleaner, which genuinely needs the
 * escaping.
 */

import { LinkedInCleaner } from "../cleaning/cleaner.js";
import { CLEANERS, cleanValue, isMissing } from "../cleaning/field-cleaners.js";

const FILE_TYPE = "messages";
const BODY_COLUMN = "CONTENT";
const CONFIG = LinkedInCleaner.configs[FILE_TYPE];

const COLUMNS = Object.freeze(
    CONFIG.columns.map((column) =>
        Object.freeze({ name: column.name, clean: CLEANERS[column.cleaner] || cleanValue }),
    ),
);

/**
 * Take the message body exactly as the CSV tokenizer produced it.
 *
 * `parseCsvRows` is the single decoding layer: it already collapses the doubled
 * quotes the CSV format uses to escape a literal quote, and it treats backslash
 * as an ordinary character for messages (`CSV_OPTIONS_DEFAULT` sets
 * `escape: null`). A second unescaping pass here would re-decode already-decoded
 * text and corrupt bodies that legitimately contain adjacent quotes, so there
 * isn't one.
 * @param {unknown} value - Parsed CONTENT cell
 * @returns {string} Message body, verbatim
 */
function decodeMessageBody(value) {
    // CONTENT is a required column and the parser fills every cell, so a missing
    // body cannot reach here; the guard is defensive.
    /* v8 ignore next 3 */
    if (value === null || value === undefined) {
        return "";
    }
    return String(value);
}

/**
 * Parse a messages CSV for the PDF export, preserving message bodies verbatim.
 * @param {string} csvText - Raw messages CSV text
 * @returns {{success: boolean, rows: object[], error: string|null}} Parsed rows
 */
export function parseMessagesForExport(csvText) {
    const parsed = LinkedInCleaner.parseCSV(csvText, FILE_TYPE);
    if (parsed.error) {
        return { success: false, rows: [], error: parsed.error };
    }

    const validation = LinkedInCleaner.validateColumns(parsed.headers, FILE_TYPE);
    if (!validation.valid) {
        return {
            success: false,
            rows: [],
            error: `This file is missing required Messages columns: ${validation.missing.join(", ")}.`,
        };
    }

    const rows = [];
    for (const raw of parsed.data) {
        const row = {};
        for (const column of COLUMNS) {
            row[column.name] =
                column.name === BODY_COLUMN
                    ? decodeMessageBody(raw[column.name])
                    : column.clean(raw[column.name]);
        }
        // Same row-level drop rule the spreadsheet cleaner applies, so the export
        // sees the same messages the workbook would have.
        if (CONFIG.requiredColumns.every((name) => !isMissing(row[name]))) {
            rows.push(row);
        }
    }

    return { success: true, rows, error: null };
}
