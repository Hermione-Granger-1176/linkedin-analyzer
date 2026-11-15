import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LinkedInCleaner } from "../../../src/features/cleaning/cleaner.js";
import {
    buildGrowthTimeline,
    computeStats,
    normalizeConnectionRows,
} from "../../../src/features/connections/view.js";
import {
    collectExportData,
    formatRangeLabel,
    terminateAnalyticsWorker,
} from "../../../src/features/export/collect.js";
import { loadConnectionsData } from "../../../src/features/export/connections-transport.js";
import { loadMessagesState } from "../../../src/features/export/messages-transport.js";
import {
    ExportRefusal,
    MESSAGES_TOO_LARGE_FOR_CONTENTS,
} from "../../../src/features/export/refusal.js";
import { loadRecentThreads } from "../../../src/features/export/threads-transport.js";
import { formatShortDate } from "../../../src/features/messages/format.js";
import {
    hydrateConnectionState,
    hydrateMessageState,
} from "../../../src/features/messages/hydrate.js";
import { captureError } from "../../../src/platform/observability/sentry.js";
import { DataCache } from "../../../src/platform/persistence/data-cache.js";
import { Storage } from "../../../src/platform/persistence/storage.js";
import { INSIGHTS_EXPORT_CACHE_KEY } from "../../../src/shared/constants.js";
import { THREADS_EXPORT_MAX_BYTES } from "../../../src/shared/limits.js";
import { compactEvents } from "../../helpers/message-events.js";
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
        getAllFiles: vi.fn(),
    },
}));

vi.mock("../../../src/features/export/threads-transport.js", () => ({
    loadRecentThreads: vi.fn(),
}));

// The two dashboard parses go through transports that own workers. They are
// stubbed, so this suite tests what each dashboard builds from a parse, not how
// the parse runs.
vi.mock("../../../src/features/export/messages-transport.js", () => ({
    loadMessagesState: vi.fn(),
    terminateMessagesWorker: vi.fn(),
}));

vi.mock("../../../src/features/export/connections-transport.js", () => ({
    loadConnectionsData: vi.fn(),
    terminateConnectionsWorker: vi.fn(),
}));

const OUTREACH = Object.freeze({
    selfInitiated: 128,
    replyRate: 0.42,
    unansweredContacts: 37,
    sentReceivedRatio: 1.84,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_NAMES = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
];

// Read once for the whole file. The range, network age and fading day counts are
// measured against the clock, so fixtures are dated relative to this instant and
// expected strings derive from it.
const NOW = Date.now();
const LAST_MESSAGE_MS = NOW - 60 * DAY_MS;
const GRACE_CONNECTED_MS = NOW - 200 * DAY_MS;

const MESSAGES_CSV = "FROM,TO\na,b";
const ADA_URL = "https://www.linkedin.com/in/ada";
const ADA_KEY = `url:${ADA_URL}`;

// The filtered view the analytics worker answers a "view" request with, cut
// down to the fields the activity dashboard reads.
const ACTIVITY_VIEW = Object.freeze({
    totals: { posts: 12, comments: 30, total: 42 },
    peakHour: { hour: 9 },
    streaks: { current: 3, longest: 11 },
    // Keyed as the analytics worker keys its points. The export reads the window
    // from the first and last points.
    timeline: [
        { key: "2026-01", label: "Jan 2026", value: 3 },
        { key: "2026-02", label: "Feb 2026", value: 6 },
    ],
    topics: [{ topic: "hiring", count: 4 }],
    heatmap: [[1, 0], [0, 2]],
    networkGrowth: { multiplier: 2.1 },
});

/**
 * Label the twelve-month window relative to the fixture's latest message.
 * @param {number} latestMs - Newest message in the fixture
 * @returns {string} Window label, as the caption prints it
 */
function messageWindowLabel(latestMs) {
    const latest = new Date(latestMs);
    const start = new Date(latest.getFullYear(), latest.getMonth() - 11, 1);
    return (
        `${MONTH_NAMES[start.getMonth()]} ${start.getFullYear()} to ` +
        `${MONTH_NAMES[latest.getMonth()]} ${latest.getFullYear()}`
    );
}

/**
 * Format a date the way LinkedIn writes "Connected On".
 * @param {number} timestamp - Epoch milliseconds
 * @returns {string} Day, short month name and year
 */
function connectedOn(timestamp) {
    const date = new Date(timestamp);
    const day = String(date.getDate()).padStart(2, "0");
    return `${day} ${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
}

/**
 * Build a connections CSV dated relative to the test clock.
 * Range counts and network age depend on that clock.
 * @returns {string} Connections CSV, preamble and all
 */
function connectionsCsv() {
    const older = connectedOn(NOW - 40 * DAY_MS);
    const newer = connectedOn(NOW - 10 * DAY_MS);
    return [
        "Notes:",
        "Export metadata",
        "",
        "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
        `Ada,Lovelace,${ADA_URL},,Analytical Engines,Mathematician,${older}`,
        `Grace,Hopper,https://www.linkedin.com/in/grace,,Navy,Rear Admiral,${newer}`,
    ].join("\n");
}

/**
 * Build a stored connections export whose every row predates the last year.
 *
 * Most people's exports have this shape. The twelve-month default would leave
 * nothing in range.
 * @returns {string} Connections CSV, preamble and all
 */
function agedConnectionsCsv() {
    return [
        "Notes:",
        "Export metadata",
        "",
        "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
        `Ada,Lovelace,${ADA_URL},,Analytical Engines,Mathematician,${connectedOn(NOW - 1100 * DAY_MS)}`,
        `Grace,Hopper,https://www.linkedin.com/in/grace,,Navy,Rear Admiral,${connectedOn(NOW - 900 * DAY_MS)}`,
    ].join("\n");
}

/**
 * Build a connections transport result through the view helpers.
 * Keep cleaned rows and aggregates consistent with the worker's result.
 * @param {string} csv - Stored connections CSV
 * @returns {{rows: object[], timeline: object[], stats: object}} Transport result
 */
function connectionsData(csv) {
    const processed = LinkedInCleaner.process(csv, "connections");
    return {
        rows: normalizeConnectionRows(processed.cleanedData),
        timeline: buildGrowthTimeline(processed.cleanedData),
        stats: computeStats(processed.cleanedData),
    };
}

/**
 * Find a dashboard by title, returning null if it was omitted.
 * @param {object} data - Document model
 * @param {string} title - Dashboard title
 * @returns {object|null} Dashboard, or null when the document has none
 */
function dashboardNamed(data, title) {
    return data.dashboards.find((dashboard) => dashboard.title === title) || null;
}

/**
 * Build hydrated messages state with the transport's hydration helpers.
 * The dashboard expects contacts as a Map and contact keys as Sets.
 * @param {boolean} withConnections - Whether a connections file was parsed too
 * @returns {{messageState: object, connectionState: object|null}} Hydrated state
 */
function messagesState(withConnections) {
    return {
        messageState: hydrateMessageState({
            contacts: [
                {
                    key: ADA_KEY,
                    name: "Ada Lovelace",
                    url: ADA_URL,
                    count: 2,
                    lastTimestamp: LAST_MESSAGE_MS,
                },
            ],
            events: compactEvents([
                { contactKey: ADA_KEY, timestamp: LAST_MESSAGE_MS },
                { contactKey: ADA_KEY, timestamp: LAST_MESSAGE_MS - DAY_MS },
            ]),
            rowTimestamps: Float64Array.of(LAST_MESSAGE_MS, LAST_MESSAGE_MS - DAY_MS),
            talkedNameKeys: ["ada lovelace"],
            talkedUrlKeys: [ADA_URL],
            latestTimestamp: LAST_MESSAGE_MS,
        }),
        connectionState: withConnections
            ? hydrateConnectionState({
                  list: [
                      {
                          name: "Ada Lovelace",
                          nameKey: "ada lovelace",
                          url: ADA_URL,
                          company: "Analytical Engines",
                          position: "Mathematician",
                          connectedOnTimestamp: LAST_MESSAGE_MS - 400 * DAY_MS,
                      },
                      {
                          name: "Grace Hopper",
                          nameKey: "grace hopper",
                          url: "https://www.linkedin.com/in/grace",
                          company: "Navy",
                          position: "Rear Admiral",
                          connectedOnTimestamp: GRACE_CONNECTED_MS,
                      },
                      {
                          // Neither field is known and no date was recorded: the
                          // Messages screen still lists them, so the export does.
                          name: "Alan Turing",
                          nameKey: "alan turing",
                          url: "https://www.linkedin.com/in/alan",
                          company: "",
                          position: "",
                          connectedOnTimestamp: null,
                      },
                  ],
              })
            : null,
    };
}

/**
 * Build a state with more people in it than a dashboard list will print.
 *
 * Twelve contacts and exactly ten silent connections, so one list is the head
 * of a longer one and the other is the whole of a list that happens to reach
 * the limit.
 * @returns {{messageState: object, connectionState: object}} Hydrated state
 */
function crowdedMessagesState() {
    const contacts = Array.from({ length: 12 }, (unused, index) => ({
        key: `url:https://www.linkedin.com/in/contact-${index}`,
        name: `Contact ${index}`,
        url: `https://www.linkedin.com/in/contact-${index}`,
        count: 1,
        lastTimestamp: LAST_MESSAGE_MS,
    }));

    return {
        messageState: hydrateMessageState({
            contacts,
            events: compactEvents(
                contacts.map((contact) => ({
                    contactKey: contact.key,
                    timestamp: LAST_MESSAGE_MS,
                })),
            ),
            rowTimestamps: Float64Array.from(contacts, () => LAST_MESSAGE_MS),
            talkedNameKeys: contacts.map((contact) => contact.name.toLowerCase()),
            talkedUrlKeys: contacts.map((contact) => contact.url),
            latestTimestamp: LAST_MESSAGE_MS,
        }),
        connectionState: hydrateConnectionState({
            list: Array.from({ length: 10 }, (unused, index) => ({
                name: `Silent ${index}`,
                nameKey: `silent ${index}`,
                url: `https://www.linkedin.com/in/silent-${index}`,
                company: "Navy",
                position: "Rear Admiral",
                connectedOnTimestamp: GRACE_CONNECTED_MS,
            })),
        }),
    };
}

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
        Storage.getAllFiles.mockResolvedValue([]);
        loadRecentThreads.mockResolvedValue([]);
        loadMessagesState.mockResolvedValue(null);
        loadConnectionsData.mockResolvedValue(null);
    });

    afterEach(() => {
        // Module-level state in collect.js: a run left active leaks into the
        // next test's cancellation behaviour.
        terminateAnalyticsWorker();
        delete globalThis.Worker;
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    /**
     * Find the diagnostic call for an operation.
     * Selecting by operation keeps assertions independent of earlier reads.
     * @param {string} operation - Fixed diagnostic operation
     * @returns {[unknown, object]} Reported value and its context
     */
    function capturedFor(operation) {
        const call = captureError.mock.calls.find(([, context]) => context.operation === operation);
        expect(call, `no captureError for ${operation}`).toBeDefined();
        return call;
    }

    const storedBlobs = new Map();

    /**
     * The stored upload Blob for a text, the same instance on every call so a
     * test can follow it from storage to the consumer it was handed to.
     * @param {string} text - Stored file contents
     * @returns {Blob} Stored upload
     */
    function stored(text) {
        if (!storedBlobs.has(text)) {
            storedBlobs.set(text, new Blob([text]));
        }
        return storedBlobs.get(text);
    }

    /**
     * Answer both stored-file reads with the uploads a full export would find.
     * @param {{messages?: string|null, connections?: string|null}} texts - Stored texts
     */
    function storeFiles(texts) {
        Storage.getFile.mockImplementation((type) => {
            const text = type === "messages" ? texts.messages : texts.connections;
            return Promise.resolve(text ? { blob: stored(text) } : null);
        });
    }

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
            { label: "Network growth", value: "3.4×" },
            { label: "Outreach initiated", value: "128" },
            { label: "Reply rate", value: "42%" },
            { label: "Unanswered", value: "37" },
            { label: "Sent : received", value: "1.8 : 1" },
        ]);
        // Without a view in the snapshot, the analytics base is read. There is
        // none here, so no worker starts and no dashboard is built.
        expect(Storage.getAnalytics).toHaveBeenCalled();
        expect(workerInstance).toBeNull();
        expect(data.dashboards).toEqual([]);
    });

    it("plots the snapshot's own view without starting the analytics worker", async () => {
        // A snapshot with a view needs no worker run: the timeline, topics and
        // heatmap come from the snapshot.
        DataCache.set(INSIGHTS_EXPORT_CACHE_KEY, {
            timeRange: "3m",
            insights: [{ title: "Mornings win", body: "…" }],
            tip: "Reply faster.",
            view: ACTIVITY_VIEW,
            networkGrowth: { multiplier: 3.4 },
            outreach: OUTREACH,
        });
        Storage.getAnalytics.mockResolvedValue({ months: { "2026-01": {} } });

        const data = await collectExportData();

        expect(workerInstance).toBeNull();
        expect(Storage.getAnalytics).not.toHaveBeenCalled();
        const activity = dashboardNamed(data, "Analytics");
        // The caption shows the months the view covers, not the selected range
        // name. The range is anchored on the newest event, so a range name would
        // go stale.
        expect(activity.subtitle).toBe("Jan 2026 to Feb 2026");
        expect(activity.charts[0].points).toEqual(ACTIVITY_VIEW.timeline);
        expect(activity.charts[1].items).toEqual(ACTIVITY_VIEW.topics);
        expect(activity.charts[2].grid).toEqual(ACTIVITY_VIEW.heatmap);
    });

    it("keeps the on-screen range when the snapshot has stats but no insight cards", async () => {
        // A range can have no cards but still have all-time stats. The snapshot
        // is used when either is present, so the on-screen range is kept.
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
        expect(data.allTime[0]).toEqual({ label: "Network growth", value: "3.4×" });
        expect(workerInstance).toBeNull();
    });

    it("leaves the growth tile out when the snapshot carries no multiple", async () => {
        // A growth object with no multiplier is not the same as no growth object.
        // The tile is left out, since a truthiness check would print "undefined×".
        DataCache.set(INSIGHTS_EXPORT_CACHE_KEY, {
            timeRange: "3m",
            insights: [{ title: "Mornings win", body: "…" }],
            tip: null,
            networkGrowth: {},
            outreach: OUTREACH,
        });

        const data = await collectExportData();

        expect(data.allTime.map((stat) => stat.label)).not.toContain("Network growth");
        expect(data.allTime[0].label).toBe("Outreach initiated");
    });

    it("asks the worker for the range the snapshot is showing", async () => {
        // Without a cached view, request the same range shown in the snapshot.
        // The header and charts must describe the same window.
        DataCache.set(INSIGHTS_EXPORT_CACHE_KEY, {
            timeRange: "3m",
            insights: [{ title: "Mornings win", body: "…" }],
            tip: "Reply faster.",
            networkGrowth: { multiplier: 3.4 },
            outreach: OUTREACH,
        });
        Storage.getAnalytics.mockResolvedValue({ months: { "2026-01": {} } });

        const pending = collectExportData();
        await vi.waitFor(() => expect(workerInstance).not.toBeNull());
        const worker = workerInstance;
        worker.reply({ type: "init", payload: { hasData: true } });

        const [request] = worker.postMessage.mock.lastCall;
        expect(request.filters.timeRange).toBe("3m");

        worker.reply({
            type: "view",
            requestId: 1,
            payload: {
                view: ACTIVITY_VIEW,
                insights: { insights: [{ title: "From the worker" }], tip: "Worker tip." },
            },
        });

        const data = await pending;
        // The snapshot still owns the cards, the tip and the growth multiple;
        // only the charts come from the run, and the caption comes from the
        // months they plot.
        expect(data.rangeLabel).toBe("Jan 2026 to Feb 2026");
        expect(data.insights).toEqual([{ title: "Mornings win", body: "…" }]);
        expect(data.tip).toBe("Reply faster.");
        expect(data.allTime[0]).toEqual({ label: "Network growth", value: "3.4×" });
        expect(dashboardNamed(data, "Analytics").subtitle).toBe("Jan 2026 to Feb 2026");
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

    it("never starts a worker for a run that has already been cancelled", async () => {
        // Cancellation is checked before any storage read or worker start, since
        // terminating a worker that does not exist yet does nothing.
        Storage.getAnalytics.mockResolvedValue({ months: {} });
        storeFiles({ messages: MESSAGES_CSV, connections: connectionsCsv() });

        const data = await collectExportData({
            includeMessages: true,
            isCancelled: () => true,
        });

        expect(workerInstance).toBeNull();
        expect(Storage.getFile).not.toHaveBeenCalled();
        expect(loadMessagesState).not.toHaveBeenCalled();
        expect(loadConnectionsData).not.toHaveBeenCalled();
        expect(loadRecentThreads).not.toHaveBeenCalled();
        expect(data.insights).toEqual([]);
        expect(data.threads).toEqual([]);
    });

    it("defaults generatedAt to now", async () => {
        const before = Date.now();
        const data = await collectExportData();

        expect(data.generatedAt).toBeInstanceOf(Date);
        expect(data.generatedAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(data.generatedAt.getTime()).toBeLessThanOrEqual(Date.now());
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
            dashboards: [],
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
        expect(data.allTime[0]).toEqual({ label: "Network growth", value: "2.1×" });
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
        terminateAnalyticsWorker();

        // Checks that no worker exists, not only that nothing threw.
        expect(workerInstance).toBeNull();
        expect(captureError).not.toHaveBeenCalled();
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

        const [reported, context] = capturedFor("analytics-worker-post");
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
        // The stale envelope carries content, so processing it would show in the
        // result.
        workerInstance.reply({
            type: "view",
            requestId: 99,
            payload: {
                view: { networkGrowth: { multiplier: 9.9 } },
                insights: { insights: [{ title: "Wrong request" }], tip: "Wrong tip." },
            },
        });
        workerInstance.reply({ type: "init", payload: { hasData: true } });
        workerInstance.reply({ type: "view", requestId: 1, payload: {} });

        const data = await pending;
        expect(data).toMatchObject({ insights: [], tip: null });
        expect(data.allTime).toEqual([]);
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

    it("cancels the worker error event so the browser cannot log what it carried", async () => {
        // This worker reads the user's share commentary and comment text. An
        // uncancelled error event would be logged with that content, so it is
        // cancelled.
        Storage.getAnalytics.mockResolvedValue({ months: {} });
        const preventDefault = vi.fn();

        const pending = collectExportData();
        await vi.waitFor(() => expect(workerInstance).not.toBeNull());
        workerInstance.emit("error", { type: "error", preventDefault });

        await pending;
        expect(preventDefault).toHaveBeenCalled();
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

    /**
     * Run an export whose worker answers with the given view.
     * @param {object|null} view - Payload the "view" reply carries
     * @returns {Promise<object>} Document model
     */
    async function collectWithView(view) {
        Storage.getAnalytics.mockResolvedValue({ months: { "2026-01": {} } });

        const pending = collectExportData();
        await vi.waitFor(() => expect(workerInstance).not.toBeNull());
        workerInstance.reply({ type: "init", payload: { hasData: true } });
        workerInstance.reply({ type: "view", requestId: 1, payload: { view, insights: {} } });
        return pending;
    }

    it("builds the activity dashboard from the worker's view", async () => {
        const activity = dashboardNamed(await collectWithView(ACTIVITY_VIEW), "Analytics");

        expect(activity.subtitle).toBe("Jan 2026 to Feb 2026");
        // Uses the Analytics screen's wording, so readers recognise the page.
        expect(activity.stats).toEqual([
            { label: "Posts", value: "12" },
            { label: "Comments", value: "30" },
            { label: "Total activity", value: "42" },
            { label: "Peak hour", value: "09:00" },
            { label: "Current streak", value: "3 days" },
        ]);
        expect(activity.charts.map((chart) => [chart.type, chart.title])).toEqual([
            ["line", "Activity timeline"],
            ["bar", "Top topics"],
            ["heatmap", "When you are active"],
        ]);
        expect(activity.charts[0].points).toEqual(ACTIVITY_VIEW.timeline);
        expect(activity.charts[1].items).toEqual(ACTIVITY_VIEW.topics);
        expect(activity.charts[2].grid).toEqual(ACTIVITY_VIEW.heatmap);
    });

    it("names a single month as itself", async () => {
        const data = await collectWithView({
            ...ACTIVITY_VIEW,
            timeline: [{ key: "2026-02", label: "Feb 2026", value: 9 }],
        });

        expect(data.rangeLabel).toBe("Feb 2026");
        expect(dashboardNamed(data, "Analytics").subtitle).toBe("Feb 2026");
    });

    it("falls back to the range's own name when the timeline carries no dates", async () => {
        // The window is read off the plotted points, so a view that arrives
        // without them has nothing to state and says which range it was asked
        // for instead.
        const data = await collectWithView({
            ...ACTIVITY_VIEW,
            timeline: [{ label: "Jan 2026", value: 3 }],
        });

        expect(data.rangeLabel).toBe("Last 12 months");
        expect(dashboardNamed(data, "Analytics").subtitle).toBe("Last 12 months");
    });

    it("builds the activity dashboard from a view with no peak hour", async () => {
        // The view crosses a worker boundary unvalidated. A missing peak hour
        // must not fail the whole export, so the dashboard is built without it.
        const data = await collectWithView({ ...ACTIVITY_VIEW, peakHour: null });

        expect(dashboardNamed(data, "Analytics").stats).toEqual([
            { label: "Posts", value: "12" },
            { label: "Comments", value: "30" },
            { label: "Total activity", value: "42" },
            { label: "Current streak", value: "3 days" },
        ]);
    });

    it("builds the activity dashboard from a view with no streaks", async () => {
        const data = await collectWithView({ ...ACTIVITY_VIEW, streaks: undefined });

        expect(dashboardNamed(data, "Analytics").stats).toEqual([
            { label: "Posts", value: "12" },
            { label: "Comments", value: "30" },
            { label: "Total activity", value: "42" },
            { label: "Peak hour", value: "09:00" },
        ]);
    });

    it("omits the activity dashboard when the range holds no activity", async () => {
        const data = await collectWithView({
            ...ACTIVITY_VIEW,
            totals: { posts: 0, comments: 0, total: 0 },
        });

        expect(data.dashboards).toEqual([]);
    });

    it("orders the dashboards the way the site divides", async () => {
        // Dashboards are one array in document order, so a new dashboard is one entry.
        storeFiles({ messages: MESSAGES_CSV, connections: connectionsCsv() });
        loadConnectionsData.mockResolvedValue(connectionsData(connectionsCsv()));
        loadMessagesState.mockResolvedValue(messagesState(true));
        DataCache.set(INSIGHTS_EXPORT_CACHE_KEY, {
            timeRange: "12m",
            insights: [{ title: "Mornings win", body: "…" }],
            view: ACTIVITY_VIEW,
        });

        const data = await collectExportData();

        expect(data.dashboards.map((dashboard) => dashboard.title)).toEqual([
            "Analytics",
            "Connections",
            "Messages",
        ]);
    });

    it("builds the connections dashboard over the whole network", async () => {
        // Uses "All time" rather than the screen's twelve-month default. The growth
        // chart is all-time, so one page must not carry two ranges.
        storeFiles({ connections: connectionsCsv() });
        loadConnectionsData.mockResolvedValue(connectionsData(connectionsCsv()));

        const connections = dashboardNamed(await collectExportData(), "Connections");

        expect(loadConnectionsData).toHaveBeenCalledWith(stored(connectionsCsv()), {
            isCancelled: expect.any(Function),
        });
        expect(connections.subtitle).toBe("All time");
        // No "In selected range" tile. An all-time page keeps every row, so that
        // tile would only repeat the total under a label naming a control the
        // reader cannot see.
        expect(connections.stats).toEqual([
            { label: "Total connections", value: "2" },
            { label: "Top company", value: "Analytical Engines" },
            { label: "Network age", value: "1 mo" },
        ]);
        expect(connections.charts.map((chart) => [chart.type, chart.title])).toEqual([
            ["line", "Connection growth"],
            ["bar", "Top companies"],
            ["bar", "Top positions"],
        ]);
        expect(connections.charts[0].points).toEqual(connectionsData(connectionsCsv()).timeline);
        expect(connections.charts[1].items).toContainEqual({ topic: "Navy", count: 1 });
    });

    it("still fills the connections charts when every connection predates the year", async () => {
        // Most connections are older than twelve months, so a twelve-month range
        // would leave the company and position charts empty.
        storeFiles({ connections: agedConnectionsCsv() });
        loadConnectionsData.mockResolvedValue(connectionsData(agedConnectionsCsv()));

        const connections = dashboardNamed(await collectExportData(), "Connections");

        expect(connections.subtitle).toBe("All time");
        expect(connections.stats).toContainEqual({ label: "Total connections", value: "2" });
        expect(connections.charts[1].items).toEqual([
            { topic: "Analytical Engines", count: 1 },
            { topic: "Navy", count: 1 },
        ]);
        expect(connections.charts[2].items).toEqual([
            { topic: "Mathematician", count: 1 },
            { topic: "Rear Admiral", count: 1 },
        ]);
    });

    it("omits the connections dashboard when there is no file to build it from", async () => {
        const data = await collectExportData();

        expect(dashboardNamed(data, "Connections")).toBeNull();
        // Nothing is handed to the transport, so no worker is started for a file
        // that was never uploaded.
        expect(loadConnectionsData).not.toHaveBeenCalled();
    });

    it("omits the connections dashboard when the transport finds nothing", async () => {
        storeFiles({ connections: "not,a,connections,export" });

        const data = await collectExportData();

        expect(loadConnectionsData).toHaveBeenCalled();
        expect(dashboardNamed(data, "Connections")).toBeNull();
    });

    it("drops the connections dashboard when the run is abandoned during the parse", async () => {
        // The run is checked again after the parse, so no dashboard is built for
        // an abandoned run.
        let cancelled = false;
        storeFiles({ connections: connectionsCsv() });
        loadConnectionsData.mockImplementation(() => {
            cancelled = true;
            return Promise.resolve(connectionsData(connectionsCsv()));
        });

        const data = await collectExportData({ isCancelled: () => cancelled });

        expect(loadConnectionsData).toHaveBeenCalled();
        expect(dashboardNamed(data, "Connections")).toBeNull();
    });

    it("never reports what an unbuildable connections dashboard carried", async () => {
        const thrown = piiError("connections-dashboard");
        storeFiles({ connections: connectionsCsv() });
        loadConnectionsData.mockRejectedValue(thrown);

        const data = await collectExportData();

        // The section goes; the export it sits in does not.
        expect(dashboardNamed(data, "Connections")).toBeNull();
        expect(data.rangeLabel).toBe("Last 12 months");

        const [reported, context] = capturedFor("build-connections-dashboard");
        expectFixedError(reported, thrown);
        expect(context).toEqual({ module: "pdf-export", operation: "build-connections-dashboard" });
    });

    it("reads each stored file once and passes the text to every consumer", async () => {
        // Read each stored upload once and share it across consumers.
        storeFiles({ messages: MESSAGES_CSV, connections: connectionsCsv() });
        loadMessagesState.mockResolvedValue(messagesState(true));
        loadConnectionsData.mockResolvedValue(connectionsData(connectionsCsv()));

        const data = await collectExportData({ includeNames: true, includeMessages: true });

        expect(Storage.getFile.mock.calls.map(([type]) => type).sort()).toEqual([
            "connections",
            "messages",
        ]);
        // One read each, and all four consumers were still served from it.
        expect(dashboardNamed(data, "Connections")).not.toBeNull();
        expect(dashboardNamed(data, "Messages")).not.toBeNull();
        expect(loadConnectionsData).toHaveBeenCalledWith(stored(connectionsCsv()), {
            isCancelled: expect.any(Function),
        });
        expect(loadMessagesState).toHaveBeenCalledWith(stored(MESSAGES_CSV), stored(connectionsCsv()), {
            isCancelled: expect.any(Function),
        });
        expect(loadRecentThreads).toHaveBeenCalledWith(stored(MESSAGES_CSV), stored(connectionsCsv()), {
            isCancelled: expect.any(Function),
        });
    });

    it("builds the messages dashboard with the people lists opted into", async () => {
        storeFiles({ messages: MESSAGES_CSV, connections: connectionsCsv() });
        loadMessagesState.mockResolvedValue(messagesState(true));

        const messages = dashboardNamed(await collectExportData({ includeNames: true }), "Messages");

        // The caption includes both the all-time and dated ranges represented
        // on the messages dashboard.
        expect(messages.subtitle).toBe(
            `Messages and people: ${messageWindowLabel(LAST_MESSAGE_MS)}. ` +
                "Connections, silent and fading: all time.",
        );
        expect(messages.stats).toEqual([
            { label: "Messages in range", value: "2" },
            { label: "People in range", value: "1" },
            { label: "Total connections", value: "3" },
            { label: "Fading conversations", value: "1" },
        ]);
        // The aggregate chart comes first, then the Messages screen's panel order.
        // Each row keeps its dates and units.
        expect(messages.charts.map((chart) => chart.title)).toEqual([
            "Messages per month",
            "Top contacts",
            "Silent connections",
            "Fading conversations",
        ]);
        expect(messages.charts[1].items).toEqual([
            {
                primary: "Ada Lovelace",
                secondary: `Last message: ${formatShortDate(LAST_MESSAGE_MS)}`,
                value: "2 msgs",
            },
        ]);
        expect(messages.charts[2].items).toEqual([
            {
                primary: "Grace Hopper",
                secondary: "Rear Admiral @ Navy",
                value: formatShortDate(GRACE_CONNECTED_MS),
            },
            // No position, company or date. The screen leaves the line blank, but
            // the page reports the missing data so the columns do not look broken.
            { primary: "Alan Turing", secondary: "No role info", value: "No date" },
        ]);
        expect(messages.charts[3].items).toEqual([
            {
                primary: "Ada Lovelace",
                secondary: `Last message: ${formatShortDate(LAST_MESSAGE_MS)}`,
                value: "60 days",
            },
        ]);
    });

    it("keeps an empty silent connections list when no connections file was parsed", async () => {
        // The list is always built; the layout engine drops an empty one, so the
        // dashboard does not have to know whether a connections file existed.
        storeFiles({ messages: MESSAGES_CSV });
        loadMessagesState.mockResolvedValue(messagesState(false));

        const messages = dashboardNamed(await collectExportData({ includeNames: true }), "Messages");

        expect(messages.charts.map((chart) => chart.title)).toEqual([
            "Messages per month",
            "Top contacts",
            "Silent connections",
            "Fading conversations",
        ]);
        expect(messages.charts[2].items).toEqual([]);
        expect(messages.charts[3].items).toEqual([]);
        expect(messages.stats).toContainEqual({ label: "Total connections", value: "0" });
        expect(messages.stats).toContainEqual({ label: "Fading conversations", value: "0" });
    });

    it("says so on a list it is only showing the head of", async () => {
        // The page has no "Full list" button, so a truncated list is titled with
        // its total, for example "top 10 of 12".
        storeFiles({ messages: MESSAGES_CSV, connections: connectionsCsv() });
        loadMessagesState.mockResolvedValue(crowdedMessagesState());

        const messages = dashboardNamed(await collectExportData({ includeNames: true }), "Messages");

        expect(messages.charts[1].title).toBe("Top contacts (top 10 of 12)");
        expect(messages.charts[1].items).toHaveLength(10);
        // Ten exactly is the whole list, so it is titled as one.
        expect(messages.charts[2].title).toBe("Silent connections");
        expect(messages.charts[2].items).toHaveLength(10);
    });

    it("keeps the message counts but no names when the lists were not opted into", async () => {
        // Include named contact lists only after the names opt-in.
        storeFiles({ messages: MESSAGES_CSV, connections: connectionsCsv() });
        loadMessagesState.mockResolvedValue(messagesState(true));

        const messages = dashboardNamed(await collectExportData(), "Messages");

        expect(messages.stats).toHaveLength(4);
        // Without the names opt-in, the messages-per-month chart is the only one,
        // since it names nobody.
        expect(messages.charts.map((chart) => chart.title)).toEqual(["Messages per month"]);
    });

    it("counts the messages in range by month, gap-filled to the window", async () => {
        // Aggregated from the timestamps the parse already produced, and its
        // months add up to the "Messages in range" tile above it.
        storeFiles({ messages: MESSAGES_CSV });
        loadMessagesState.mockResolvedValue(messagesState(false));

        const messages = dashboardNamed(await collectExportData(), "Messages");
        const [timeline] = messages.charts;

        expect(timeline.type).toBe("line");
        // Always twelve months, so quiet months still appear on the line.
        expect(timeline.points).toHaveLength(12);
        expect(timeline.points.map((point) => point.value).reduce((a, b) => a + b, 0)).toBe(2);
        const last = timeline.points[timeline.points.length - 1];
        expect(last.key).toBe(
            `${new Date(LAST_MESSAGE_MS).getFullYear()}-${String(
                new Date(LAST_MESSAGE_MS).getMonth() + 1,
            ).padStart(2, "0")}`,
        );
        expect(last.label).toBe(
            `${MONTH_NAMES[new Date(LAST_MESSAGE_MS).getMonth()]} ${new Date(
                LAST_MESSAGE_MS,
            ).getFullYear()}`,
        );
        expect(messages.stats).toContainEqual({ label: "Messages in range", value: "2" });
    });

    it("leaves out the messages timeline when nothing was said in the window", async () => {
        // A timeline of zeroes would be an empty chart, so it is left out.
        storeFiles({ messages: MESSAGES_CSV });
        loadMessagesState.mockResolvedValue({
            messageState: hydrateMessageState({
                contacts: [],
                events: compactEvents([]),
                rowTimestamps: Float64Array.of(),
                latestTimestamp: LAST_MESSAGE_MS,
            }),
            connectionState: null,
        });

        const messages = dashboardNamed(await collectExportData(), "Messages");

        expect(messages.charts[0].points).toEqual([]);
    });

    it("keeps the relative caption when the file holds no dated message", async () => {
        // Nothing to anchor a window on, so there is no window to print and no
        // month to bucket by: the caption falls back to the range's own name.
        storeFiles({ messages: MESSAGES_CSV, connections: connectionsCsv() });
        loadConnectionsData.mockResolvedValue(connectionsData(connectionsCsv()));
        loadMessagesState.mockResolvedValue({
            messageState: hydrateMessageState({
                contacts: [],
                events: compactEvents([]),
                rowTimestamps: Float64Array.of(),
            }),
            connectionState: null,
        });

        const data = await collectExportData();
        const messages = dashboardNamed(data, "Messages");

        expect(messages.subtitle).toBe(
            "Messages and people: last 12 months. Connections, silent and fading: all time.",
        );
        expect(messages.charts).toEqual([]);
        expect(data.rangeLabel).toBe("Last 12 months");
    });

    it("marks the characters the document's fonts cannot draw", async () => {
        // The embedded faces are Latin, so characters without a glyph are marked
        // with "?". The finished model is sanitized once, so names, chart labels
        // and message bodies all get the same treatment.
        storeFiles({ messages: MESSAGES_CSV });
        loadMessagesState.mockResolvedValue({
            messageState: hydrateMessageState({
                contacts: [
                    {
                        key: ADA_KEY,
                        name: "Ňuňo319 陈",
                        url: ADA_URL,
                        count: 1,
                        lastTimestamp: LAST_MESSAGE_MS,
                    },
                ],
                events: compactEvents([{ contactKey: ADA_KEY, timestamp: LAST_MESSAGE_MS }]),
                rowTimestamps: Float64Array.of(LAST_MESSAGE_MS),
                latestTimestamp: LAST_MESSAGE_MS,
            }),
            connectionState: null,
        });
        loadRecentThreads.mockResolvedValue([
            { title: "田中 Fernández-Hall", messages: [{ body: "Спасибо, Björn" }] },
        ]);
        DataCache.set(INSIGHTS_EXPORT_CACHE_KEY, {
            timeRange: "12m",
            insights: [{ title: "Καλημέρα", body: "Müller replied" }],
            view: ACTIVITY_VIEW,
        });

        const data = await collectExportData({ includeNames: true, includeMessages: true });
        const messages = dashboardNamed(data, "Messages");

        expect(messages.charts[1].items[0].primary).toBe("?u?o319 ?");
        expect(data.insights).toEqual([{ title: "?", body: "Müller replied" }]);
        expect(data.threads).toEqual([
            // Latin-1 survives whole; only what the faces cannot spell is marked.
            { title: "? Fernández-Hall", messages: [{ body: "?, Björn" }] },
        ]);
    });

    it("omits the messages dashboard when the parse comes back empty", async () => {
        storeFiles({ messages: MESSAGES_CSV });

        expect(dashboardNamed(await collectExportData(), "Messages")).toBeNull();
    });

    it("drops the messages dashboard when the run is abandoned during the parse", async () => {
        // The run is checked again after the parse, so no state is walked for an
        // abandoned run.
        let cancelled = false;
        storeFiles({ messages: MESSAGES_CSV, connections: connectionsCsv() });
        loadMessagesState.mockImplementation(() => {
            cancelled = true;
            return Promise.resolve(messagesState(true));
        });

        const data = await collectExportData({
            includeNames: true,
            includeMessages: true,
            isCancelled: () => cancelled,
        });

        expect(loadMessagesState).toHaveBeenCalled();
        expect(dashboardNamed(data, "Messages")).toBeNull();
        // The run stops before the threads worker and the connections transport
        // start.
        expect(loadRecentThreads).not.toHaveBeenCalled();
        expect(loadConnectionsData).not.toHaveBeenCalled();
        expect(data.threads).toEqual([]);
    });

    it("never reports what an unbuildable messages dashboard carried", async () => {
        const thrown = piiError("messages-dashboard");
        storeFiles({ messages: MESSAGES_CSV });
        loadMessagesState.mockRejectedValue(thrown);

        const data = await collectExportData({ includeNames: true });

        expect(dashboardNamed(data, "Messages")).toBeNull();
        expect(data.rangeLabel).toBe("Last 12 months");

        const [reported, context] = capturedFor("build-messages-dashboard");
        expectFixedError(reported, thrown);
        expect(context).toEqual({ module: "pdf-export", operation: "build-messages-dashboard" });
    });

    it("drops both dashboards when the stored file reads throw", async () => {
        const thrown = piiError("dashboard-storage");
        Storage.getFile.mockRejectedValue(thrown);

        const data = await collectExportData();

        expect(data.dashboards).toEqual([]);
        for (const operation of ["load-connections-file", "load-messages-file"]) {
            const [reported] = capturedFor(operation);
            expectFixedError(reported, thrown);
        }
    });

    it("never reports what an unreadable stored record carried", async () => {
        const thrown = piiError("record-blob");
        Storage.getFile.mockResolvedValue({
            get blob() {
                throw thrown;
            },
        });

        const data = await collectExportData({ includeMessages: true });

        expect(data.dashboards).toEqual([]);
        expect(data.threads).toEqual([]);

        const [reported, context] = capturedFor("read-export-files");
        expectFixedError(reported, thrown);
        expect(context).toEqual({ module: "pdf-export", operation: "read-export-files" });
    });

    it("refuses message contents from a messages file over the limit before any worker", async () => {
        const large = { size: THREADS_EXPORT_MAX_BYTES + 1 };
        Object.setPrototypeOf(large, Blob.prototype);
        Storage.getFile.mockImplementation((type) =>
            Promise.resolve(type === "messages" ? { blob: large } : null),
        );

        const refused = collectExportData({ includeMessages: true });

        await expect(refused).rejects.toBeInstanceOf(ExportRefusal);
        await expect(refused).rejects.toThrow(MESSAGES_TOO_LARGE_FOR_CONTENTS);
        expect(loadMessagesState).not.toHaveBeenCalled();
        expect(loadRecentThreads).not.toHaveBeenCalled();

        // Without contents the same file exports as usual.
        await collectExportData({ includeMessages: false });
        expect(loadMessagesState).toHaveBeenCalled();
    });

    it("includes threads only when the user opted in", async () => {
        storeFiles({ messages: MESSAGES_CSV, connections: connectionsCsv() });
        loadRecentThreads.mockResolvedValue([{ name: "Ada", messages: [] }]);

        expect((await collectExportData({ includeMessages: false })).threads).toEqual([]);
        expect(loadRecentThreads).not.toHaveBeenCalled();

        const data = await collectExportData({ includeMessages: true });
        expect(data.threads).toEqual([{ name: "Ada", messages: [] }]);
        expect(loadRecentThreads).toHaveBeenCalledWith(stored(MESSAGES_CSV), stored(connectionsCsv()), {
            isCancelled: expect.any(Function),
        });
    });

    it("passes the connections file through raw as a self-detection tiebreak", async () => {
        // Send the raw connections source to the worker to derive tiebreak keys.
        // Neither CSV parser entry point may run on the page for this step.
        const connections = [
            // LinkedIn puts three notes rows above the header.
            "Notes:",
            "",
            "",
            "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
            `Ada,Lovelace,${ADA_URL},,Acme,Engineer,01 Jan 2026`,
        ].join("\n");
        storeFiles({ messages: MESSAGES_CSV, connections });
        // Both entry points: `parseCSV` is module-local and merely re-exposed
        // on the object, so cleaner.js's own calls to it hit the local binding
        // and this spy never sees them.
        const parseCSV = vi.spyOn(LinkedInCleaner, "parseCSV");
        const processFile = vi.spyOn(LinkedInCleaner, "process");

        await collectExportData({ includeMessages: true });

        expect(loadRecentThreads.mock.calls[0][1]).toBe(stored(connections));
        expect(loadRecentThreads.mock.calls[0][2].contactKeys).toBeUndefined();
        expect(parseCSV).not.toHaveBeenCalled();
        expect(processFile).not.toHaveBeenCalled();
    });

    it("passes an empty string when there is no connections file", async () => {
        storeFiles({ messages: MESSAGES_CSV });

        await collectExportData({ includeMessages: true });

        expect(loadRecentThreads.mock.calls[0][1]).toBe("");
    });

    it("never reports the exception a rejected connections read carried", async () => {
        // Distinct from the unreadable-text case above: this one rejects the read
        // itself, and is reported under its own operation.
        const thrown = piiError("connections-storage");
        Storage.getFile.mockImplementation((type) =>
            type === "connections"
                ? Promise.reject(thrown)
                : Promise.resolve({ blob: stored(MESSAGES_CSV) }),
        );

        await collectExportData({ includeMessages: true });

        const [reported, context] = capturedFor("load-connections-file");
        expectFixedError(reported, thrown);
        expect(context).toEqual({ module: "pdf-export", operation: "load-connections-file" });
        expect(loadRecentThreads.mock.calls[0][1]).toBe("");
    });

    it("omits threads when no messages file was uploaded", async () => {
        Storage.getFile.mockResolvedValue(null);

        expect((await collectExportData({ includeMessages: true })).threads).toEqual([]);
        expect(loadRecentThreads).not.toHaveBeenCalled();
    });

    it("omits threads when the stored record has no upload", async () => {
        Storage.getFile.mockResolvedValue({ blob: null });

        expect((await collectExportData({ includeMessages: true })).threads).toEqual([]);
    });

    it("drops the thread section when selection fails", async () => {
        storeFiles({ messages: MESSAGES_CSV });
        loadRecentThreads.mockRejectedValue(new Error("worker exploded"));

        expect((await collectExportData({ includeMessages: true })).threads).toEqual([]);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "select-threads",
        });
    });

    it("never reports the exception a thread-selection failure carried", async () => {
        const thrown = piiError("selection");
        storeFiles({ messages: MESSAGES_CSV });
        loadRecentThreads.mockRejectedValue(thrown);

        await collectExportData({ includeMessages: true });

        const [reported, context] = capturedFor("select-threads");
        expectFixedError(reported, thrown);
        expect(context).toEqual({ module: "pdf-export", operation: "select-threads" });
    });

    it("never reports the exception a stored-file read carried", async () => {
        const thrown = piiError("storage");
        Storage.getFile.mockRejectedValue(thrown);

        expect((await collectExportData({ includeMessages: true })).threads).toEqual([]);

        const [reported, context] = capturedFor("load-messages-file");
        expectFixedError(reported, thrown);
        expect(context).toEqual({ module: "pdf-export", operation: "load-messages-file" });
    });
});
