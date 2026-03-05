import { describe, expect, it, vi } from 'vitest';

import { LinkedInCleaner } from '../src/cleaner.js';
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

    it('processConnections uses fallback parser error message when cleaner omits error', () => {
        const processSpy = vi.spyOn(LinkedInCleaner, 'process').mockReturnValueOnce({
            success: false,
            error: ''
        });

        const result = processConnections('First Name,Last Name\nAda,Lovelace');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Unable to parse Connections.csv.');

        processSpy.mockRestore();
    });

    // ── computeStats edge cases (lines 167, 172) ──────────────────────────────

    it('computeStats with a single connection has networkAgeMonths >= 0 (line 167)', () => {
        const rows = [{ 'Connected On': '2023-06-01' }];
        const stats = computeStats(rows);
        expect(stats.total).toBe(1);
        expect(stats.networkAgeMonths).toBeGreaterThan(0);
    });

    it('computeStats skips rows with unparseable dates and still counts them (line 172)', () => {
        // Rows with missing dates still contribute to total but not to earliestMs
        const rows = [
            { 'Connected On': '' },
            { 'Connected On': 'bad' },
            { 'Connected On': '2024-03-01' }
        ];
        const stats = computeStats(rows);
        // total counts ALL rows regardless of date validity
        expect(stats.total).toBe(3);
        expect(stats.networkAgeMonths).toBeGreaterThan(0);
    });

    it('computeStats with all invalid dates returns networkAgeMonths of 0 (line 143)', () => {
        const rows = [
            { 'Connected On': '' },
            { 'Connected On': 'not-a-date' }
        ];
        const stats = computeStats(rows);
        expect(stats.total).toBe(2);
        expect(stats.networkAgeMonths).toBe(0);
    });

    // ── processConnections empty-rows path (lines 187-194) ───────────────────

    it('processConnections returns error when CSV parses but yields no valid rows (line 172)', () => {
        // A valid connections header but every row is empty (all identity fields missing)
        const csv = [
            'Notes:',
            'Export metadata',
            '',
            'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
            ',,,,,,',
            ',,,,,,'
        ].join('\n');

        const result = processConnections(csv);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/no valid rows/i);
    });

    // ── Worker message listener (lines 187-194) ───────────────────────────────

    it('connections worker listener ignores non-process messages', () => {
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});

        globalThis.dispatchEvent(
            Object.assign(new Event('message'), { data: { type: 'ping', requestId: 'r0', payload: {} } })
        );

        expect(postMessageSpy).not.toHaveBeenCalled();
        postMessageSpy.mockRestore();
    });

    it('connections worker listener posts result for process message type', () => {
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});

        const csv = [
            'Notes:',
            'Export metadata',
            '',
            'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
            'Ada,Lovelace,https://linkedin.com/in/ada,,Engines,Mathematician,30 Jan 2024'
        ].join('\n');

        globalThis.dispatchEvent(
            Object.assign(new Event('message'), {
                data: {
                    type: 'process',
                    requestId: 'conn-req-1',
                    payload: { connectionsCsv: csv }
                }
            })
        );

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [msg] = postMessageSpy.mock.calls[0];
        expect(msg.type).toBe('processed');
        expect(msg.requestId).toBe('conn-req-1');
        expect(msg.payload.success).toBe(true);
        expect(msg.payload.rows).toBeTruthy();

        postMessageSpy.mockRestore();
    });

    it('connections worker forwards runtime error events', () => {
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});

        const event = new Event('error');
        Object.defineProperty(event, 'error', { value: new Error('connections-runtime') });
        globalThis.dispatchEvent(event);

        expect(postMessageSpy).toHaveBeenCalled();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.type).toBe('error');
        expect(message.payload.message).toContain('connections-runtime');

        postMessageSpy.mockRestore();
    });

    it('connections worker forwards unhandled rejections', () => {
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});

        const event = new Event('unhandledrejection');
        Object.defineProperty(event, 'reason', { value: new Error('connections-rejection') });
        globalThis.dispatchEvent(event);

        expect(postMessageSpy).toHaveBeenCalled();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.type).toBe('error');
        expect(message.payload.message).toContain('connections-rejection');

        postMessageSpy.mockRestore();
    });

    it('connections worker reports invalid process payloads', () => {
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});

        globalThis.dispatchEvent(
            Object.assign(new Event('message'), {
                data: {
                    type: 'process',
                    requestId: 'conn-invalid',
                    payload: {}
                }
            })
        );

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.type).toBe('error');
        expect(message.payload.message).toContain('Missing connectionsCsv payload');

        postMessageSpy.mockRestore();
    });

    it('connections worker catches processing exceptions and posts normalized error', () => {
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});
        const processSpy = vi.spyOn(LinkedInCleaner, 'process').mockImplementationOnce(() => {
            throw new Error('connections-failure');
        });

        globalThis.dispatchEvent(
            Object.assign(new Event('message'), {
                data: {
                    type: 'process',
                    requestId: 'conn-fail',
                    payload: { connectionsCsv: 'First Name,Last Name\nAda,Lovelace' }
                }
            })
        );

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.type).toBe('error');
        expect(message.requestId).toBe('conn-fail');
        expect(message.payload.message).toBe('connections-failure');

        processSpy.mockRestore();
        postMessageSpy.mockRestore();
    });

    it('connections worker falls back to generic runtime message for unknown rejection reasons', () => {
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});

        const event = new Event('unhandledrejection');
        Object.defineProperty(event, 'reason', { value: { unknown: true } });
        globalThis.dispatchEvent(event);

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.type).toBe('error');
        expect(message.payload.message).toBe('Connections worker runtime failure.');

        postMessageSpy.mockRestore();
    });

    it('connections worker error listener falls back when event has no payload', () => {
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});

        globalThis.dispatchEvent(new Event('error'));

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.type).toBe('error');
        expect(message.payload.message).toBe('Connections worker runtime failure.');

        postMessageSpy.mockRestore();
    });

    it('connections worker rejection listener falls back when reason is missing', () => {
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});

        globalThis.dispatchEvent(new Event('unhandledrejection'));

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.type).toBe('error');
        expect(message.payload.message).toBe('Connections worker runtime failure.');

        postMessageSpy.mockRestore();
    });
});
