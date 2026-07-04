/* LinkedIn Analyzer - Analytics date parsing and calendar math */

import { MONTH_LABELS } from "./analytics-constants.js";

/**
 * Parse a LinkedIn date string into date components.
 * @param {string} value - Date string in "YYYY-MM-DD HH:MM:SS" format.
 * @returns {{ timestamp: number, dayIndex: number, hour: number, dateKey: string, monthKey: string } | null} Parsed date components, or null if invalid.
 */
export function parseLinkedInDate(value) {
    if (!value || typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    const [datePart, timePart] = trimmed.split(" ");
    if (!datePart || !timePart) {
        return null;
    }
    const [year, month, day] = datePart.split("-").map(Number);
    const [hour, minute] = timePart.split(":").map(Number);
    if (!year || !month || !day) {
        return null;
    }

    // Timestamps are already converted to local time by the cleaner.
    const localDate = new Date(year, month - 1, day, hour || 0, minute || 0, 0);

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
