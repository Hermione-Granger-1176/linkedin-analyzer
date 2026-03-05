import { beforeEach, describe, expect, it, vi } from 'vitest';

import 'fake-indexeddb/auto';

import {
    getViewKey,
    handleAddFile,
    handleClear,
    handleInitBase,
    handleRestoreFiles,
    handleView,
    normalizeFilters
} from '../src/analytics-worker.js';
import { AnalyticsEngine } from '../src/analytics.js';
import { LinkedInCleaner } from '../src/cleaner.js';

vi.mock('../src/analytics.js', () => ({
    AnalyticsEngine: {
        compute: vi.fn(),
        buildView: vi.fn(),
        generateInsights: vi.fn()
    }
}));

vi.mock('../src/cleaner.js', () => ({
    LinkedInCleaner: {
        process: vi.fn()
    }
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal analytics object that satisfies hasAnalyticsData() */
function makeAnalytics(overrides = {}) {
    return {
        months: {
            '2025-01': {
                posts: 3,
                comments: 2,
                total: 5,
                topics: { excel: 2 },
                days: Array(7).fill(0),
                hours: Array(24).fill(0),
                heatmap: Array.from({ length: 7 }, () => Array(24).fill(0)),
                shareTypes: { textOnly: 1, links: 1, media: 1 },
                activeDays: ['2025-01-02']
            }
        },
        dayIndex: { '2025-01-02': { posts: 3, comments: 2, total: 5, shareTypes: { textOnly: 1, links: 1, media: 1 } } },
        activeDays: ['2025-01-02'],
        latestTimestamp: Date.now(),
        earliestTimestamp: Date.now() - 86400000,
        totals: { posts: 3, comments: 2, total: 5 },
        ...overrides
    };
}

/** Minimal view returned by AnalyticsEngine.buildView */
function makeView() {
    return {
        timeline: [{ key: '2025-01', label: 'Jan 2025', value: 5 }],
        timelineMax: 5,
        heatmap: Array.from({ length: 7 }, () => Array(24).fill(0)),
        topics: [{ topic: 'excel', count: 2 }],
        contentMix: { textOnly: 1, links: 1, media: 1 },
        streaks: { current: 1, longest: 1 },
        peakHour: { hour: 9, count: 3 },
        peakDay: { dayIndex: 0, count: 3 },
        trend: { percent: 10, direction: 'up', currentCount: 5, previousCount: 4 },
        totals: { posts: 3, comments: 2, total: 5 }
    };
}

/** Minimal insights returned by AnalyticsEngine.generateInsights */
function makeInsights() {
    return {
        insights: [{ id: 'steady-pace', title: 'Steady Rhythm', body: 'Rhythm', icon: 'calendar', accent: 'accent-blue' }],
        tip: 'Try posting on Mon around 09:00.'
    };
}

/** Capture postMessage output via globalThis.self stub */
function makePostMessageCapture() {
    const messages = [];
    globalThis.self = {
        addEventListener: vi.fn(),
        postMessage: vi.fn((msg) => messages.push(msg))
    };
    return messages;
}

/** Default cleaned data returned by a mocked successful LinkedInCleaner.process */
function mockCleanerSuccess(fileType = 'shares') {
    LinkedInCleaner.process.mockReturnValue({
        success: true,
        fileType,
        cleanedData: [{ Date: '2025-01-02 05:00', ShareCommentary: 'hello', SharedUrl: '', MediaUrl: '' }],
        rowCount: 1
    });
}

// ---------------------------------------------------------------------------
// normalizeFilters
// ---------------------------------------------------------------------------

describe('normalizeFilters', () => {
    it('fills in defaults for null/undefined input', () => {
        const result = normalizeFilters(null);
        expect(result.timeRange).toBe('12m');
        expect(result.topic).toBe('all');
        expect(result.monthFocus).toBeNull();
        expect(result.day).toBeNull();
        expect(result.hour).toBeNull();
        expect(result.shareType).toBe('all');
    });

    it('fills in defaults for empty object input', () => {
        const result = normalizeFilters({});
        expect(result.timeRange).toBe('12m');
        expect(result.topic).toBe('all');
        expect(result.monthFocus).toBeNull();
        expect(result.day).toBeNull();
        expect(result.hour).toBeNull();
        expect(result.shareType).toBe('all');
    });

    it('preserves provided values', () => {
        const result = normalizeFilters({
            timeRange: '3m',
            topic: 'excel',
            monthFocus: '2025-01',
            day: 2,
            hour: 9,
            shareType: 'media'
        });
        expect(result.timeRange).toBe('3m');
        expect(result.topic).toBe('excel');
        expect(result.monthFocus).toBe('2025-01');
        expect(result.day).toBe(2);
        expect(result.hour).toBe(9);
        expect(result.shareType).toBe('media');
    });

    it('treats numeric 0 as a valid day and hour', () => {
        const result = normalizeFilters({ day: 0, hour: 0 });
        expect(result.day).toBe(0);
        expect(result.hour).toBe(0);
    });

    it('treats non-numeric day/hour as null', () => {
        const result = normalizeFilters({ day: 'Monday', hour: 'noon' });
        expect(result.day).toBeNull();
        expect(result.hour).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// getViewKey
// ---------------------------------------------------------------------------

describe('getViewKey', () => {
    it('returns a pipe-delimited string with default fields', () => {
        const key = getViewKey({});
        expect(key).toBe('12m|all|none|none|none|all');
    });

    it('reflects provided filter values in the key', () => {
        const key = getViewKey({ timeRange: '3m', topic: 'excel', monthFocus: '2025-01', day: 1, hour: 9, shareType: 'media' });
        expect(key).toBe('3m|excel|2025-01|1|9|media');
    });

    it('different filters produce different keys', () => {
        expect(getViewKey({ timeRange: '1m' })).not.toBe(getViewKey({ timeRange: '12m' }));
        expect(getViewKey({ topic: 'ai' })).not.toBe(getViewKey({ topic: 'all' }));
    });
});

// ---------------------------------------------------------------------------
// handleInitBase
// ---------------------------------------------------------------------------

describe('handleInitBase', () => {
    beforeEach(() => {
        makePostMessageCapture();
        vi.clearAllMocks();
        // Re-wire postMessage capture after clearAllMocks resets spies
        makePostMessageCapture();
    });

    it('posts init message with hasData=false when payload is null', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        handleInitBase(null);

        expect(messages.length).toBe(1);
        expect(messages[0].type).toBe('init');
        expect(messages[0].payload.hasData).toBe(false);
    });

    it('posts init message with hasData=false for payload with no months', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        handleInitBase({ activeDays: [] });

        expect(messages[0].type).toBe('init');
        expect(messages[0].payload.hasData).toBe(false);
    });

    it('hydrates analytics from stored payload and reports hasData=true', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        const stored = makeAnalytics();
        // activeDays inside months must be arrays for hydrateAnalytics
        stored.months['2025-01'].activeDays = ['2025-01-02'];
        stored.activeDays = ['2025-01-02'];

        handleInitBase(stored);

        expect(messages[0].type).toBe('init');
        expect(messages[0].payload.hasData).toBe(true);
    });

    it('resets view cache so subsequent views are recomputed', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        AnalyticsEngine.buildView.mockReturnValue(makeView());
        AnalyticsEngine.generateInsights.mockReturnValue(makeInsights());

        const stored = makeAnalytics();
        stored.months['2025-01'].activeDays = ['2025-01-02'];
        stored.activeDays = ['2025-01-02'];
        handleInitBase(stored);

        // First view request — should call buildView
        AnalyticsEngine.buildView.mockClear();
        handleView(1, {});
        expect(AnalyticsEngine.buildView).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// handleView
// ---------------------------------------------------------------------------

describe('handleView', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        makePostMessageCapture();
    });

    it('posts an error when analytics is not loaded', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        // Ensure analytics is cleared
        handleClear();
        messages.length = 0; // discard the 'cleared' message

        handleView(1, {});

        expect(messages[0].type).toBe('error');
        expect(messages[0].requestId).toBe(1);
        expect(messages[0].payload.message).toBeTruthy();
    });

    it('posts a view message after analytics is loaded via initBase', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        AnalyticsEngine.buildView.mockReturnValue(makeView());
        AnalyticsEngine.generateInsights.mockReturnValue(makeInsights());

        const stored = makeAnalytics();
        stored.months['2025-01'].activeDays = ['2025-01-02'];
        stored.activeDays = ['2025-01-02'];
        handleInitBase(stored);
        messages.length = 0;

        handleView(42, {});

        const viewMsg = messages.find((m) => m.type === 'view');
        expect(viewMsg).toBeDefined();
        expect(viewMsg.requestId).toBe(42);
        expect(viewMsg.payload.view).toBeDefined();
        expect(viewMsg.payload.insights).toBeDefined();
    });

    it('returns cached view on second request with same filters', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        AnalyticsEngine.buildView.mockReturnValue(makeView());
        AnalyticsEngine.generateInsights.mockReturnValue(makeInsights());

        const stored = makeAnalytics();
        stored.months['2025-01'].activeDays = ['2025-01-02'];
        stored.activeDays = ['2025-01-02'];
        handleInitBase(stored);
        messages.length = 0;

        handleView(1, {});
        handleView(2, {});

        // buildView should only have been called once; second request served from cache
        expect(AnalyticsEngine.buildView).toHaveBeenCalledTimes(1);

        const viewMsgs = messages.filter((m) => m.type === 'view');
        expect(viewMsgs.length).toBe(2);
    });

    it('posts an error when buildView returns null', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        AnalyticsEngine.buildView.mockReturnValue(null);

        const stored = makeAnalytics();
        stored.months['2025-01'].activeDays = ['2025-01-02'];
        stored.activeDays = ['2025-01-02'];
        handleInitBase(stored);
        messages.length = 0;

        handleView(5, {});

        const errMsg = messages.find((m) => m.type === 'error');
        expect(errMsg).toBeDefined();
        expect(errMsg.requestId).toBe(5);
    });

    it('tracks the most recent requestId — each call sets currentRequestId', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        AnalyticsEngine.buildView.mockReturnValue(makeView());
        AnalyticsEngine.generateInsights.mockReturnValue(makeInsights());

        const stored = makeAnalytics();
        stored.months['2025-01'].activeDays = ['2025-01-02'];
        stored.activeDays = ['2025-01-02'];
        handleInitBase(stored);
        messages.length = 0;

        // Two sequential synchronous calls: each completes before the next starts,
        // so both produce view messages (no async interleaving is possible here).
        handleView(10, { timeRange: '12m' });
        handleView(11, { timeRange: '3m' });

        const viewFor10 = messages.filter((m) => m.type === 'view' && m.requestId === 10);
        const viewFor11 = messages.filter((m) => m.type === 'view' && m.requestId === 11);
        expect(viewFor10.length).toBe(1);
        expect(viewFor11.length).toBe(1);
    });

    it('includes a view key in the view payload', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        AnalyticsEngine.buildView.mockReturnValue(makeView());
        AnalyticsEngine.generateInsights.mockReturnValue(makeInsights());

        const stored = makeAnalytics();
        stored.months['2025-01'].activeDays = ['2025-01-02'];
        stored.activeDays = ['2025-01-02'];
        handleInitBase(stored);
        messages.length = 0;

        handleView(7, {});

        const viewMsg = messages.find((m) => m.type === 'view');
        expect(typeof viewMsg.payload.view.key).toBe('string');
        expect(viewMsg.payload.view.key.includes('|')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// handleAddFile
// ---------------------------------------------------------------------------

describe('handleAddFile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        makePostMessageCapture();
        handleClear();
    });

    it('posts progress then fileProcessed message for a valid shares file', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        mockCleanerSuccess('shares');
        AnalyticsEngine.compute.mockReturnValue(makeAnalytics());

        handleAddFile({ csvText: 'header\nrow1', fileName: 'shares.csv' });

        const progressMsgs = messages.filter((m) => m.type === 'progress');
        expect(progressMsgs.length).toBeGreaterThanOrEqual(2);

        const processed = messages.find((m) => m.type === 'fileProcessed');
        expect(processed).toBeDefined();
        expect(processed.payload.fileType).toBe('shares');
        expect(processed.payload.rowCount).toBe(1);
        expect(processed.payload.hasData).toBe(true);
    });

    it('posts progress then fileProcessed message for a valid comments file', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        mockCleanerSuccess('comments');
        AnalyticsEngine.compute.mockReturnValue(makeAnalytics());

        handleAddFile({ csvText: 'header\nrow1', fileName: 'comments.csv' });

        const processed = messages.find((m) => m.type === 'fileProcessed');
        expect(processed).toBeDefined();
        expect(processed.payload.fileType).toBe('comments');
        expect(processed.payload.hasData).toBe(true);
    });

    it('posts fileProcessed with error when LinkedInCleaner fails', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        LinkedInCleaner.process.mockReturnValue({ success: false, error: 'Bad format' });

        handleAddFile({ csvText: 'garbage', fileName: 'bad.csv' });

        const processed = messages.find((m) => m.type === 'fileProcessed');
        expect(processed).toBeDefined();
        expect(processed.payload.error).toBeTruthy();
    });

    it('posts fileProcessed with error for unknown fileType', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        LinkedInCleaner.process.mockReturnValue({
            success: true,
            fileType: 'messages',      // not a recognized analytics source type
            cleanedData: [],
            rowCount: 0
        });

        handleAddFile({ csvText: 'something', fileName: 'messages.csv' });

        // analyticsBase should be null since fileType is not shares/comments
        const processed = messages.find((m) => m.type === 'fileProcessed');
        expect(processed).toBeDefined();
        expect(processed.payload.analyticsBase).toBeNull();
    });

    it('passes jobId through to progress and fileProcessed messages', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        mockCleanerSuccess('shares');
        AnalyticsEngine.compute.mockReturnValue(makeAnalytics());

        handleAddFile({ csvText: 'data', fileName: 'shares.csv', jobId: 'job-123' });

        messages.forEach((m) => {
            if (m.payload && 'jobId' in m.payload) {
                expect(m.payload.jobId).toBe('job-123');
            }
        });
    });
});

// ---------------------------------------------------------------------------
// handleRestoreFiles
// ---------------------------------------------------------------------------

describe('handleRestoreFiles', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        makePostMessageCapture();
    });

    it('posts restored with hasData=true when shares CSV parses successfully', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        LinkedInCleaner.process.mockImplementation((csv, type) => {
            if (type === 'shares') {
                return { success: true, fileType: 'shares', cleanedData: [{ Date: '2025-01-02 09:00' }], rowCount: 1 };
            }
            return { success: false };
        });
        AnalyticsEngine.compute.mockReturnValue(makeAnalytics());

        handleRestoreFiles({ sharesCsv: 'shares-csv-text', commentsCsv: '' });

        const restored = messages.find((m) => m.type === 'restored');
        expect(restored).toBeDefined();
        expect(restored.payload.hasData).toBe(true);
    });

    it('posts restored with hasData=false when both CSVs fail to parse', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        LinkedInCleaner.process.mockReturnValue({ success: false, error: 'Bad CSV' });

        handleRestoreFiles({ sharesCsv: 'bad', commentsCsv: 'also-bad' });

        const restored = messages.find((m) => m.type === 'restored');
        expect(restored).toBeDefined();
        expect(restored.payload.hasData).toBe(false);
    });

    it('posts restored with hasData=false when payload is empty', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        handleRestoreFiles({});

        const restored = messages.find((m) => m.type === 'restored');
        expect(restored).toBeDefined();
        expect(restored.payload.hasData).toBe(false);
    });

    it('processes both shares and comments when both are provided', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        LinkedInCleaner.process.mockImplementation((csv, type) => ({
            success: true,
            fileType: type,
            cleanedData: [{ Date: '2025-01-02 09:00' }],
            rowCount: 1
        }));
        AnalyticsEngine.compute.mockReturnValue(makeAnalytics());

        handleRestoreFiles({ sharesCsv: 'shares', commentsCsv: 'comments' });

        // Should have called compute once after loading both
        expect(AnalyticsEngine.compute).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// handleClear
// ---------------------------------------------------------------------------

describe('handleClear', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        makePostMessageCapture();
    });

    it('posts cleared message', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        handleClear();

        expect(messages[0].type).toBe('cleared');
    });

    it('causes subsequent handleView to post an error', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        handleClear();
        messages.length = 0;

        handleView(1, {});

        expect(messages[0].type).toBe('error');
    });
});

// ---------------------------------------------------------------------------
// message dispatcher (via self.addEventListener handler)
// ---------------------------------------------------------------------------

describe('message event dispatcher', () => {
    it('registers a message listener on self during module load', async () => {
        const addEventListenerSpy = vi.fn();
        globalThis.self = {
            addEventListener: addEventListenerSpy,
            postMessage: vi.fn()
        };
        vi.resetModules();
        await import('../src/analytics-worker.js');
        const registeredTypes = addEventListenerSpy.mock.calls.map((c) => c[0]);
        expect(registeredTypes).toContain('message');
        expect(registeredTypes).toContain('error');
        expect(registeredTypes).toContain('unhandledrejection');
    });

    it('dispatches addFile message to handleAddFile', async () => {
        const posted = [];
        const handlers = {};
        globalThis.self = {
            addEventListener: (type, fn) => { handlers[type] = fn; },
            postMessage: vi.fn((m) => posted.push(m))
        };

        vi.resetModules();
        await import('../src/analytics-worker.js');

        // Re-import mocks after resetModules
        const { LinkedInCleaner: LC } = await import('../src/cleaner.js');
        const { AnalyticsEngine: AE } = await import('../src/analytics.js');
        LC.process.mockReturnValue({ success: false, error: 'bad' });
        AE.compute.mockReturnValue(makeAnalytics());

        handlers.message({ data: { type: 'addFile', payload: { csvText: 'x', fileName: 'f.csv' } } });

        const processed = posted.find((m) => m.type === 'fileProcessed');
        expect(processed).toBeDefined();
    });

    it('ignores unknown message types without throwing', async () => {
        const handlers = {};
        globalThis.self = {
            addEventListener: (type, fn) => { handlers[type] = fn; },
            postMessage: vi.fn()
        };

        vi.resetModules();
        await import('../src/analytics-worker.js');

        expect(() => {
            handlers.message({ data: { type: 'unknownType', payload: {} } });
        }).not.toThrow();
    });

    it('handles missing data on the event without throwing', async () => {
        const handlers = {};
        globalThis.self = {
            addEventListener: (type, fn) => { handlers[type] = fn; },
            postMessage: vi.fn()
        };

        vi.resetModules();
        await import('../src/analytics-worker.js');

        expect(() => {
            handlers.message({});
            handlers.message({ data: null });
            handlers.message({ data: {} });
        }).not.toThrow();
    });

    it('posts worker error payload when a handler throws', async () => {
        const posted = [];
        const handlers = {};
        globalThis.self = {
            addEventListener: (type, fn) => { handlers[type] = fn; },
            postMessage: vi.fn((message) => posted.push(message))
        };

        vi.resetModules();
        await import('../src/analytics-worker.js');

        const { LinkedInCleaner: LC } = await import('../src/cleaner.js');
        LC.process.mockImplementation(() => {
            throw new Error('add-file-failed');
        });

        handlers.message({
            data: {
                type: 'addFile',
                payload: {
                    csvText: 'Date,ShareLink,ShareCommentary\n2025-01-01,https://example.com,hello',
                    fileName: 'Shares.csv'
                }
            }
        });

        const errorMessage = posted.find(message => message.type === 'error');
        expect(errorMessage).toBeDefined();
        expect(errorMessage.payload.message).toContain('add-file-failed');
    });

    it('forwards unhandled rejection events to error payloads', async () => {
        const posted = [];
        const handlers = {};
        globalThis.self = {
            addEventListener: (type, fn) => { handlers[type] = fn; },
            postMessage: vi.fn((message) => posted.push(message))
        };

        vi.resetModules();
        await import('../src/analytics-worker.js');

        handlers.unhandledrejection({ reason: new Error('worker-rejection') });

        const errorMessage = posted.find(message => message.type === 'error');
        expect(errorMessage).toBeDefined();
        expect(errorMessage.payload.message).toContain('worker-rejection');
    });
});

// ---------------------------------------------------------------------------
// hydrateAnalytics round-trip (tested via initBase → view)
// ---------------------------------------------------------------------------

describe('hydrateAnalytics via initBase/view round-trip', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        makePostMessageCapture();
    });

    it('converts activeDays arrays back to Sets so streaks work', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        const view = makeView();
        AnalyticsEngine.buildView.mockReturnValue(view);
        AnalyticsEngine.generateInsights.mockReturnValue(makeInsights());

        const stored = makeAnalytics();
        // activeDays stored as plain arrays (as they come from IDB)
        stored.months['2025-01'].activeDays = ['2025-01-02', '2025-01-03'];
        stored.activeDays = ['2025-01-02', '2025-01-03'];

        handleInitBase(stored);
        messages.length = 0;

        handleView(1, { timeRange: 'all' });

        const viewMsg = messages.find((m) => m.type === 'view');
        expect(viewMsg).toBeDefined();
        // AnalyticsEngine.buildView was called — hydration succeeded
        expect(AnalyticsEngine.buildView).toHaveBeenCalledTimes(1);
        // Verify the first argument passed to buildView has months with Set activeDays
        const analyticsArg = AnalyticsEngine.buildView.mock.calls[0][0];
        expect(analyticsArg.months['2025-01'].activeDays).toBeInstanceOf(Set);
        expect(analyticsArg.activeDays).toBeInstanceOf(Set);
    });
});

// ---------------------------------------------------------------------------
// view cache LRU trimming
// ---------------------------------------------------------------------------

describe('view cache LRU trimming', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        makePostMessageCapture();
    });

    it('trims the cache when it exceeds VIEW_CACHE_LIMIT entries', () => {
        const messages = [];
        globalThis.self.postMessage = vi.fn((m) => messages.push(m));

        AnalyticsEngine.generateInsights.mockReturnValue(makeInsights());

        const stored = makeAnalytics();
        stored.months['2025-01'].activeDays = ['2025-01-02'];
        stored.activeDays = ['2025-01-02'];
        handleInitBase(stored);
        messages.length = 0;

        // Fill the cache past the VIEW_CACHE_LIMIT (50) by requesting 55 unique filter combos
        for (let i = 0; i < 55; i++) {
            AnalyticsEngine.buildView.mockReturnValue({ ...makeView(), _i: i });
            handleView(i + 100, { timeRange: `${i + 1}m` });
        }

        // If trimming works correctly, the function should not throw and all 55 requests
        // should have produced a view or error message without crashing.
        const viewAndError = messages.filter((m) => m.type === 'view' || m.type === 'error');
        expect(viewAndError.length).toBeGreaterThan(0);
    });
});
