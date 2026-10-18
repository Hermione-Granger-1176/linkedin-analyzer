/**
 * Parse messages for the PDF without changing their bodies.
 *
 * Reuse CSV parsing and date, name, and URL normalization. Keep CONTENT exactly
 * as the parser produced it. Spreadsheet cleaning would prefix an apostrophe
 * to ordinary messages such as "+1, that works for me" and trim their whitespace.
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
 * Return the message body exactly as the CSV parser decoded it.
 * parseCsvRows already decodes doubled CSV quotes. CSV_OPTIONS_DEFAULT treats
 * backslashes as ordinary characters, so another unescaping pass would corrupt
 * bodies that contain adjacent quotes or backslashes.
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
 * the row carries an empty `CONTENT`, so a caller can hold many rows without
 * their bodies. A value cache cleans every other repeated value once.
 * @param {Record<string, unknown>} raw - Parsed record keyed by CSV column name
 * @param {{withBody?: boolean, cache?: import("../cleaning/string-pool.js").ValueCache|null}} [options] - Body and value handling
 * @returns {MessageRow|null} Export row
 */
export function toExportRow(raw, { withBody = true, cache = null } = {}) {
    /** @type {MessageRow} */
    const row = {};
    for (const column of COLUMNS) {
        const value = raw[column.name];
        row[column.name] =
            cache && column.name !== BODY_COLUMN
                ? cache(column.name, value, column.read)
                : column.read(value);
    }
    if (!CONFIG.requiredColumns.every((name) => !isMissing(row[name]))) {
        return null;
    }
    if (!withBody) {
        row[BODY_COLUMN] = "";
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
