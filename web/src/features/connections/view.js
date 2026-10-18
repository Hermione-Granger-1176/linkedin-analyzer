/**
 * Pure connections analytics shared by the worker, the screen, and the PDF export.
 *
 * Every function here derives its result from its arguments and the clock alone,
 * so the three callers compute one set of numbers instead of each keeping its
 * own copy. The clock is not incidental: a range filter and the network's age
 * are both measured from now, not from the newest connection in the file.
 */

import {
    enumerateMonths,
    monthKeyToLabel,
    parseLocalDate,
    toMonthKey,
} from "../analytics/dates.js";

/** @typedef {import("../../shared/ui/charts.js").TimelinePoint} TimelinePoint */
/** @typedef {import("../../shared/ui/charts.js").TopicPoint} TopicPoint */

/**
 * A cleaned Connections.csv row in the cleaner's title-case columns
 * ("Connected On", "Company", "Position", ...).
 * @typedef {import("../cleaning/cleaner.js").CleanedRow} CleanedConnectionRow
 */

/**
 * A connection row normalized for filtering and aggregation.
 * @typedef {object} ConnectionRow
 * @property {number} connectedOn - Connection date (epoch ms), or 0 when unparseable
 * @property {string} company - Trimmed company name, possibly empty
 * @property {string} position - Trimmed position title, possibly empty
 */

/** @typedef {TimelinePoint} GrowthPoint - One month of new connections */

/**
 * Range-independent stats computeStats() produces.
 * @typedef {object} ConnectionStats
 * @property {number} total - Connection count
 * @property {number} networkAgeMonths - Whole months from the earliest connection to now
 */

/**
 * The analytics the connections worker posts.
 * @typedef {object} ConnectionsAnalytics
 * @property {GrowthPoint[]} growthTimeline - All-time monthly growth, gaps filled
 * @property {ConnectionStats} stats - Range-independent stats
 */

/**
 * The stats bar of a connections view.
 * @typedef {object} ViewStats
 * @property {number} total - Connection count
 * @property {number} recent - Connections in the selected range
 * @property {string} topCompany - Most frequent company in the range, or "-"
 * @property {string} networkAge - Formatted network age, or "-"
 */

/**
 * The view the screen renders and the export draws.
 * @typedef {object} ConnectionsView
 * @property {GrowthPoint[]} timeline - All-time growth timeline
 * @property {TopicPoint[]} companies - Top companies in the range
 * @property {TopicPoint[]} positions - Top positions in the range
 * @property {ViewStats} stats - Stats bar values
 */

/* -- Constants --------------------------------------------------------------- */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** @type {Readonly<Record<string, number>>} */
const RANGE_DAYS = Object.freeze({
    "1m": 30,
    "3m": 91,
    "6m": 182,
    "12m": 365,
});

/**
 * Supported range keys, including the unbounded range.
 * The screen builds its controls from this list so every offered range
 * has a matching filter definition.
 * @type {readonly string[]}
 */
export const RANGE_KEYS = Object.freeze([...Object.keys(RANGE_DAYS), "all"]);

const TOP_N = 10;

// Cache parsed timestamps for repeated date values. Clear the cache at the
// cap to bound memory use for files with many distinct dates.
const DATE_CACHE_LIMIT = 100000;
/** @type {Map<string, number|null>} */
const connectedOnTimes = new Map();

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
    const time = connectedOnTime(dateStr);
    return time === null ? null : new Date(time);
}

/**
 * Local-midnight epoch milliseconds of a cleaned "Connected On" value, parsed
 * once per distinct value.
 * @param {unknown} value - ISO-style date string (YYYY-MM-DD)
 * @returns {number|null} Epoch milliseconds, or null if unparseable
 */
function connectedOnTime(value) {
    if (typeof value !== "string") {
        return null;
    }
    let time = connectedOnTimes.get(value);
    if (time === undefined) {
        const parsed = parseLocalDate(value);
        time = parsed ? parsed.getTime() : null;
        /* v8 ignore next 3 */
        if (connectedOnTimes.size >= DATE_CACHE_LIMIT) {
            connectedOnTimes.clear();
        }
        connectedOnTimes.set(value, time);
    }
    return time;
}

/**
 * Parse a cleaned "Connected On" date string into a timestamp.
 * @param {string} dateStr - ISO-style date string (YYYY-MM-DD)
 * @returns {number} Epoch milliseconds, or 0 if unparseable
 */
export function parseConnectedOnTimestamp(dateStr) {
    return connectedOnTime(dateStr) ?? 0;
}

/* -- Growth timeline --------------------------------------------------------- */

/**
 * Bucket connections by month and fill gaps so the timeline has no missing
 * months. Gaps look misleading on line/bar charts, so we insert zero-value
 * entries for any month between the earliest and latest connection dates.
 *
 * @param {CleanedConnectionRow[]} rows - Cleaned connection rows
 * @returns {GrowthPoint[]} Sorted chronologically
 */
export function buildGrowthTimeline(rows) {
    /** @type {Map<string, number>} */
    const buckets = new Map();

    for (const row of rows) {
        const time = connectedOnTime(row["Connected On"]);
        if (time === null) {
            continue;
        }
        const key = toMonthKey(new Date(time));
        buckets.set(key, (buckets.get(key) || 0) + 1);
    }

    if (buckets.size === 0) {
        return [];
    }

    /* Fill gaps between earliest and latest month */
    const sortedKeys = Array.from(buckets.keys()).sort();
    return enumerateMonths(sortedKeys[0], sortedKeys[sortedKeys.length - 1]).map((key) => ({
        key,
        label: monthKeyToLabel(key),
        value: buckets.get(key) || 0,
    }));
}

/* -- Summary stats ----------------------------------------------------------- */

/**
 * Compute the total connection count and network age in whole months.
 * buildConnectionsView computes range-dependent values from filtered rows.
 * @param {CleanedConnectionRow[]} rows - Cleaned connection rows
 * @returns {Readonly<ConnectionStats>}
 */
export function computeStats(rows) {
    const total = rows.length;
    const now = Date.now();

    const earliestMs = rows.reduce((earliest, row) => {
        const time = connectedOnTime(row["Connected On"]);
        return time === null ? earliest : Math.min(earliest, time);
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
 * @param {CleanedConnectionRow[]} rows - Cleaned connection rows with title-case keys
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
 * @param {ConnectionRow[]} rows - All parsed connection rows
 * @param {string} range - Time range key ('1m', '3m', '6m', '12m', 'all')
 * @returns {ConnectionRow[]} Filtered rows within the range
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
 * @param {ConnectionRow[]} rows - Connection rows to aggregate
 * @param {"company"|"position"} field - Field name to aggregate
 * @returns {TopicPoint[]} Top N aggregated entries
 */
export function aggregateField(rows, field) {
    /** @type {Record<string, number>} */
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
 * @param {ConnectionRow[]} rows - Connection rows
 * @param {"company"|"position"} field - Field name
 * @returns {string} Most frequent value or '-'
 */
export function findTopValue(rows, field) {
    if (!rows.length) {
        return "-";
    }

    /** @type {Record<string, number>} */
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
 * @param {GrowthPoint[]|null|undefined} timeline - All-time growth timeline, defaulted here
 * when absent
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
        // Default a missing timeline here so the screen, PDF export, and transport
        // use the same empty value.
        timeline: Array.isArray(timeline) ? timeline : [],
        companies,
        positions,
        stats,
    };
}
