/* LinkedIn Analyzer - Connections parsing & analytics worker */

import { LinkedInCleaner } from './cleaner.js';

/* ── Constants ─────────────────────────────────────────────────────────────── */

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
    const [startYear, startMonth] = firstKey.split('-').map(Number);
    const [endYear, endMonth] = lastKey.split('-').map(Number);
    const monthSpan = (endYear - startYear) * 12 + (endMonth - startMonth);

    for (let offset = 0; offset <= monthSpan; offset += 1) {
        const absoluteMonth = (startMonth - 1) + offset;
        const year = startYear + Math.floor(absoluteMonth / 12);
        const month = (absoluteMonth % 12) + 1;
        const key = `${year}-${String(month).padStart(2, '0')}`;
        timeline.push({
            key,
            label: monthKeyToLabel(key),
            value: buckets.get(key) || 0
        });
    }

    return timeline;
}

/* ── Summary stats ─────────────────────────────────────────────────────────── */

/**
 * Compute high-level stats that feed the dashboard stat cards.
 * Only total and networkAgeMonths are used by the UI — the UI recomputes
 * filtered stats (recent adds, top company) client-side.
 *
 * @param {object[]} rows - Cleaned connection rows
 * @returns {{total: number, networkAgeMonths: number}}
 */
function computeStats(rows) {
    const total = rows.length;
    const now = Date.now();

    let earliestMs = Infinity;

    for (const row of rows) {
        const date = parseConnectionDate(row['Connected On']);
        if (!date) continue;

        const ms = date.getTime();
        if (ms < earliestMs) earliestMs = ms;
    }

    /* Network age in whole months from earliest connection to now */
    const networkAgeMonths = earliestMs === Infinity
        ? 0
        : Math.max(0, Math.round((now - earliestMs) / (MS_PER_DAY * 30.44)));

    return Object.freeze({ total, networkAgeMonths });
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

    const analytics = Object.freeze({
        growthTimeline: buildGrowthTimeline(rows),
        stats: computeStats(rows)
    });

    return { success: true, analytics, rows };
}

/* ── Worker message handler ────────────────────────────────────────────────── */

if (typeof self !== 'undefined') {
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
}

export {
    parseConnectionDate,
    toMonthKey,
    monthKeyToLabel,
    buildGrowthTimeline,
    computeStats,
    processConnections
};
