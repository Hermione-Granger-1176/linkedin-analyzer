/**
 * Low-level CSV parsing primitives for LinkedIn exports.
 *
 * A character-by-character scanner with a quote/escape/newline state machine
 * that splits raw CSV text into rows of string cells. Used by the
 * LinkedInCleaner facade in cleaner.js to turn file text into rows.
 */

import { MAX_CSV_CHARS } from "./constants.js";
import { isMissing } from "./field-cleaners.js";

export const CSV_OPTIONS_DEFAULT = Object.freeze({
    delimiter: ",",
    quote: '"',
    escape: null,
});

export const CSV_OPTIONS_COMMENTS = Object.freeze({
    delimiter: ",",
    quote: '"',
    escape: "\\",
});

const CSV_PARSE_STATE = Object.freeze({
    OUTSIDE_QUOTES: 0,
    INSIDE_QUOTES: 1,
});

const CSV_LIMITS = Object.freeze({
    maxChars: MAX_CSV_CHARS,
    maxRows: 500000,
    maxColumns: 256,
    maxFieldChars: 200000,
});

/**
 * Check if every cell in a row is missing.
 * @param {Array<*>} row - Array of cell values
 * @returns {boolean} True if all cells are missing
 */
export function isRowEmpty(row) {
    return row.every((cell) => isMissing(cell));
}

/**
 * Parse CSV into rows with support for quoted fields, configured escaped characters, and newlines.
 * @param {string} csvText
 * @param {{delimiter: string, quote: string, escape: string|null}} options
 * @returns {{rows: string[][], error: string|null}}
 */
export function parseCsvRows(csvText, options = CSV_OPTIONS_DEFAULT) {
    const { delimiter, quote, escape } = options;
    if (csvText.length > CSV_LIMITS.maxChars) {
        const maxMb = Math.round(CSV_LIMITS.maxChars / (1024 * 1024));
        return {
            rows: [],
            error: `CSV file exceeds ${maxMb}MB parser limit`,
        };
    }

    // Character codes for the hot scanning loop (avoids per-char string allocation).
    const CR = 13;
    const LF = 10;
    const quoteCode = quote.charCodeAt(0);
    const delimiterCode = delimiter.charCodeAt(0);
    const escapeCode = escape ? escape.charCodeAt(0) : -1;
    const length = csvText.length;

    const rows = [];
    let row = [];
    let field = "";
    /** @type {number} */
    let state = CSV_PARSE_STATE.OUTSIDE_QUOTES;
    let parseError = null;

    // Reject oversized fields *before* appending, so we never allocate a
    // huge string just to discard it. addLength is the number of characters
    // about to be appended to the current field.
    const wouldOverflowField = (addLength) => {
        if (field.length + addLength > CSV_LIMITS.maxFieldChars) {
            parseError = "CSV parsing error: one field is too large to process safely.";
            return true;
        }
        return false;
    };

    const consumeEscape = (start) => {
        if (start + 1 >= length) {
            parseError = "CSV parsing error: trailing escape character.";
            return length;
        }
        // start + 1 < length was just checked, so the index is in range and
        // codePointAt always returns a code point (never undefined) here.
        const escapedCodePoint = /** @type {number} */ (csvText.codePointAt(start + 1));
        const escapedCharacter = String.fromCodePoint(escapedCodePoint);
        if (wouldOverflowField(escapedCharacter.length)) {
            return start + 1 + escapedCharacter.length;
        }
        field += escapedCharacter;
        return start + 1 + escapedCharacter.length;
    };

    const pushField = () => {
        if (row.length >= CSV_LIMITS.maxColumns) {
            parseError = "CSV parsing error: too many columns in a row.";
            return false;
        }
        row.push(field);
        field = "";
        return true;
    };

    const pushRow = () => {
        if (rows.length >= CSV_LIMITS.maxRows) {
            parseError = "CSV parsing error: row limit exceeded for this file.";
            return false;
        }
        rows.push(row);
        row = [];
        return true;
    };

    // Handle one step while inside a quoted field; returns the next index.
    // Setting parseError (here, in consumeEscape, or in wouldOverflowField) stops the outer loop.
    const stepInsideQuotes = (start) => {
        // Bulk-copy the run of ordinary characters up to the next quote,
        // carriage return, or escape character.
        let j = start;
        while (j < length) {
            const code = csvText.charCodeAt(j);
            if (code === quoteCode || code === CR || code === escapeCode) {
                break;
            }
            j += 1;
        }
        if (j > start) {
            if (wouldOverflowField(j - start)) {
                return j;
            }
            field += csvText.slice(start, j);
            return j;
        }

        const code = csvText.charCodeAt(start);
        if (code === escapeCode) {
            return consumeEscape(start);
        }
        if (code === quoteCode) {
            // Lone closing quote: leave the quoted section.
            if (csvText.charCodeAt(start + 1) !== quoteCode) {
                state = CSV_PARSE_STATE.OUTSIDE_QUOTES;
                return start + 1;
            }
            // Doubled quote collapses to a single literal quote.
            if (wouldOverflowField(1)) {
                return start + 2;
            }
            field += quote;
            return start + 2;
        }
        if (wouldOverflowField(1)) {
            return start + 1;
        }
        if (code === CR) {
            if (csvText.charCodeAt(start + 1) === LF) {
                field += "\n";
                return start + 2;
            }
            field += "\r";
            return start + 1;
        }
        field += csvText[start];
        return start + 1;
    };

    // Handle one step while outside quotes; returns the next index.
    const stepOutsideQuotes = (start) => {
        // Bulk-copy ordinary characters up to the next quote, escape,
        // delimiter, or line break.
        let j = start;
        while (j < length) {
            const code = csvText.charCodeAt(j);
            if (
                code === quoteCode ||
                code === escapeCode ||
                code === delimiterCode ||
                code === CR ||
                code === LF
            ) {
                break;
            }
            j += 1;
        }
        if (j > start) {
            if (wouldOverflowField(j - start)) {
                return j;
            }
            field += csvText.slice(start, j);
            return j;
        }

        const code = csvText.charCodeAt(start);
        if (code === escapeCode) {
            return consumeEscape(start);
        }
        if (code === quoteCode) {
            // Quotes only open a quoted section at the start of a field;
            // mid-field quotes stay literal (matches the Python cleaner's
            // pandas parsing).
            if (field.length === 0) {
                state = CSV_PARSE_STATE.INSIDE_QUOTES;
                return start + 1;
            }
            if (wouldOverflowField(1)) {
                return start + 1;
            }
            field += quote;
            return start + 1;
        }
        if (code === delimiterCode) {
            pushField();
            return start + 1;
        }
        if (code === LF) {
            // Short-circuit: only push the row when the field push succeeds.
            if (pushField()) {
                pushRow();
            }
            return start + 1;
        }
        // Carriage return ends the row, consuming a following newline (CRLF).
        if (pushField()) {
            pushRow();
        }
        return csvText.charCodeAt(start + 1) === LF ? start + 2 : start + 1;
    };

    let i = 0;
    while (i < length && !parseError) {
        i =
            state === CSV_PARSE_STATE.INSIDE_QUOTES
                ? stepInsideQuotes(i)
                : stepOutsideQuotes(i);
    }

    if (parseError) {
        return {
            rows: [],
            error: parseError,
        };
    }

    if (!pushField() || !pushRow()) {
        return {
            rows: [],
            error: parseError || "CSV parsing error.",
        };
    }

    let lastNonEmptyIndex = -1;
    for (let k = rows.length - 1; k >= 0; k -= 1) {
        if (!isRowEmpty(rows[k])) {
            lastNonEmptyIndex = k;
            break;
        }
    }
    const trimmedRows = lastNonEmptyIndex === -1 ? [] : rows.slice(0, lastNonEmptyIndex + 1);

    return {
        rows: trimmedRows,
        error:
            state === CSV_PARSE_STATE.INSIDE_QUOTES
                ? "CSV parsing error: unmatched quote"
                : null,
    };
}
