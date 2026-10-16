/**
 * Low-level CSV parsing primitives for LinkedIn exports.
 *
 * A character-by-character scanner with a quote/escape/newline state machine
 * that splits raw CSV text into rows of string cells. Used by the
 * LinkedInCleaner facade in cleaner.js to turn file text into rows.
 */

import { MAX_CSV_CHARS, MAX_CSV_ROWS } from "../../shared/limits.js";

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
    maxRows: MAX_CSV_ROWS,
    maxColumns: 256,
    maxFieldChars: 200000,
});

/**
 * Check if every cell in a row is missing.
 * @param {unknown[]} row - Array of cell values
 * @returns {boolean} True if all cells are missing
 */
export function isRowEmpty(row) {
    return row.every((cell) => isMissing(cell));
}

/**
 * Incremental CSV parser. push returns the first error so far, or null; finish flushes
 * the last row and returns the final error, or null.
 * @typedef {{push: (chunk: string) => string|null, finish: () => string|null}} CsvRowParser
 */

/** Step result meaning the scanner needs the next chunk before it can decide. */
const NEED_MORE = -1;

/**
 * Create an incremental CSV parser that takes text chunks and emits complete rows.
 *
 * Quote, escape, and newline state carries across chunks, so a quoted field, a
 * CRLF pair, an escape, or a surrogate pair may straddle two chunks. Running
 * counts enforce the same character, row, column, and field limits as a
 * whole-text parse. Empty rows are held back until a non-empty row follows,
 * so trailing empty rows are never emitted. Rows emitted before an error are
 * not retracted; a caller that sees an error should discard them.
 * @param {{delimiter: string, quote: string, escape: string|null}} options
 * @param {(row: string[]) => void} onRow - Called once per complete row, in order
 * @returns {CsvRowParser} push returns the first error so far, or null; finish flushes the
 * last row and returns the final error, or null.
 */
export function createCsvRowParser(options, onRow) {
    const { delimiter, quote, escape } = options;

    // Character codes for the hot scanning loop (avoids per-char string allocation).
    const CR = 13;
    const LF = 10;
    const quoteCode = quote.charCodeAt(0);
    const delimiterCode = delimiter.charCodeAt(0);
    const escapeCode = escape ? escape.charCodeAt(0) : -1;

    // The text being scanned: the unconsumed tail of the previous chunk plus the new chunk.
    let csvText = "";
    let length = 0;
    // True when no more chunks will follow, so lookahead past the end means end of input.
    let atEnd = false;
    let carry = "";
    let totalChars = 0;
    let rowCount = 0;
    /** @type {string[][]} */
    let heldEmptyRows = [];
    let finished = false;

    /** @type {string[]} */
    let row = [];
    let field = "";
    /** @type {number} */
    let state = CSV_PARSE_STATE.OUTSIDE_QUOTES;
    /** @type {string|null} */
    let parseError = null;

    // Reject oversized fields *before* appending, so we never allocate a
    // large string to discard. addLength is the number of characters
    // about to be appended to the field being parsed.
    /**
     * @param {number} addLength - Characters about to be appended
     * @returns {boolean} True when the field would exceed the limit
     */
    const wouldOverflowField = (addLength) => {
        if (field.length + addLength > CSV_LIMITS.maxFieldChars) {
            parseError = "CSV parsing error: one field is too large to process safely.";
            return true;
        }
        return false;
    };

    // True when the character at index is a high surrogate whose pair may arrive in the next chunk.
    /**
     * @param {number} index - Index into csvText
     * @returns {boolean}
     */
    const splitsSurrogatePair = (index) => {
        const code = csvText.charCodeAt(index);
        return index + 1 >= length && !atEnd && code >= 0xd800 && code <= 0xdbff;
    };

    /**
     * @param {number} start - Index of the escape character
     * @returns {number} Next index, or NEED_MORE
     */
    const consumeEscape = (start) => {
        if (start + 1 >= length) {
            if (!atEnd) {
                return NEED_MORE;
            }
            parseError = "CSV parsing error: trailing escape character.";
            return length;
        }
        if (splitsSurrogatePair(start + 1)) {
            return NEED_MORE;
        }
        // start + 1 < length was checked, so the index is in range and
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
        if (rowCount >= CSV_LIMITS.maxRows) {
            parseError = "CSV parsing error: row limit exceeded for this file.";
            return false;
        }
        rowCount += 1;
        if (isRowEmpty(row)) {
            heldEmptyRows.push(row);
        } else {
            for (const emptyRow of heldEmptyRows) {
                onRow(emptyRow);
            }
            heldEmptyRows = [];
            onRow(row);
        }
        row = [];
        return true;
    };

    // Handle one step while inside a quoted field; returns the next index,
    // or NEED_MORE when the decision depends on the next chunk.
    // Setting parseError (here, in consumeEscape, or in wouldOverflowField) stops the outer loop.
    /**
     * @param {number} start - Current index
     * @returns {number} Next index, or NEED_MORE
     */
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
        if ((code === quoteCode || code === CR) && start + 1 >= length && !atEnd) {
            return NEED_MORE;
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
        if (csvText.charCodeAt(start + 1) === LF) {
            field += "\n";
            return start + 2;
        }
        field += "\r";
        return start + 1;
    };

    // Handle one step while outside quotes; returns the next index,
    // or NEED_MORE when the decision depends on the next chunk.
    /**
     * @param {number} start - Current index
     * @returns {number} Next index, or NEED_MORE
     */
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
        if (start + 1 >= length && !atEnd) {
            return NEED_MORE;
        }
        if (pushField()) {
            pushRow();
        }
        return csvText.charCodeAt(start + 1) === LF ? start + 2 : start + 1;
    };

    // Scan csvText from the start, keeping any tail that needs lookahead as the next carry.
    const scan = () => {
        let i = 0;
        while (i < length && !parseError) {
            const next =
                state === CSV_PARSE_STATE.INSIDE_QUOTES
                    ? stepInsideQuotes(i)
                    : stepOutsideQuotes(i);
            if (next === NEED_MORE) {
                break;
            }
            i = next;
        }
        carry = i < length ? csvText.slice(i) : "";
        csvText = "";
        length = 0;
    };

    /**
     * @param {string} chunk - Next text chunk
     * @returns {string|null} First error so far, or null
     */
    const push = (chunk) => {
        if (parseError || finished || chunk.length === 0) {
            return parseError;
        }
        totalChars += chunk.length;
        if (totalChars > CSV_LIMITS.maxChars) {
            const maxMb = Math.round(CSV_LIMITS.maxChars / (1024 * 1024));
            parseError = `CSV file exceeds ${maxMb}MB parser limit`;
            return parseError;
        }
        csvText = carry + chunk;
        length = csvText.length;
        scan();
        return parseError;
    };

    const finish = () => {
        if (finished) {
            return parseError;
        }
        finished = true;
        if (parseError) {
            return parseError;
        }
        atEnd = true;
        csvText = carry;
        length = carry.length;
        scan();
        if (parseError) {
            return parseError;
        }
        // Both pushers set parseError when they refuse.
        if (!pushField() || !pushRow()) {
            return parseError;
        }
        heldEmptyRows = [];
        return state === CSV_PARSE_STATE.INSIDE_QUOTES
            ? "CSV parsing error: unmatched quote"
            : null;
    };

    return { push, finish };
}

/**
 * Parse CSV into rows with support for quoted fields, configured escaped characters, and newlines.
 *
 * A thin wrapper that feeds the whole text through createCsvRowParser in one chunk.
 * @param {string} csvText
 * @param {{delimiter: string, quote: string, escape: string|null}} options
 * @returns {{rows: string[][], error: string|null}}
 */
export function parseCsvRows(csvText, options = CSV_OPTIONS_DEFAULT) {
    if (csvText.length > CSV_LIMITS.maxChars) {
        const maxMb = Math.round(CSV_LIMITS.maxChars / (1024 * 1024));
        return {
            rows: [],
            error: `CSV file exceeds ${maxMb}MB parser limit`,
        };
    }

    /** @type {string[][]} */
    const rows = [];
    const parser = createCsvRowParser(options, (row) => {
        rows.push(row);
    });
    parser.push(csvText);
    const error = parser.finish();
    if (error && error !== "CSV parsing error: unmatched quote") {
        return { rows: [], error };
    }
    return { rows, error };
}
