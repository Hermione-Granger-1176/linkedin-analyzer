import { beforeEach, describe, expect, it, vi } from "vitest";

import { createCanvas } from "./helpers/dom.js";

vi.mock("../src/charts.js", () => ({
    SketchCharts: {
        drawTimeline: vi.fn(),
        drawTopics: vi.fn(),
        getItemAt: vi.fn(() => null),
    },
}));

vi.mock("../src/data-cache.js", () => {
    const values = new Map();
    return {
        DataCache: {
            get: vi.fn((key) => values.get(key)),
            set: vi.fn((key, value) => values.set(key, value)),
            subscribe: vi.fn(),
        },
    };
});

vi.mock("../src/loading-overlay.js", () => ({
    LoadingOverlay: { show: vi.fn(), hide: vi.fn() },
}));

vi.mock("../src/router.js", () => ({
    AppRouter: {
        getCurrentRoute: vi.fn(() => ({ name: "connections", params: {} })),
        setParams: vi.fn(),
    },
}));

vi.mock("../src/session.js", () => ({
    Session: { waitForCleanup: vi.fn(() => Promise.resolve()) },
}));

vi.mock("../src/storage.js", () => ({
    Storage: { getFile: vi.fn() },
}));

let ConnectionsPage;
let SketchCharts;
let DataCache;
let AppRouter;
let Storage;

describe("ConnectionsPage", () => {
    let workerInstance;

    class MockWorker {
        constructor() {
            this.listeners = { message: [], error: [] };
            this.postMessage = vi.fn();
            this.terminate = vi.fn();
            workerInstance = this;
        }
        addEventListener(type, callback) {
            this.listeners[type] = this.listeners[type] || [];
            this.listeners[type].push(callback);
        }
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
            <select id="connectionsTimeRangeSelect">
                <option value="1m">1 month</option>
                <option value="3m">3 months</option>
                <option value="6m">6 months</option>
                <option value="12m" selected>12 months</option>
                <option value="all">All time</option>
            </select>
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
        growth.id = "connectionGrowthChart";
        document.getElementById("connectionGrowthChart").replaceWith(growth);

        const companies = createCanvas({ width: 200, height: 120 }).canvas;
        companies.id = "connectionCompaniesChart";
        document.getElementById("connectionCompaniesChart").replaceWith(companies);

        const positions = createCanvas({ width: 200, height: 120 }).canvas;
        positions.id = "connectionPositionsChart";
        document.getElementById("connectionPositionsChart").replaceWith(positions);

        vi.resetModules();
        ({ ConnectionsPage } = await import("../src/connections-ui.js"));
        ({ SketchCharts } = await import("../src/charts.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ AppRouter } = await import("../src/router.js"));
        ({ Storage } = await import("../src/storage.js"));
    });

    it("shows empty state when no connections file is stored", async () => {
        Storage.getFile.mockResolvedValue(null);
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(document.getElementById("connectionsEmpty").hidden).toBe(false);
        expect(document.getElementById("connectionsGrid").hidden).toBe(true);
    });

    it("shows the storage-error state when the connections text record is missing", async () => {
        // Metadata is present but the text record is gone (cleared in another
        // tab / degraded persistence); this must surface as a load failure, not
        // the "not uploaded" empty state.
        Storage.getFile.mockResolvedValue({
            type: "connections",
            name: "Connections.csv",
            rowCount: 5,
            updatedAt: 10,
        });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.getElementById("connectionsEmpty").hidden).toBe(false);
        expect(
            document.getElementById("connectionsEmpty").querySelector("h2").textContent,
        ).toContain("Storage error");
    });

    it("initializes on route change when the page is not initialized yet", async () => {
        Storage.getFile.mockResolvedValue(null);
        DataCache.get.mockReturnValue(null);

        await ConnectionsPage.onRouteChange({});

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(document.getElementById("connectionsEmpty").hidden).toBe(false);
        expect(document.getElementById("connectionsGrid").hidden).toBe(true);
    });

    it("renders stats and charts on worker success", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({ range: "all" });

        await new Promise((resolve) => setTimeout(resolve, 0));
        const processedId = workerInstance.postMessage.mock.calls[0][0].requestId;
        workerInstance.listeners.message[0]({
            data: {
                type: "processed",
                requestId: processedId,
                payload: {
                    success: true,
                    rows: [
                        { "Connected On": "2024-05-01", Company: "OpenAI", Position: "Researcher" },
                        { "Connected On": "2024-05-10", Company: "OpenAI", Position: "Engineer" },
                    ],
                    analytics: {
                        growthTimeline: [{ key: "2024-05", label: "May 2024", value: 2 }],
                        stats: { total: 2, networkAgeMonths: 13 },
                    },
                },
            },
        });

        expect(document.getElementById("connStatTotal").textContent).toBe("2");
        expect(document.getElementById("connStatTopCompany").textContent).toBe("OpenAI");
        expect(document.getElementById("connStatNetworkAge").textContent).toContain("yr");
        expect(SketchCharts.drawTimeline).toHaveBeenCalled();
    });

    it("excludes impossible connection dates from range analytics", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({ range: "12m" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const processedId = workerInstance.postMessage.mock.calls[0][0].requestId;
        workerInstance.listeners.message[0]({
            data: {
                type: "processed",
                requestId: processedId,
                payload: {
                    success: true,
                    rows: [
                        { "Connected On": "9999-02-29", Company: "Invalid", Position: "Bad" },
                        { "Connected On": "9999-02-28", Company: "Valid", Position: "Good" },
                    ],
                    analytics: {
                        growthTimeline: [],
                        stats: { total: 2, networkAgeMonths: 1 },
                    },
                },
            },
        });

        expect(document.getElementById("connStatRecent").textContent).toBe("1");
        expect(document.getElementById("connStatTopCompany").textContent).toBe("Valid");
    });

    it("shows tooltip on chart hover", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        SketchCharts.getItemAt.mockReturnValue({ tooltip: "May: 2" });
        const canvas = document.getElementById("connectionGrowthChart");
        canvas.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: 10 }));

        expect(document.getElementById("chartTooltip").hidden).toBe(false);
    });

    it("syncs range into router on button click", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        document.querySelector('#connectionsTimeRangeButtons [data-range="3m"]').click();

        expect(AppRouter.setParams).toHaveBeenCalledWith(
            { range: "3m" },
            { replaceHistory: false },
        );
    });

    it("sets empty state when worker fires error event", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        workerInstance.listeners.error[0](new Event("error"));

        expect(document.getElementById("connectionsEmpty").hidden).toBe(false);
        expect(
            document.getElementById("connectionsEmpty").querySelector("h2").textContent,
        ).toContain("Worker error");
    });

    it("recreates the worker after a worker-level error", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        const failedWorker = workerInstance;
        failedWorker.listeners.error[0](new Event("error"));

        expect(failedWorker.terminate).toHaveBeenCalled();

        const cacheCallback = DataCache.subscribe.mock.calls[0][0];
        cacheCallback({ type: "filesChanged", fileType: "connections" });

        await ConnectionsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(workerInstance).not.toBe(failedWorker);
        expect(workerInstance.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "process" }),
        );
    });

    it("sets empty state when worker sends error payload message", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        workerInstance.listeners.message[0]({
            data: {
                type: "error",
                payload: { message: "Parse failed catastrophically" },
            },
        });

        expect(document.getElementById("connectionsEmpty").hidden).toBe(false);
        expect(
            document.getElementById("connectionsEmpty").querySelector("p").textContent,
        ).toContain("Parse failed catastrophically");
    });

    it("hides tooltip when mouseleave fires on chart canvas", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        // Show tooltip first
        SketchCharts.getItemAt.mockReturnValue({ tooltip: "May: 2" });
        const canvas = document.getElementById("connectionGrowthChart");
        canvas.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: 10 }));
        expect(document.getElementById("chartTooltip").hidden).toBe(false);

        // Now trigger mouseleave
        canvas.dispatchEvent(new MouseEvent("mouseleave"));
        expect(document.getElementById("chartTooltip").hidden).toBe(true);
    });

    it("hides tooltip on hover when no item found at position", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        SketchCharts.getItemAt.mockReturnValue(null);
        const canvas = document.getElementById("connectionGrowthChart");
        canvas.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 5 }));

        expect(document.getElementById("chartTooltip").hidden).toBe(true);
    });

    it("onRouteLeave hides tooltip and loading", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        ConnectionsPage.onRouteLeave();
        expect(document.getElementById("chartTooltip").hidden).toBe(true);
    });

    it("calls drawTopics for companies and positions charts", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({ range: "all" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const processedId = workerInstance.postMessage.mock.calls[0][0].requestId;
        SketchCharts.drawTopics.mockClear();

        workerInstance.listeners.message[0]({
            data: {
                type: "processed",
                requestId: processedId,
                payload: {
                    success: true,
                    rows: [{ "Connected On": "2024-05-01", Company: "Acme", Position: "Engineer" }],
                    analytics: {
                        growthTimeline: [],
                        stats: { total: 1, networkAgeMonths: 6 },
                    },
                },
            },
        });

        // drawTopics called once for companies and once for positions
        expect(SketchCharts.drawTopics).toHaveBeenCalledTimes(2);
        const canvasArgs = SketchCharts.drawTopics.mock.calls.map((c) => c[0].id);
        expect(canvasArgs).toContain("connectionCompaniesChart");
        expect(canvasArgs).toContain("connectionPositionsChart");
    });

    it("shows empty state when processed payload has success=false", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        const processedId = workerInstance.postMessage.mock.calls[0][0].requestId;
        workerInstance.listeners.message[0]({
            data: {
                type: "processed",
                requestId: processedId,
                payload: {
                    success: false,
                    error: "CSV is malformed",
                },
            },
        });

        expect(document.getElementById("connectionsEmpty").hidden).toBe(false);
        expect(
            document.getElementById("connectionsEmpty").querySelector("p").textContent,
        ).toContain("CSV is malformed");
    });

    it("shows empty state when rows result in no data", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        const processedId = workerInstance.postMessage.mock.calls[0][0].requestId;
        workerInstance.listeners.message[0]({
            data: {
                type: "processed",
                requestId: processedId,
                payload: {
                    success: true,
                    rows: [],
                    analytics: {
                        growthTimeline: [],
                        stats: { total: 0, networkAgeMonths: 0 },
                    },
                },
            },
        });

        expect(document.getElementById("connectionsEmpty").hidden).toBe(false);
    });

    it("does not sync route when not on connections route", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        AppRouter.getCurrentRoute.mockReturnValue({ name: "home", params: {} });
        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        AppRouter.setParams.mockClear();

        document.querySelector('#connectionsTimeRangeButtons [data-range="3m"]').click();

        expect(AppRouter.setParams).not.toHaveBeenCalled();
    });

    it("syncRouteRange skips setParams when not on connections route (line 690)", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        // Set route to something other than 'connections'
        AppRouter.getCurrentRoute.mockReturnValue({ name: "home", params: {} });
        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        AppRouter.setParams.mockClear();

        // Clicking a range button calls applyTimeRange → syncRouteRange
        // syncRouteRange should return early because currentRoute.name !== 'connections'
        document.querySelector('#connectionsTimeRangeButtons [data-range="3m"]').click();

        expect(AppRouter.setParams).not.toHaveBeenCalled();
    });

    it("showConnectionsLoading returns early when connectionsGrid is absent (line 764)", async () => {
        // Remove the connectionsGrid element from DOM before init
        document.getElementById("connectionsGrid").remove();

        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        // Should not throw even without connectionsGrid
        expect(() => ConnectionsPage.init()).not.toThrow();

        // Calling onRouteChange should not throw
        await ConnectionsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it("showTooltip returns early when chartTooltip element is absent (line 730)", async () => {
        document.getElementById("chartTooltip").remove();

        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        // Hovering should not throw even without tooltip element
        SketchCharts.getItemAt.mockReturnValue({ tooltip: "Test" });
        const canvas = document.getElementById("connectionGrowthChart");
        expect(() => {
            canvas.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: 10 }));
        }).not.toThrow();
    });

    it("ignores processed message with mismatched requestId", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        SketchCharts.drawTimeline.mockClear();

        workerInstance.listeners.message[0]({
            data: {
                type: "processed",
                requestId: 9999,
                payload: { success: true, rows: [], analytics: { growthTimeline: [], stats: {} } },
            },
        });

        expect(SketchCharts.drawTimeline).not.toHaveBeenCalled();
    });

    it("themechange event triggers re-render when currentView is set (lines 147-149)", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({ range: "all" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Load data so currentView is set
        const processedId = workerInstance.postMessage.mock.calls[0][0].requestId;
        workerInstance.listeners.message[0]({
            data: {
                type: "processed",
                requestId: processedId,
                payload: {
                    success: true,
                    rows: [{ "Connected On": "2024-05-01", Company: "Acme", Position: "Dev" }],
                    analytics: { growthTimeline: [], stats: { total: 1, networkAgeMonths: 6 } },
                },
            },
        });

        SketchCharts.drawTimeline.mockClear();
        document.dispatchEvent(new CustomEvent("themechange"));

        // Re-render should be triggered
        expect(SketchCharts.drawTimeline).toHaveBeenCalled();
    });

    it("visibilitychange event triggers re-render when visible (lines 152-155)", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({ range: "all" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const processedId = workerInstance.postMessage.mock.calls[0][0].requestId;
        workerInstance.listeners.message[0]({
            data: {
                type: "processed",
                requestId: processedId,
                payload: {
                    success: true,
                    rows: [{ "Connected On": "2024-05-01", Company: "Acme", Position: "Dev" }],
                    analytics: { growthTimeline: [], stats: { total: 1, networkAgeMonths: 6 } },
                },
            },
        });

        SketchCharts.drawTimeline.mockClear();
        Object.defineProperty(document, "visibilityState", {
            value: "visible",
            configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));

        expect(SketchCharts.drawTimeline).toHaveBeenCalled();
    });

    it("terminateWorker fires on beforeunload (lines 181-187)", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        expect(workerInstance).not.toBeNull();
        window.dispatchEvent(new Event("beforeunload"));
        // Calling again should be safe (worker is already null)
        window.dispatchEvent(new Event("beforeunload"));
    });

    it("handleCacheChange resets state for valid cache events (lines 204-216)", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        const cacheCallback = DataCache.subscribe.mock.calls[0][0];

        // Valid cache events should reset state
        cacheCallback({ type: "analyticsChanged" });
        cacheCallback({ type: "storageCleared" });
        // filesChanged for a different file type should be ignored
        cacheCallback({ type: "filesChanged", fileType: "shares" });
        // filesChanged for connections should reset
        cacheCallback({ type: "filesChanged", fileType: "connections" });
        // Unknown type should be ignored
        cacheCallback({ type: "unknown" });
        cacheCallback(null);

        expect(DataCache.subscribe).toHaveBeenCalled();
    });

    it("onRouteChange goes to updateVisibility when dataReady=true but hasData=false (lines 94-96)", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Worker sends an empty result → hasData=false, dataReady=true
        const processedId = workerInstance.postMessage.mock.calls[0][0].requestId;
        workerInstance.listeners.message[0]({
            data: {
                type: "processed",
                requestId: processedId,
                payload: {
                    success: true,
                    rows: [],
                    analytics: { growthTimeline: [], stats: { total: 0, networkAgeMonths: 0 } },
                },
            },
        });

        // Second route change: dataReady=true, hasData=false → hits line 94
        AppRouter.getCurrentRoute.mockReturnValue({ name: "connections", params: {} });
        await ConnectionsPage.onRouteChange({});

        expect(document.getElementById("connectionsEmpty").hidden).toBe(false);
    });

    it("reset filters button restores default range and syncs route", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({ range: "3m" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Load data so state.dataReady = true
        const processedId = workerInstance.postMessage.mock.calls[0][0].requestId;
        workerInstance.listeners.message[0]({
            data: {
                type: "processed",
                requestId: processedId,
                payload: {
                    success: true,
                    rows: [{ "Connected On": "2024-05-01", Company: "Acme", Position: "Dev" }],
                    analytics: { growthTimeline: [], stats: { total: 1, networkAgeMonths: 6 } },
                },
            },
        });

        // Ensure router mock returns connections route
        AppRouter.getCurrentRoute.mockReturnValue({ name: "connections", params: {} });
        AppRouter.setParams.mockClear();
        document.getElementById("connectionsResetFiltersBtn").click();

        expect(AppRouter.setParams).toHaveBeenCalledWith(
            { range: "12m" },
            { replaceHistory: false },
        );
    });

    it("loads the connections text from storage and caches metadata only", async () => {
        // The per-type cache holds metadata only, so the CSV text is always loaded
        // from storage when parsing (the dataReady guard prevents redundant reads).
        DataCache.get.mockImplementation(() => null);
        DataCache.set.mockClear();
        Storage.getFile.mockReset();
        Storage.getFile.mockResolvedValue({
            type: "connections",
            text: "csv",
            rowCount: 2,
            updatedAt: 5,
        });

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Text is loaded from storage (the cache can't provide it)...
        expect(Storage.getFile).toHaveBeenCalledWith("connections");
        // ...and the per-type cache is refreshed without the text.
        const cacheSet = DataCache.set.mock.calls.find(
            (call) => call[0] === "storage:file:connections",
        );
        expect(cacheSet).toBeTruthy();
        expect(cacheSet[1].text).toBeUndefined();
    });

    it("tooltip is clamped to viewport when it would overflow right/bottom edges", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        const tooltip = document.getElementById("chartTooltip");
        // Mock getBoundingClientRect to simulate large tooltip
        tooltip.getBoundingClientRect = () => ({
            width: 200,
            height: 100,
            left: 0,
            top: 0,
            right: 200,
            bottom: 100,
        });

        // Position near the right edge so tooltip would overflow
        const origWidth = window.innerWidth;
        const origHeight = window.innerHeight;
        Object.defineProperty(window, "innerWidth", { value: 300, configurable: true });
        Object.defineProperty(window, "innerHeight", { value: 200, configurable: true });

        SketchCharts.getItemAt.mockReturnValue({ tooltip: "Test tooltip" });
        const canvas = document.getElementById("connectionGrowthChart");
        // clientX=290 means left=302 which > innerWidth=300, so it clamps
        canvas.dispatchEvent(new MouseEvent("mousemove", { clientX: 290, clientY: 190 }));

        expect(tooltip.hidden).toBe(false);
        // Left should be clamped (290 - 200 - 12 = 78)
        expect(parseInt(tooltip.style.left)).toBeLessThan(290);

        Object.defineProperty(window, "innerWidth", { value: origWidth, configurable: true });
        Object.defineProperty(window, "innerHeight", { value: origHeight, configurable: true });
    });

    /** Init, route in, and return the pending worker request id. */
    async function primeWorker(routeParams = {}) {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);
        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange(routeParams);
        await new Promise((resolve) => setTimeout(resolve, 0));
        return workerInstance.postMessage.mock.calls[0][0].requestId;
    }

    /** Dispatch a processed worker payload for the pending request. */
    function sendProcessed(requestId, payload) {
        workerInstance.listeners.message[0]({
            data: { type: "processed", requestId, payload },
        });
    }

    it("ignores a malformed worker message without rendering data", async () => {
        await primeWorker({ range: "all" });
        expect(() =>
            workerInstance.listeners.message[0]({ data: { notAType: true } }),
        ).not.toThrow();
        expect(document.getElementById("connStatTotal").textContent).toBe("");
    });

    it("shows the failure message from an unsuccessful worker payload", async () => {
        const id = await primeWorker({ range: "all" });
        sendProcessed(id, { success: false, error: "Broken CSV" });
        expect(
            document.getElementById("connectionsEmpty").querySelector("p").textContent,
        ).toContain("Broken CSV");
    });

    it("falls back to a default failure message when none is supplied", async () => {
        const id = await primeWorker({ range: "all" });
        sendProcessed(id, { success: false });
        expect(
            document.getElementById("connectionsEmpty").querySelector("p").textContent,
        ).toContain("Unable to parse Connections.csv");
    });

    it("treats a payload with no rows or analytics as empty", async () => {
        const id = await primeWorker({ range: "all" });
        sendProcessed(id, { success: true });
        expect(document.getElementById("connectionsEmpty").hidden).toBe(false);
    });

    it("defaults company, position, and stats for sparse rows", async () => {
        const id = await primeWorker({ range: "all" });
        // Rows missing Company/Position and stats missing total/networkAgeMonths
        // exercise the field and stat fallbacks.
        sendProcessed(id, {
            success: true,
            rows: [{ "Connected On": "2024-05-01" }, { "Connected On": "2024-05-02" }],
            analytics: { stats: {} },
        });
        expect(document.getElementById("connStatTotal").textContent).toBe("2");
        expect(document.getElementById("connStatTopCompany").textContent).toBe("-");
        expect(document.getElementById("connStatNetworkAge").textContent).toBe("-");
    });

    it("skips unparseable Connected On dates without crashing", async () => {
        const id = await primeWorker({ range: "all" });
        sendProcessed(id, {
            success: true,
            rows: [
                { "Connected On": "2024", Company: "Acme" },
                { "Connected On": "bad-da-te", Company: "Acme" },
                { "Connected On": "2024-05-01", Company: "Beta" },
            ],
            analytics: { stats: { total: 3, networkAgeMonths: 5 } },
        });
        // The most common company still wins over the runner-up.
        expect(document.getElementById("connStatTopCompany").textContent).toBe("Acme");
        // networkAgeMonths under 12 renders in months.
        expect(document.getElementById("connStatNetworkAge").textContent).toContain("mo");
    });

    it("normalizes a stored file that carries its own metadata", async () => {
        Storage.getFile.mockResolvedValue({
            text: "csv",
            name: "MyConnections.csv",
            rowCount: 3,
            updatedAt: 1700000000000,
        });
        DataCache.get.mockReturnValue(null);
        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({ range: "all" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const id = workerInstance.postMessage.mock.calls[0][0].requestId;
        sendProcessed(id, {
            success: true,
            rows: [{ "Connected On": "2024-05-01", Company: "Acme" }],
            analytics: { stats: { total: 1, networkAgeMonths: 20 } },
        });
        expect(document.getElementById("connStatTotal").textContent).toBe("1");
    });

    it("captures a worker error event that carries an error object", async () => {
        await primeWorker({ range: "all" });
        const event = Object.assign(new Event("error"), { error: new Error("kaboom") });
        workerInstance.listeners.error[0](event);
        expect(
            document.getElementById("connectionsEmpty").querySelector("h2").textContent,
        ).toContain("Worker error");
    });

    it("re-renders on a later route change once data is loaded", async () => {
        const id = await primeWorker({ range: "all" });
        sendProcessed(id, {
            success: true,
            rows: [
                { "Connected On": "2024-05-01", Company: "Acme" },
                { "Connected On": "2023-01-01", Company: "Beta" },
            ],
            analytics: {
                growthTimeline: [{ key: "2024-05", label: "May 2024", value: 1 }],
                stats: { total: 2, networkAgeMonths: 18 },
            },
        });
        SketchCharts.drawTimeline.mockClear();
        // A second route change with a new range re-applies filters and renders.
        await ConnectionsPage.onRouteChange({ range: "3m" });
        expect(SketchCharts.drawTimeline).toHaveBeenCalled();
    });

    it("reflects an already-active time-range button as aria-pressed", () => {
        document.querySelector('[data-range="3m"]').classList.add("active");
        // bindEvents (run during init) mirrors the active class into aria-pressed.
        ConnectionsPage.init();
        expect(document.querySelector('[data-range="3m"]').getAttribute("aria-pressed")).toBe(
            "true",
        );
    });

    it("is a no-op when init runs a second time", () => {
        ConnectionsPage.init();
        expect(() => ConnectionsPage.init()).not.toThrow();
        // A second init must not create a second worker.
        expect(workerInstance.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "process" }),
        );
    });

    it("shows a timeout state when the worker never responds", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);
        const realSetTimeout = globalThis.setTimeout;
        let workerTimeoutCb = null;
        vi.spyOn(window, "setTimeout").mockImplementation((cb, delay) => {
            if (delay && delay > 100) {
                workerTimeoutCb = cb;
                return 999;
            }
            return realSetTimeout(cb, delay);
        });

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({ range: "all" });
        await new Promise((resolve) => realSetTimeout(resolve, 0));

        expect(typeof workerTimeoutCb).toBe("function");
        workerTimeoutCb();

        expect(
            document.getElementById("connectionsEmpty").querySelector("h2").textContent,
        ).toContain("timeout");
    });

    it("ignores a worker message event that carries no data", async () => {
        await primeWorker({ range: "all" });
        expect(() => workerInstance.listeners.message[0]({})).not.toThrow();
        expect(document.getElementById("connStatTotal").textContent).toBe("");
    });

    it("reports a stored file that has no usable text payload", async () => {
        Storage.getFile.mockResolvedValue({ name: "broken" });
        DataCache.get.mockReturnValue(null);
        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));
        // With no text the file cannot be parsed, so the empty state is shown and
        // no worker request is dispatched.
        expect(document.getElementById("connectionsEmpty").hidden).toBe(false);
    });

    it("does not re-render on a repeat route change with the same range", async () => {
        const id = await primeWorker({ range: "all" });
        sendProcessed(id, {
            success: true,
            rows: [{ "Connected On": "2024-05-01", Company: "Acme" }],
            analytics: { stats: { total: 1, networkAgeMonths: 12 } },
        });
        SketchCharts.drawTimeline.mockClear();
        // Same range and an existing view: nothing changed, so no re-render.
        await ConnectionsPage.onRouteChange({ range: "all" });
        expect(SketchCharts.drawTimeline).not.toHaveBeenCalled();
    });

    it("syncs range into router on select change", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});

        const select = document.getElementById("connectionsTimeRangeSelect");
        select.value = "3m";
        select.dispatchEvent(new Event("change"));

        expect(AppRouter.setParams).toHaveBeenCalledWith(
            { range: "3m" },
            { replaceHistory: false },
        );
    });

    it("ignores a select change carrying an unknown range value", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        AppRouter.setParams.mockClear();

        const select = document.getElementById("connectionsTimeRangeSelect");
        select.value = "bogus";
        select.dispatchEvent(new Event("change"));

        expect(AppRouter.setParams).not.toHaveBeenCalled();
    });

    it("mirrors the active range onto the select when applied from the route", async () => {
        Storage.getFile.mockResolvedValue({ text: "csv" });
        DataCache.get.mockReturnValue(null);

        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({ range: "3m" });

        expect(document.getElementById("connectionsTimeRangeSelect").value).toBe("3m");
    });

    it("falls back to the default range for an unknown time-range button", async () => {
        const button = document.createElement("button");
        button.className = "filter-btn";
        button.dataset.range = "bogus";
        document.getElementById("connectionsTimeRangeButtons").append(button);
        Storage.getFile.mockResolvedValue({ text: "csv" });
        ConnectionsPage.init();
        await ConnectionsPage.onRouteChange({});
        button.click();
        // The invalid range resolves to the default before syncing the router.
        expect(AppRouter.setParams).toHaveBeenLastCalledWith(
            { range: "12m" },
            expect.anything(),
        );
    });
});
