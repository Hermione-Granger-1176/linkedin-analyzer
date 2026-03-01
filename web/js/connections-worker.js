/* LinkedIn Analyzer - Connections parsing & analytics worker */

const WORKER_VERSION = '20260301-1';
importScripts(`cleaner.js?v=${WORKER_VERSION}`);

/* ── Constants ─────────────────────────────────────────────────────────────── */

const TOP_N = 15;
const RECENT_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Short month names used by LinkedIn's "Connected On" field after cleaning.
 * The cleaner outputs ISO dates (YYYY-MM-DD), so we only need this map for
 * building human-readable month labels in the growth timeline.
 */
const MONTH_LABELS = Object.freeze([
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
]);

/* ── Date helpers ──────────────────────────────────────────────────────────── */

/**
 * Parse a cleaned "Connected On" value into a Date.
 * The cleaner's cleanConnectionsDate turns "01 Jan 2024" into "2024-01-01",
 * so we split on hyphens to avoid timezone-shifting pitfalls of Date.parse.
 *
 * @param {string} dateStr - ISO-style date string (YYYY-MM-DD)
 * @returns {Date|null} Local-midnight Date, or null if unparseable
 */
function parseConnectionDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;

    const parts = dateStr.split('-');
    if (parts.length !== 3) return null;

    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);

    if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;

    return new Date(year, month - 1, day);
}

/**
 * Build a YYYY-MM key from a Date, used as the bucket identifier in the
 * growth timeline so months are naturally sortable.
 *
 * @param {Date} date
 * @returns {string} e.g. "2024-01"
 */
function toMonthKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

/**
 * Build a human-readable label from a YYYY-MM key, since chart axes
 * should show "Jan 2024" rather than "2024-01".
 *
 * @param {string} key - e.g. "2024-01"
 * @returns {string} e.g. "Jan 2024"
 */
function monthKeyToLabel(key) {
    const [yearStr, monthStr] = key.split('-');
    const monthIndex = Number(monthStr) - 1;
    return `${MONTH_LABELS[monthIndex]} ${yearStr}`;
}

/* ── Aggregation helpers ───────────────────────────────────────────────────── */

/**
 * Count occurrences of each non-empty value in a given field.
 * Returns a Map so callers can sort/slice without re-iterating.
 *
 * @param {object[]} rows - Cleaned connection rows
 * @param {string} field - Column name to tally (e.g. "Company")
 * @returns {Map<string, number>} Value -> count
 */
function countByField(rows, field) {
    const counts = new Map();
    for (const row of rows) {
        const value = (row[field] || '').trim();
        if (!value) continue;
        counts.set(value, (counts.get(value) || 0) + 1);
    }
    return counts;
}

/**
 * Extract the top N entries from a frequency map, sorted descending.
 * Separated from countByField so the counting pass stays reusable for
 * stats that need the full map (e.g. finding the single top company).
 *
 * @param {Map<string, number>} countMap - Value -> count
 * @param {number} limit - Maximum entries to return
 * @returns {Array<{name: string, count: number}>}
 */
function topEntries(countMap, limit) {
    return Array.from(countMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([name, count]) => ({ name, count }));
}

/* ── Growth timeline ───────────────────────────────────────────────────────── */

/**
 * Bucket connections by month and fill gaps so the timeline has no missing
 * months. Gaps look misleading on line/bar charts, so we insert zero-value
 * entries for any month between the earliest and latest connection dates.
 *
 * @param {object[]} rows - Cleaned connection rows
 * @returns {Array<{key: string, label: string, value: number}>} Sorted chronologically
 */
function buildGrowthTimeline(rows) {
    const buckets = new Map();

    for (const row of rows) {
        const date = parseConnectionDate(row['Connected On']);
        if (!date) continue;
        const key = toMonthKey(date);
        buckets.set(key, (buckets.get(key) || 0) + 1);
    }

    if (buckets.size === 0) return [];

    /* Fill gaps between earliest and latest month */
    const sortedKeys = Array.from(buckets.keys()).sort();
    const firstKey = sortedKeys[0];
    const lastKey = sortedKeys[sortedKeys.length - 1];

    const timeline = [];
    let [curYear, curMonth] = firstKey.split('-').map(Number);
    const [endYear, endMonth] = lastKey.split('-').map(Number);

    while (curYear < endYear || (curYear === endYear && curMonth <= endMonth)) {
        const key = `${curYear}-${String(curMonth).padStart(2, '0')}`;
        timeline.push({
            key,
            label: monthKeyToLabel(key),
            value: buckets.get(key) || 0
        });

        curMonth += 1;
        if (curMonth > 12) {
            curMonth = 1;
            curYear += 1;
        }
    }

    return timeline;
}

/* ── Summary stats ─────────────────────────────────────────────────────────── */

/**
 * Compute high-level stats that feed the dashboard stat cards.
 * Kept as a pure function so it's easy to unit-test without worker plumbing.
 *
 * @param {object[]} rows - Cleaned connection rows
 * @param {Map<string, number>} companyCounts - Pre-computed company frequencies
 * @returns {{total: number, recentAdds: number, topCompany: string, networkAgeMonths: number}}
 */
function computeStats(rows, companyCounts) {
    const total = rows.length;
    const now = Date.now();
    const recentCutoff = now - RECENT_DAYS * MS_PER_DAY;

    let recentAdds = 0;
    let earliestMs = Infinity;

    for (const row of rows) {
        const date = parseConnectionDate(row['Connected On']);
        if (!date) continue;

        const ms = date.getTime();
        if (ms >= recentCutoff) recentAdds += 1;
        if (ms < earliestMs) earliestMs = ms;
    }

    /* Top company by count; fall back to empty string when no data */
    let topCompany = '';
    let topCount = 0;
    for (const [name, count] of companyCounts) {
        if (count > topCount) {
            topCompany = name;
            topCount = count;
        }
    }

    /* Network age in whole months from earliest connection to now */
    const networkAgeMonths = earliestMs === Infinity
        ? 0
        : Math.max(0, Math.round((now - earliestMs) / (MS_PER_DAY * 30.44)));

    return Object.freeze({ total, recentAdds, topCompany, networkAgeMonths });
}

/* ── Main processing pipeline ──────────────────────────────────────────────── */

/**
 * Parse and aggregate a Connections CSV into analytics ready for the UI.
 * The cleaned rows are included in the response so the UI can apply its own
 * client-side filters (search, company drill-down) without another worker round-trip.
 *
 * @param {string} connectionsCsv - Raw CSV text from the Connections export
 * @returns {{success: boolean, analytics?: object, rows?: object[], error?: string}}
 */
function processConnections(connectionsCsv) {
    if (!connectionsCsv || typeof connectionsCsv !== 'string') {
        return { success: false, error: 'No connections CSV data provided.' };
    }

    const result = LinkedInCleaner.process(connectionsCsv, 'connections');
    if (!result.success) {
        return { success: false, error: result.error || 'Unable to parse Connections.csv.' };
    }

    const rows = result.cleanedData;
    if (!rows.length) {
        return { success: false, error: 'Connections file contained no valid rows.' };
    }

    const companyCounts = countByField(rows, 'Company');
    const positionCounts = countByField(rows, 'Position');

    const analytics = Object.freeze({
        growthTimeline: buildGrowthTimeline(rows),
        companyBreakdown: topEntries(companyCounts, TOP_N),
        positionDistribution: topEntries(positionCounts, TOP_N),
        stats: computeStats(rows, companyCounts)
    });

    return { success: true, analytics, rows };
}

/* ── Worker message handler ────────────────────────────────────────────────── */

self.addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type !== 'process') return;

    const requestId = message.requestId;
    const payload = message.payload || {};
    const result = processConnections(payload.connectionsCsv);

    self.postMessage({
        type: 'processed',
        requestId,
        payload: {
            success: result.success,
            analytics: result.analytics || null,
            rows: result.rows || null,
            error: result.error || null
        }
    });
});
