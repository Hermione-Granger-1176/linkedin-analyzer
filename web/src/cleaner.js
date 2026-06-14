/**
 * LinkedIn CSV Cleaner - JavaScript port of Python cleaning logic
 * Original: src/linkedin_analyzer/core/text.py
 */

import { FILE_TYPE_LABELS, MAX_CSV_CHARS } from "./constants.js";

export const LinkedInCleaner = (() => {
    "use strict";

    const FILE_TYPES = Object.freeze(["shares", "comments", "messages", "connections"]);
    const EMPTY_CSV_ERROR = "CSV file is empty or has no data rows";

    const CONFIGS = Object.freeze({
        shares: freezeConfig({
            columns: [
                { name: "Date", width: 20, cleaner: "cleanDate" },
                { name: "ShareLink", width: 60 },
                {
                    name: "ShareCommentary",
                    width: 100,
                    wrapText: true,
                    cleaner: "cleanSharesCommentary",
                },
                { name: "SharedUrl", width: 30, cleaner: "cleanEmptyField" },
                { name: "MediaUrl", width: 30, cleaner: "cleanEmptyField" },
                { name: "Visibility", width: 18 },
            ],
            requiredColumns: ["Date", "ShareLink", "ShareCommentary"],
            outputName: "Shares.xlsx",
        }),
        comments: freezeConfig({
            columns: [
                { name: "Date", width: 20, cleaner: "cleanDate" },
                { name: "Link", width: 60 },
                { name: "Message", width: 100, wrapText: true, cleaner: "cleanCommentsMessage" },
            ],
            requiredColumns: ["Date", "Link", "Message"],
            outputName: "Comments.xlsx",
        }),
        messages: freezeConfig({
            columns: [
                { name: "FROM", width: 24 },
                { name: "TO", width: 24 },
                { name: "DATE", width: 20, cleaner: "cleanDate" },
                { name: "CONTENT", width: 100, wrapText: true, cleaner: "cleanMessagesContent" },
                { name: "FOLDER", width: 16 },
                { name: "CONVERSATION ID", width: 40 },
                { name: "SENDER PROFILE URL", width: 48, cleaner: "cleanEmptyField" },
                { name: "RECIPIENT PROFILE URLS", width: 48, cleaner: "cleanEmptyField" },
            ],
            requiredColumns: ["FROM", "TO", "DATE", "CONTENT"],
            outputName: "Messages.xlsx",
        }),
        connections: freezeConfig({
            columns: [
                { name: "First Name", width: 20 },
                { name: "Last Name", width: 20 },
                { name: "URL", width: 50, cleaner: "cleanEmptyField" },
                { name: "Email Address", width: 32, cleaner: "cleanEmptyField" },
                { name: "Company", width: 30 },
                { name: "Position", width: 30 },
                { name: "Connected On", width: 20, cleaner: "cleanConnectionsDate" },
            ],
            requiredColumns: ["First Name", "Last Name", "Connected On"],
            requiredRowColumns: ["Connected On"],
            dropIfAllMissing: ["First Name", "Last Name", "URL"],
            outputName: "Connections.xlsx",
            skipRows: 3,
        }),
    });

    const CSV_OPTIONS_DEFAULT = Object.freeze({
        delimiter: ",",
        quote: '"',
        escape: null,
    });

    const CSV_OPTIONS_COMMENTS = Object.freeze({
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

    // Auto-detection only needs the header row, which sits at the top of the file
    // (after at most a few skip rows). For large files, parse just this prefix to
    // match a type, then full-parse the matched type once — instead of full-parsing
    // the whole file up to three times (one per distinct option/skip-row combo).
    // Files at or below this size skip the pre-pass and use the original full
    // multi-type detection, so small uploads are unaffected.
    const PREFIX_DETECT_CHARS = 64 * 1024;

    /** OWASP formula injection prefixes (= + - @ TAB CR LF). */
    const FORMULA_PREFIXES = new Set(["=", "+", "-", "@", "\t", "\r", "\n"]);

    const MISSING_STRINGS = new Set([
        "#N/A",
        "#N/A N/A",
        "#NA",
        "-1.#IND",
        "-1.#QNAN",
        "-NAN",
        "1.#IND",
        "1.#QNAN",
        "N/A",
        "NA",
        "NULL",
        "NAN",
        "NONE",
        "<NA>",
    ]);

    const CONNECTION_MONTH_LOOKUP = Object.freeze({
        jan: "01",
        january: "01",
        feb: "02",
        february: "02",
        mar: "03",
        march: "03",
        apr: "04",
        april: "04",
        may: "05",
        jun: "06",
        june: "06",
        jul: "07",
        july: "07",
        aug: "08",
        august: "08",
        sep: "09",
        september: "09",
        oct: "10",
        october: "10",
        nov: "11",
        november: "11",
        dec: "12",
        december: "12",
    });

    /**
     * Deep-freeze a cleaner configuration object.
     * @param {object} config - Configuration with columns, requiredColumns, and outputName
     * @returns {object} Frozen configuration object
     */
    function freezeConfig(config) {
        const frozenColumns = config.columns.map((column) => Object.freeze({ ...column }));
        return Object.freeze({
            ...config,
            columns: Object.freeze(frozenColumns),
        });
    }

    /**
     * Check if a value is missing (null, undefined, empty, or 'NA')
     * Port of: is_missing() from text.py
     * @param {*} value - Value to check
     * @returns {boolean}
     */
    function isMissing(value) {
        /* v8 ignore next 5 */
        if (value === null || value === undefined) {
            return true;
        }
        if (typeof value === "number") {
            return Number.isNaN(value);
        }
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed === "") {
                return true;
            }
            return MISSING_STRINGS.has(trimmed.toUpperCase());
        }
        return false;
    }

    /**
     * Clean ShareCommentary field from LinkedIn Shares export.
     * Port of: clean_shares_commentary() from text.py
     *
     * Handles the double-double quote escaping pattern used in Shares.csv:
     * - Removes leading/trailing quotes
     * - Converts CSV line break patterns ("\n") to actual newlines
     * - Converts escaped quotes ("") to single quotes (")
     *
     * @param {*} value - Raw value from CSV
     * @returns {string} Cleaned string
     */
    function cleanSharesCommentary(value) {
        if (isMissing(value)) {
            return "";
        }

        let text = String(value);

        if (text.startsWith('"')) {
            text = text.slice(1);
        }

        if (text.endsWith('"')) {
            text = text.slice(0, -1);
        }

        text = text.replace(/"\n"/g, "\n");

        text = text.replace(/""/g, '"');

        return text.trim();
    }

    /**
     * Strip backslash- and double-double-quote escaping from a CSV value.
     * Shared helper for the Comments and Messages cleaners.
     *
     * Handles the escaping patterns used in those exports:
     * - Converts backslash-escaped quotes (\") to regular quotes (")
     * - Converts double-double quotes ("") to regular quotes (")
     * - Preserves line breaks
     *
     * @param {*} value - Raw value from CSV
     * @returns {string} Cleaned string
     */
    function cleanEscapedQuotesText(value) {
        if (isMissing(value)) {
            return "";
        }

        let text = String(value);
        text = text.replace(/\\"/g, '"');
        text = text.replace(/""/g, '"');
        return text.trim();
    }

    /**
     * Clean Message field from LinkedIn Comments export.
     * Port of: clean_comments_message() from text.py
     *
     * @param {*} value - Raw value from CSV
     * @returns {string} Cleaned string
     */
    function cleanCommentsMessage(value) {
        return cleanEscapedQuotesText(value);
    }

    /**
     * Clean CONTENT field from LinkedIn Messages export.
     * Handles quote escaping while preserving line breaks.
     *
     * @param {*} value - Raw value from CSV
     * @returns {string} Cleaned string
     */
    function cleanMessagesContent(value) {
        return cleanEscapedQuotesText(value);
    }

    /**
     * Clean empty or quoted-empty fields.
     * Port of: clean_empty_field() from text.py
     *
     * @param {*} value - Raw value from CSV
     * @returns {string} Empty string if the field is empty/missing, otherwise the cleaned value
     */
    function cleanEmptyField(value) {
        if (isMissing(value)) {
            return "";
        }
        const text = String(value).trim();
        return text === '""' || text === '"' || text === "" ? "" : text;
    }

    /**
     * Check whether date/time components are within valid ranges.
     * @param {number} month - Month (1-12)
     * @param {number} day - Day (1-31)
     * @param {number} hour - Hour (0-23)
     * @param {number} minute - Minute (0-59)
     * @param {number} second - Second (0-59)
     * @returns {boolean}
     */
    function isValidDateRange(month, day, hour, minute, second) {
        return (
            month >= 1 &&
            month <= 12 &&
            day >= 1 &&
            day <= 31 &&
            hour >= 0 &&
            hour <= 23 &&
            minute >= 0 &&
            minute <= 59 &&
            second >= 0 &&
            second <= 59
        );
    }

    /**
     * Verify a UTC Date object matches the intended components (guards against rollover).
     * @param {Date} utcDate - Date constructed from UTC components
     * @param {number} year
     * @param {number} month - 1-indexed month
     * @param {number} day
     * @param {number} hour
     * @param {number} minute
     * @param {number} second
     * @returns {boolean}
     */
    function dateMatchesComponents(utcDate, year, month, day, hour, minute, second) {
        return (
            utcDate.getUTCFullYear() === year &&
            utcDate.getUTCMonth() === month - 1 &&
            utcDate.getUTCDate() === day &&
            utcDate.getUTCHours() === hour &&
            utcDate.getUTCMinutes() === minute &&
            utcDate.getUTCSeconds() === second
        );
    }

    /**
     * Convert UTC date from LinkedIn export to local timezone.
     * LinkedIn exports dates in UTC format: "YYYY-MM-DD HH:MM:SS"
     * This converts to local time and returns in the same format.
     *
     * @param {*} value - Raw date value from CSV (UTC)
     * @returns {string} Date string in local timezone (YYYY-MM-DD HH:MM:SS)
     */
    function cleanDate(value) {
        if (isMissing(value)) {
            return "";
        }
        let text = String(value).trim();
        if (text.toUpperCase().endsWith(" UTC")) {
            text = text.slice(0, -4).trim();
        }
        // Parse UTC date: "YYYY-MM-DD HH:MM:SS"
        const [datePart, timePart] = text.split(" ");
        if (!datePart || !timePart) {
            return text; // Return as-is if format is unexpected
        }
        const [year, month, day] = datePart.split("-").map(Number);
        const [hour, minute, second] = timePart.split(":").map(Number);
        if ([year, month, day, hour, minute, second].some(Number.isNaN)) {
            return text; // Return as-is if any component is invalid
        }
        if (!isValidDateRange(month, day, hour, minute, second)) {
            return text; // Return as-is if components out of range
        }

        // Create UTC date and convert to local
        const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
        if (!dateMatchesComponents(utcDate, year, month, day, hour, minute, second)) {
            return text;
        }

        // Format in local time
        const localYear = utcDate.getFullYear();
        const localMonth = String(utcDate.getMonth() + 1).padStart(2, "0");
        const localDay = String(utcDate.getDate()).padStart(2, "0");
        const localHour = String(utcDate.getHours()).padStart(2, "0");
        const localMinute = String(utcDate.getMinutes()).padStart(2, "0");
        const localSecond = String(utcDate.getSeconds()).padStart(2, "0");

        return `${localYear}-${localMonth}-${localDay} ${localHour}:${localMinute}:${localSecond}`;
    }

    /**
     * Convert LinkedIn Connections date to ISO format.
     *
     * @param {*} value - Raw date value (e.g. "30 Jan 2026")
     * @returns {string} Date string in YYYY-MM-DD format
     */
    function cleanConnectionsDate(value) {
        if (isMissing(value)) {
            return "";
        }

        const text = String(value).trim();
        const monthMatch = text.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
        if (!monthMatch) {
            return text;
        }

        const day = monthMatch[1].padStart(2, "0");
        const monthToken = monthMatch[2].toLowerCase();
        const month = CONNECTION_MONTH_LOOKUP[monthToken];
        const year = monthMatch[3];
        if (!month) {
            return text;
        }

        const numericYear = Number(year);
        const numericMonth = Number(month);
        const numericDay = Number(day);
        const parsedDate = new Date(Date.UTC(numericYear, numericMonth - 1, numericDay));
        if (
            !dateMatchesComponents(
                parsedDate,
                numericYear,
                numericMonth,
                numericDay,
                0,
                0,
                0,
            )
        ) {
            return text;
        }
        return `${year}-${month}-${day}`;
    }

    /**
     * Check if all required columns in a row have non-missing values.
     * @param {object} row - Row object
     * @param {string[]} requiredColumns - Columns that must be present
     * @returns {boolean}
     */
    function hasRequiredRowValues(row, requiredColumns) {
        if (!requiredColumns.length) {
            return true;
        }
        return requiredColumns.every((column) => !isMissing(row[column]));
    }

    /**
     * Check if at least one column has a non-missing value.
     * @param {object} row - Row object
     * @param {string[]} columns - Columns to scan
     * @returns {boolean}
     */
    function hasAnyRowValue(row, columns) {
        if (!columns.length) {
            return true;
        }
        return columns.some((column) => !isMissing(row[column]));
    }

    const CLEANERS = Object.freeze({
        cleanSharesCommentary,
        cleanCommentsMessage,
        cleanMessagesContent,
        cleanEmptyField,
        cleanDate,
        cleanConnectionsDate,
    });

    /**
     * Strip BOM and whitespace from a single header string.
     * @param {string} header - Raw header value
     * @returns {string} Normalized header
     */
    function normalizeHeader(header) {
        if (typeof header !== "string") {
            return "";
        }
        return header.replace(/^\uFEFF/, "").trim();
    }

    /**
     * Normalize an array of header strings.
     * @param {string[]} headers - Raw header values
     * @returns {string[]} Normalized headers
     */
    function normalizeHeaders(headers) {
        return headers.map(normalizeHeader);
    }

    /**
     * Check if every cell in a row is missing.
     * @param {Array<*>} row - Array of cell values
     * @returns {boolean} True if all cells are missing
     */
    function isRowEmpty(row) {
        return row.every((cell) => isMissing(cell));
    }

    /**
     * Parse CSV into rows with support for quoted fields, escaped quotes, and newlines.
     * @param {string} csvText
     * @param {{delimiter: string, quote: string, escape: string}} options
     * @returns {{rows: string[][], error: string|null}}
     */
    function parseCsvRows(csvText, options = CSV_OPTIONS_DEFAULT) {
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
        // parseError (set via wouldOverflowField) is what stops the outer loop.
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
            if (code === quoteCode) {
                // Lone closing quote: leave the quoted section.
                if (csvText.charCodeAt(start + 1) !== quoteCode) {
                    state = CSV_PARSE_STATE.OUTSIDE_QUOTES;
                    return start + 1;
                }
                // Doubled quote collapses to a single literal quote.
                /* v8 ignore next */
                if (wouldOverflowField(1)) {
                    return start + 2;
                }
                field += quote;
                return start + 2;
            }
            /* v8 ignore start */
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
            // Escape character: collapse escape+quote, otherwise keep it literally.
            if (csvText.charCodeAt(start + 1) === quoteCode) {
                field += quote;
                return start + 2;
            }
            field += csvText[start];
            return start + 1;
            /* v8 ignore stop */
        };

        // Handle one step while outside quotes; returns the next index.
        const stepOutsideQuotes = (start) => {
            // Bulk-copy ordinary characters up to the next quote, delimiter,
            // or line break.
            let j = start;
            while (j < length) {
                const code = csvText.charCodeAt(j);
                if (
                    code === quoteCode ||
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
            if (code === quoteCode) {
                // Quotes only open a quoted section at the start of a field;
                // mid-field quotes stay literal (matches the Python cleaner's
                // pandas parsing).
                if (field.length === 0) {
                    state = CSV_PARSE_STATE.INSIDE_QUOTES;
                    return start + 1;
                }
                /* v8 ignore next 3 */
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

    /**
     * Build parse cache key from file type options.
     * @param {string} fileType - Target file type
     * @returns {string}
     */
    function getParseCacheKey(fileType) {
        const config = CONFIGS[fileType] || null;
        const skipRows = config && Number.isInteger(config.skipRows) ? config.skipRows : 0;
        const optionsKey = fileType === "comments" ? "comments" : "default";
        return `${optionsKey}:${skipRows}`;
    }

    /**
     * Parse CSV text into array of objects
     * @param {string} csvText - Raw CSV text
     * @param {string} [fileType='auto'] - Target file type for CSV options and skip rows
     * @param {Map<string, object>|null} [parseCache=null] - Optional parse cache map
     * @returns {{headers: string[], data: object[], error: string|null}}
     */
    function parseCSV(csvText, fileType = "auto", parseCache = null) {
        const cacheKey = parseCache ? getParseCacheKey(fileType) : null;
        if (cacheKey && parseCache.has(cacheKey)) {
            return parseCache.get(cacheKey);
        }

        if (typeof csvText !== "string" || !csvText.trim()) {
            const emptyResult = { headers: [], data: [], error: EMPTY_CSV_ERROR };
            if (cacheKey) {
                parseCache.set(cacheKey, emptyResult);
            }
            return emptyResult;
        }

        const csvOptions = fileType === "comments" ? CSV_OPTIONS_COMMENTS : CSV_OPTIONS_DEFAULT;
        let { rows, error } = parseCsvRows(csvText, csvOptions);
        if (error && error.includes("unmatched quote")) {
            ({ rows, error } = parseCsvRows(`${csvText}"`, csvOptions));
        }
        if (error) {
            const errorResult = { headers: [], data: [], error };
            if (cacheKey) {
                parseCache.set(cacheKey, errorResult);
            }
            return errorResult;
        }

        if (!rows.length) {
            const emptyRowsResult = { headers: [], data: [], error: EMPTY_CSV_ERROR };
            if (cacheKey) {
                parseCache.set(cacheKey, emptyRowsResult);
            }
            return emptyRowsResult;
        }

        const config = CONFIGS[fileType] || null;
        const skipRows = config && Number.isInteger(config.skipRows) ? config.skipRows : 0;
        const rowsAfterSkip = skipRows > 0 ? rows.slice(skipRows) : rows;
        if (!rowsAfterSkip.length) {
            const skipResult = {
                headers: [],
                data: [],
                error: "CSV file has no header rows after skip.",
            };
            if (cacheKey) {
                parseCache.set(cacheKey, skipResult);
            }
            return skipResult;
        }

        const headers = normalizeHeaders(rowsAfterSkip[0]);
        if (!headers.length || headers.every((header) => header === "")) {
            const headerResult = { headers: [], data: [], error: "Could not parse CSV headers" };
            if (cacheKey) {
                parseCache.set(cacheKey, headerResult);
            }
            return headerResult;
        }

        const headerCount = headers.length;
        const data = [];
        for (let r = 1; r < rowsAfterSkip.length; r += 1) {
            const row = rowsAfterSkip[r];
            if (isRowEmpty(row)) {
                continue;
            }
            // Null-prototype object: CSV headers are user-controlled, so keys
            // like "__proto__" must not mutate the prototype chain.
            const record = Object.create(null);
            for (let c = 0; c < headerCount; c += 1) {
                const value = row[c];
                record[headers[c]] = value !== undefined ? value : "";
            }
            data.push(record);
        }

        const result = { headers, data, error: null };
        if (cacheKey) {
            parseCache.set(cacheKey, result);
        }
        return result;
    }

    /**
     * Auto-detect file type based on column headers
     * @param {string[]} headers - Array of column headers
     * @returns {string|null} File type or null if unknown
     */
    function detectFileType(headers) {
        const normalizedHeaders = normalizeHeaders(headers);
        const headerSet = new Set(normalizedHeaders);
        const detectedType = FILE_TYPES.find((type) => {
            const requiredColumns = CONFIGS[type].requiredColumns;
            return requiredColumns.every((column) => headerSet.has(column));
        });
        return detectedType || null;
    }

    /**
     * Find all supported file types that can parse and validate the given CSV text.
     * @param {string} csvText - Raw CSV text
     * @param {Map<string, object>|null} [parseCache=null] - Optional parse cache map
     * @returns {Array<{type: string, headers: string[], data: object[]}>}
     */
    function detectMatchingFileTypes(csvText, parseCache = null) {
        const matches = [];
        for (const type of FILE_TYPES) {
            const parsed = parseCSV(csvText, type, parseCache);
            if (parsed.error) {
                continue;
            }
            const validation = validateColumns(parsed.headers, type);
            if (!validation.valid) {
                continue;
            }
            matches.push({
                type,
                headers: parsed.headers,
                data: parsed.data,
            });
        }
        return matches;
    }

    /**
     * Cheaply detect a file's type from its header row by parsing only a prefix
     * of the text. Returns the first supported type (in FILE_TYPES order) whose
     * required columns are present, or null when no prefix match is found.
     *
     * A truncated tail can only corrupt the prefix's last row, never the header
     * at the top, so a positive match is reliable; a null result falls back to
     * full multi-type detection in the caller, which keeps behaviour identical.
     * Uses a throwaway parse cache so truncated parses never poison the caller's
     * full-parse cache.
     * @param {string} csvText - Raw CSV text
     * @returns {string|null} Detected file type, or null if unknown from the prefix
     */
    function detectTypeFromPrefix(csvText) {
        const prefix = csvText.slice(0, PREFIX_DETECT_CHARS);
        const prefixCache = new Map();
        for (const type of FILE_TYPES) {
            const parsed = parseCSV(prefix, type, prefixCache);
            if (parsed.error) {
                continue;
            }
            if (validateColumns(parsed.headers, type).valid) {
                return type;
            }
        }
        return null;
    }

    /**
     * Validate that required columns exist in the data
     * @param {string[]} headers - Array of column headers
     * @param {string} fileType - Supported file type
     * @returns {{valid: boolean, missing: string[]}}
     */
    function validateColumns(headers, fileType) {
        const config = CONFIGS[fileType];
        if (!config) {
            return { valid: false, missing: ["Unknown file type"] };
        }

        const normalizedHeaders = normalizeHeaders(headers);
        const headerSet = new Set(normalizedHeaders);
        const missing = config.requiredColumns.filter((column) => !headerSet.has(column));

        return {
            valid: missing.length === 0,
            missing,
        };
    }

    /**
     * Clean the parsed data based on file type
     * @param {object[]} data - Parsed CSV data as array of objects
     * @param {string} fileType - Supported file type
     * @returns {object[]} Cleaned data
     */
    function cleanData(data, fileType) {
        const config = CONFIGS[fileType];
        if (!config) {
            return data;
        }

        const requiredRowColumns = Array.isArray(config.requiredRowColumns)
            ? config.requiredRowColumns
            : config.requiredColumns;
        const dropIfAllMissing = Array.isArray(config.dropIfAllMissing)
            ? config.dropIfAllMissing
            : [];

        // Clean and filter in a single pass to avoid intermediate arrays.
        const cleanedRows = [];
        for (const row of data) {
            const cleanedRow = {};
            config.columns.forEach((column) => {
                const value = row[column.name];
                const cleaner = column.cleaner ? CLEANERS[column.cleaner] : null;
                const cleanedValue = cleaner ? cleaner(value) : cleanValue(value);
                cleanedRow[column.name] = escapeFormula(cleanedValue);
            });

            if (!hasRequiredRowValues(cleanedRow, requiredRowColumns)) {
                continue;
            }
            if (dropIfAllMissing.length && !hasAnyRowValue(cleanedRow, dropIfAllMissing)) {
                continue;
            }
            cleanedRows.push(cleanedRow);
        }

        return cleanedRows;
    }

    /**
     * Clean a generic cell value.
     * @param {*} value - Raw cell value
     * @returns {string} Trimmed cell value
     */
    function cleanValue(value) {
        if (isMissing(value)) {
            return "";
        }
        return String(value).trim();
    }

    /**
     * Escape OWASP formula injection prefixes after any column-specific cleaning.
     * @param {string} value - Cleaned cell value
     * @returns {string} Formula-safe cell value
     */
    function escapeFormula(value) {
        return value.length > 0 && FORMULA_PREFIXES.has(value[0]) ? `'${value}` : value;
    }

    /**
     * Build a user-friendly error message for column validation failures.
     * @param {string} selectedType - The file type selected by the user ('shares', 'comments', 'messages', 'connections', or 'auto')
     * @param {string|null} detectedType - The auto-detected file type, or null
     * @param {string[]} missing - List of missing required column names
     * @returns {string} Descriptive error message
     */
    function buildColumnErrorMessage(selectedType, detectedType, missing) {
        if (selectedType !== "auto" && detectedType && detectedType !== selectedType) {
            const selectedLabel = FILE_TYPE_LABELS[selectedType] || selectedType;
            const detectedLabel = FILE_TYPE_LABELS[detectedType] || detectedType;
            return `This looks like a ${detectedLabel} file, but you selected ${selectedLabel}. Please switch to "${detectedLabel}" or "Auto-detect".`;
        }

        if (selectedType !== "auto" && !detectedType) {
            const selectedLabel = FILE_TYPE_LABELS[selectedType] || selectedType;
            return `This file doesn't appear to be a LinkedIn ${selectedLabel} export. Missing columns: ${missing.join(", ")}. Please check that you uploaded the correct file.`;
        }

        /* v8 ignore next */
        return `Missing required columns: ${missing.join(", ")}`;
    }

    /**
     * Build a standardised process() result object.
     * @param {boolean} success - Whether processing succeeded
     * @param {string|null} error - Error message, or null on success
     * @param {object} [overrides] - Fields that differ from the empty defaults
     * @returns {object}
     */
    function makeResult(success, error, overrides = {}) {
        return {
            success,
            fileType: null,
            detectedType: null,
            headers: [],
            cleanedData: [],
            rowCount: 0,
            error,
            ...overrides,
        };
    }

    /**
     * Process a CSV file completely
     * @param {string} csvText - Raw CSV text
     * @param {string} fileType - Supported file type or 'auto'
     * @returns {object}
     */
    function process(csvText, fileType = "auto") {
        const parseCache = new Map();

        if (fileType === "auto") {
            // Fast path for large files: detect the type from a small prefix, then
            // full-parse only the matched type once. Falls through to full
            // multi-type detection on a prefix miss or if the matched type fails
            // to parse/validate on the whole file, so the result is unchanged.
            if (typeof csvText === "string" && csvText.length > PREFIX_DETECT_CHARS) {
                const prefixType = detectTypeFromPrefix(csvText);
                if (prefixType) {
                    const parsed = parseCSV(csvText, prefixType, parseCache);
                    if (!parsed.error && validateColumns(parsed.headers, prefixType).valid) {
                        const cleanedData = cleanData(parsed.data, prefixType);
                        return makeResult(true, null, {
                            fileType: prefixType,
                            detectedType: prefixType,
                            headers: parsed.headers,
                            cleanedData,
                            rowCount: cleanedData.length,
                        });
                    }
                }
            }

            const matches = detectMatchingFileTypes(csvText, parseCache);
            if (matches.length) {
                const selected = matches[0];
                const cleanedData = cleanData(selected.data, selected.type);
                return makeResult(true, null, {
                    fileType: selected.type,
                    detectedType: selected.type,
                    headers: selected.headers,
                    cleanedData,
                    rowCount: cleanedData.length,
                });
            }

            const initialParse = parseCSV(csvText, "auto", parseCache);
            if (initialParse.error) {
                return makeResult(false, initialParse.error);
            }
            return makeResult(
                false,
                "Could not auto-detect file type. This file does not appear to be a LinkedIn Shares, Comments, Messages, or Connections export. Please check that you uploaded the correct file.",
                {
                    headers: initialParse.headers,
                    rowCount: initialParse.data.length,
                },
            );
        }

        const parsed = parseCSV(csvText, fileType, parseCache);
        if (parsed.error) {
            return makeResult(false, parsed.error);
        }

        const { headers, data } = parsed;
        let detectedType = detectFileType(headers);
        const validation = validateColumns(headers, fileType);
        if (!validation.valid) {
            detectedType =
                detectedType ||
                detectMatchingFileTypes(csvText, parseCache).find(
                    (match) => match.type !== fileType,
                )?.type ||
                null;
            return makeResult(
                false,
                buildColumnErrorMessage(fileType, detectedType, validation.missing),
                {
                    fileType,
                    detectedType,
                    headers,
                    rowCount: data.length,
                },
            );
        }

        const cleanedData = cleanData(data, fileType);

        return makeResult(true, null, {
            fileType,
            detectedType,
            headers,
            cleanedData,
            rowCount: cleanedData.length,
        });
    }

    return {
        configs: CONFIGS,
        process,
        parseCSV,
        detectFileType,
        validateColumns,
    };
})();
