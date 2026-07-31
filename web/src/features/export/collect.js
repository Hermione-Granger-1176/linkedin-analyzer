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

import { loadRecentThreads } from "./threads-transport.js";

const ANALYTICS_BASE_CACHE_KEY = "storage:analyticsBase";
const WORKER_TIMEOUT_MS = 30000;

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
 * @param {object|null} networkGrowth - Lifetime network growth from the view
 * @param {object|null} outreach - Persisted outreach summary
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
    const empty = { insights: [], tip: null, networkGrowth: null };

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

        const finish = (value) => {
            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
                timeoutId = null;
            }
            worker.terminate();
            resolve(value);
        };

        worker.addEventListener("message", (event) => {
            const parsed = parseAnalyticsWorkerMessage(event.data || {});
            if (!parsed.valid) {
                return;
            }
            const message = parsed.value;
            if (message.type === "init") {
                if (!message.payload.hasData) {
                    finish(empty);
                    return;
                }
                worker.postMessage({ type: "view", requestId, filters: { ...DEFAULT_FILTERS } });
                return;
            }
            if (message.type === "view" && message.requestId === requestId) {
                const payload = message.payload || {};
                const insights = payload.insights || {};
                finish({
                    insights: insights.insights || [],
                    tip: insights.tip || null,
                    networkGrowth: (payload.view && payload.view.networkGrowth) || null,
                });
                return;
            }
            if (message.type === "error") {
                captureError(new Error("Analytics worker error during export."), {
                    module: "pdf-export",
                    operation: "analytics-worker-error-payload",
                });
                finish(empty);
            }
        });

        const handleError = () => {
            captureError(new Error("Analytics worker failed during export."), {
                module: "pdf-export",
                operation: "analytics-worker-error-event",
            });
            finish(empty);
        };
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

        worker.postMessage({ type: "initBase", payload: analyticsBase });
    });
}

/**
 * Resolve the insight cards, tip and range, preferring the on-screen snapshot.
 * @returns {Promise<{timeRange: string, insights: object[], tip: string|null, networkGrowth: object|null, outreach: object|null}>} Insight source data
 */
async function resolveInsightSource() {
    const snapshot = DataCache.get(INSIGHTS_EXPORT_CACHE_KEY);
    if (snapshot && Array.isArray(snapshot.insights) && snapshot.insights.length) {
        return {
            timeRange: snapshot.timeRange,
            insights: snapshot.insights,
            tip: snapshot.tip || null,
            networkGrowth: snapshot.networkGrowth || null,
            outreach: snapshot.outreach || null,
        };
    }

    let analyticsBase = DataCache.get(ANALYTICS_BASE_CACHE_KEY) || null;
    if (!analyticsBase) {
        analyticsBase = await readSafely(() => Storage.getAnalytics(), "load-analytics");
    }
    if (!analyticsBase || !analyticsBase.months) {
        return {
            timeRange: DEFAULT_FILTERS.timeRange,
            insights: [],
            tip: null,
            networkGrowth: null,
            outreach: null,
        };
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
    if (snapshot && Array.isArray(snapshot.insights) && snapshot.insights.length) {
        return true;
    }
    const cachedBase = DataCache.get(ANALYTICS_BASE_CACHE_KEY);
    if (cachedBase && cachedBase.months) {
        return true;
    }
    const analyticsBase = await readSafely(() => Storage.getAnalytics(), "load-analytics");
    if (analyticsBase && analyticsBase.months) {
        return true;
    }
    const outreach = await readSafely(() => Storage.getOutreach(), "load-outreach");
    return Boolean(outreach);
}

/**
 * Read the stored messages CSV and select the recent threads.
 * @returns {Promise<object[]>} Selected threads, or an empty list
 */
async function collectThreads() {
    const stored = await readSafely(() => Storage.getFile("messages"), "load-messages-file");
    const text = stored && stored.text ? stored.text : "";
    if (!text) {
        return [];
    }
    try {
        return await loadRecentThreads(text);
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
 * @param {{includeMessages?: boolean, generatedAt?: Date}} [options] - Export options
 * @returns {Promise<{generatedAt: Date, rangeLabel: string, insights: object[], tip: string|null, allTime: Array<{label: string, value: string}>, threads: object[]}>} Document model
 */
export async function collectExportData(options = {}) {
    const source = await resolveInsightSource();
    const outreach =
        source.outreach || (await readSafely(() => Storage.getOutreach(), "load-outreach"));

    return {
        generatedAt: options.generatedAt instanceof Date ? options.generatedAt : new Date(),
        rangeLabel: formatRangeLabel(source.timeRange),
        insights: source.insights,
        tip: source.tip,
        allTime: buildAllTimeStats(source.networkGrowth, outreach),
        threads: options.includeMessages ? await collectThreads() : [],
    };
}
