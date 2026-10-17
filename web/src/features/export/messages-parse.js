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
        Object.freeze({
            name: column.name,
            // CONTENT is taken verbatim; every other column gets its usual cleaner.
            read:
                column.name === BODY_COLUMN
                    ? messageBodyText
                    : CLEANERS[
                          /** @type {import("../cleaning/field-cleaners.js").CleanerName} */ (
                              column.cleaner
                          )
                      ] || cleanValue,
        }),
    ),
);

/**
 * One parsed messages row, keyed by CSV column name.
 * @typedef {Record<string, string>} MessageRow
 */

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
function messageBodyText(value) {
    // CONTENT is required and the parser fills every cell. Keep an empty body for malformed data.
    /* v8 ignore next 3 */
    if (value === null || value === undefined) {
        return "";
    }
    return String(value);
}

/**
 * Build one export row from a parsed record, or null when the row lacks a
 * required value. The drop rule is the spreadsheet cleaner's, so the export
 * sees the same messages the workbook would have.
 *
 * With `withBody` false the body still decides whether the row is kept, but
 * the row carries an empty `CONTENT`, and `keep` sees every other value with
 * its column name first, so a caller can hold many rows without their bodies.
 * @param {Record<string, unknown>} raw - Parsed record keyed by CSV column name
 * @param {{withBody?: boolean, keep?: (value: string, column: string) => string}} [options] - Body and value handling
 * @returns {MessageRow|null} Export row
 */
export function toExportRow(raw, { withBody = true, keep = (value) => value } = {}) {
    /** @type {MessageRow} */
    const row = {};
    for (const column of COLUMNS) {
        row[column.name] = column.read(raw[column.name]);
    }
    if (!CONFIG.requiredColumns.every((name) => !isMissing(row[name]))) {
        return null;
    }
    if (!withBody) {
        for (const column of COLUMNS) {
            row[column.name] =
                column.name === BODY_COLUMN ? "" : keep(row[column.name], column.name);
        }
    }
    return row;
}

/**
 * Read one record's message body exactly as `toExportRow` would.
 * @param {Record<string, unknown>} raw - Parsed record keyed by CSV column name
 * @returns {string} Message body, verbatim
 */
export function exportRowBody(raw) {
    return messageBodyText(raw[BODY_COLUMN]);
}

/**
 * Parse a messages CSV for the PDF export, preserving message bodies verbatim.
 * @param {string} csvText - Raw messages CSV text
 * @returns {{success: boolean, rows: MessageRow[], error: string|null}} Parsed rows
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

    /** @type {MessageRow[]} */
    const rows = [];
    for (const raw of parsed.data) {
        const row = toExportRow(raw);
        if (row) {
            rows.push(row);
        }
    }

    return { success: true, rows, error: null };
}
