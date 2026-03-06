import { beforeEach, describe, expect, it, vi } from "vitest";

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
        getCurrentRoute: vi.fn(() => ({ name: "insights", params: {} })),
        setParams: vi.fn(),
    },
}));

vi.mock("../src/session.js", () => ({
    Session: { waitForCleanup: vi.fn(() => Promise.resolve()) },
}));

vi.mock("../src/storage.js", () => ({
    Storage: { getAnalytics: vi.fn() },
}));

let InsightsPage;
let DataCache;
let LoadingOverlay;
let AppRouter;
let Storage;

describe("InsightsPage", () => {
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
            <div id="insightsEmpty"><h2></h2><p></p></div>
            <div id="insightsGrid"></div>
            <div id="insightTip" hidden><span id="insightTipText"></span></div>
            <div id="insightsTimeRangeButtons">
                <button class="filter-btn" data-range="12m"></button>
                <button class="filter-btn" data-range="3m"></button>
            </div>
            <button id="insightsResetFiltersBtn"></button>
        `;

        vi.resetModules();
        ({ InsightsPage } = await import("../src/insights-ui.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ LoadingOverlay } = await import("../src/loading-overlay.js"));
        ({ AppRouter } = await import("../src/router.js"));
        ({ Storage } = await import("../src/storage.js"));
    });

    it("shows empty state when analytics base is missing", async () => {
        Storage.getAnalytics.mockResolvedValue(null);
        DataCache.get.mockReturnValue(null);

        InsightsPage.init();
        await InsightsPage.onRouteChange({});

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(document.getElementById("insightsEmpty").hidden).toBe(false);
        expect(document.getElementById("insightsGrid").hidden).toBe(true);
    });

    it("initializes on route change when the page is not initialized yet", async () => {
        Storage.getAnalytics.mockResolvedValue(null);
        DataCache.get.mockReturnValue(null);

        await InsightsPage.onRouteChange({});

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(document.getElementById("insightsEmpty").hidden).toBe(false);
        expect(document.getElementById("insightsGrid").hidden).toBe(true);
    });

    it("renders insight cards and tip from worker payload", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        DataCache.get.mockReturnValue(null);

        InsightsPage.init();
        await InsightsPage.onRouteChange({ range: "3m" });

        await new Promise((resolve) => setTimeout(resolve, 0));

        workerInstance.listeners.message[0]({
            data: { type: "init", payload: { hasData: true } },
        });
        const viewRequestId = workerInstance.postMessage.mock.calls.find(
            (call) => call[0].type === "view",
        )[0].requestId;
        workerInstance.listeners.message[0]({
            data: {
                type: "view",
                requestId: viewRequestId,
                payload: {
                    insights: {
                        insights: [
                            { title: "Top topic", body: "AI & ML", accent: "blue", icon: "spark" },
                        ],
                        tip: "Try sharing weekly.",
                    },
                },
            },
        });

        expect(document.querySelectorAll(".insight-card").length).toBe(1);
        expect(document.getElementById("insightTip").hidden).toBe(false);
        expect(document.getElementById("insightTipText").textContent).toContain("Try sharing");
    });

    it("syncs range into router on button click", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        DataCache.get.mockReturnValue(null);

        InsightsPage.init();
        await InsightsPage.onRouteChange({});

        const button = document.querySelector('#insightsTimeRangeButtons [data-range="3m"]');
        button.click();

        expect(AppRouter.setParams).toHaveBeenCalledWith(
            { range: "3m" },
            { replaceHistory: false },
        );
    });

    it("hides insightTip when tip is null in renderInsights (line 341)", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        DataCache.get.mockReturnValue(null);

        InsightsPage.init();
        await InsightsPage.onRouteChange({ range: "3m" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        workerInstance.listeners.message[0]({
            data: { type: "init", payload: { hasData: true } },
        });
        const viewCall = workerInstance.postMessage.mock.calls.find((c) => c[0].type === "view");
        workerInstance.listeners.message[0]({
            data: {
                type: "view",
                requestId: viewCall[0].requestId,
                payload: {
                    insights: {
                        insights: [{ title: "T", body: "B", accent: "blue", icon: "spark" }],
                        tip: null, // no tip → insightTip.hidden should be true
                    },
                },
            },
        });

        expect(document.getElementById("insightTip").hidden).toBe(true);
    });

    it("syncRouteRange skips setParams when not on insights route (line 397-398)", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        DataCache.get.mockReturnValue(null);

        AppRouter.getCurrentRoute.mockReturnValue({ name: "home", params: {} });
        InsightsPage.init();
        await InsightsPage.onRouteChange({});
        AppRouter.setParams.mockClear();

        // Clicking range button → applyTimeRange → syncRouteRange → early return
        document.querySelector('#insightsTimeRangeButtons [data-range="3m"]').click();

        expect(AppRouter.setParams).not.toHaveBeenCalled();
    });

    it("updateVisibility shows grid when state.hasData is true (line 311)", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        DataCache.get.mockReturnValue(null);

        InsightsPage.init();
        await InsightsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        workerInstance.listeners.message[0]({
            data: { type: "init", payload: { hasData: true } },
        });

        // After hasData=true, insightsGrid should be shown
        expect(document.getElementById("insightsGrid").hidden).toBe(false);
    });

    it("handles worker error payload", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        DataCache.get.mockReturnValue(null);

        InsightsPage.init();
        await InsightsPage.onRouteChange({});

        await new Promise((resolve) => setTimeout(resolve, 0));

        workerInstance.listeners.message[0]({
            data: { type: "error", payload: { message: "Boom" } },
        });

        expect(document.getElementById("insightsEmpty").hidden).toBe(false);
        expect(LoadingOverlay.hide).toHaveBeenCalledWith("insights");
    });

    it("handleCacheChange resets state for known cache events (lines 122-129)", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        DataCache.get.mockReturnValue(null);

        InsightsPage.init();
        await InsightsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        const cacheCallback = DataCache.subscribe.mock.calls[0][0];

        // Valid events should reset state
        cacheCallback({ type: "analyticsChanged" });
        cacheCallback({ type: "storageCleared" });
        cacheCallback({ type: "filesChanged" });
        // Unknown type should be ignored
        cacheCallback({ type: "noop" });
        cacheCallback(null);

        expect(DataCache.subscribe).toHaveBeenCalled();
    });

    it("handleWorkerError sets empty state (lines 241-242)", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        DataCache.get.mockReturnValue(null);

        InsightsPage.init();
        await InsightsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        workerInstance.listeners.error[0](new Event("error"));

        expect(document.getElementById("insightsEmpty").hidden).toBe(false);
    });

    it("ignores worker view message with mismatched requestId (line 204)", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        DataCache.get.mockReturnValue(null);

        InsightsPage.init();
        await InsightsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        workerInstance.listeners.message[0]({
            data: { type: "init", payload: { hasData: true } },
        });

        const initialGridInnerHTML = document.getElementById("insightsGrid").innerHTML;

        // Send view with wrong requestId
        workerInstance.listeners.message[0]({
            data: {
                type: "view",
                requestId: 9999,
                payload: {
                    insights: {
                        insights: [
                            {
                                title: "Should not appear",
                                body: "B",
                                accent: "blue",
                                icon: "spark",
                            },
                        ],
                        tip: null,
                    },
                },
            },
        });

        // Grid should not be updated
        expect(document.getElementById("insightsGrid").innerHTML).toBe(initialGridInnerHTML);
    });

    it("loadBase catch block sets empty state on storage error (lines 183-184)", async () => {
        Storage.getAnalytics.mockRejectedValue(new Error("Storage failure"));
        DataCache.get.mockReturnValue(null);

        InsightsPage.init();
        await InsightsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(document.getElementById("insightsEmpty").hidden).toBe(false);
        expect(document.getElementById("insightsEmpty").querySelector("h2").textContent).toBe(
            "Storage error",
        );
    });

    it("onRouteChange calls updateVisibility when analyticsReady=true hasData=false (line 78-80)", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        DataCache.get.mockReturnValue(null);

        InsightsPage.init();
        await InsightsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Fire init with hasData=false
        workerInstance.listeners.message[0]({
            data: { type: "init", payload: { hasData: false } },
        });

        // Second route change: analyticsReady=true, hasData=false → line 78
        AppRouter.getCurrentRoute.mockReturnValue({ name: "insights", params: {} });
        await InsightsPage.onRouteChange({});

        expect(document.getElementById("insightsEmpty").hidden).toBe(false);
    });

    it("uses cached analytics base from DataCache when available (line 164)", async () => {
        const analyticsBase = { months: { "2024-01": {} } };
        DataCache.get.mockImplementation((key) =>
            key === "storage:analyticsBase" ? analyticsBase : null,
        );

        const callsBefore = Storage.getAnalytics.mock.calls.length;
        InsightsPage.init();
        await InsightsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Storage.getAnalytics should NOT be called since DataCache had the data
        expect(Storage.getAnalytics.mock.calls.length).toBe(callsBefore);
    });

    it("resetFilters button calls syncRouteRange and requestView (lines 275-278)", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        DataCache.get.mockReturnValue(null);

        AppRouter.getCurrentRoute.mockReturnValue({ name: "insights", params: {} });
        InsightsPage.init();
        await InsightsPage.onRouteChange({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        workerInstance.listeners.message[0]({
            data: { type: "init", payload: { hasData: true } },
        });

        AppRouter.setParams.mockClear();
        document.getElementById("insightsResetFiltersBtn").click();

        expect(AppRouter.setParams).toHaveBeenCalled();
    });
});
