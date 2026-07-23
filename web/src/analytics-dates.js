/* LinkedIn Analyzer - Analytics date parsing and calendar math */

import { MONTH_LABELS } from "./analytics-constants.js";

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME_PATTERN =
    /^(\d{4})-(\d{2})-(\d{2})[ \t]+(\d{2}):(\d{2})(?::(\d{2}))?$/;
const LINKEDIN_DATE_TIME_PATTERN =
    /^(\d{4})-(\d{2})-(\d{2})[ \t]+(\d{2})(?::(\d{2}))?(?::(\d{2}))?$/;

/**
 * Construct a local Date only when every component describes the same instant.
 * @param {number} year - Four-digit year
 * @param {number} month - One-based month
 * @param {number} day - One-based day of month
 * @param {number} hour - Hour from 0 through 23
 * @param {number} minute - Minute from 0 through 59
 * @param {number} second - Second from 0 through 59
 * @returns {Date|null} Strictly validated local Date, or null
 */
function createStrictLocalDate(year, month, day, hour = 0, minute = 0, second = 0) {
    if (
        year < 1 ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31 ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59 ||
        second < 0 ||
        second > 59
    ) {
        return null;
    }

    const parsed = new Date(year, month - 1, day, hour, minute, second, 0);
    if (year < 100) {
        parsed.setFullYear(year);
    }

    if (
        Number.isNaN(parsed.getTime()) ||
        parsed.getFullYear() !== year ||
        parsed.getMonth() !== month - 1 ||
        parsed.getDate() !== day ||
        parsed.getHours() !== hour ||
        parsed.getMinutes() !== minute ||
        parsed.getSeconds() !== second
    ) {
        return null;
    }

    return parsed;
}

/**
 * Parse a strict local date in YYYY-MM-DD format.
 * @param {string} value - Local date string
 * @returns {Date|null} Local-midnight Date, or null if invalid
 */
export function parseLocalDate(value) {
    if (typeof value !== "string") {
        return null;
    }

    const match = value.trim().match(LOCAL_DATE_PATTERN);
    if (!match) {
        return null;
    }

    return createStrictLocalDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/**
 * Parse a strict local date-time in YYYY-MM-DD HH:MM[:SS] format.
 * @param {string} value - Local date-time string
 * @returns {Date|null} Local Date, or null if invalid
 */
export function parseLocalDateTime(value) {
    if (typeof value !== "string") {
        return null;
    }

    const match = value.trim().match(LOCAL_DATE_TIME_PATTERN);
    if (!match) {
        return null;
    }

    return createStrictLocalDate(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6] || 0),
    );
}

/**
 * Parse a LinkedIn date string into date components.
 * @param {string} value - Date string in "YYYY-MM-DD HH[:MM[:SS]]" format (hour required, minutes and seconds optional).
 * @returns {{ timestamp: number, dayIndex: number, hour: number, dateKey: string, monthKey: string } | null} Parsed date components, or null if invalid.
 */
export function parseLinkedInDate(value) {
    if (!value || typeof value !== "string") {
        return null;
    }

    const match = value.trim().match(LINKEDIN_DATE_TIME_PATTERN);
    if (!match) {
        return null;
    }

    const localDate = createStrictLocalDate(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        Number(match[4]),
        Number(match[5] || 0),
        Number(match[6] || 0),
    );
    if (!localDate) {
        return null;
    }

    const localHour = localDate.getHours();
    const localDay = localDate.getDay(); // 0 = Sunday
    const localDayIndex = (localDay + 6) % 7; // Convert to 0 = Monday

    const localYear = localDate.getFullYear();
    const localMonth = localDate.getMonth() + 1;
    const localDayOfMonth = localDate.getDate();

    return {
        timestamp: localDate.getTime(),
        dayIndex: localDayIndex,
        hour: localHour,
        dateKey: `${localYear}-${String(localMonth).padStart(2, "0")}-${String(localDayOfMonth).padStart(2, "0")}`,
        monthKey: `${localYear}-${String(localMonth).padStart(2, "0")}`,
    };
}

/**
 * Enumerate inclusive "YYYY-MM" month keys between two keys.
 * @param {string} startKey - First month key, "YYYY-MM"
 * @param {string} endKey - Last month key, "YYYY-MM"
 * @returns {string[]} Contiguous month keys, oldest first
 */
export function enumerateMonths(startKey, endKey) {
    const [startYear, startMonth] = startKey.split("-").map(Number);
    const [endYear, endMonth] = endKey.split("-").map(Number);
    const keys = [];
    let year = startYear;
    let month = startMonth;
    while (year < endYear || (year === endYear && month <= endMonth)) {
        keys.push(`${year}-${String(month).padStart(2, "0")}`);
        month += 1;
        if (month > 12) {
            month = 1;
            year += 1;
        }
    }
    return keys;
}

/**
 * Return a new Date offset by the given number of months, set to the 1st.
 * @param {Date} date - Starting date.
 * @param {number} months - Number of months to add (can be negative).
 * @returns {Date} New date offset by months.
 */
export function addMonths(date, months) {
    return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

/**
 * Return a new Date offset by the given number of days.
 * @param {Date} date - Starting date.
 * @param {number} days - Number of days to add (can be negative).
 * @returns {Date} New date offset by days.
 */
export function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * Get the first day of the month for the given date.
 * @param {Date} date - Input date.
 * @returns {Date} New date set to the 1st of the same month.
 */
export function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Get the last day of the month for the given date.
 * @param {Date} date - Input date.
 * @returns {Date} New date set to the last day of the same month.
 */
export function endOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

/**
 * Parse a "YYYY-MM-DD" date key string into a Date object.
 * @param {string} key - Date key in "YYYY-MM-DD" format.
 * @returns {Date} Parsed date.
 */
export function parseDateKey(key) {
    const [year, month, day] = key.split("-").map(Number);
    return new Date(year, month - 1, day);
}

/**
 * Format a Date object as a "YYYY-MM-DD" string.
 * @param {Date} date - Date to format.
 * @returns {string} Formatted date key.
 */
export function formatDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

/**
 * Get the Monday of the week containing the given date.
 * @param {Date} date - Input date.
 * @returns {Date} Monday of that week.
 */
export function startOfWeek(date) {
    const day = date.getDay();
    const diff = (day + 6) % 7;
    return addDays(date, -diff);
}

/**
 * Format a date as a "Mon DD" label string.
 * @param {Date} date - Date to format.
 * @returns {string} Formatted label, e.g. "Jan 05".
 */
export function formatWeekLabel(date) {
    return `${MONTH_LABELS[date.getMonth()]} ${String(date.getDate()).padStart(2, "0")}`;
}
