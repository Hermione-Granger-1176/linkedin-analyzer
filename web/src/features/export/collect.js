/**
 * Document model assembly for the PDF export.
 *
 * The export button is global, so this module cannot assume any screen has ever
 * run. It takes the on-screen snapshot when there is one and otherwise reads the
 * stored exports itself, mirroring each screen's own load: a short-lived
 * analytics worker for activity, and a transport of the export's own over each
 * screen's parsing worker for connections and for messages.
 *
 * The result is a dashboard per screen rather than one long list, so the
 * document divides the way the site does.
 */

import { parseAnalyticsWorkerMessage } from "../../app/worker-contracts.js";
import { captureError } from "../../platform/observability/sentry.js";
import { DataCache } from "../../platform/persistence/data-cache.js";
import { Storage } from "../../platform/persistence/storage.js";
import { INSIGHTS_EXPORT_CACHE_KEY } from "../../shared/constants.js";
import { enumerateMonths } from "../analytics/dates.js";
import { buildConnectionsView, monthKeyToLabel, toMonthKey } from "../connections/view.js";
import {
    DEFAULT_TIME_RANGE,
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
import { loadRecentThreads } from "./threads-transport.js";

const WORKER_TIMEOUT_MS = 30000;

// How many entries a dashboard list carries. The screens render ten, and a page
// that showed more would stop being the same view the user is exporting.
const LIST_LIMIT = 10;

// The connections dashboard covers the whole network rather than the screen's
// twelve-month default, for the reason set out where it is built.
const CONNECTIONS_RANGE = "all";

// The messages dashboard follows the Messages screen's own default, not the
// Insights one below: they agree today, and a page that silently tracked the
// wrong screen if either moved would still be captioned with this one's name.
// Were this ever to become "all", there would be no range to anchor a window
// on, and the page would quietly lose its timeline rather than say so.
const MESSAGES_RANGE = DEFAULT_TIME_RANGE;

/**
 * The analytics worker run in flight, so a cancelled export can end it.
 * @type {{cancel: () => void}|null}
 */
let activeAnalyticsRun = null;

// Same shape the Insights screen sends, so the worker produces the same view.
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
 * Name a time range the way the app's own controls do.
 *
 * The document's captions are the window below rather than one of these: a
 * relative name is only used where the data gives no window to state, and for
 * the connections dashboard, which really does cover all time.
 * @param {unknown} timeRange - Filter range key
 * @returns {string} Human-readable range label
 */
export function formatRangeLabel(timeRange) {
    const key = typeof timeRange === "string" ? timeRange : "";
    return RANGE_LABELS[key] || RANGE_LABELS[DEFAULT_FILTERS.timeRange];
}

/**
 * @typedef {{startKey: string, endKey: string}} MonthWindow
 */

/**
 * Label the months a section covers, or nothing when it has no window.
 *
 * A document outlives the moment it was made, so a caption written against that
 * moment stops being true the day after: the header read "Last 12 months" beside
 * a generation date nineteen months after the only post it counted. Every range
 * in the app is anchored on the user's own latest event rather than on today,
 * which is right on screen, where the reader can move the control and watch it
 * answer, and is exactly what makes the relative wording a lie on paper. The
 * window says the same thing about the data and goes on saying it.
 * @param {MonthWindow|null} monthWindow - Months covered
 * @returns {string} Window label such as "Feb 2024 to Jan 2025", or an empty string
 */
function formatWindow(monthWindow) {
    if (!monthWindow) {
        return "";
    }
    const start = monthKeyToLabel(monthWindow.startKey);
    const end = monthKeyToLabel(monthWindow.endKey);
    // A single month reads as itself rather than as a range from it to it.
    return start === end ? start : `${start} to ${end}`;
}

/**
 * Read the months an analytics view was built over.
 *
 * From the plotted timeline rather than from the range key, which says how long
 * the window is but not where it sits. The monthly and the weekly timeline both
 * key their points by date, so the first seven characters are the month whichever
 * one the view carries.
 * @param {object|null} view - Filtered analytics view
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
 * Read the months the messages dashboard covers.
 *
 * The range start is midnight on the first of the oldest month in range, so the
 * window is simply the months the range runs between. Null when the parse found
 * no dated message at all: `getRangeStart` has nothing to anchor on, and there
 * is no window to report.
 * @param {number|null} rangeStart - Start of the messages range
 * @param {number} latestTimestamp - Newest message in the file
 * @returns {MonthWindow|null} Window, or null when there is nothing in range
 */
function messageWindow(rangeStart, latestTimestamp) {
    // Against null rather than falsiness: a local-midnight epoch is a legitimate
    // range start, and the one that falls on it is 0.
    if (rangeStart === null) {
        return null;
    }
    return {
        startKey: toMonthKey(new Date(rangeStart)),
        endKey: toMonthKey(new Date(latestTimestamp)),
    };
}

/**
 * Format an outreach reply rate, matching the Insights screen.
 * @param {number|null|undefined} replyRate - Fraction in [0, 1]
 * @returns {string} Percentage text, or "N/A"
 */
function formatReplyRate(replyRate) {
    return typeof replyRate === "number" ? `${Math.round(replyRate * 100)}%` : "N/A";
}

/**
 * Format a sent-to-received ratio, matching the Insights screen.
 * @param {number|null|undefined} ratio - Sent over received
 * @returns {string} Ratio text, or "N/A"
 */
function formatSentRatio(ratio) {
    return typeof ratio === "number" ? `${ratio.toFixed(1)} : 1` : "N/A";
}

/**
 * Build the all-time stat list, dropping stats with no data behind them.
 * @param {{multiplier?: number}|null} networkGrowth - Lifetime network growth from the view
 * @param {{selfInitiated: number, replyRate: number|null, unansweredContacts: number, sentReceivedRatio: number|null}|null} outreach - Persisted outreach summary
 * @returns {Array<{label: string, value: string}>} Stats in display order
 */
function buildAllTimeStats(networkGrowth, outreach) {
    const stats = [];
    if (networkGrowth && typeof networkGrowth.multiplier === "number") {
        // The same multiplication sign the Insights screen uses. Both embedded
        // faces carry U+00D7, and it is in WinAnsi, so the Helvetica fallback
        // renders it too.
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
 * Run a one-shot analytics worker to produce a view and its insights.
 *
 * The worker computes the timeline, topics and heatmap alongside the insight
 * cards whatever it is asked for, so the whole view is kept: the activity
 * dashboard is drawn from data this run was already paying for.
 * @param {object} analyticsBase - Persisted analytics base
 * @param {string} timeRange - Range key to build the view at
 * @returns {Promise<{insights: object[], tip: string|null, networkGrowth: object|null, view: object|null}>} Worker view
 */
function runAnalyticsWorker(analyticsBase, timeRange) {
    // One identity is handed to every caller, so it is frozen: callers only read
    // these fields, and nothing should be able to edit the shared empty result.
    const empty = Object.freeze({ insights: [], tip: null, networkGrowth: null, view: null });

    if (typeof Worker === "undefined") {
        return Promise.resolve(empty);
    }

    let worker = null;
    try {
        worker = new Worker(new URL("../analytics/analytics-worker.js", import.meta.url), {
            type: "module",
        });
    } catch {
        captureError(new Error("Analytics worker could not start during export."), {
            module: "pdf-export",
            operation: "init-analytics-worker",
        });
        return Promise.resolve(empty);
    }

    return new Promise((resolve) => {
        const requestId = 1;
        let timeoutId = null;
        let settled = false;

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
                case "view": {
                    if (message.requestId !== requestId) {
                        return;
                    }
                    /* v8 ignore next */
                    const payload = message.payload || {};
                    const insights = payload.insights || {};
                    finish({
                        insights: insights.insights || [],
                        tip: insights.tip || null,
                        networkGrowth: (payload.view && payload.view.networkGrowth) || null,
                        view: payload.view || null,
                    });
                    return;
                }
                case "error":
                    captureError(new Error("Analytics worker error during export."), {
                        module: "pdf-export",
                        operation: "analytics-worker-error-payload",
                    });
                    finish(empty);
            }
        };

        const handleError = (event) => {
            // Cancelling the event suppresses the browser's own reporting of it,
            // as the three transports do. This worker derives topics from the
            // user's own share commentary and comment text, so an uncancelled
            // error prints that text to the console along with the failure.
            if (event && typeof event.preventDefault === "function") {
                event.preventDefault();
            }
            // event.error is never forwarded, for the same reason.
            captureError(new Error("Analytics worker failed during export."), {
                module: "pdf-export",
                operation: "analytics-worker-error-event",
            });
            finish(empty);
        };

        /**
         * Settle once and release the worker, whatever ended it.
         * @param {object} value - Resolution value
         */
        function finish(value) {
            // Every settle path below detaches the listeners and clears the
            // watchdog before it returns, so nothing can settle this run twice
            // today. The latch is defensive, as the transports' own identity
            // guards are: it exists so that stops being something the next
            // reader has to re-derive before adding a path.
            /* v8 ignore next 3 */
            if (settled) {
                return;
            }
            settled = true;
            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
                timeoutId = null;
            }
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", handleError);
            worker.removeEventListener("messageerror", handleError);
            worker.terminate();
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
                worker.postMessage(message);
            } catch {
                captureError(new Error("Analytics worker request could not be sent."), {
                    module: "pdf-export",
                    operation: "analytics-worker-post",
                });
                finish(empty);
            }
        }

        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", handleError);
        worker.addEventListener("messageerror", handleError);

        timeoutId = window.setTimeout(() => {
            timeoutId = null;
            captureError(new Error("Analytics worker timed out during export."), {
                module: "pdf-export",
                operation: "analytics-worker-timeout",
            });
            finish(empty);
        }, WORKER_TIMEOUT_MS);

        activeAnalyticsRun = { cancel };
        post({ type: "initBase", payload: analyticsBase });
    });
}

/**
 * Abandon an analytics worker still running for a cancelled export.
 *
 * Cancelling used to leave it churning until it answered or its 30-second
 * watchdog fired. The generation token already stopped a late answer from being
 * used, but the worker itself, its listeners and the analytics base it was
 * handed all stayed alive for the wait.
 */
export function terminateAnalyticsWorker() {
    if (activeAnalyticsRun) {
        activeAnalyticsRun.cancel();
    }
}

/**
 * @typedef {object} InsightSource
 * @property {string} timeRange - Range key the insights were computed at
 * @property {object[]} insights - Insight cards in display order
 * @property {string|null} tip - Closing tip, when there is one
 * @property {object|null} networkGrowth - Lifetime network growth
 * @property {object|null} outreach - Persisted outreach summary
 * @property {object|null} view - Filtered analytics view the activity dashboard is drawn from
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
 * @param {object} snapshot - Published Insights snapshot
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
 * Resolve the insight cards, the range, and the view the charts are plotted from.
 *
 * The snapshot the Insights screen publishes wins outright when it carries the
 * view as well as the cards, which is the fast path it exists to be: exporting
 * from that screen then costs no worker run at all. A snapshot written before
 * that screen kept its view, or none at all, falls through to the worker, which
 * is asked for the range the snapshot is showing rather than the default one. A
 * header reading "All time" above a chart of the last twelve months would be a
 * lie about the same document.
 * @param {() => boolean} isCancelled - True once the run has been abandoned
 * @returns {Promise<InsightSource>} Insight source data
 */
async function resolveInsightSource(isCancelled) {
    const snapshot = DataCache.get(INSIGHTS_EXPORT_CACHE_KEY);
    const source = hasSnapshotContent(snapshot) ? fromSnapshot(snapshot) : null;
    if (source && source.view) {
        return source;
    }

    const analyticsBase = await readAnalyticsBase();
    // The storage read above is a macrotask boundary, so the user may have
    // cancelled while it was in flight. Starting the worker now would hand a
    // whole analytics base to a run whose answer nobody will ever read, and
    // leave it churning under its own 30-second watchdog.
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
 * Build the activity dashboard from an analytics view.
 *
 * The stat wording and the three charts are the Analytics screen's, in its
 * order: a reader who knows the screen should recognize the page.
 * @param {object|null} view - Filtered analytics view
 * @param {string} rangeLabel - Window the view was built over
 * @returns {object|null} Dashboard, or null when there is no activity
 */
function buildActivityDashboard(view, rangeLabel) {
    if (!view || !view.totals || !view.totals.total) {
        return null;
    }
    // The view crosses a worker boundary and its payload is passed through
    // unvalidated, and this runs outside the try the other two dashboards sit
    // in: reaching into a half-built view unguarded would take down the whole
    // export rather than this one page.
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
 * Build the connections dashboard from the stored connections export.
 *
 * The file is cleaned and aggregated through the export's own transport, over
 * the Connections screen's worker. It used to be done inline, here, on the UI
 * thread: an export of thirty thousand rows held that thread long enough that
 * the Escape key which cancels the run could not reach its own handler.
 *
 * Drawn over the whole network rather than the screen's twelve-month default.
 * On screen that default sits beside a range control the reader can move; on
 * paper it cannot be moved, and most people's connections predate it, so the
 * default would print a page whose company and position charts are empty. The
 * growth chart is all-time on screen too, so this also stops one page carrying
 * two different ranges at once.
 * @param {string} connectionsCsv - Raw connections CSV text, or an empty string
 * @param {() => boolean} isCancelled - True once the run has been abandoned
 * @returns {Promise<object|null>} Dashboard, or null when there is nothing to show
 */
async function buildConnectionsDashboard(connectionsCsv, isCancelled) {
    if (!connectionsCsv || isCancelled()) {
        return null;
    }
    try {
        const data = await loadConnectionsData(connectionsCsv, { isCancelled });
        // The parse is the longest step on this path, so the run is checked
        // again on the way out rather than aggregating the whole network for a
        // page nobody will read.
        if (!data || isCancelled()) {
            return null;
        }

        const view = buildConnectionsView(data.rows, data.timeline, data.stats, CONNECTIONS_RANGE);

        return {
            title: "Connections",
            subtitle: formatRangeLabel(CONNECTIONS_RANGE),
            stats: [
                { label: "Total connections", value: String(view.stats.total) },
                // "In selected range" is on the screen and not here: it counts
                // the rows the range kept, and an all-time page keeps every one
                // of them, so the tile could only ever restate the total beside
                // it under a label naming a control the reader cannot see.
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
        // A dashboard is worth less than the export it sits in, so a malformed
        // connections file drops the section. The caught value came from the
        // user's own file and is discarded rather than reported.
        captureError(new Error("Connections dashboard failed."), {
            module: "pdf-export",
            operation: "build-connections-dashboard",
        });
        return null;
    }
}

/**
 * Title a list, saying so when it is only the head of a longer one.
 *
 * The screen puts a "Full list" button beside each panel, so the reader can see
 * that ten is not all of them. The page has no such cue, and a list of ten under
 * a stat tile reading 157 would look like a contradiction.
 * @param {string} label - Panel name
 * @param {number} total - How many entries there are in all
 * @returns {string} Chart title
 */
function listTitle(label, total) {
    return total > LIST_LIMIT ? `${label} (top ${LIST_LIMIT} of ${total})` : label;
}

/**
 * Count the messages in range by month, gap-filled the way growth is.
 *
 * The one chart on the messages dashboard that names nobody, and the reason the
 * page is worth printing at the default settings: every other panel on it is a
 * list of people, so with the names box unticked the sheet was four stat tiles
 * and blank paper. It is aggregated from the timestamps the parse already
 * produced, and its months add up to the "Messages in range" tile above it.
 *
 * Empty when nothing was sent or received in the window: a year of zeroes drawn
 * as a flat line is the empty axes the layout engine drops a chart to avoid.
 * @param {number[]} rowTimestamps - Timestamp of every message the parse kept
 * @param {MonthWindow} monthWindow - Months the dashboard covers
 * @returns {Array<{key: string, label: string, value: number}>} Points, oldest first
 */
function buildMessageTimeline(rowTimestamps, monthWindow) {
    const counts = new Map();
    for (const timestamp of rowTimestamps) {
        const key = toMonthKey(new Date(timestamp));
        // Month keys sort as text, and the window starts on the first of its
        // own month, so this is the same cut the range start makes.
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
 * @param {object} messageState - Hydrated message state
 * @param {object|null} connectionState - Hydrated connection state
 * @param {object[]} topContacts - Top contacts in range
 * @param {object[]} fading - Fading conversations
 * @returns {object[]} Chart configurations
 */
function buildMessagePeopleCharts(messageState, connectionState, topContacts, fading) {
    // Panel order, wording and per-row detail are the Messages screen's. A list
    // that dropped the dates and the units would be the same names carrying less
    // than the page they were copied from.
    //
    // Computed here rather than beside `fading` in the caller: this panel is the
    // only thing that wants it, and this function only runs when names are opted
    // in, so a names-off export never walks the whole network for it.
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
 * Build a list panel of contacts, each titled by when they last wrote.
 *
 * The two panels that take this shape differ only in what they put on the right,
 * so the row limit and the title's count are stated once: a third cannot forget
 * either.
 * @param {string} label - Panel name
 * @param {object[]} contacts - Contacts in display order
 * @param {(contact: object) => string} toValue - Right-hand value for one row
 * @returns {object} Chart configuration
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
 * Build the messages dashboard from the stored messages and connections exports.
 *
 * Counts and totals are always included; anything that names a person is behind
 * `includeNames`, because a file the reader may forward is not the place to put
 * somebody else's name without being asked.
 * @param {{messagesCsv: string, connectionsCsv: string}} files - Stored export texts
 * @param {boolean} includeNames - Whether the people lists were opted into
 * @param {() => boolean} isCancelled - True once the run has been abandoned
 * @returns {Promise<{dashboard: object|null, window: MonthWindow|null}>} Dashboard and the months it covers
 */
async function collectMessagesDashboard(files, includeNames, isCancelled) {
    // The window is returned alongside the page because the header may need it:
    // an export built from a messages file alone has no other dated section to
    // take its caption from.
    const empty = { dashboard: null, window: null };
    if (!files.messagesCsv || isCancelled()) {
        return empty;
    }
    try {
        const state = await loadMessagesState(files.messagesCsv, files.connectionsCsv, {
            isCancelled,
        });
        // The parse is the longest step on this path, so the run is checked again
        // on the way out rather than walking the whole state for a page nobody
        // will read.
        if (!state || isCancelled()) {
            return empty;
        }
        // Built inside the catch's reach, not after it: a throw from any of the
        // aggregates below still costs the section rather than the export.
        return buildMessagesDashboard(state, includeNames);
    } catch {
        // As with the connections dashboard: the section goes, the export stays,
        // and the caught value, parsed from the user's own messages, is not
        // reported.
        captureError(new Error("Messages dashboard failed."), {
            module: "pdf-export",
            operation: "build-messages-dashboard",
        });
        return empty;
    }
}

/**
 * Assemble the messages dashboard from hydrated state.
 *
 * Pure, as the other builders in this module are: the loading, the cancellation
 * checks and the reporting stay with the caller, so what the page contains can
 * be read, and exercised, without a worker.
 * @param {{messageState: object, connectionState: object|null}} state - Hydrated message state
 * @param {boolean} includeNames - Whether the people lists were opted into
 * @returns {{dashboard: object, window: MonthWindow|null}} Dashboard and the months it covers
 */
function buildMessagesDashboard(state, includeNames) {
    const { messageState, connectionState } = state;
    const rangeStart = getRangeStart(MESSAGES_RANGE, messageState.latestTimestamp);
    const monthWindow = messageWindow(rangeStart, messageState.latestTimestamp);
    const summary = getTopContactsInRange(messageState, rangeStart);
    const fading = connectionState ? getFadingConversations(messageState, connectionState) : [];
    const rangeLabel = formatWindow(monthWindow) || formatRangeLabel(MESSAGES_RANGE).toLowerCase();

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
            // Two ranges live on this page, so the caption names both rather
            // than printing one over the top of the other. On screen each
            // panel carries its own line of copy saying what it counts; the
            // page keeps only the caption, so the caption has to carry it.
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
 * One read each, shared by every consumer below. A record whose `text` getter
 * throws is treated as absent rather than allowed to abort the export.
 * @param {() => boolean} isCancelled - True once the run has been abandoned
 * @returns {Promise<{messagesCsv: string, connectionsCsv: string}>} Raw CSV texts
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
        messagesCsv: readStoredText(messagesFile),
        connectionsCsv: readStoredText(connectionsFile),
    };
}

/**
 * Read one stored record's text, treating an unreadable one as absent.
 *
 * Each record is read on its own rather than the pair together: a messages
 * record whose getter throws used to cost the connections dashboard as well,
 * which is a wider blast radius than the failure deserves.
 * @param {object|null} file - Stored file record
 * @returns {string} Raw CSV text, or an empty string
 */
function readStoredText(file) {
    try {
        return file && file.text ? file.text : "";
    } catch {
        // The caught value came off a stored record holding the user's own
        // export, so only a fixed error is reported.
        captureError(new Error("Stored export text could not be read."), {
            module: "pdf-export",
            operation: "read-export-files",
        });
        return "";
    }
}

/**
 * Select the recent threads, with message bodies, from the stored messages file.
 *
 * Both files travel down raw. The self-detection tiebreak the connections
 * export settles is derived inside the transport's worker rather than here: it
 * was the last whole-file parse this module ran on the UI thread, and it ran on
 * every export that opted message contents in.
 * @param {{messagesCsv: string, connectionsCsv: string}} files - Stored export texts
 * @param {() => boolean} isCancelled - True once the run has been abandoned
 * @returns {Promise<object[]>} Threads for the document
 */
async function collectThreads(files, isCancelled) {
    if (!files.messagesCsv || isCancelled()) {
        return [];
    }
    try {
        return await loadRecentThreads(files.messagesCsv, files.connectionsCsv, { isCancelled });
    } catch {
        // A thread-selection failure drops the section rather than the export.
        // The caught value is discarded: it came from parsing the user's own
        // messages, so only a fixed error is reported.
        captureError(new Error("Thread selection failed."), {
            module: "pdf-export",
            operation: "select-threads",
        });
        return [];
    }
}

/**
 * Assemble everything the PDF layout needs.
 *
 * Cancellation is threaded down rather than left to the caller: collection walks
 * several storage reads before it reaches either worker, and terminating a
 * worker that has not been created yet does nothing. Without `isCancelled` an
 * abandoned run went on to build a worker and hand it the user's whole CSV, and
 * a second run started meanwhile could deadlock against it over the shared
 * worker handle. Each step that is about to start real work checks it; unlike
 * the threads transport, which distinguishes cancellation from failure by
 * symbol, a cancelled run here simply yields the same empty sections as a run
 * with no data, and the caller discards the result either way.
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
    // Read once and pass the text down. The connections export used to be read
    // and re-read up to three times in one run, once per consumer, which is both
    // the slow way and an odd thing to do alongside a promise to keep only one
    // copy of it in memory.
    const files = await readExportFiles(isCancelled);
    const messages = await collectMessagesDashboard(
        files,
        Boolean(options.includeNames),
        isCancelled,
    );
    const threads = options.includeMessages ? await collectThreads(files, isCancelled) : [];
    // Awaited in turn rather than raced against the messages dashboard above:
    // each owns a worker of its own, and starting both would hold two copies of
    // the connections export in flight at once to save a step neither is
    // blocking on.
    const connections = await buildConnectionsDashboard(files.connectionsCsv, isCancelled);

    const model = {
        generatedAt: options.generatedAt instanceof Date ? options.generatedAt : new Date(),
        // The header speaks for the whole document rather than for one page of
        // it, so it states the activity window when there is one and the
        // messages window when messages are all the document has. Either way it
        // is not the last relative caption on a file whose pages name their own
        // dates.
        rangeLabel: formatWindow(activityWindow || messages.window) || activityLabel,
        // One array in document order rather than a field per screen, so a
        // fourth dashboard is an entry here instead of a change in four files.
        // The layout engine takes only real dashboards, so the ones that found
        // nothing to show are dropped rather than passed along as holes.
        dashboards: [
            buildActivityDashboard(source.view, activityLabel),
            connections,
            messages.dashboard,
        ].filter(Boolean),
        insights: source.insights,
        tip: source.tip,
        allTime: buildAllTimeStats(source.networkGrowth, outreach),
        threads,
    };

    // Last, over the finished model: every collector above feeds it, and the
    // faces the document is drawn with cannot spell every name that reaches
    // them. See drawable-text.js for what is replaced and why it is replaced
    // rather than left to disappear.
    return sanitizeModel(model, readDrawableCoverage());
}
