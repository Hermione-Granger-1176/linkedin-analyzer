/**
 * Field-level cleaning primitives for LinkedIn CSV exports.
 * Port of: src/linkedin_analyzer/core/text.py
 *
 * These functions normalize individual cell values (quote/date/value
 * normalization, missing-value detection, and OWASP formula escaping). They are
 * composed by the LinkedInCleaner facade in cleaner.js.
 */

/** OWASP formula injection prefixes (= + - @ TAB CR LF). */
const FORMULA_PREFIXES = new Set(["=", "+", "-", "@", "\t", "\r", "\n"]);

// Control characters XML 1.0 forbids in a worksheet cell. Spreadsheet writers
// reject them, so they are stripped from every exported cell. Tab (0x09),
// newline (0x0A), and carriage return (0x0D) are legal and excluded.
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

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

// Length of the longest sentinel in MISSING_STRINGS. Derived from the set so the
// fast-path stays correct if a longer sentinel is ever added. Used as a cheap
// upper bound so isMissing can skip the uppercase + Set lookup for longer values.
const MISSING_MAX_LENGTH = Math.max(...Array.from(MISSING_STRINGS, (s) => s.length));

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
 * Check if a value is missing (null, undefined, empty, or 'NA')
 * Port of: is_missing() from text.py
 * @param {*} value - Value to check
 * @returns {boolean}
 */
export function isMissing(value) {
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
        // No MISSING_STRINGS sentinel is longer than MISSING_MAX_LENGTH, so a
        // longer trimmed value cannot be one. Skipping the uppercase + Set lookup
        // here avoids a per-cell allocation on the common case (real content cells).
        if (trimmed.length > MISSING_MAX_LENGTH) {
            return false;
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

    const text = String(value);
    // Both passes only rewrite quote/backslash sequences, so text with neither
    // character is returned unchanged. This skips two regex scans over the long
    // message/comment bodies that make up the common case.
    if (!text.includes('"') && !text.includes("\\")) {
        return text.trim();
    }
    return text.replace(/\\"/g, '"').replace(/""/g, '"').trim();
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
 * Clean a generic cell value.
 * @param {*} value - Raw cell value
 * @returns {string} Trimmed cell value
 */
export function cleanValue(value) {
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
export function escapeFormula(value) {
    return value.length > 0 && FORMULA_PREFIXES.has(value[0]) ? `'${value}` : value;
}

/**
 * Strip control characters that are illegal in XML/xlsx worksheet cells.
 * Mirror of remove_illegal_chars() from text.py so the web export never emits a
 * cell a spreadsheet writer would reject. Tab, newline, and carriage return are
 * legal and left intact.
 * @param {string} value - Cleaned cell value
 * @returns {string} Value with illegal control characters removed
 */
export function removeIllegalChars(value) {
    return value.replace(ILLEGAL_XML_CHARS, "");
}

/** Named cell cleaners referenced by column configs via their string id. */
export const CLEANERS = Object.freeze({
    cleanSharesCommentary,
    cleanCommentsMessage,
    cleanMessagesContent,
    cleanEmptyField,
    cleanDate,
    cleanConnectionsDate,
});
