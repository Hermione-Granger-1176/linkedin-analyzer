/**
 * Document model assembly for the PDF export.
 *
 * The export button is global, so this module cannot assume the Insights screen
 * has ever run. It takes the on-screen snapshot when there is one and otherwise
 * runs its own short-lived analytics worker at the default filters, mirroring
 * the Insights screen's own load.
 */

import { parseAnalyticsWorkerMessage } from "../../app/worker-contracts.js";
import { captureError } from "../../platform/observability/sentry.js";
import { DataCache } from "../../platform/persistence/data-cache.js";
import { Storage } from "../../platform/persistence/storage.js";
import { INSIGHTS_EXPORT_CACHE_KEY } from "../../shared/constants.js";
import { LinkedInCleaner } from "../cleaning/cleaner.js";
import { MessagesAnalytics } from "../messages/analytics.js";

import { loadRecentThreads } from "./threads-transport.js";

const ANALYTICS_BASE_CACHE_KEY = "storage:analyticsBase";
const WORKER_TIMEOUT_MS = 30000;

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
 * Describe a time range the way the export header should read it.
 * @param {unknown} timeRange - Filter range key
 * @returns {string} Human-readable range label
 */
export function formatRangeLabel(timeRange) {
    const key = typeof timeRange === "string" ? timeRange : "";
    return RANGE_LABELS[key] || RANGE_LABELS[DEFAULT_FILTERS.timeRange];
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
        stats.push({ label: "Network growth", value: `${networkGrowth.multiplier}x` });
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
 * Read a stored value without letting a storage failure abort the export.
 *
 * The caught value is discarded rather than reported: one of these reads is the
 * stored messages CSV, so a storage error could carry a fragment of it.
 * @param {() => Promise<any>} read - Storage reader
 * @param {string} operation - Fixed identifier for diagnostics
 * @returns {Promise<any>} Stored value, or null when unavailable
 */
async function readSafely(read, operation) {
    try {
        return await read();
    } catch {
        captureError(new Error("Export storage read failed."), {
            module: "pdf-export",
            operation,
        });
        return null;
    }
}

/**
 * Run a one-shot analytics worker to produce insights at the default filters.
 * @param {object} analyticsBase - Persisted analytics base
 * @returns {Promise<{insights: object[], tip: string|null, networkGrowth: object|null}>} Worker view
 */
function runAnalyticsWorker(analyticsBase) {
    // One identity is handed to every caller, so it is frozen: callers only read
    // these fields, and nothing should be able to edit the shared empty result.
    const empty = Object.freeze({ insights: [], tip: null, networkGrowth: null });

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
                    post({ type: "view", requestId, filters: { ...DEFAULT_FILTERS } });
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

        const handleError = () => {
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
 */

/**
 * Read the analytics base an export computes from, cache first.
 *
 * Shared so the availability check and the collection itself answer the same
 * question the same way: a cached base with no months used to make the button
 * read the stored one and say yes, while collection gave up without looking and
 * exported nothing.
 * @returns {Promise<any>} Analytics base carrying months, or null
 */
async function readAnalyticsBase() {
    const cached = DataCache.get(ANALYTICS_BASE_CACHE_KEY);
    if (cached && cached.months) {
        return cached;
    }
    const stored = await readSafely(() => Storage.getAnalytics(), "load-analytics");
    return stored && stored.months ? stored : null;
}

/**
 * Report whether a published snapshot holds anything the document would show.
 *
 * Insight cards are not the only thing on the Insights screen: a range can
 * produce no cards while the all-time stats below them are still populated.
 * Testing the cards alone would send that screen down the cold path and export
 * the default range instead of the one the user has selected.
 * @param {object|null|undefined} snapshot - Published Insights snapshot
 * @returns {boolean} True when the snapshot carries content
 */
function hasSnapshotContent(snapshot) {
    if (!snapshot) {
        return false;
    }
    if (Array.isArray(snapshot.insights) && snapshot.insights.length) {
        return true;
    }
    return Boolean(snapshot.networkGrowth || snapshot.outreach);
}

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
    };
}

/**
 * Resolve the insight cards, tip and range, preferring the on-screen snapshot.
 * @param {() => boolean} isCancelled - True once the run has been abandoned
 * @returns {Promise<InsightSource>} Insight source data
 */
async function resolveInsightSource(isCancelled) {
    const snapshot = DataCache.get(INSIGHTS_EXPORT_CACHE_KEY);
    if (hasSnapshotContent(snapshot)) {
        return {
            timeRange: snapshot.timeRange,
            insights: Array.isArray(snapshot.insights) ? snapshot.insights : [],
            tip: snapshot.tip || null,
            networkGrowth: snapshot.networkGrowth || null,
            outreach: snapshot.outreach || null,
        };
    }

    const analyticsBase = await readAnalyticsBase();
    if (!analyticsBase) {
        return emptyInsightSource();
    }
    // The storage read above is a macrotask boundary, so the user may have
    // cancelled while it was in flight. Starting the worker now would hand a
    // whole analytics base to a run whose answer nobody will ever read, and
    // leave it churning under its own 30-second watchdog.
    if (isCancelled()) {
        return emptyInsightSource();
    }

    const view = await runAnalyticsWorker(analyticsBase);
    return {
        timeRange: DEFAULT_FILTERS.timeRange,
        insights: view.insights,
        tip: view.tip,
        networkGrowth: view.networkGrowth,
        outreach: null,
    };
}

/**
 * Check whether there is anything worth exporting.
 *
 * Used to disable the export button before the user opens the dialog, so it is
 * deliberately cheap: caches first, one small storage read otherwise.
 * @returns {Promise<boolean>} True when a PDF would contain something
 */
export async function hasExportableData() {
    const snapshot = DataCache.get(INSIGHTS_EXPORT_CACHE_KEY);
    if (hasSnapshotContent(snapshot)) {
        return true;
    }
    if (await readAnalyticsBase()) {
        return true;
    }
    const outreach = await readSafely(() => Storage.getOutreach(), "load-outreach");
    return Boolean(outreach);
}

/**
 * Collect the normalized names and profile URLs of the user's connections.
 *
 * Used only as a self-detection tiebreak: an export holding one conversation
 * cannot say which of its two people is the account owner, but you are never in
 * your own connections list, so whoever is in it is not you. A missing or
 * unreadable connections file simply leaves the tie unresolved.
 * @returns {Promise<string[]>} Normalized keys, empty when there is nothing to read
 */
async function collectContactKeys() {
    const stored = await readSafely(() => Storage.getFile("connections"), "load-connections-file");
    try {
        const text = stored && stored.text ? stored.text : "";
        if (!text) {
            return [];
        }
        const parsed = LinkedInCleaner.parseCSV(text, "connections");
        if (parsed.error) {
            return [];
        }
        const keys = new Set();
        for (const row of parsed.data) {
            const name = MessagesAnalytics.normalizeName(
                `${row["First Name"] || ""} ${row["Last Name"] || ""}`,
            );
            if (name) {
                keys.add(name);
            }
            const url = MessagesAnalytics.normalizeUrl(row.URL);
            if (url) {
                keys.add(url);
            }
        }
        return Array.from(keys);
    } catch {
        // A tiebreak is a nicety; losing it costs a direction label, not the
        // export. The caught value came from the user's own connections file.
        captureError(new Error("Connections read failed during export."), {
            module: "pdf-export",
            operation: "load-connections",
        });
        return [];
    }
}

/**
 * Select the recent threads, with message bodies, from the stored messages file.
 * @param {() => boolean} isCancelled - True once the run has been abandoned
 * @returns {Promise<object[]>} Threads for the document
 */
async function collectThreads(isCancelled) {
    if (isCancelled()) {
        return [];
    }
    const stored = await readSafely(() => Storage.getFile("messages"), "load-messages-file");
    try {
        // Read inside the try, as collectContactKeys does: a record whose text
        // getter throws would otherwise escape this function entirely and take
        // the whole export down, which is what the catch below exists to stop.
        const text = stored && stored.text ? stored.text : "";
        if (!text) {
            return [];
        }
        const contactKeys = await collectContactKeys();
        // Two storage reads have completed since the last check, and the next
        // step hands the whole messages CSV to a worker. A run the user has
        // already abandoned stops here rather than starting that work.
        if (isCancelled()) {
            return [];
        }
        return await loadRecentThreads(text, { contactKeys, isCancelled });
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
 * @param {{includeMessages?: boolean, generatedAt?: Date, isCancelled?: () => boolean}} [options] - Export options
 * @returns {Promise<{generatedAt: Date, rangeLabel: string, insights: object[], tip: string|null, allTime: Array<{label: string, value: string}>, threads: object[]}>} Document model
 */
export async function collectExportData(options = {}) {
    const isCancelled =
        typeof options.isCancelled === "function" ? options.isCancelled : () => false;
    const source = await resolveInsightSource(isCancelled);
    const outreach =
        source.outreach || (await readSafely(() => Storage.getOutreach(), "load-outreach"));
    const threads = options.includeMessages ? await collectThreads(isCancelled) : [];

    return {
        generatedAt: options.generatedAt instanceof Date ? options.generatedAt : new Date(),
        rangeLabel: formatRangeLabel(source.timeRange),
        insights: source.insights,
        tip: source.tip,
        allTime: buildAllTimeStats(source.networkGrowth, outreach),
        threads,
    };
}
