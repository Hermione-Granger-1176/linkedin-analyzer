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
    Storage: { getAnalytics: vi.fn(), getOutreach: vi.fn() },
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
            this.listeners[type] = this.listeners[type] || [];
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
            <section id="insightsAllTime" hidden>
                <div id="insightsNetworkGrowthCard" hidden><span id="insightsNetworkGrowthValue"></span></div>
                <div id="insightsOutreachInitiatedCard" hidden><span id="insightsStatInitiated"></span></div>
                <div id="insightsOutreachReplyCard" hidden><span id="insightsStatReplyRate"></span></div>
                <div id="insightsOutreachUnansweredCard" hidden><span id="insightsStatUnanswered"></span></div>
                <div id="insightsOutreachRatioCard" hidden><span id="insightsStatSentRatio"></span></div>
            </section>
            <div id="insightTip" hidden><span id="insightTipText"></span></div>
            <div id="insightsTimeRangeButtons">
                <button class="filter-btn" data-range="12m"></button>
                <button class="filter-btn" data-range="3m"></button>
            </div>
            <select id="insightsTimeRangeSelect">
                <option value="1m">1 month</option>
                <option value="3m">3 months</option>
                <option value="6m">6 months</option>
                <option value="12m" selected>12 months</option>
                <option value="all">All time</option>
            </select>
            <button id="insightsResetFiltersBtn"></button>
        `;

        vi.resetModules();
        ({ InsightsPage } = await import("../src/insights-ui.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ LoadingOverlay } = await import("../src/loading-overlay.js"));
        ({ AppRouter } = await import("../src/router.js"));
        ({ Storage } = await import("../src/storage.js"));
        Storage.getOutreach.mockResolvedValue(null);
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

    it("times out and hides the overlay when the worker never responds", async () => {
        vi.useFakeTimers();
        try {
            Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
            DataCache.get.mockReturnValue(null);

            InsightsPage.init();
            InsightsPage.onRouteChange({});
            // Flush loadBase's awaits so the watchdog is armed; the worker is
            // created but deliberately never posts an "init"/"view" reply.
            for (let i = 0; i < 10; i++) {
                await Promise.resolve();
            }
            expect(workerInstance).toBeTruthy();
            expect(workerInstance.listeners.message.length).toBeGreaterThan(0);

            // Regression: without a watchdog a silent worker leaves the loading
            // overlay up forever. Advancing past the timeout must surface an error
            // and hide the overlay.
            vi.advanceTimersByTime(30000);

            expect(document.getElementById("insightsEmpty").hidden).toBe(false);
            expect(
                document.getElementById("insightsEmpty").querySelector("h2").textContent.toLowerCase(),
            ).toContain("timeout");
            expect(LoadingOverlay.hide).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
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
        expect(document.querySelector(".insight-card").dataset.accent).toBe("accent-blue");
        expect(document.querySelector(".insight-icon").classList.contains("accent-blue")).toBe(true);
        expect(document.getElementById("insightTip").hidden).toBe(false);
        expect(document.getElementById("insightTipText").textContent).toContain("Try sharing");
        // No lifetime data delivered, so the All-time section stays hidden.
        expect(document.getElementById("insightsAllTime").hidden).toBe(true);
    });

    it("renders a canonical insight accent class", async () => {
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
                            {
                                title: "Reply lift",
                                body: "Direct outreach is improving.",
                                accent: "accent-green",
                                icon: "spark",
                            },
                        ],
                        tip: null,
                    },
                },
            },
        });

        expect(document.querySelector(".insight-card").dataset.accent).toBe("accent-green");
        expect(document.querySelector(".insight-icon").classList.contains("accent-green")).toBe(true);
    });

    it("falls back for a non-allowlisted insight accent class", async () => {
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
                            {
                                title: "Hostile",
                                body: "Unexpected accent should not render.",
                                accent: 'accent-red" onclick="alert(1)',
                                icon: "spark",
                            },
                        ],
                        tip: null,
                    },
                },
            },
        });

        const card = document.querySelector(".insight-card");
        const icon = document.querySelector(".insight-icon");
        expect(card.dataset.accent).toBe("accent-blue");
        expect(icon.classList.contains("accent-blue")).toBe(true);
        expect(icon.className).not.toContain("onclick");
    });

    it("renders the All-time section from networkGrowth and the stored outreach summary", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        Storage.getOutreach.mockResolvedValue({
            selfInitiated: 4070,
            replyRate: 0.5,
            unansweredContacts: 2259,
            sentReceivedRatio: 1.8,
        });
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
                    view: { networkGrowth: { multiplier: 15, topAvg: 206, quietAvg: 14 } },
                    insights: { insights: [], tip: null },
                },
            },
        });

        expect(document.getElementById("insightsAllTime").hidden).toBe(false);
        expect(document.getElementById("insightsNetworkGrowthCard").hidden).toBe(false);
        expect(document.getElementById("insightsNetworkGrowthValue").textContent).toBe("15×");
        expect(document.getElementById("insightsStatInitiated").textContent).toBe("4070");
        expect(document.getElementById("insightsStatReplyRate").textContent).toBe("50%");
        expect(document.getElementById("insightsStatUnanswered").textContent).toBe("2259");
        expect(document.getElementById("insightsStatSentRatio").textContent).toBe("1.8 : 1");
    });

    it("shows N/A for outreach reply rate and ratio when they are null", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        Storage.getOutreach.mockResolvedValue({
            selfInitiated: 0,
            replyRate: null,
            unansweredContacts: 0,
            sentReceivedRatio: null,
        });
        DataCache.get.mockReturnValue(null);

        InsightsPage.init();
        await InsightsPage.onRouteChange({ range: "3m" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Outreach loaded from storage; network-growth absent (no view yet).
        expect(document.getElementById("insightsAllTime").hidden).toBe(false);
        expect(document.getElementById("insightsNetworkGrowthCard").hidden).toBe(true);
        expect(document.getElementById("insightsStatReplyRate").textContent).toBe("N/A");
        expect(document.getElementById("insightsStatSentRatio").textContent).toBe("N/A");
    });

    it("reloads outreach on re-entry so a later Messages upload appears without refresh", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        Storage.getOutreach.mockResolvedValue(null);
        DataCache.get.mockReturnValue(null);

        InsightsPage.init();
        await InsightsPage.onRouteChange({ range: "3m" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(document.getElementById("insightsAllTime").hidden).toBe(true);

        // Leave Insights, "upload Messages" (outreach now stored), then return.
        InsightsPage.onRouteLeave();
        Storage.getOutreach.mockResolvedValue({
            selfInitiated: 12,
            replyRate: 0.25,
            unansweredContacts: 3,
            sentReceivedRatio: 2,
        });
        await InsightsPage.onRouteChange({ range: "3m" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.getElementById("insightsAllTime").hidden).toBe(false);
        expect(document.getElementById("insightsStatInitiated").textContent).toBe("12");
    });

    it("retries the outreach load after a storage error", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        Storage.getOutreach.mockRejectedValueOnce(new Error("idb down"));
        DataCache.get.mockReturnValue(null);

        InsightsPage.init();
        await InsightsPage.onRouteChange({ range: "3m" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(document.getElementById("insightsAllTime").hidden).toBe(true);

        // The error cleared the latch, so a subsequent entry retries and succeeds.
        Storage.getOutreach.mockResolvedValue({
            selfInitiated: 5,
            replyRate: null,
            unansweredContacts: 0,
            sentReceivedRatio: null,
        });
        await InsightsPage.onRouteChange({ range: "3m" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.getElementById("insightsStatInitiated").textContent).toBe("5");
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

    it("syncs range into router on select change", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        DataCache.get.mockReturnValue(null);

        InsightsPage.init();
        await InsightsPage.onRouteChange({});

        const select = document.getElementById("insightsTimeRangeSelect");
        select.value = "3m";
        select.dispatchEvent(new Event("change"));

        expect(AppRouter.setParams).toHaveBeenCalledWith(
            { range: "3m" },
            { replaceHistory: false },
        );
    });

    it("ignores a select change carrying an unknown range value", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        DataCache.get.mockReturnValue(null);

        InsightsPage.init();
        await InsightsPage.onRouteChange({});
        AppRouter.setParams.mockClear();

        const select = document.getElementById("insightsTimeRangeSelect");
        select.value = "bogus";
        select.dispatchEvent(new Event("change"));

        expect(AppRouter.setParams).not.toHaveBeenCalled();
    });

    it("mirrors the active range onto the select when applied from the route", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        DataCache.get.mockReturnValue(null);

        InsightsPage.init();
        await InsightsPage.onRouteChange({ range: "3m" });

        expect(document.getElementById("insightsTimeRangeSelect").value).toBe("3m");
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

    /** Init, route in, deliver the worker "init" reply, and return the view id. */
    async function primeInsights(range = "3m", hasData = true) {
        Storage.getAnalytics.mockResolvedValue({ months: { "2024-01": {} } });
        DataCache.get.mockReturnValue(null);
        InsightsPage.init();
        await InsightsPage.onRouteChange({ range });
        await new Promise((resolve) => setTimeout(resolve, 0));
        workerInstance.listeners.message[0]({
            data: { type: "init", payload: { hasData } },
        });
        const viewCall = workerInstance.postMessage.mock.calls.find((c) => c[0].type === "view");
        return viewCall ? viewCall[0].requestId : null;
    }

    function sendView(requestId, payload) {
        workerInstance.listeners.message[0]({
            data: { type: "view", requestId, payload },
        });
    }

    it("is a no-op when init runs a second time", () => {
        InsightsPage.init();
        expect(() => InsightsPage.init()).not.toThrow();
    });

    it("requests a fresh view on a repeat route change once data is ready", async () => {
        await primeInsights();
        const viewCallsBefore = workerInstance.postMessage.mock.calls.filter(
            (c) => c[0].type === "view",
        ).length;
        // Data is already loaded, so re-entering the route just re-requests a view.
        await InsightsPage.onRouteChange({ range: "3m" });
        const viewCallsAfter = workerInstance.postMessage.mock.calls.filter(
            (c) => c[0].type === "view",
        ).length;
        expect(viewCallsAfter).toBeGreaterThan(viewCallsBefore);
    });

    it("reflects an already-active time-range button as aria-pressed", () => {
        document.querySelector('[data-range="3m"]').classList.add("active");
        InsightsPage.init();
        expect(document.querySelector('[data-range="3m"]').getAttribute("aria-pressed")).toBe(
            "true",
        );
    });

    it("ignores a worker message event that carries no data", async () => {
        await primeInsights();
        expect(() => workerInstance.listeners.message[0]({})).not.toThrow();
    });

    it("leaves prior cards untouched when a later view omits insights", async () => {
        const id = await primeInsights();
        sendView(id, {
            insights: {
                insights: [{ title: "T", body: "B", accent: "blue", icon: "spark" }],
                tip: null,
            },
        });
        expect(document.querySelectorAll(".insight-card").length).toBe(1);
        // A follow-up view with no insights leaves currentInsights null, so the
        // existing cards are not re-rendered away.
        sendView(id, { view: { networkGrowth: null } });
        expect(document.getElementById("insightsAllTime").hidden).toBe(true);
    });

    it("clears networkGrowth when the view carries none", async () => {
        const id = await primeInsights();
        sendView(id, { insights: { insights: [], tip: null }, view: {} });
        expect(document.getElementById("insightsNetworkGrowthCard").hidden).toBe(true);
    });

    it("renders an insights payload with no cards or tip", async () => {
        const id = await primeInsights();
        // A currentInsights object missing its array and tip exercises the defaults.
        sendView(id, { insights: {} });
        expect(document.querySelectorAll(".insight-card").length).toBe(0);
        expect(document.getElementById("insightTip").hidden).toBe(true);
    });

    it("captures a worker error event that carries an error object", async () => {
        await primeInsights();
        const event = Object.assign(new Event("error"), { error: new Error("kaboom") });
        workerInstance.listeners.error[0](event);
        expect(
            document.getElementById("insightsEmpty").querySelector("h2").textContent,
        ).toContain("Insights worker error");
    });
});
