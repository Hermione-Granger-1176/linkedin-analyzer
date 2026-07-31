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
 * normalizers, and leaves `CONTENT` exactly as the file had it apart from the
 * quote unescaping the CSV format itself requires. The Excel path keeps the full
 * spreadsheet-oriented cleaner, which genuinely needs the escaping.
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
 * Undo the CSV-level quote escaping without touching anything else.
 *
 * The same two passes `cleanMessagesContent` runs, minus the trim: leading tabs
 * and trailing blank lines are part of what the person typed.
 * @param {unknown} value - Raw CONTENT cell
 * @returns {string} Message body, verbatim
 */
function decodeMessageBody(value) {
    if (value === null || value === undefined) {
        return "";
    }
    const text = String(value);
    if (!text.includes('"') && !text.includes("\\")) {
        return text;
    }
    return text.replace(/\\"/g, '"').replace(/""/g, '"');
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
