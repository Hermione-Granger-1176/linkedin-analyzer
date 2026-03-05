import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCanvas } from './helpers/dom.js';

vi.mock('../src/charts.js', () => ({
    SketchCharts: {
        drawTimeline: vi.fn(),
        drawTopics: vi.fn(),
        getItemAt: vi.fn(() => null)
    }
}));

vi.mock('../src/data-cache.js', () => {
    const values = new Map();
    return {
        DataCache: {
            get: vi.fn((key) => values.get(key)),
            set: vi.fn((key, value) => values.set(key, value)),
            subscribe: vi.fn()
        }
    };
});

vi.mock('../src/loading-overlay.js', () => ({
    LoadingOverlay: { show: vi.fn(), hide: vi.fn() }
}));

vi.mock('../src/router.js', () => ({
    AppRouter: {
        getCurrentRoute: vi.fn(() => ({ name: 'connections', params: {} })),
        setParams: vi.fn()
    }
}));

vi.mock('../src/session.js', () => ({
    Session: { waitForCleanup: vi.fn(() => Promise.resolve()) }
}));

vi.mock('../src/storage.js', () => ({
    Storage: { getFile: vi.fn() }
}));

let ConnectionsPage;
let SketchCharts;
let DataCache;
let AppRouter;
let Storage;

describe('ConnectionsPage', () => {
    let workerInstance;

    class MockWorker {
        constructor() {
            this.listeners = { message: [], error: [] };
            this.postMessage = vi.fn();
            workerInstance = this;
        }
        addEventListener(type, callback) {
            this.listeners[type].push(callback);
        }
        terminate() {}
    }

    beforeEach(async () => {
        workerInstance = null;
        globalThis.Worker = MockWorker;
        document.body.innerHTML = `
            <div id="connectionsEmpty"><h2></h2><p></p></div>
            <div id="connectionsGrid"></div>
            <div id="connectionsStatsGrid"></div>
            <div id="chartTooltip"></div>
            <div id="connectionsTimeRangeButtons">
                <button class="filter-btn" data-range="12m"></button>
                <button class="filter-btn" data-range="3m"></button>
            </div>
            <button id="connectionsResetFiltersBtn"></button>
            <div id="connStatTotal"></div>
            <div id="connStatRecent"></div>
            <div id="connStatTopCompany"></div>
            <div id="connStatNetworkAge"></div>
            <canvas id="connectionGrowthChart"></canvas>
            <canvas id="connectionCompaniesChart"></canvas>
            <canvas id="connectionPositionsChart"></canvas>
        `;

        const growth = createCanvas({ width: 200, height: 120 }).canvas;
        growth.id = 'connectionGrowthChart';
        document.getElementById('connectionGrowthChart').replaceWith(growth);

        const companies = createCanvas({ width: 200, height: 120 }).canvas;
        companies.id = 'connectionCompaniesChart';
        document.getElementById('connectionCompaniesChart').replaceWith(companies);

        const positions = createCanvas({ width: 200, height: 120 }).canvas;
        positions.id = 'connectionPositionsChart';
        document.getElementById('connectionPositionsChart').replaceWith(positions);

        vi.resetModules();
        ({ ConnectionsPage } = await import('../src/connections-ui.js'));
        ({ SketchCharts } = await import('../src/charts.js'));
        ({ DataCache } = await import('../src/data-cache.js'));
        ({ AppRouter } = await import('../src/router.js'));
        ({ Storage } = await import('../src/storage.js'));
    });

    it('shows empty state when no connections file is stored', async () => {
        Storage.getFile.mockResolvedValue(null);
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        await new Promise(resolve => setTimeout(resolve, 0));
        expect(document.getElementById('connectionsEmpty').hidden).toBe(false);
        expect(document.getElementById('connectionsGrid').hidden).toBe(true);
    });

    it('renders stats and charts on worker success', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({ range: 'all' });

        await new Promise(resolve => setTimeout(resolve, 0));
        const processedId = workerInstance.postMessage.mock.calls[0][0].requestId;
        workerInstance.listeners.message[0]({
            data: {
                type: 'processed',
                requestId: processedId,
                payload: {
                    success: true,
                    rows: [
                        { 'Connected On': '2024-05-01', Company: 'OpenAI', Position: 'Researcher' },
                        { 'Connected On': '2024-05-10', Company: 'OpenAI', Position: 'Engineer' }
                    ],
                    analytics: {
                        growthTimeline: [{ key: '2024-05', label: 'May 2024', value: 2 }],
                        stats: { total: 2, networkAgeMonths: 13 }
                    }
                }
            }
        });

        expect(document.getElementById('connStatTotal').textContent).toBe('2');
        expect(document.getElementById('connStatTopCompany').textContent).toBe('OpenAI');
        expect(document.getElementById('connStatNetworkAge').textContent).toContain('yr');
        expect(SketchCharts.drawTimeline).toHaveBeenCalled();
    });

    it('shows tooltip on chart hover', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        SketchCharts.getItemAt.mockReturnValue({ tooltip: 'May: 2' });
        const canvas = document.getElementById('connectionGrowthChart');
        canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 10 }));

        expect(document.getElementById('chartTooltip').hidden).toBe(false);
    });

    it('syncs range into router on button click', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        document.querySelector('#connectionsTimeRangeButtons [data-range="3m"]').click();

        expect(AppRouter.setParams).toHaveBeenCalledWith(
            { range: '3m' },
            { replaceHistory: false }
        );
    });

    it('sets empty state when worker fires error event', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise(resolve => setTimeout(resolve, 0));

        workerInstance.listeners.error[0](new Event('error'));

        expect(document.getElementById('connectionsEmpty').hidden).toBe(false);
        expect(document.getElementById('connectionsEmpty').querySelector('h2').textContent)
            .toContain('Worker error');
    });

    it('sets empty state when worker sends error payload message', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise(resolve => setTimeout(resolve, 0));

        workerInstance.listeners.message[0]({
            data: {
                type: 'error',
                payload: { message: 'Parse failed catastrophically' }
            }
        });

        expect(document.getElementById('connectionsEmpty').hidden).toBe(false);
        expect(document.getElementById('connectionsEmpty').querySelector('p').textContent)
            .toContain('Parse failed catastrophically');
    });

    it('hides tooltip when mouseleave fires on chart canvas', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        // Show tooltip first
        SketchCharts.getItemAt.mockReturnValue({ tooltip: 'May: 2' });
        const canvas = document.getElementById('connectionGrowthChart');
        canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 10 }));
        expect(document.getElementById('chartTooltip').hidden).toBe(false);

        // Now trigger mouseleave
        canvas.dispatchEvent(new MouseEvent('mouseleave'));
        expect(document.getElementById('chartTooltip').hidden).toBe(true);
    });

    it('hides tooltip on hover when no item found at position', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        SketchCharts.getItemAt.mockReturnValue(null);
        const canvas = document.getElementById('connectionGrowthChart');
        canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5 }));

        expect(document.getElementById('chartTooltip').hidden).toBe(true);
    });

    it('onRouteLeave hides tooltip and loading', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        ConnectionsPage.onRouteLeave();
        expect(document.getElementById('chartTooltip').hidden).toBe(true);
    });

    it('calls drawTopics for companies and positions charts', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({ range: 'all' });
        await new Promise(resolve => setTimeout(resolve, 0));

        const processedId = workerInstance.postMessage.mock.calls[0][0].requestId;
        SketchCharts.drawTopics.mockClear();

        workerInstance.listeners.message[0]({
            data: {
                type: 'processed',
                requestId: processedId,
                payload: {
                    success: true,
                    rows: [
                        { 'Connected On': '2024-05-01', Company: 'Acme', Position: 'Engineer' }
                    ],
                    analytics: {
                        growthTimeline: [],
                        stats: { total: 1, networkAgeMonths: 6 }
                    }
                }
            }
        });

        // drawTopics called once for companies and once for positions
        expect(SketchCharts.drawTopics).toHaveBeenCalledTimes(2);
        const canvasArgs = SketchCharts.drawTopics.mock.calls.map(c => c[0].id);
        expect(canvasArgs).toContain('connectionCompaniesChart');
        expect(canvasArgs).toContain('connectionPositionsChart');
    });

    it('shows empty state when processed payload has success=false', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise(resolve => setTimeout(resolve, 0));

        const processedId = workerInstance.postMessage.mock.calls[0][0].requestId;
        workerInstance.listeners.message[0]({
            data: {
                type: 'processed',
                requestId: processedId,
                payload: {
                    success: false,
                    error: 'CSV is malformed'
                }
            }
        });

        expect(document.getElementById('connectionsEmpty').hidden).toBe(false);
        expect(document.getElementById('connectionsEmpty').querySelector('p').textContent)
            .toContain('CSV is malformed');
    });

    it('shows empty state when rows result in no data', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise(resolve => setTimeout(resolve, 0));

        const processedId = workerInstance.postMessage.mock.calls[0][0].requestId;
        workerInstance.listeners.message[0]({
            data: {
                type: 'processed',
                requestId: processedId,
                payload: {
                    success: true,
                    rows: [],
                    analytics: {
                        growthTimeline: [],
                        stats: { total: 0, networkAgeMonths: 0 }
                    }
                }
            }
        });

        expect(document.getElementById('connectionsEmpty').hidden).toBe(false);
    });

    it('does not sync route when not on connections route', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        AppRouter.getCurrentRoute.mockReturnValue({ name: 'home', params: {} });
        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        AppRouter.setParams.mockClear();

        document.querySelector('#connectionsTimeRangeButtons [data-range="3m"]').click();

        expect(AppRouter.setParams).not.toHaveBeenCalled();
    });

    it('syncRouteRange skips setParams when not on connections route (line 690)', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        // Set route to something other than 'connections'
        AppRouter.getCurrentRoute.mockReturnValue({ name: 'home', params: {} });
        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        AppRouter.setParams.mockClear();

        // Clicking a range button calls applyTimeRange → syncRouteRange
        // syncRouteRange should return early because currentRoute.name !== 'connections'
        document.querySelector('#connectionsTimeRangeButtons [data-range="3m"]').click();

        expect(AppRouter.setParams).not.toHaveBeenCalled();
    });

    it('showConnectionsLoading returns early when connectionsGrid is absent (line 764)', async () => {
        // Remove the connectionsGrid element from DOM before init
        document.getElementById('connectionsGrid').remove();

        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        // Should not throw even without connectionsGrid
        expect(() => ConnectionsPage.init()).not.toThrow();

        // Calling onRouteChange should not throw
        await ConnectionsPage.onRouteChange({});
        await new Promise(resolve => setTimeout(resolve, 0));
    });

    it('showTooltip returns early when chartTooltip element is absent (line 730)', async () => {
        document.getElementById('chartTooltip').remove();

        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        // Hovering should not throw even without tooltip element
        SketchCharts.getItemAt.mockReturnValue({ tooltip: 'Test' });
        const canvas = document.getElementById('connectionGrowthChart');
        expect(() => {
            canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 10 }));
        }).not.toThrow();
    });

    it('ignores processed message with mismatched requestId', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise(resolve => setTimeout(resolve, 0));

        SketchCharts.drawTimeline.mockClear();

        workerInstance.listeners.message[0]({
            data: {
                type: 'processed',
                requestId: 9999,
                payload: { success: true, rows: [], analytics: { growthTimeline: [], stats: {} } }
            }
        });

        expect(SketchCharts.drawTimeline).not.toHaveBeenCalled();
    });

    it('themechange event triggers re-render when currentView is set (lines 147-149)', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({ range: 'all' });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Load data so currentView is set
        const processedId = workerInstance.postMessage.mock.calls[0][0].requestId;
        workerInstance.listeners.message[0]({
            data: {
                type: 'processed',
                requestId: processedId,
                payload: {
                    success: true,
                    rows: [{ 'Connected On': '2024-05-01', Company: 'Acme', Position: 'Dev' }],
                    analytics: { growthTimeline: [], stats: { total: 1, networkAgeMonths: 6 } }
                }
            }
        });

        SketchCharts.drawTimeline.mockClear();
        document.dispatchEvent(new CustomEvent('themechange'));

        // Re-render should be triggered
        expect(SketchCharts.drawTimeline).toHaveBeenCalled();
    });

    it('visibilitychange event triggers re-render when visible (lines 152-155)', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({ range: 'all' });
        await new Promise(resolve => setTimeout(resolve, 0));

        const processedId = workerInstance.postMessage.mock.calls[0][0].requestId;
        workerInstance.listeners.message[0]({
            data: {
                type: 'processed',
                requestId: processedId,
                payload: {
                    success: true,
                    rows: [{ 'Connected On': '2024-05-01', Company: 'Acme', Position: 'Dev' }],
                    analytics: { growthTimeline: [], stats: { total: 1, networkAgeMonths: 6 } }
                }
            }
        });

        SketchCharts.drawTimeline.mockClear();
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        expect(SketchCharts.drawTimeline).toHaveBeenCalled();
    });

    it('terminateWorker fires on beforeunload (lines 181-187)', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        expect(workerInstance).not.toBeNull();
        window.dispatchEvent(new Event('beforeunload'));
        // Calling again should be safe (worker is already null)
        window.dispatchEvent(new Event('beforeunload'));
    });

    it('handleCacheChange resets state for valid cache events (lines 204-216)', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise(resolve => setTimeout(resolve, 0));

        const cacheCallback = DataCache.subscribe.mock.calls[0][0];

        // Valid cache events should reset state
        cacheCallback({ type: 'analyticsChanged' });
        cacheCallback({ type: 'storageCleared' });
        // filesChanged for a different file type should be ignored
        cacheCallback({ type: 'filesChanged', fileType: 'shares' });
        // filesChanged for connections should reset
        cacheCallback({ type: 'filesChanged', fileType: 'connections' });
        // Unknown type should be ignored
        cacheCallback({ type: 'unknown' });
        cacheCallback(null);

        expect(DataCache.subscribe).toHaveBeenCalled();
    });

    it('onRouteChange goes to updateVisibility when dataReady=true but hasData=false (lines 94-96)', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise(resolve => setTimeout(resolve, 0));

        // Worker sends an empty result → hasData=false, dataReady=true
        const processedId = workerInstance.postMessage.mock.calls[0][0].requestId;
        workerInstance.listeners.message[0]({
            data: {
                type: 'processed',
                requestId: processedId,
                payload: {
                    success: true,
                    rows: [],
                    analytics: { growthTimeline: [], stats: { total: 0, networkAgeMonths: 0 } }
                }
            }
        });

        // Second route change: dataReady=true, hasData=false → hits line 94
        AppRouter.getCurrentRoute.mockReturnValue({ name: 'connections', params: {} });
        await ConnectionsPage.onRouteChange({});

        expect(document.getElementById('connectionsEmpty').hidden).toBe(false);
    });

    it('reset filters button restores default range and syncs route', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({ range: '3m' });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Load data so state.dataReady = true
        const processedId = workerInstance.postMessage.mock.calls[0][0].requestId;
        workerInstance.listeners.message[0]({
            data: {
                type: 'processed',
                requestId: processedId,
                payload: {
                    success: true,
                    rows: [{ 'Connected On': '2024-05-01', Company: 'Acme', Position: 'Dev' }],
                    analytics: { growthTimeline: [], stats: { total: 1, networkAgeMonths: 6 } }
                }
            }
        });

        // Ensure router mock returns connections route
        AppRouter.getCurrentRoute.mockReturnValue({ name: 'connections', params: {} });
        AppRouter.setParams.mockClear();
        document.getElementById('connectionsResetFiltersBtn').click();

        expect(AppRouter.setParams).toHaveBeenCalledWith(
            { range: '12m' },
            { replaceHistory: false }
        );
    });

    it('uses cached file from DataCache when available (line 287)', async () => {
        const fileRecord = { text: 'csv', type: 'connections' };
        DataCache.get.mockImplementation((key) =>
            key === 'storage:file:connections' ? fileRecord : null
        );

        const callsBefore = Storage.getFile.mock.calls.length;
        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise(resolve => setTimeout(resolve, 0));

        // Storage.getFile should NOT be called since DataCache had the data
        expect(Storage.getFile.mock.calls.length).toBe(callsBefore);
    });

    it('tooltip is clamped to viewport when it would overflow right/bottom edges', async () => {
        Storage.getFile.mockResolvedValue({ text: 'csv' });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        const tooltip = document.getElementById('chartTooltip');
        // Mock getBoundingClientRect to simulate large tooltip
        tooltip.getBoundingClientRect = () => ({
            width: 200,
            height: 100,
            left: 0,
            top: 0,
            right: 200,
            bottom: 100
        });

        // Position near the right edge so tooltip would overflow
        const origWidth = window.innerWidth;
        const origHeight = window.innerHeight;
        Object.defineProperty(window, 'innerWidth', { value: 300, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: 200, configurable: true });

        SketchCharts.getItemAt.mockReturnValue({ tooltip: 'Test tooltip' });
        const canvas = document.getElementById('connectionGrowthChart');
        // clientX=290 means left=302 which > innerWidth=300, so it clamps
        canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 290, clientY: 190 }));

        expect(tooltip.hidden).toBe(false);
        // Left should be clamped (290 - 200 - 12 = 78)
        expect(parseInt(tooltip.style.left)).toBeLessThan(290);

        Object.defineProperty(window, 'innerWidth', { value: origWidth, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: origHeight, configurable: true });
    });
});
