const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/* LinkedInCleaner must be a global before the worker module loads */
globalThis.LinkedInCleaner = require(path.join(__dirname, '..', 'js', 'cleaner.js'));

const {
    parseConnectionDate,
    toMonthKey,
    monthKeyToLabel,
    buildGrowthTimeline,
    computeStats,
    processConnections
} = require(path.join(__dirname, '..', 'js', 'connections-worker.js'));

/* ── parseConnectionDate ──────────────────────────────────────────────────── */

test('parseConnectionDate returns Date for valid ISO string', () => {
    const date = parseConnectionDate('2024-06-15');
    assert.ok(date instanceof Date);
    assert.equal(date.getFullYear(), 2024);
    assert.equal(date.getMonth(), 5);
    assert.equal(date.getDate(), 15);
});

test('parseConnectionDate returns null for invalid input', () => {
    assert.equal(parseConnectionDate(null), null);
    assert.equal(parseConnectionDate(''), null);
    assert.equal(parseConnectionDate('not-a-date'), null);
    assert.equal(parseConnectionDate('2024-13-01'), null);
    assert.equal(parseConnectionDate('2024-00-15'), null);
    assert.equal(parseConnectionDate('2024-06-32'), null);
    assert.equal(parseConnectionDate(42), null);
});

/* ── toMonthKey ───────────────────────────────────────────────────────────── */

test('toMonthKey formats Date as YYYY-MM with zero-padding', () => {
    assert.equal(toMonthKey(new Date(2024, 0, 1)), '2024-01');
    assert.equal(toMonthKey(new Date(2024, 11, 31)), '2024-12');
    assert.equal(toMonthKey(new Date(2025, 5, 15)), '2025-06');
});

/* ── monthKeyToLabel ──────────────────────────────────────────────────────── */

test('monthKeyToLabel converts YYYY-MM to readable label', () => {
    assert.equal(monthKeyToLabel('2024-01'), 'Jan 2024');
    assert.equal(monthKeyToLabel('2025-12'), 'Dec 2025');
    assert.equal(monthKeyToLabel('2023-06'), 'Jun 2023');
});

/* ── buildGrowthTimeline ──────────────────────────────────────────────────── */

test('buildGrowthTimeline buckets by month and fills gaps', () => {
    const rows = [
        { 'Connected On': '2024-01-10' },
        { 'Connected On': '2024-01-20' },
        { 'Connected On': '2024-03-05' }
    ];

    const timeline = buildGrowthTimeline(rows);

    assert.equal(timeline.length, 3);
    assert.equal(timeline[0].key, '2024-01');
    assert.equal(timeline[0].value, 2);
    assert.equal(timeline[0].label, 'Jan 2024');
    assert.equal(timeline[1].key, '2024-02');
    assert.equal(timeline[1].value, 0);
    assert.equal(timeline[2].key, '2024-03');
    assert.equal(timeline[2].value, 1);
});

test('buildGrowthTimeline returns empty array when no valid dates', () => {
    assert.deepEqual(buildGrowthTimeline([]), []);
    assert.deepEqual(buildGrowthTimeline([{ 'Connected On': '' }]), []);
    assert.deepEqual(buildGrowthTimeline([{ 'Connected On': 'invalid' }]), []);
});

/* ── computeStats ─────────────────────────────────────────────────────────── */

test('computeStats returns total and positive network age', () => {
    const rows = [
        { 'Connected On': '2020-01-01' },
        { 'Connected On': '2024-06-15' },
        { 'Connected On': '2025-01-01' }
    ];

    const stats = computeStats(rows);

    assert.equal(stats.total, 3);
    assert.ok(stats.networkAgeMonths > 0);
});

test('computeStats handles empty rows', () => {
    const stats = computeStats([]);

    assert.equal(stats.total, 0);
    assert.equal(stats.networkAgeMonths, 0);
});

/* ── processConnections (end-to-end) ──────────────────────────────────────── */

test('processConnections succeeds with valid CSV', () => {
    const csv = [
        'Notes:',
        'Export metadata',
        '',
        'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
        'Ada,Lovelace,https://linkedin.com/in/ada,,Engines,Mathematician,30 Jan 2024',
        'Bob,Smith,https://linkedin.com/in/bob,,Acme,Engineer,15 Jun 2024'
    ].join('\n');

    const result = processConnections(csv);

    assert.equal(result.success, true);
    assert.ok(result.rows.length === 2);
    assert.ok(result.analytics.growthTimeline.length > 0);
    assert.equal(result.analytics.stats.total, 2);
    assert.ok(result.analytics.stats.networkAgeMonths > 0);
});

test('processConnections rejects empty input', () => {
    assert.equal(processConnections('').success, false);
    assert.equal(processConnections(null).success, false);
    assert.ok(processConnections('').error);
});
