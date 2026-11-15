/**
 * Build the PDF document model.
 *
 * Reuse a screen snapshot when available. Otherwise, read stored uploads and
 * compute each dashboard through workers owned by this export. Each dashboard
 * follows its corresponding screen.
 */

import { parseAnalyticsWorkerMessage } from "../../app/worker-contracts.ts";
import { captureError } from "../../platform/observability/sentry.js";
import { DataCache } from "../../platform/persistence/data-cache.js";
import { Storage } from "../../platform/persistence/storage.js";
import { INSIGHTS_EXPORT_CACHE_KEY } from "../../shared/constants.js";
import { csvSourceSize } from "../../shared/csv-source.js";
import { THREADS_EXPORT_MAX_BYTES } from "../../shared/limits.js";
import { createWorkerHandle } from "../../shared/worker-handle.js";
import { enumerateMonths, monthKeyToLabel, toMonthKey } from "../analytics/dates.js";
import { buildConnectionsView } from "../connections/view.js";
import {
    DEFAULT_TIME_RANGE,
    formatReplyRate,
    formatSentRatio,
    formatShortDate,
    getRangeStart,
} from "../messages/format.js";
import {
    getFadingConversations,
    getSilentConnections,
    getTopContactsInRange,
} from "../messages/relationships.js";

import { hasSnapshotContent, readAnalyticsBase, readOutreach, readSafely } from "./availability.js";
import { loadConnectionsData } from "./connections-transport.js";
import { sanitizeModel } from "./drawable-text.js";
import { readDrawableCoverage } from "./fonts.js";
import { loadMessagesState } from "./messages-transport.js";
import { ExportRefusal, MESSAGES_TOO_LARGE_FOR_CONTENTS } from "./refusal.js";
import { loadRecentThreads } from "./threads-transport.js";

const WORKER_TIMEOUT_MS = 30000;

/**
 * @typedef {import("./availability.js").ExportAnalyticsView} ExportAnalyticsView
 * @typedef {import("./availability.js").InsightsSnapshot} InsightsSnapshot
 * @typedef {import("./availability.js").NetworkGrowth} NetworkGrowth
 * @typedef {import("./availability.js").OutreachSummary} OutreachSummary
 * @typedef {import("./pdf-document.js").Insight} Insight
 * @typedef {import("./pdf-document.js").Dashboard} Dashboard
 * @typedef {import("./pdf-document.js").Chart} Chart
 * @typedef {import("./pdf-document.js").ListChart} ListChart
 * @typedef {import("./messages-transport.js").MessageState} MessageState
 * @typedef {import("./messages-transport.js").ConnectionState} ConnectionState
 * @typedef {import("./messages-transport.js").MessagesState} MessagesState
 * @typedef {import("../messages/relationships.js").RangeContact} RangeContact
 * @typedef {import("../messages/relationships.js").FadingConversation} FadingConversation
 */

/**
 * What one analytics worker run produced for the export.
 * @typedef {object} AnalyticsRun
 * @property {Insight[]} insights - Insight cards in display order
 * @property {string|null} tip - Closing tip, when there is one
 * @property {NetworkGrowth|null} networkGrowth - Lifetime network growth
 * @property {ExportAnalyticsView|null} view - Filtered analytics view
 */

// Entries per dashboard list. Matches the ten the screens render.
const LIST_LIMIT = 10;

// The connections dashboard covers the whole network, not the screen's
// twelve-month default.
const CONNECTIONS_RANGE = "all";

// The messages dashboard uses the Messages screen's default range, not the
// Insights range. If this were ever "all", there would be no range to anchor the
// timeline window on, and the timeline would be dropped.
const MESSAGES_RANGE = DEFAULT_TIME_RANGE;

/**
 * The analytics worker run in flight, so a cancelled export can end it.
 * @type {{cancel: () => void}|null}
 */
let activeAnalyticsRun = null;

// Same shape the Insights screen sends.
const DEFAULT_FILTERS = Object.freeze({
    timeRange: "12m",
    topic: "all",
    monthFocus: null,
    day: null,
    hour: null,
    shareType: "all",
});

const RANGE_LABELS = Object.freeze({
    "1m": "Last month",
    "3m": "Last 3 months",
    "6m": "Last 6 months",
    "12m": "Last 12 months",
    all: "All time",
});

/**
 * Return a time-range label for sections without dated windows.
 * The connections dashboard uses its all-time label.
 * @param {unknown} timeRange - Filter range key
 * @returns {string} Human-readable range label
 */
export function formatRangeLabel(timeRange) {
    const key = typeof timeRange === "string" ? timeRange : "";
    const labels = /** @type {Record<string, string>} */ (RANGE_LABELS);
    return labels[key] || labels[DEFAULT_FILTERS.timeRange];
}

/**
 * @typedef {{startKey: string, endKey: string}} MonthWindow
 */

/**
 * Label the months a section covers. Return an empty string without a window.
 * Uses calendar dates rather than relative labels such as "Last 12 months".
 * Activity and message windows end at the newest event in the file.
 * @param {MonthWindow|null} monthWindow - Months covered
 * @returns {string} Window label such as "Feb 2024 to Jan 2025", or an empty string
 */
function formatWindow(monthWindow) {
    if (!monthWindow) {
        return "";
    }
    const start = monthKeyToLabel(monthWindow.startKey);
    const end = monthKeyToLabel(monthWindow.endKey);
    // A single month is shown alone, not as a range.
    return start === end ? start : `${start} to ${end}`;
}

/**
 * Read the first and last months from the plotted timeline.
 * Both monthly and weekly points begin with a YYYY-MM date prefix.
 * @param {ExportAnalyticsView|null} view - Filtered analytics view
 * @returns {MonthWindow|null} Window, or null when nothing was plotted
 */
function viewWindow(view) {
    if (!view || !Array.isArray(view.timeline) || !view.timeline.length) {
        return null;
    }
    const { timeline } = view;
    const startKey = String(timeline[0].key || "").slice(0, 7);
    const endKey = String(timeline[timeline.length - 1].key || "").slice(0, 7);
    return startKey && endKey ? { startKey, endKey } : null;
}

/**
 * Read the months covered by the messages dashboard.
 * The range starts at local midnight on the first day of its oldest month.
 * Return null when there is no dated message to anchor the window.
 * @param {number|null} rangeStart - Start of the messages range
 * @param {number} latestTimestamp - Newest message in the file
 * @returns {MonthWindow|null} Window, or null when there is nothing in range
 */
function messageWindow(rangeStart, latestTimestamp) {
    // Compares against null, since a range start of 0 is valid.
    if (rangeStart === null) {
        return null;
    }
    return {
        startKey: toMonthKey(new Date(rangeStart)),
        endKey: toMonthKey(new Date(latestTimestamp)),
    };
}

/**
 * Build the all-time stat list, dropping stats with no data behind them.
 * @param {NetworkGrowth|null} networkGrowth - Lifetime network growth from the view
 * @param {OutreachSummary|null} outreach - Persisted outreach summary
 * @returns {Array<{label: string, value: string}>} Stats in display order
 */
function buildAllTimeStats(networkGrowth, outreach) {
    const stats = [];
    if (networkGrowth && typeof networkGrowth.multiplier === "number") {
        // Uses the multiplication sign U+00D7, which the Insights screen also uses.
        // Both embedded faces and the Helvetica fallback draw it.
        stats.push({ label: "Network growth", value: `${networkGrowth.multiplier}×` });
    }
    if (outreach) {
        stats.push(
            { label: "Outreach initiated", value: String(outreach.selfInitiated) },
            { label: "Reply rate", value: formatReplyRate(outreach.replyRate) },
            { label: "Unanswered", value: String(outreach.unansweredContacts) },
            { label: "Sent : received", value: formatSentRatio(outreach.sentReceivedRatio) },
        );
    }
    return stats;
}

/**
 * Read the payload of an analytics worker "view" reply into what the export keeps.
 * @param {unknown} payload - Reply payload, which may omit any part of the view
 * @returns {AnalyticsRun} The insights, tip, network growth, and view, with null for what is absent
 */
function analyticsRunFromPayload(payload) {
    const reply =
        /** @type {{insights?: {insights?: Insight[], tip?: string|null}, view?: ExportAnalyticsView|null}} */ (
            payload || {}
        );
    const insights = reply.insights || {};
    return {
        insights: insights.insights || [],
        tip: insights.tip || null,
        networkGrowth: (reply.view && reply.view.networkGrowth) || null,
        view: reply.view || null,
    };
}

/**
 * Run a one-shot analytics worker to produce a view and its insights.
 *
 * The worker computes the timeline, topics, and heatmap along with the insight
 * cards. The complete view is kept for the activity dashboard.
 * @param {import("../../platform/persistence/storage.js").StoredAnalytics} analyticsBase - Persisted analytics base
 * @param {string} timeRange - Range key to build the view at
 * @returns {Promise<AnalyticsRun>} Worker view
 */
function runAnalyticsWorker(analyticsBase, timeRange) {
    // The shared empty result is frozen, so callers cannot change it.
    const empty = Object.freeze({ insights: [], tip: null, networkGrowth: null, view: null });

    return new Promise((resolve) => {
        const requestId = 1;
        let settled = false;

        /** @param {MessageEvent} event - Worker reply */
        const onMessage = (event) => {
            const parsed = parseAnalyticsWorkerMessage(event.data || {});
            if (!parsed.valid) {
                return;
            }
            const message = parsed.value;
            switch (message.type) {
                case "init":
                    if (!message.payload.hasData) {
                        finish(empty);
                        return;
                    }
                    post({ type: "view", requestId, filters: { ...DEFAULT_FILTERS, timeRange } });
                    return;
                case "view":
                    if (message.requestId !== requestId) {
                        return;
                    }
                    finish(analyticsRunFromPayload(message.payload));
                    return;
                case "error":
                    captureError(new Error("Analytics worker error during export."), {
                        module: "pdf-export",
                        operation: "analytics-worker-error-payload",
                    });
                    finish(empty);
            }
        };

        /** @param {Event} event - Worker error or messageerror event */
        const handleError = (event) => {
            // Cancels the event so the browser does not log it. This worker derives
            // topics from the user's own text, which must not reach the console.
            if (event && typeof event.preventDefault === "function") {
                event.preventDefault();
            }
            // event.error is never forwarded.
            captureError(new Error("Analytics worker failed during export."), {
                module: "pdf-export",
                operation: "analytics-worker-error-event",
            });
            finish(empty);
        };

        /**
         * Settle once and release the worker, whatever ended it.
         * @param {AnalyticsRun} value - Resolution value
         */
        function finish(value) {
            // Ignores calls after the first, so cleanup runs once.
            /* v8 ignore next 3 */
            if (settled) {
                return;
            }
            settled = true;
            workers.terminate();
            if (activeAnalyticsRun && activeAnalyticsRun.cancel === cancel) {
                activeAnalyticsRun = null;
            }
            resolve(value);
        }

        /** Abandon the run because the export was cancelled. */
        function cancel() {
            finish(empty);
        }

        /**
         * Post to the worker, settling if the structured clone throws.
         * @param {object} message - Message to post
         */
        function post(message) {
            try {
                /** @type {Worker} */ (workers.current()).postMessage(message);
            } catch {
                captureError(new Error("Analytics worker request could not be sent."), {
                    module: "pdf-export",
                    operation: "analytics-worker-post",
                });
                finish(empty);
            }
        }

        // Each run has its own handle, released when the run settles.
        const workers = createWorkerHandle({
            create: () =>
                new Worker(new URL("../analytics/analytics-worker.js", import.meta.url), {
                    type: "module",
                }),
            onMessage,
            onError: handleError,
            onStartError: () => {
                captureError(new Error("Analytics worker could not start during export."), {
                    module: "pdf-export",
                    operation: "init-analytics-worker",
                });
            },
        });
        if (!workers.ensure()) {
            resolve(empty);
            return;
        }

        workers.watch(WORKER_TIMEOUT_MS, () => {
            captureError(new Error("Analytics worker timed out during export."), {
                module: "pdf-export",
                operation: "analytics-worker-timeout",
            });
            finish(empty);
        });

        activeAnalyticsRun = { cancel };
        post({ type: "initBase", payload: analyticsBase });
    });
}

/**
 * Terminate the analytics worker when an export is cancelled.
 * Release its listeners and analytics data without waiting for a reply or timeout.
 */
export function terminateAnalyticsWorker() {
    if (activeAnalyticsRun) {
        activeAnalyticsRun.cancel();
    }
}

/**
 * @typedef {object} InsightSource
 * @property {string} timeRange - Range key the insights were computed at
 * @property {Insight[]} insights - Insight cards in display order
 * @property {string|null} tip - Closing tip, when there is one
 * @property {NetworkGrowth|null} networkGrowth - Lifetime network growth
 * @property {OutreachSummary|null} outreach - Persisted outreach summary
 * @property {ExportAnalyticsView|null} view - Filtered analytics view the activity dashboard is drawn from
 */

/**
 * Build the insight source an export falls back to when there is nothing to show.
 * @returns {InsightSource} Empty source
 */
function emptyInsightSource() {
    return {
        timeRange: DEFAULT_FILTERS.timeRange,
        insights: [],
        tip: null,
        networkGrowth: null,
        outreach: null,
        view: null,
    };
}

/**
 * Read the insight half of a published snapshot.
 * @param {InsightsSnapshot} snapshot - Published Insights snapshot
 * @returns {InsightSource} Source with no view attached yet
 */
function fromSnapshot(snapshot) {
    return {
        timeRange: snapshot.timeRange,
        insights: Array.isArray(snapshot.insights) ? snapshot.insights : [],
        tip: snapshot.tip || null,
        networkGrowth: snapshot.networkGrowth || null,
        outreach: snapshot.outreach || null,
        view: snapshot.view || null,
    };
}

/**
 * Resolve insight cards and their matching analytics view.
 * Reuse a published snapshot that contains both. Otherwise, ask the worker
 * for the snapshot range, or the default range when no snapshot exists.
 * @param {() => boolean} isCancelled - True once the run has been abandoned
 * @returns {Promise<InsightSource>} Insight source data
 */
async function resolveInsightSource(isCancelled) {
    const snapshot = /** @type {InsightsSnapshot|undefined} */ (
        DataCache.get(INSIGHTS_EXPORT_CACHE_KEY)
    );
    const source = hasSnapshotContent(snapshot) ? fromSnapshot(snapshot) : null;
    if (source && source.view) {
        return source;
    }

    const analyticsBase = await readAnalyticsBase();
    // The user may have cancelled during the storage read. Returns without
    // starting the worker in that case.
    if (!analyticsBase || isCancelled()) {
        return source || emptyInsightSource();
    }

    const timeRange = source ? source.timeRange : DEFAULT_FILTERS.timeRange;
    const run = await runAnalyticsWorker(analyticsBase, timeRange);
    if (source) {
        return { ...source, view: run.view };
    }
    return {
        timeRange: DEFAULT_FILTERS.timeRange,
        insights: run.insights,
        tip: run.tip,
        networkGrowth: run.networkGrowth,
        outreach: null,
        view: run.view,
    };
}

/**
 * Build the activity dashboard with the Analytics screen's stats and chart order.
 * @param {ExportAnalyticsView|null} view - Filtered analytics view
 * @param {string} rangeLabel - Window the view was built over
 * @returns {Dashboard|null} Dashboard, or null when there is no activity
 */
function buildActivityDashboard(view, rangeLabel) {
    if (!view || !view.totals || !view.totals.total) {
        return null;
    }
    // The view crosses a worker boundary unvalidated. This function runs outside
    // the try blocks the other two dashboards use.
    const { totals, peakHour, streaks } = view;
    const stats = [
        { label: "Posts", value: String(totals.posts) },
        { label: "Comments", value: String(totals.comments) },
        { label: "Total activity", value: String(totals.total) },
    ];
    if (peakHour) {
        stats.push({
            label: "Peak hour",
            value: `${String(peakHour.hour).padStart(2, "0")}:00`,
        });
    }
    if (streaks) {
        stats.push({ label: "Current streak", value: `${streaks.current} days` });
    }

    return {
        title: "Analytics",
        subtitle: rangeLabel,
        stats,
        charts: [
            { type: "line", title: "Activity timeline", points: view.timeline },
            { type: "bar", title: "Top topics", items: view.topics },
            { type: "heatmap", title: "When you are active", grid: view.heatmap },
        ],
    };
}

/**
 * Build the connections dashboard through an export-owned worker.
 * Worker processing keeps cancellation responsive during large parses.
 * The PDF covers all time, since it has no range control.
 * @param {Blob|string} connectionsCsv - Stored connections upload, or an empty string
 * @param {() => boolean} isCancelled - True once the run has been abandoned
 * @returns {Promise<Dashboard|null>} Dashboard, or null when there is nothing to show
 */
async function buildConnectionsDashboard(connectionsCsv, isCancelled) {
    if (!connectionsCsv || isCancelled()) {
        return null;
    }
    try {
        const data = await loadConnectionsData(connectionsCsv, { isCancelled });
        // The run is checked again after the parse, before aggregating.
        if (!data || isCancelled()) {
            return null;
        }

        const view = buildConnectionsView(data.rows, data.timeline, data.stats, CONNECTIONS_RANGE);

        return {
            title: "Connections",
            subtitle: formatRangeLabel(CONNECTIONS_RANGE),
            stats: [
                { label: "Total connections", value: String(view.stats.total) },
                // The screen's "In selected range" stat is omitted. The all-time
                // range keeps every row, so it would only repeat the total, and
                // its label names a control the PDF does not have.
                { label: "Top company", value: view.stats.topCompany },
                { label: "Network age", value: view.stats.networkAge },
            ],
            charts: [
                { type: "line", title: "Connection growth", points: view.timeline },
                { type: "bar", title: "Top companies", items: view.companies },
                { type: "bar", title: "Top positions", items: view.positions },
            ],
        };
    } catch {
        // A malformed connections file drops this section, not the export. The
        // caught value is discarded.
        captureError(new Error("Connections dashboard failed."), {
            module: "pdf-export",
            operation: "build-connections-dashboard",
        });
        return null;
    }
}

/**
 * Title a list with its total when the displayed entries are incomplete.
 * The PDF has no Full list control, so the title states the total.
 * @param {string} label - Panel name
 * @param {number} total - How many entries there are in all
 * @returns {string} Chart title
 */
function listTitle(label, total) {
    return total > LIST_LIMIT ? `${label} (top ${LIST_LIMIT} of ${total})` : label;
}

/**
 * Count messages by month within the dashboard window, filling gaps with zeroes.
 * The timeline is shown whether or not contact names are included. Returns an
 * empty series when the window has no messages.
 * @param {Float64Array} rowTimestamps - Timestamp of every message the parse kept
 * @param {MonthWindow} monthWindow - Months the dashboard covers
 * @returns {Array<{key: string, label: string, value: number}>} Points, oldest first
 */
function buildMessageTimeline(rowTimestamps, monthWindow) {
    const counts = new Map();
    for (const timestamp of rowTimestamps) {
        const key = toMonthKey(new Date(timestamp));
        // Month keys compare as text, and the window starts at the first of its month.
        if (key >= monthWindow.startKey) {
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }
    if (!counts.size) {
        return [];
    }

    return enumerateMonths(monthWindow.startKey, monthWindow.endKey).map((key) => ({
        key,
        label: monthKeyToLabel(key),
        value: counts.get(key) || 0,
    }));
}

/**
 * Build the lists of people the messages dashboard shows, when they are opted in.
 * @param {MessageState} messageState - Hydrated message state
 * @param {ConnectionState|null} connectionState - Hydrated connection state
 * @param {RangeContact[]} topContacts - Top contacts in range
 * @param {FadingConversation[]} fading - Fading conversations
 * @returns {ListChart[]} Chart configurations
 */
function buildMessagePeopleCharts(messageState, connectionState, topContacts, fading) {
    // Panel order, wording, and per-row detail match the Messages screen.
    // Silent connections are computed here, since only this panel uses them, and
    // only when names are included.
    const silent = connectionState ? getSilentConnections(messageState, connectionState) : [];

    return [
        buildLastMessageList("Top contacts", topContacts, (contact) => `${contact.count} msgs`),
        {
            type: "list",
            title: listTitle("Silent connections", silent.length),
            items: silent.slice(0, LIST_LIMIT).map((connection) => ({
                primary: connection.name,
                secondary:
                    [connection.position, connection.company].filter(Boolean).join(" @ ") ||
                    "No role info",
                value: connection.connectedOnTimestamp
                    ? formatShortDate(connection.connectedOnTimestamp)
                    : "No date",
            })),
        },
        buildLastMessageList("Fading conversations", fading, (contact) => `${contact.daysSince} days`),
    ];
}

/**
 * Build a contact list with last-contact dates and caller-supplied values.
 * Both list variants share the row limit and total count in the title.
 * @template {{name: string, lastTimestamp: number}} C
 * @param {string} label - Panel name
 * @param {C[]} contacts - Contacts in display order
 * @param {(contact: C) => string} toValue - Right-hand value for one row
 * @returns {ListChart} Chart configuration
 */
function buildLastMessageList(label, contacts, toValue) {
    return {
        type: "list",
        title: listTitle(label, contacts.length),
        items: contacts.slice(0, LIST_LIMIT).map((contact) => ({
            primary: contact.name,
            secondary: `Last message: ${formatShortDate(contact.lastTimestamp)}`,
            value: toValue(contact),
        })),
    };
}

/**
 * Build the messages dashboard from stored uploads.
 * Include counts and totals in every export. Include contact lists only
 * when includeNames is true.
 * @param {{messagesCsv: Blob|string, connectionsCsv: Blob|string}} files - Stored uploads
 * @param {boolean} includeNames - Whether the people lists were opted into
 * @param {() => boolean} isCancelled - True once the run has been abandoned
 * @returns {Promise<{dashboard: Dashboard|null, window: MonthWindow|null}>} Dashboard and the months it covers
 */
async function collectMessagesDashboard(files, includeNames, isCancelled) {
    // The window is returned with the page, since the header may use it when the
    // messages file is the only dated section.
    const empty = { dashboard: null, window: null };
    if (!files.messagesCsv || isCancelled()) {
        return empty;
    }
    try {
        const state = await loadMessagesState(files.messagesCsv, files.connectionsCsv, {
            isCancelled,
        });
        // The run is checked again after the parse.
        if (!state || isCancelled()) {
            return empty;
        }
        // Built inside the try block, so a throw from any aggregate drops only
        // this section.
        return buildMessagesDashboard(state, includeNames);
    } catch {
        // The section is dropped and the caught value is not reported.
        captureError(new Error("Messages dashboard failed."), {
            module: "pdf-export",
            operation: "build-messages-dashboard",
        });
        return empty;
    }
}

/**
 * Build the messages dashboard from hydrated state.
 * The caller handles loading, cancellation, and diagnostics.
 * @param {MessagesState} state - Hydrated message state
 * @param {boolean} includeNames - Whether the people lists were opted into
 * @returns {{dashboard: Dashboard, window: MonthWindow|null}} Dashboard and the months it covers
 */
function buildMessagesDashboard(state, includeNames) {
    const { messageState, connectionState } = state;
    const rangeStart = getRangeStart(MESSAGES_RANGE, messageState.latestTimestamp);
    const monthWindow = messageWindow(rangeStart, messageState.latestTimestamp);
    const summary = getTopContactsInRange(messageState, rangeStart);
    const fading = connectionState ? getFadingConversations(messageState, connectionState) : [];
    const rangeLabel = formatWindow(monthWindow) || formatRangeLabel(MESSAGES_RANGE).toLowerCase();

    /** @type {Chart[]} */
    const charts = [];
    if (monthWindow) {
        charts.push({
            type: "line",
            title: "Messages per month",
            points: buildMessageTimeline(messageState.rowTimestamps, monthWindow),
        });
    }
    if (includeNames) {
        charts.push(
            ...buildMessagePeopleCharts(messageState, connectionState, summary.items, fading),
        );
    }

    return {
        window: monthWindow,
        dashboard: {
            title: "Messages",
            // The page has two ranges, so the caption names both. Per-panel copy
            // from the screen is not included, so the caption carries that information.
            subtitle:
                `Messages and people: ${rangeLabel}. ` +
                "Connections, silent and fading: all time.",
            stats: [
                { label: "Messages in range", value: String(summary.totalRows) },
                { label: "People in range", value: String(summary.totalPeople) },
                {
                    label: "Total connections",
                    value: String(connectionState ? connectionState.list.length : 0),
                },
                { label: "Fading conversations", value: String(fading.length) },
            ],
            charts,
        },
    };
}

/**
 * Read the stored exports the dashboards and the thread section are built from.
 *
 * Reads each stored upload Blob once and shares it with the builders. Workers
 * read the Blobs; the small-export fallback reads text on the page. A record
 * whose `blob` getter throws is treated as absent.
 * @param {() => boolean} isCancelled - True once the run has been abandoned
 * @returns {Promise<{messagesCsv: Blob|string, connectionsCsv: Blob|string}>} Stored uploads, or empty strings
 */
async function readExportFiles(isCancelled) {
    const empty = { messagesCsv: "", connectionsCsv: "" };
    if (isCancelled()) {
        return empty;
    }
    const [messagesFile, connectionsFile] = await Promise.all([
        readSafely(() => Storage.getFile("messages"), "load-messages-file"),
        readSafely(() => Storage.getFile("connections"), "load-connections-file"),
    ]);
    return {
        messagesCsv: readStoredUpload(messagesFile),
        connectionsCsv: readStoredUpload(connectionsFile),
    };
}

/**
 * Read one stored upload Blob, returning an empty string when unreadable.
 * Each record is read independently.
 * @param {import("../../platform/persistence/storage.js").StoredFile|null} file - Stored file record
 * @returns {Blob|string} The stored upload, or an empty string
 */
function readStoredUpload(file) {
    try {
        return file && file.blob ? file.blob : "";
    } catch {
        // Only a fixed error is reported.
        captureError(new Error("Stored export text could not be read."), {
            module: "pdf-export",
            operation: "read-export-files",
        });
        return "";
    }
}

/**
 * Select recent threads and their message bodies from stored uploads.
 * The worker derives the tiebreak keys from the connections file, so the file is
 * not parsed on the main thread.
 * @param {{messagesCsv: Blob|string, connectionsCsv: Blob|string}} files - Stored uploads
 * @param {() => boolean} isCancelled - True once the run has been abandoned
 * @returns {Promise<import("./threads.js").SelectedThread[]>} Threads for the document
 */
async function collectThreads(files, isCancelled) {
    if (!files.messagesCsv || isCancelled()) {
        return [];
    }
    try {
        return await loadRecentThreads(files.messagesCsv, files.connectionsCsv, { isCancelled });
    } catch {
        // A thread-selection failure drops the section rather than the export.
        // The caught value is discarded. Only a fixed error is reported.
        captureError(new Error("Thread selection failed."), {
            module: "pdf-export",
            operation: "select-threads",
        });
        return [];
    }
}

/**
 * Build the PDF document model from stored data.
 * Pass cancellation checks to each asynchronous collection step so a cancelled
 * run does not start another worker. Cancelled runs return empty sections,
 * and the caller discards their results.
 * @param {{includeNames?: boolean, includeMessages?: boolean, generatedAt?: Date, isCancelled?: () => boolean}} [options] - Export options
 * @returns {Promise<import("./pdf-document.js").DocumentModel>} Document model
 */
export async function collectExportData(options = {}) {
    const isCancelled =
        typeof options.isCancelled === "function" ? options.isCancelled : () => false;
    const source = await resolveInsightSource(isCancelled);
    const activityWindow = viewWindow(source.view);
    const activityLabel = formatWindow(activityWindow) || formatRangeLabel(source.timeRange);
    const outreach = source.outreach || (await readOutreach());
    // Read each stored upload once and pass its Blob to every consumer.
    const files = await readExportFiles(isCancelled);
    // Refused before any worker starts. Message contents from a file this large
    // cannot be held in memory.
    if (options.includeMessages && csvSourceSize(files.messagesCsv) > THREADS_EXPORT_MAX_BYTES) {
        throw new ExportRefusal(MESSAGES_TOO_LARGE_FOR_CONTENTS);
    }
    const messages = await collectMessagesDashboard(
        files,
        Boolean(options.includeNames),
        isCancelled,
    );
    const threads = options.includeMessages ? await collectThreads(files, isCancelled) : [];
    // Awaited in turn, not in parallel with the messages dashboard, so only one
    // copy of the connections export is in flight at a time.
    const connections = await buildConnectionsDashboard(files.connectionsCsv, isCancelled);

    const model = {
        generatedAt: options.generatedAt instanceof Date ? options.generatedAt : new Date(),
        // The header covers the whole document. It states the activity window when
        // there is one, and the messages window otherwise.
        rangeLabel: formatWindow(activityWindow || messages.window) || activityLabel,
        // Dashboards are one array in document order. Dashboards that found nothing
        // to show are dropped, since the layout engine takes only real dashboards.
        dashboards: /** @type {Dashboard[]} */ (
            [
                buildActivityDashboard(source.view, activityLabel),
                connections,
                messages.dashboard,
            ].filter(Boolean)
        ),
        insights: source.insights,
        tip: source.tip,
        allTime: buildAllTimeStats(source.networkGrowth, outreach),
        threads,
    };

    // Applied last, to the finished model. The fonts cannot draw every character
    // that can appear in a name. See drawable-text.js for what is replaced.
    return sanitizeModel(model, readDrawableCoverage());
}
