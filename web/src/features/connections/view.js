/**
 * Pure connections analytics shared by the worker, the screen, and the PDF export.
 *
 * Every function here derives its result from its arguments and the clock alone,
 * so the three callers compute one set of numbers instead of each keeping its
 * own copy. The clock is not incidental: a range filter and the network's age
 * are both measured from now, not from the newest connection in the file.
 */

import { MONTH_LABELS } from "../analytics/constants.js";
import { parseLocalDate } from "../analytics/dates.js";

/**
 * @typedef {object} ConnectionRow
 * @property {number} connectedOn
 * @property {string} company
 * @property {string} position
 */

/**
 * @typedef {object} ViewStats
 * @property {number} total
 * @property {number} recent
 * @property {string} topCompany
 * @property {string} networkAge
 */

/**
 * @typedef {object} ConnectionsView
 * @property {Array<object>} timeline
 * @property {Array<{topic: string, count: number}>} companies
 * @property {Array<{topic: string, count: number}>} positions
 * @property {ViewStats} stats
 */

/* -- Constants --------------------------------------------------------------- */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const RANGE_DAYS = Object.freeze({
    "1m": 30,
    "3m": 91,
    "6m": 182,
    "12m": 365,
});

const TOP_N = 10;

/* -- Date helpers ------------------------------------------------------------ */

/**
 * Parse a cleaned "Connected On" value into a Date.
 * The cleaner's cleanConnectionsDate turns "01 Jan 2024" into "2024-01-01",
 * which the shared strict parser turns into a local-midnight Date without the
 * timezone-shifting pitfalls of Date.parse.
 *
 * @param {string} dateStr - ISO-style date string (YYYY-MM-DD)
 * @returns {Date|null} Local-midnight Date, or null if unparseable
 */
export function parseConnectionDate(dateStr) {
    return parseLocalDate(dateStr);
}

/**
 * Parse a cleaned "Connected On" date string into a timestamp.
 * @param {string} dateStr - ISO-style date string (YYYY-MM-DD)
 * @returns {number} Epoch milliseconds, or 0 if unparseable
 */
export function parseConnectedOnTimestamp(dateStr) {
    const parsed = parseLocalDate(dateStr);
    return parsed ? parsed.getTime() : 0;
}

/**
 * Build a YYYY-MM key from a Date, used as the bucket identifier in the
 * growth timeline so months are naturally sortable.
 *
 * @param {Date} date - Date to convert
 * @returns {string} e.g. "2024-01"
 */
export function toMonthKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
}

/**
 * Build a human-readable label from a YYYY-MM key, since chart axes
 * should show "Jan 2024" rather than "2024-01".
 *
 * @param {string} key - e.g. "2024-01"
 * @returns {string} e.g. "Jan 2024"
 */
export function monthKeyToLabel(key) {
    const [yearStr, monthStr] = key.split("-");
    const monthIndex = Number(monthStr) - 1;
    return `${MONTH_LABELS[monthIndex]} ${yearStr}`;
}

/* -- Growth timeline --------------------------------------------------------- */

/**
 * Bucket connections by month and fill gaps so the timeline has no missing
 * months. Gaps look misleading on line/bar charts, so we insert zero-value
 * entries for any month between the earliest and latest connection dates.
 *
 * @param {object[]} rows - Cleaned connection rows
 * @returns {Array<{key: string, label: string, value: number}>} Sorted chronologically
 */
export function buildGrowthTimeline(rows) {
    const buckets = new Map();

    for (const row of rows) {
        const date = parseConnectionDate(row["Connected On"]);
        if (!date) {
            continue;
        }
        const key = toMonthKey(date);
        buckets.set(key, (buckets.get(key) || 0) + 1);
    }

    if (buckets.size === 0) {
        return [];
    }

    /* Fill gaps between earliest and latest month */
    const sortedKeys = Array.from(buckets.keys()).sort();
    const firstKey = sortedKeys[0];
    const lastKey = sortedKeys[sortedKeys.length - 1];

    const [startYear, startMonth] = firstKey.split("-").map(Number);
    const [endYear, endMonth] = lastKey.split("-").map(Number);
    const monthSpan = (endYear - startYear) * 12 + (endMonth - startMonth);

    return Array.from({ length: monthSpan + 1 }, (_, offset) => {
        const absoluteMonth = startMonth - 1 + offset;
        const year = startYear + Math.floor(absoluteMonth / 12);
        const month = (absoluteMonth % 12) + 1;
        const key = `${year}-${String(month).padStart(2, "0")}`;
        return {
            key,
            label: monthKeyToLabel(key),
            value: buckets.get(key) || 0,
        };
    });
}

/* -- Summary stats ----------------------------------------------------------- */

/**
 * Compute the stats that do not depend on the selected time range: the size of
 * the network and its age in whole months. Everything the range does move
 * (recent adds, top company) is computed from the filtered rows by
 * buildConnectionsView below, which takes this result as its starting point.
 *
 * @param {object[]} rows - Cleaned connection rows
 * @returns {{total: number, networkAgeMonths: number}}
 */
export function computeStats(rows) {
    const total = rows.length;
    const now = Date.now();

    const earliestMs = rows.reduce((earliest, row) => {
        const date = parseConnectionDate(row["Connected On"]);
        if (!date) {
            return earliest;
        }
        return Math.min(earliest, date.getTime());
    }, Infinity);

    /* Network age in whole months from earliest connection to now */
    const networkAgeMonths =
        earliestMs === Infinity
            ? 0
            : Math.max(0, Math.round((now - earliestMs) / (MS_PER_DAY * 30.44)));

    return Object.freeze({ total, networkAgeMonths });
}

/* -- Row normalization ------------------------------------------------------- */

/**
 * Normalize title-case cleaned rows into the shape the filtering and
 * aggregation below expect. The screen gets those rows back from the worker and
 * the export cleans them itself, so both arrive here in the cleaner's casing.
 *
 * @param {object[]} rows - Cleaned connection rows with title-case keys
 * @returns {ConnectionRow[]} Normalized rows
 */
export function normalizeConnectionRows(rows) {
    return rows.map((row) => ({
        connectedOn: parseConnectedOnTimestamp(row["Connected On"]),
        company: (row.Company || "").trim(),
        position: (row.Position || "").trim(),
    }));
}

/* -- Filtering and aggregation ----------------------------------------------- */

/**
 * Filter connection rows by the selected time range.
 * @param {Array<object>} rows - All parsed connection rows
 * @param {string} range - Time range key ('1m', '3m', '6m', '12m', 'all')
 * @returns {Array<object>} Filtered rows within the range
 */
export function filterRowsByRange(rows, range) {
    if (range === "all") {
        return rows;
    }

    const days = RANGE_DAYS[range];
    if (!days) {
        return rows;
    }

    const cutoff = Date.now() - days * MS_PER_DAY;
    return rows.filter((row) => row.connectedOn >= cutoff);
}

/**
 * Aggregate a string field into {topic, count} pairs, sorted descending.
 * @param {Array<object>} rows - Connection rows to aggregate
 * @param {string} field - Field name to aggregate ('company' or 'position')
 * @returns {Array<{topic: string, count: number}>} Top N aggregated entries
 */
export function aggregateField(rows, field) {
    const counts = Object.create(null);
    for (const row of rows) {
        const value = row[field];
        if (!value) {
            continue;
        }
        counts[value] = (counts[value] || 0) + 1;
    }

    return Object.entries(counts)
        .map(([topic, count]) => ({ topic, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, TOP_N);
}

/**
 * Find the most frequent value for a given field.
 * @param {Array<object>} rows - Connection rows
 * @param {string} field - Field name
 * @returns {string} Most frequent value or '-'
 */
export function findTopValue(rows, field) {
    if (!rows.length) {
        return "-";
    }

    const counts = Object.create(null);
    let maxKey = "";
    let maxCount = 0;
    for (const row of rows) {
        const value = row[field];
        if (!value) {
            continue;
        }
        const next = (counts[value] || 0) + 1;
        counts[value] = next;
        if (next > maxCount) {
            maxCount = next;
            maxKey = value;
        }
    }

    return maxKey || "-";
}

/**
 * Format a network age in months as a human-readable string.
 * @param {number} months - Network age in whole months from computeStats()
 * @returns {string} Human-readable network age (e.g. '3.2 yr')
 */
export function formatNetworkAge(months) {
    if (!months) {
        return "-";
    }
    if (months < 12) {
        return `${months} mo`;
    }
    return `${(months / 12).toFixed(1)} yr`;
}

/* -- View assembly ----------------------------------------------------------- */

/**
 * Apply the time-range filter and compute the view the screen renders and the
 * export draws. The growth timeline stays all-time for context, while companies,
 * positions, and recent adds follow the selected range.
 *
 * @param {ConnectionRow[]} rows - Normalized connection rows
 * @param {Array<object>} timeline - All-time growth timeline
 * @param {{total?: number, networkAgeMonths?: number}|null} workerStats - Range-independent stats from computeStats()
 * @param {string} timeRange - Time range key ('1m', '3m', '6m', '12m', 'all')
 * @returns {ConnectionsView}
 */
export function buildConnectionsView(rows, timeline, workerStats, timeRange) {
    const filtered = filterRowsByRange(rows, timeRange);
    const companies = aggregateField(filtered, "company");
    const positions = aggregateField(filtered, "position");
    const stats = {
        total: (workerStats && workerStats.total) || rows.length,
        recent: filtered.length,
        topCompany: findTopValue(filtered, "company"),
        networkAge: formatNetworkAge((workerStats && workerStats.networkAgeMonths) || 0),
    };

    return {
        timeline,
        companies,
        positions,
        stats,
    };
}
