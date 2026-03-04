import { describe, expect, it } from 'vitest';

import {
    buildGrowthTimeline,
    computeStats,
    monthKeyToLabel,
    parseConnectionDate,
    processConnections,
    toMonthKey
} from '../src/connections-worker.js';

describe('connections worker helpers', () => {
    it('parseConnectionDate returns Date for valid ISO string', () => {
        const date = parseConnectionDate('2024-06-15');
        expect(date).toBeInstanceOf(Date);
        expect(date.getFullYear()).toBe(2024);
        expect(date.getMonth()).toBe(5);
        expect(date.getDate()).toBe(15);
    });

    it('parseConnectionDate returns null for invalid input', () => {
        expect(parseConnectionDate(null)).toBe(null);
        expect(parseConnectionDate('')).toBe(null);
        expect(parseConnectionDate('not-a-date')).toBe(null);
        expect(parseConnectionDate('2024-13-01')).toBe(null);
        expect(parseConnectionDate('2024-00-15')).toBe(null);
        expect(parseConnectionDate('2024-06-32')).toBe(null);
        expect(parseConnectionDate(42)).toBe(null);
    });

    it('toMonthKey formats Date as YYYY-MM with zero-padding', () => {
        expect(toMonthKey(new Date(2024, 0, 1))).toBe('2024-01');
        expect(toMonthKey(new Date(2024, 11, 31))).toBe('2024-12');
        expect(toMonthKey(new Date(2025, 5, 15))).toBe('2025-06');
    });

    it('monthKeyToLabel converts YYYY-MM to readable label', () => {
        expect(monthKeyToLabel('2024-01')).toBe('Jan 2024');
        expect(monthKeyToLabel('2025-12')).toBe('Dec 2025');
        expect(monthKeyToLabel('2023-06')).toBe('Jun 2023');
    });

    it('buildGrowthTimeline buckets by month and fills gaps', () => {
        const rows = [
            { 'Connected On': '2024-01-10' },
            { 'Connected On': '2024-01-20' },
            { 'Connected On': '2024-03-05' }
        ];

        const timeline = buildGrowthTimeline(rows);

        expect(timeline.length).toBe(3);
        expect(timeline[0].key).toBe('2024-01');
        expect(timeline[0].value).toBe(2);
        expect(timeline[0].label).toBe('Jan 2024');
        expect(timeline[1].key).toBe('2024-02');
        expect(timeline[1].value).toBe(0);
        expect(timeline[2].key).toBe('2024-03');
        expect(timeline[2].value).toBe(1);
    });

    it('buildGrowthTimeline returns empty array when no valid dates', () => {
        expect(buildGrowthTimeline([])).toEqual([]);
        expect(buildGrowthTimeline([{ 'Connected On': '' }])).toEqual([]);
        expect(buildGrowthTimeline([{ 'Connected On': 'invalid' }])).toEqual([]);
    });

    it('computeStats returns total and positive network age', () => {
        const rows = [
            { 'Connected On': '2020-01-01' },
            { 'Connected On': '2024-06-15' },
            { 'Connected On': '2025-01-01' }
        ];

        const stats = computeStats(rows);

        expect(stats.total).toBe(3);
        expect(stats.networkAgeMonths).toBeGreaterThan(0);
    });

    it('computeStats handles empty rows', () => {
        const stats = computeStats([]);
        expect(stats.total).toBe(0);
        expect(stats.networkAgeMonths).toBe(0);
    });

    it('processConnections succeeds with valid CSV', () => {
        const csv = [
            'Notes:',
            'Export metadata',
            '',
            'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
            'Ada,Lovelace,https://linkedin.com/in/ada,,Engines,Mathematician,30 Jan 2024',
            'Bob,Smith,https://linkedin.com/in/bob,,Acme,Engineer,15 Jun 2024'
        ].join('\n');

        const result = processConnections(csv);

        expect(result.success).toBe(true);
        expect(result.rows.length).toBe(2);
        expect(result.analytics.growthTimeline.length).toBeGreaterThan(0);
        expect(result.analytics.stats.total).toBe(2);
        expect(result.analytics.stats.networkAgeMonths).toBeGreaterThan(0);
    });

    it('processConnections rejects empty input', () => {
        expect(processConnections('').success).toBe(false);
        expect(processConnections(null).success).toBe(false);
        expect(processConnections('').error).toBeTruthy();
    });
});
