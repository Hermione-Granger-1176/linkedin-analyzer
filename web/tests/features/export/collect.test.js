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

// Both dashboards parse through a transport of the export's own, each owning a
// worker of its own. Stubbing them, exactly as the threads transport above is
// stubbed, keeps this suite about what a dashboard makes of a parse rather than
// about how the parse happened.
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

// Read once for the whole file. "In selected range", "network age" and the day
// counts on the fading list are all measured against the clock, so the fixtures
// are dated relative to it and the expected strings are derived from the same
// instant rather than from a second read that has since moved on.
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
    // Keyed as the analytics worker keys its points, because the export reads
    // the window it prints off the first and the last of them.
    timeline: [
        { key: "2026-01", label: "Jan 2026", value: 3 },
        { key: "2026-02", label: "Feb 2026", value: 6 },
    ],
    topics: [{ topic: "hiring", count: 4 }],
    heatmap: [[1, 0], [0, 2]],
    networkGrowth: { multiplier: 2.1 },
});

/**
 * Name the twelve-month window a messages dashboard covers.
 *
 * Derived from the same instant the fixtures are dated against rather than
 * written out: the window is anchored on the newest message in the file, so a
 * hard-coded pair of months would start failing in a month nobody chose.
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
 * Build a stored connections export, dated relative to now.
 *
 * Relative rather than fixed: "in selected range" and "network age" are both
 * measured against the clock, so hard-coded dates would make this suite start
 * failing on a date nobody chose.
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
 * The shape most people's exports have: the screen's twelve-month default would
 * leave this file with nothing in range at all.
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
 * Build what the export's connections transport resolves a CSV with.
 *
 * Run through the same view helpers the transport itself uses rather than
 * written out by hand: the dashboard's stats and charts are aggregated from
 * these rows, and a fixture that invented them would keep passing after the
 * shape the worker answers in changed.
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
 * Find one dashboard in the document by its title.
 *
 * The model carries dashboards in document order rather than a field per
 * screen, and drops the ones that found nothing, so a test that wants a
 * particular page asks for it by name.
 * @param {object} data - Document model
 * @param {string} title - Dashboard title
 * @returns {object|null} Dashboard, or null when the document has none
 */
function dashboardNamed(data, title) {
    return data.dashboards.find((dashboard) => dashboard.title === title) || null;
}

/**
 * Build the hydrated state the export's messages transport resolves with.
 *
 * Run through the same hydration the transport itself applies rather than
 * written out by hand: the dashboard reads `contacts` as a Map and the
 * talked-to keys as Sets, and a fixture that skipped that step would keep
 * passing after either shape changed.
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
            events: [
                { contactKey: ADA_KEY, timestamp: LAST_MESSAGE_MS },
                { contactKey: ADA_KEY, timestamp: LAST_MESSAGE_MS - DAY_MS },
            ],
            rowTimestamps: [LAST_MESSAGE_MS, LAST_MESSAGE_MS - DAY_MS],
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
            events: contacts.map((contact) => ({
                contactKey: contact.key,
                timestamp: LAST_MESSAGE_MS,
            })),
            rowTimestamps: contacts.map(() => LAST_MESSAGE_MS),
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
     * Find the captureError call made for one operation.
     *
     * Addressed by operation rather than by index: collection walks several
     * reads before the one under test, so a diagnostic added anywhere earlier
     * would silently shift index 0 and the assertions would start describing a
     * different call while still passing.
     * @param {string} operation - Fixed diagnostic operation
     * @returns {[unknown, object]} Reported value and its context
     */
    function capturedFor(operation) {
        const call = captureError.mock.calls.find(([, context]) => context.operation === operation);
        expect(call, `no captureError for ${operation}`).toBeDefined();
        return call;
    }

    /**
     * Answer both stored-file reads with the texts a full export would find.
     * @param {{messages?: string|null, connections?: string|null}} texts - Stored texts
     */
    function storeFiles(texts) {
        Storage.getFile.mockImplementation((type) => {
            const text = type === "messages" ? texts.messages : texts.connections;
            return Promise.resolve(text ? { text } : null);
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
        // This snapshot predates the screen keeping its view, so the base is
        // still read for the activity dashboard. There is none here, so the
        // worker never starts and no dashboard finds anything to show.
        expect(Storage.getAnalytics).toHaveBeenCalled();
        expect(workerInstance).toBeNull();
        expect(data.dashboards).toEqual([]);
    });

    it("plots the snapshot's own view without starting the analytics worker", async () => {
        // The fast path the snapshot exists to be: exporting from the Insights
        // screen costs no worker run at all, because that screen has already
        // been handed the timeline, topics and heatmap this page is drawn from.
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
        // The months the view actually covers, not the name of the control it
        // was selected with: the range is anchored on the newest event in the
        // file, so "Last 3 months" stops being true the day after the export.
        expect(activity.subtitle).toBe("Jan 2026 to Feb 2026");
        expect(activity.charts[0].points).toEqual(ACTIVITY_VIEW.timeline);
        expect(activity.charts[1].items).toEqual(ACTIVITY_VIEW.topics);
        expect(activity.charts[2].grid).toEqual(ACTIVITY_VIEW.heatmap);
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
        expect(data.allTime[0]).toEqual({ label: "Network growth", value: "3.4×" });
        expect(workerInstance).toBeNull();
    });

    it("leaves the growth tile out when the snapshot carries no multiple", async () => {
        // A growth object with no multiplier on it, which is not the same as no
        // growth object at all. Relaxed to a truthiness check, the guard would
        // let this through and print a tile reading "undefined×".
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
        // An older snapshot carries no view, so the worker supplies the charts -
        // and has to be asked for the same range the header will print. A
        // document headed with one window over a chart of another lies about
        // itself.
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
        // Cancellation cannot only be checked on the way back: collection walks
        // several storage reads before it reaches either worker, and
        // terminating a worker that does not exist yet does nothing at all.
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

        // Stronger than "did not throw", which would also pass while quietly
        // cancelling a run left active by an earlier test.
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
        // The stale envelope carries content, so processing it instead of
        // dropping it is visible in the result rather than indistinguishable
        // from dropping it.
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
        // This worker derives topics from the user's own share commentary and
        // comment text, so an uncancelled error event is reported to the console
        // along with whatever it was reading.
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
        // The Analytics screen's own wording: a reader who knows the screen
        // should recognise the page.
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
        // The view crosses a worker boundary unvalidated and this runs outside
        // the try the other dashboards sit in, so a half-built one used to take
        // down the whole export rather than one stat on one page.
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
        // One array in document order rather than a field per screen, so a
        // fourth dashboard is an entry here instead of a change in four files.
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
        // "All time", not the screen's twelve-month default: on paper the range
        // control the default sits beside cannot be moved, and the growth chart
        // is all-time either way, so one page would otherwise carry two ranges.
        storeFiles({ connections: connectionsCsv() });
        loadConnectionsData.mockResolvedValue(connectionsData(connectionsCsv()));

        const connections = dashboardNamed(await collectExportData(), "Connections");

        expect(loadConnectionsData).toHaveBeenCalledWith(connectionsCsv(), {
            isCancelled: expect.any(Function),
        });
        expect(connections.subtitle).toBe("All time");
        // No "In selected range" tile: it counts the rows the range kept, and
        // an all-time page keeps every one of them, so it could only ever
        // restate the total beside it under a label naming a control the reader
        // cannot see.
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
        // The reason the page is all-time at all: most people's connections are
        // older than twelve months, and the screen's default would print a page
        // whose company and position charts are empty.
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
        // The parse is the longest step on this path, so the run is checked
        // again on the way out rather than aggregating the whole network for a
        // page nobody will read.
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
        // The connections export used to be read and re-read once per consumer,
        // which is both the slow way round and an odd thing to do alongside a
        // promise to keep only one copy of it in memory.
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
        expect(loadConnectionsData).toHaveBeenCalledWith(connectionsCsv(), {
            isCancelled: expect.any(Function),
        });
        expect(loadMessagesState).toHaveBeenCalledWith(MESSAGES_CSV, connectionsCsv(), {
            isCancelled: expect.any(Function),
        });
        expect(loadRecentThreads).toHaveBeenCalledWith(MESSAGES_CSV, connectionsCsv(), {
            isCancelled: expect.any(Function),
        });
    });

    it("builds the messages dashboard with the people lists opted into", async () => {
        storeFiles({ messages: MESSAGES_CSV, connections: connectionsCsv() });
        loadMessagesState.mockResolvedValue(messagesState(true));

        const messages = dashboardNamed(await collectExportData({ includeNames: true }), "Messages");

        // Two ranges live on this page, so the caption names both rather than
        // printing one over the top of the other: on screen each panel carries
        // its own line of copy saying what it counts, and the page keeps only
        // the caption. The ranged half names the months it covers, because
        // "last 12 months" beside a generation date is only true on the day.
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
        // The aggregate chart first, then the Messages screen's panel order,
        // and so is the detail on each row: a list that dropped the dates and
        // the units would be the same names carrying less than the page they
        // were copied from.
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
            // Neither a position nor a company, and no date on the record. The
            // screen leaves the line blank; a page whose middle column simply
            // stopped would read as a rendering fault, so it says so.
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
        // The screen puts a "Full list" button beside each panel, so the reader
        // can see that ten is not all of them. The page has no such cue, and a
        // list of ten under a stat tile reading 12 would look like a
        // contradiction.
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
        // A file the reader may forward is not the place to put somebody else's
        // name without being asked; the totals above them are nobody's.
        storeFiles({ messages: MESSAGES_CSV, connections: connectionsCsv() });
        loadMessagesState.mockResolvedValue(messagesState(true));

        const messages = dashboardNamed(await collectExportData(), "Messages");

        expect(messages.stats).toHaveLength(4);
        // The default settings, and the only chart on the page that names
        // nobody. Without it this sheet was four stat tiles and blank paper.
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
        // Twelve months whether or not anything happened in them, so the line
        // is not drawn as if the quiet months did not exist.
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
        // A year of zeroes drawn as a flat line is the empty axes the layout
        // engine drops a chart to avoid.
        storeFiles({ messages: MESSAGES_CSV });
        loadMessagesState.mockResolvedValue({
            messageState: hydrateMessageState({
                contacts: [],
                events: [],
                rowTimestamps: [],
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
            messageState: hydrateMessageState({ contacts: [], events: [], rowTimestamps: [] }),
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
        // The embedded faces are Latin and jsPDF omits what they have no glyph
        // for, so "Ňuňo319 陈" reached the page as "uo319" with nothing to say a
        // surname had been lost. Sanitizing the finished model catches every
        // section at once: a name in a list, a topic on a chart, and a message
        // body all take the same pass.
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
                events: [{ contactKey: ADA_KEY, timestamp: LAST_MESSAGE_MS }],
                rowTimestamps: [LAST_MESSAGE_MS],
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
        // The parse is the longest step on this path, so the run is checked
        // again on the way out rather than walking the whole state for a page
        // nobody will read.
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
        // And the run stops before the threads worker and the connections
        // transport too, rather than handing either a whole CSV on behalf of
        // nobody.
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
        const thrown = piiError("record-text");
        Storage.getFile.mockResolvedValue({
            get text() {
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

    it("includes threads only when the user opted in", async () => {
        storeFiles({ messages: MESSAGES_CSV, connections: connectionsCsv() });
        loadRecentThreads.mockResolvedValue([{ name: "Ada", messages: [] }]);

        expect((await collectExportData({ includeMessages: false })).threads).toEqual([]);
        expect(loadRecentThreads).not.toHaveBeenCalled();

        const data = await collectExportData({ includeMessages: true });
        expect(data.threads).toEqual([{ name: "Ada", messages: [] }]);
        expect(loadRecentThreads).toHaveBeenCalledWith(MESSAGES_CSV, connectionsCsv(), {
            isCancelled: expect.any(Function),
        });
    });

    it("passes the connections file through raw as a self-detection tiebreak", async () => {
        // Raw, and parsed by nobody on this thread: the keys are derived inside
        // the transport's worker. Reading them out here was the last whole-file
        // parse the export ran on the UI thread, and it ran on every export that
        // opted message contents in.
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

        expect(loadRecentThreads.mock.calls[0][1]).toBe(connections);
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
        // Distinct from the unreadable-text case above: this one rejects the
        // read itself, which is reported under a different operation and was
        // the one leak path on the connections file with no test behind it.
        const thrown = piiError("connections-storage");
        Storage.getFile.mockImplementation((type) =>
            type === "connections"
                ? Promise.reject(thrown)
                : Promise.resolve({ text: MESSAGES_CSV }),
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

    it("omits threads when the stored text record is empty", async () => {
        Storage.getFile.mockResolvedValue({ text: "" });

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
