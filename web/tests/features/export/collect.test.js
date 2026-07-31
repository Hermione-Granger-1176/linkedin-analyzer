import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    collectExportData,
    formatRangeLabel,
    hasExportableData,
    terminateAnalyticsWorker,
} from "../../../src/features/export/collect.js";
import { loadRecentThreads } from "../../../src/features/export/threads-transport.js";
import { captureError } from "../../../src/platform/observability/sentry.js";
import { DataCache } from "../../../src/platform/persistence/data-cache.js";
import { Storage } from "../../../src/platform/persistence/storage.js";
import { INSIGHTS_EXPORT_CACHE_KEY } from "../../../src/shared/constants.js";
import { expectFixedError, piiError } from "../../helpers/pii-sentinel.js";

vi.mock("../../../src/platform/observability/sentry.js", () => ({
    captureError: vi.fn(),
}));

vi.mock("../../../src/platform/persistence/data-cache.js", () => {
    const values = new Map();
    return {
        DataCache: {
            get: vi.fn((key) => values.get(key)),
            set: vi.fn((key, value) => values.set(key, value)),
            clearAll: () => values.clear(),
        },
    };
});

vi.mock("../../../src/platform/persistence/storage.js", () => ({
    Storage: {
        getAnalytics: vi.fn(),
        getOutreach: vi.fn(),
        getFile: vi.fn(),
    },
}));

vi.mock("../../../src/features/export/threads-transport.js", () => ({
    loadRecentThreads: vi.fn(),
}));

const OUTREACH = Object.freeze({
    selfInitiated: 128,
    replyRate: 0.42,
    unansweredContacts: 37,
    sentReceivedRatio: 1.84,
});

let workerInstance = null;
let workerConstructable = true;

class MockWorker {
    constructor() {
        if (!workerConstructable) {
            throw new Error("blocked");
        }
        this.listeners = new Map();
        this.terminate = vi.fn();
        this.postMessage = vi.fn();
        workerInstance = this;
    }

    addEventListener(type, callback) {
        const existing = this.listeners.get(type) || [];
        existing.push(callback);
        this.listeners.set(type, existing);
    }

    removeEventListener(type, callback) {
        const existing = this.listeners.get(type) || [];
        this.listeners.set(
            type,
            existing.filter((entry) => entry !== callback),
        );
    }

    /**
     * Count the listeners still attached.
     * @returns {number} Listener count
     */
    listenerCount() {
        return Array.from(this.listeners.values()).reduce(
            (total, entries) => total + entries.length,
            0,
        );
    }

    emit(type, event) {
        for (const callback of [...(this.listeners.get(type) || [])]) {
            callback(event);
        }
    }

    reply(data) {
        this.emit("message", { data });
    }
}

describe("formatRangeLabel", () => {
    it("names each range", () => {
        expect(formatRangeLabel("1m")).toBe("Last month");
        expect(formatRangeLabel("3m")).toBe("Last 3 months");
        expect(formatRangeLabel("6m")).toBe("Last 6 months");
        expect(formatRangeLabel("12m")).toBe("Last 12 months");
        expect(formatRangeLabel("all")).toBe("All time");
    });

    it("falls back to the default range", () => {
        expect(formatRangeLabel("nonsense")).toBe("Last 12 months");
        expect(formatRangeLabel(null)).toBe("Last 12 months");
        expect(formatRangeLabel(undefined)).toBe("Last 12 months");
    });
});

describe("collectExportData", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        DataCache.clearAll();
        workerInstance = null;
        workerConstructable = true;
        globalThis.Worker = MockWorker;
        Storage.getAnalytics.mockResolvedValue(null);
        Storage.getOutreach.mockResolvedValue(null);
        Storage.getFile.mockResolvedValue(null);
        loadRecentThreads.mockResolvedValue([]);
    });

    afterEach(() => {
        delete globalThis.Worker;
        vi.useRealTimers();
    });

    it("uses the Insights screen snapshot when there is one", async () => {
        DataCache.set(INSIGHTS_EXPORT_CACHE_KEY, {
            timeRange: "3m",
            insights: [{ title: "Mornings win", body: "…", accent: "accent-yellow" }],
            tip: "Reply faster.",
            networkGrowth: { multiplier: 3.4 },
            outreach: OUTREACH,
        });

        const data = await collectExportData({ generatedAt: new Date(2026, 6, 31) });

        expect(data.rangeLabel).toBe("Last 3 months");
        expect(data.insights).toHaveLength(1);
        expect(data.tip).toBe("Reply faster.");
        expect(data.generatedAt).toEqual(new Date(2026, 6, 31));
        expect(data.threads).toEqual([]);
        expect(data.allTime).toEqual([
            { label: "Network growth", value: "3.4x" },
            { label: "Outreach initiated", value: "128" },
            { label: "Reply rate", value: "42%" },
            { label: "Unanswered", value: "37" },
            { label: "Sent : received", value: "1.8 : 1" },
        ]);
        expect(Storage.getAnalytics).not.toHaveBeenCalled();
        expect(workerInstance).toBeNull();
    });

    it("keeps the on-screen range when the snapshot has stats but no insight cards", async () => {
        // A range can produce no cards while the all-time stats below them are
        // still populated. Testing the cards alone sent that screen down the
        // cold path, which exports the default range instead of this one.
        DataCache.set(INSIGHTS_EXPORT_CACHE_KEY, {
            timeRange: "3m",
            insights: [],
            tip: null,
            networkGrowth: { multiplier: 3.4 },
            outreach: OUTREACH,
        });

        const data = await collectExportData();

        expect(data.rangeLabel).toBe("Last 3 months");
        expect(data.insights).toEqual([]);
        expect(data.allTime[0]).toEqual({ label: "Network growth", value: "3.4x" });
        expect(Storage.getAnalytics).not.toHaveBeenCalled();
        expect(workerInstance).toBeNull();
    });

    it("falls back to the cold path when the snapshot holds nothing at all", async () => {
        DataCache.set(INSIGHTS_EXPORT_CACHE_KEY, {
            timeRange: "3m",
            insights: [],
            tip: null,
            networkGrowth: null,
            outreach: null,
        });

        const data = await collectExportData();

        expect(data.rangeLabel).toBe("Last 12 months");
        expect(Storage.getAnalytics).toHaveBeenCalled();
    });

    it("defaults generatedAt to now", async () => {
        const before = Date.now();
        const data = await collectExportData();

        expect(data.generatedAt).toBeInstanceOf(Date);
        expect(data.generatedAt.getTime()).toBeGreaterThanOrEqual(before);
    });

    it("shows N/A for outreach values that were never measurable", async () => {
        DataCache.set(INSIGHTS_EXPORT_CACHE_KEY, {
            timeRange: "12m",
            insights: [{ title: "One", body: "…" }],
            outreach: {
                selfInitiated: 0,
                replyRate: null,
                unansweredContacts: 0,
                sentReceivedRatio: null,
            },
        });

        const data = await collectExportData();

        expect(data.allTime).toEqual([
            { label: "Outreach initiated", value: "0" },
            { label: "Reply rate", value: "N/A" },
            { label: "Unanswered", value: "0" },
            { label: "Sent : received", value: "N/A" },
        ]);
    });

    it("returns empty sections when there is no analytics base at all", async () => {
        const data = await collectExportData();

        expect(data).toMatchObject({
            rangeLabel: "Last 12 months",
            insights: [],
            tip: null,
            allTime: [],
            threads: [],
        });
        expect(workerInstance).toBeNull();
    });

    it("runs a one-shot analytics worker when only stored analytics exist", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2026-01": {} } });
        Storage.getOutreach.mockResolvedValue(OUTREACH);

        const pending = collectExportData();
        await vi.waitFor(() => expect(workerInstance).not.toBeNull());
        const worker = workerInstance;

        expect(worker.postMessage).toHaveBeenCalledWith({
            type: "initBase",
            payload: { months: { "2026-01": {} } },
        });

        worker.reply({ type: "init", payload: { hasData: true } });
        expect(worker.postMessage).toHaveBeenLastCalledWith({
            type: "view",
            requestId: 1,
            filters: {
                timeRange: "12m",
                topic: "all",
                monthFocus: null,
                day: null,
                hour: null,
                shareType: "all",
            },
        });

        worker.reply({
            type: "view",
            requestId: 1,
            payload: {
                view: { networkGrowth: { multiplier: 2.1 } },
                insights: { insights: [{ title: "From the worker", body: "…" }], tip: "A tip." },
            },
        });

        const data = await pending;
        expect(data.insights).toEqual([{ title: "From the worker", body: "…" }]);
        expect(data.tip).toBe("A tip.");
        expect(data.allTime[0]).toEqual({ label: "Network growth", value: "2.1x" });
        expect(worker.terminate).toHaveBeenCalled();
        expect(worker.listenerCount()).toBe(0);
    });

    it("ends the analytics worker when the export is cancelled", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2026-01": {} } });

        const pending = collectExportData();
        await vi.waitFor(() => expect(workerInstance).not.toBeNull());
        const worker = workerInstance;

        terminateAnalyticsWorker();

        // The promise settles at once rather than waiting out the 30s watchdog,
        // and nothing is left holding the analytics base.
        const data = await pending;
        expect(data.insights).toEqual([]);
        expect(worker.terminate).toHaveBeenCalled();
        expect(worker.listenerCount()).toBe(0);

        // A late answer from a worker that was already told to stop changes
        // nothing, and cancelling twice is harmless.
        worker.reply({ type: "init", payload: { hasData: true } });
        terminateAnalyticsWorker();
        expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it("does nothing when there is no analytics worker to cancel", () => {
        expect(() => terminateAnalyticsWorker()).not.toThrow();
    });

    it("settles when the analytics request cannot be posted", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: { "2026-01": {} } });
        const postFailure = piiError();

        const pending = collectExportData();
        await vi.waitFor(() => expect(workerInstance).not.toBeNull());
        const worker = workerInstance;
        worker.postMessage.mockImplementation(() => {
            throw postFailure;
        });

        worker.reply({ type: "init", payload: { hasData: true } });

        const data = await pending;
        expect(data.insights).toEqual([]);
        expect(worker.terminate).toHaveBeenCalled();
        expect(worker.listenerCount()).toBe(0);

        const [reported, context] = captureError.mock.calls[0];
        expectFixedError(reported, postFailure);
        expect(context).toEqual({ module: "pdf-export", operation: "analytics-worker-post" });
    });

    it("prefers the cached analytics base over a storage read", async () => {
        DataCache.set("storage:analyticsBase", { months: {} });

        const pending = collectExportData();
        await vi.waitFor(() => expect(workerInstance).not.toBeNull());
        workerInstance.reply({ type: "init", payload: { hasData: false } });
        await pending;

        expect(Storage.getAnalytics).not.toHaveBeenCalled();
    });

    it("gives up on the worker when the base holds no data", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: {} });

        const pending = collectExportData();
        await vi.waitFor(() => expect(workerInstance).not.toBeNull());
        workerInstance.reply({ type: "init", payload: { hasData: false } });

        expect((await pending).insights).toEqual([]);
        expect(workerInstance.terminate).toHaveBeenCalled();
    });

    it("ignores worker chatter for other requests and bad envelopes", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: {} });

        const pending = collectExportData();
        await vi.waitFor(() => expect(workerInstance).not.toBeNull());
        workerInstance.reply({ type: "nonsense" });
        workerInstance.reply({ type: "view", requestId: 99, payload: {} });
        workerInstance.reply({ type: "init", payload: { hasData: true } });
        workerInstance.reply({ type: "view", requestId: 1, payload: {} });

        expect(await pending).toMatchObject({ insights: [], tip: null });
    });

    it("reports and recovers from a worker error payload", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: {} });

        const pending = collectExportData();
        await vi.waitFor(() => expect(workerInstance).not.toBeNull());
        workerInstance.reply({ type: "error", payload: { message: "boom" } });

        expect((await pending).insights).toEqual([]);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "analytics-worker-error-payload",
        });
    });

    it("recovers from a worker error event", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: {} });

        const pending = collectExportData();
        await vi.waitFor(() => expect(workerInstance).not.toBeNull());
        workerInstance.emit("error", { type: "error" });

        expect((await pending).insights).toEqual([]);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "analytics-worker-error-event",
        });
    });

    it("recovers when the worker never answers", async () => {
        vi.useFakeTimers();
        Storage.getAnalytics.mockResolvedValue({ months: {} });

        const pending = collectExportData();
        await vi.waitFor(() => expect(workerInstance).not.toBeNull());
        vi.advanceTimersByTime(31000);
        vi.useRealTimers();

        expect((await pending).insights).toEqual([]);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "analytics-worker-timeout",
        });
    });

    it("recovers when the worker cannot be constructed", async () => {
        workerConstructable = false;
        Storage.getAnalytics.mockResolvedValue({ months: {} });

        expect((await collectExportData()).insights).toEqual([]);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "init-analytics-worker",
        });
    });

    it("skips the worker entirely when the platform has none", async () => {
        delete globalThis.Worker;
        Storage.getAnalytics.mockResolvedValue({ months: {} });

        expect((await collectExportData()).insights).toEqual([]);
    });

    it("survives a storage failure", async () => {
        Storage.getAnalytics.mockRejectedValue(new Error("indexeddb gone"));

        expect((await collectExportData()).insights).toEqual([]);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "load-analytics",
        });
    });

    it("includes threads only when the user opted in", async () => {
        Storage.getFile.mockResolvedValue({ text: "FROM,TO\na,b" });
        loadRecentThreads.mockResolvedValue([{ name: "Ada", messages: [] }]);

        expect((await collectExportData({ includeMessages: false })).threads).toEqual([]);
        expect(loadRecentThreads).not.toHaveBeenCalled();

        const data = await collectExportData({ includeMessages: true });
        expect(data.threads).toEqual([{ name: "Ada", messages: [] }]);
        expect(loadRecentThreads).toHaveBeenCalledWith("FROM,TO\na,b", {
            contactKeys: expect.any(Array),
        });
    });

    it("passes the connections list through as a self-detection tiebreak", async () => {
        Storage.getFile.mockImplementation((type) =>
            Promise.resolve(
                type === "connections"
                    ? {
                          // LinkedIn puts three notes rows above the header.
                          text: [
                              "Notes:",
                              "",
                              "",
                              "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
                              "Ada,Lovelace,https://www.linkedin.com/in/ada,,Acme,Engineer,01 Jan 2026",
                          ].join("\n"),
                      }
                    : { text: "FROM,TO\na,b" },
            ),
        );
        loadRecentThreads.mockResolvedValue([]);

        await collectExportData({ includeMessages: true });

        const [, options] = loadRecentThreads.mock.calls[0];
        expect(options.contactKeys).toContain("https://www.linkedin.com/in/ada");
        expect(options.contactKeys).toContain("ada lovelace");
    });

    it("exports without a tiebreak when there is no connections file", async () => {
        Storage.getFile.mockImplementation((type) =>
            Promise.resolve(type === "connections" ? null : { text: "FROM,TO\na,b" }),
        );
        loadRecentThreads.mockResolvedValue([]);

        await collectExportData({ includeMessages: true });

        expect(loadRecentThreads.mock.calls[0][1].contactKeys).toEqual([]);
    });

    it("never reports the exception an unreadable connections file carried", async () => {
        const thrown = piiError("connections");
        Storage.getFile.mockImplementation((type) => {
            if (type === "connections") {
                return Promise.resolve({
                    get text() {
                        throw thrown;
                    },
                });
            }
            return Promise.resolve({ text: "FROM,TO\na,b" });
        });
        loadRecentThreads.mockResolvedValue([]);

        await collectExportData({ includeMessages: true });

        const [reported, context] = captureError.mock.calls[0];
        expectFixedError(reported, thrown);
        expect(context).toEqual({ module: "pdf-export", operation: "load-connections" });
        expect(loadRecentThreads.mock.calls[0][1].contactKeys).toEqual([]);
    });

    it("omits threads when no messages file was uploaded", async () => {
        Storage.getFile.mockResolvedValue(null);

        expect((await collectExportData({ includeMessages: true })).threads).toEqual([]);
        expect(loadRecentThreads).not.toHaveBeenCalled();
    });

    it("omits threads when the stored text record is empty", async () => {
        Storage.getFile.mockResolvedValue({ text: "" });

        expect((await collectExportData({ includeMessages: true })).threads).toEqual([]);
    });

    it("drops the thread section when selection fails", async () => {
        Storage.getFile.mockResolvedValue({ text: "FROM,TO\na,b" });
        loadRecentThreads.mockRejectedValue(new Error("worker exploded"));

        expect((await collectExportData({ includeMessages: true })).threads).toEqual([]);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "select-threads",
        });
    });

    it("never reports the exception a thread-selection failure carried", async () => {
        const thrown = piiError("selection");
        Storage.getFile.mockResolvedValue({ text: "FROM,TO\na,b" });
        loadRecentThreads.mockRejectedValue(thrown);

        await collectExportData({ includeMessages: true });

        const [reported, context] = captureError.mock.calls[0];
        expectFixedError(reported, thrown);
        expect(context).toEqual({ module: "pdf-export", operation: "select-threads" });
    });

    it("never reports the exception a stored-file read carried", async () => {
        const thrown = piiError("storage");
        Storage.getFile.mockRejectedValue(thrown);

        expect((await collectExportData({ includeMessages: true })).threads).toEqual([]);

        const [reported, context] = captureError.mock.calls[0];
        expectFixedError(reported, thrown);
        expect(context).toEqual({ module: "pdf-export", operation: "load-messages-file" });
    });
});

describe("hasExportableData", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        DataCache.clearAll();
        Storage.getAnalytics.mockResolvedValue(null);
        Storage.getOutreach.mockResolvedValue(null);
    });

    it("is true when the Insights screen has published a snapshot", async () => {
        DataCache.set(INSIGHTS_EXPORT_CACHE_KEY, { insights: [{ title: "One" }] });

        expect(await hasExportableData()).toBe(true);
        expect(Storage.getAnalytics).not.toHaveBeenCalled();
    });

    it("is true when the snapshot holds only all-time stats", async () => {
        DataCache.set(INSIGHTS_EXPORT_CACHE_KEY, { insights: [], outreach: OUTREACH });

        expect(await hasExportableData()).toBe(true);
        expect(Storage.getAnalytics).not.toHaveBeenCalled();
    });

    it("is true when the analytics base is cached", async () => {
        DataCache.set("storage:analyticsBase", { months: {} });

        expect(await hasExportableData()).toBe(true);
        expect(Storage.getAnalytics).not.toHaveBeenCalled();
    });

    it("is true when analytics are only in storage", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: {} });

        expect(await hasExportableData()).toBe(true);
    });

    it("is true when only an outreach summary exists", async () => {
        Storage.getOutreach.mockResolvedValue(OUTREACH);

        expect(await hasExportableData()).toBe(true);
    });

    it("is false when nothing has been uploaded", async () => {
        DataCache.set(INSIGHTS_EXPORT_CACHE_KEY, { insights: [] });

        expect(await hasExportableData()).toBe(false);
    });
});
