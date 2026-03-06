/* LinkedIn Analyzer - Analytics Web Worker */

import { AnalyticsEngine } from "./analytics.js";
import { LinkedInCleaner } from "./cleaner.js";
import { parseAnalyticsWorkerRequest } from "./worker-contracts.js";

let sharesData = null;
let commentsData = null;
let analytics = null;
let viewCache = new Map();
let currentRequestId = 0;
const VIEW_CACHE_LIMIT = 50;
const VIEW_CACHE_TRIM = 20;
const ANALYTICS_SOURCE_TYPES = Object.freeze(["shares", "comments"]);
const WORKER_REQUEST_TYPES = new Set(["addFile", "restoreFiles", "initBase", "view", "clear"]);

/**
 * Normalize raw filter values into a safe, complete filter object.
 * @param {object} filters - Raw filter values from the UI
 * @returns {{timeRange: string, topic: string, monthFocus: string|null, day: number|null, hour: number|null, shareType: string}}
 */
function normalizeFilters(filters) {
    const safe = filters || {};
    return {
        timeRange: safe.timeRange || "12m",
        topic: safe.topic || "all",
        monthFocus: safe.monthFocus || null,
        day: typeof safe.day === "number" ? safe.day : null,
        hour: typeof safe.hour === "number" ? safe.hour : null,
        shareType: safe.shareType || "all",
    };
}

/**
 * Build a cache key string from normalized filters.
 * @param {object} filters - Raw or normalized filter object
 * @returns {string} Pipe-delimited cache key
 */
function getViewKey(filters) {
    const safe = normalizeFilters(filters);
    return [
        safe.timeRange,
        safe.topic,
        safe.monthFocus || "none",
        safe.day !== null ? safe.day : "none",
        safe.hour !== null ? safe.hour : "none",
        safe.shareType || "all",
    ].join("|");
}

/**
 * Recompute analytics aggregates from current shares and comments data.
 * Clears the view cache since aggregates have changed.
 */
function computeAnalytics() {
    analytics = AnalyticsEngine.compute(sharesData, commentsData);
    viewCache = new Map();
}

/**
 * Reset analytics and cache when no source datasets are loaded.
 */
function resetAnalyticsState() {
    analytics = null;
    viewCache = new Map();
}

/**
 * Check whether analytics currently contains any activity.
 * @returns {boolean}
 */
function hasAnalyticsData() {
    return Boolean(analytics && analytics.totals && analytics.totals.total > 0);
}

/**
 * Serialize analytics for storage - now much simpler since we store aggregates, not events
 * @param {object|null} analyticsData - Analytics aggregate payload
 * @returns {object|null}
 */
function serializeAnalytics(analyticsData) {
    if (!analyticsData) {
        /* v8 ignore next */
        return null;
    }
    // The new format is already serializable (no Date objects, no Sets in final output)
    return analyticsData;
}

/**
 * Hydrate analytics from storage - minimal work needed now
 * @param {object|null} base - Stored analytics payload
 * @returns {object|null}
 */
function hydrateAnalytics(base) {
    if (!base || !base.months) {
        return null;
    }

    // Convert activeDays arrays back to Sets for streak calculation
    const months = Object.fromEntries(
        Object.entries(base.months).map(([key, bucket]) => [
            key,
            {
                ...bucket,
                activeDays: new Set(bucket.activeDays || []),
            },
        ]),
    );

    return {
        ...base,
        months,
        activeDays: new Set(base.activeDays || []),
    };
}

/**
 * Post an error message back to the main thread.
 * @param {number} requestId - ID of the originating request
 * @param {string} message - Human-readable error description
 */
function postError(requestId, message) {
    self.postMessage({
        type: "error",
        requestId,
        payload: { message },
    });
}

/**
 * Convert unknown error values into a message string.
 * @param {unknown} error
 * @returns {string}
 */
function toErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    /* v8 ignore next 3 */
    if (typeof error === "string" && error) {
        return error;
    }
    /* v8 ignore next */
    return "Worker runtime failure.";
}

/**
 * Store a view payload in the LRU cache, trimming old entries when full.
 * @param {string} key - Cache key from getViewKey
 * @param {object} payload - The view and insights payload to cache
 */
function cacheView(key, payload) {
    viewCache.set(key, payload);
    if (viewCache.size > VIEW_CACHE_LIMIT) {
        const keysToDelete = Array.from(viewCache.keys()).slice(0, VIEW_CACHE_TRIM);
        keysToDelete.forEach((k) => viewCache.delete(k));
    }
}

/**
 * Process an uploaded CSV file: parse, clean, recompute analytics, and reply.
 * @param {{csvText: string, fileName: string, jobId?: string, totalSize?: number}} payload - File content and name
 */
function handleAddFile(payload) {
    const { csvText = "", fileName = "", jobId = null } = payload || {};

    self.postMessage({
        type: "progress",
        payload: { jobId, fileName, percent: 0.05 },
    });

    self.postMessage({
        type: "progress",
        payload: { jobId, fileName, percent: 0.12 },
    });

    const processed = LinkedInCleaner.process(csvText, "auto");
    if (!processed.success) {
        self.postMessage({
            type: "fileProcessed",
            payload: { error: processed.error || "Unable to process file.", jobId, fileName },
        });
        return;
    }

    self.postMessage({
        type: "progress",
        payload: { jobId, fileName, percent: 0.4 },
    });

    const fileType = processed.fileType;
    let analyticsBase = null;
    const updateSourceByType = {
        shares: () => {
            sharesData = processed.cleanedData;
        },
        comments: () => {
            commentsData = processed.cleanedData;
        },
    };
    const updateSource = updateSourceByType[fileType];
    if (updateSource) {
        updateSource();
        self.postMessage({
            type: "progress",
            payload: { jobId, fileName, percent: 0.55 },
        });
        computeAnalytics();
        self.postMessage({
            type: "progress",
            payload: { jobId, fileName, percent: 0.85 },
        });
        analyticsBase = serializeAnalytics(analytics);
        self.postMessage({
            type: "progress",
            payload: { jobId, fileName, percent: 0.95 },
        });
    }
    self.postMessage({
        type: "fileProcessed",
        payload: {
            fileType,
            fileName,
            jobId,
            rowCount: processed.rowCount,
            analyticsBase,
            hasData: hasAnalyticsData(),
        },
    });
}

/**
 * Restore worker source datasets from persisted CSV texts.
 * @param {{sharesCsv?: string, commentsCsv?: string}} payload - Persisted analytics inputs
 */
function handleRestoreFiles(payload) {
    const { sharesCsv = "", commentsCsv = "" } = payload || {};

    const sourceCsvByType = {
        shares: sharesCsv,
        comments: commentsCsv,
    };
    const assignSourceByType = {
        shares: (cleanedData) => {
            sharesData = cleanedData;
        },
        comments: (cleanedData) => {
            commentsData = cleanedData;
        },
    };

    sharesData = null;
    commentsData = null;

    ANALYTICS_SOURCE_TYPES.forEach((type) => {
        const csvText = sourceCsvByType[type];
        if (!csvText) {
            return;
        }

        const parsed = LinkedInCleaner.process(csvText, type);
        if (!parsed.success) {
            return;
        }
        assignSourceByType[type](parsed.cleanedData);
    });

    if (sharesData || commentsData) {
        computeAnalytics();
    } else {
        /* v8 ignore next */
        resetAnalyticsState();
    }

    self.postMessage({
        type: "restored",
        payload: {
            hasData: hasAnalyticsData(),
        },
    });
}

/**
 * Hydrate analytics from stored data and notify the main thread.
 * @param {object|null} payload - Serialized analytics base from IndexedDB
 */
function handleInitBase(payload) {
    analytics = hydrateAnalytics(payload);
    viewCache = new Map();
    const hasData = hasAnalyticsData();
    self.postMessage({
        type: "init",
        payload: { hasData },
    });
}

/**
 * Build a filtered analytics view and post it back, using cache when available.
 * @param {number} requestId - Caller-assigned request identifier for deduplication
 * @param {object} filters - Filter parameters from the UI
 */
function handleView(requestId, filters) {
    currentRequestId = requestId;

    if (!analytics) {
        postError(requestId, "Analytics not ready.");
        return;
    }

    const safeFilters = normalizeFilters(filters || {});
    const key = getViewKey(safeFilters);

    if (viewCache.has(key)) {
        if (currentRequestId !== requestId) {
            /* v8 ignore next */
            return;
        }
        self.postMessage({
            type: "view",
            requestId,
            payload: viewCache.get(key),
        });
        return;
    }

    const view = AnalyticsEngine.buildView(analytics, safeFilters);

    if (currentRequestId !== requestId) {
        /* v8 ignore next */
        return;
    }

    if (!view) {
        postError(requestId, "Unable to build analytics view.");
        return;
    }

    const insights = AnalyticsEngine.generateInsights(view);
    const payload = {
        view: { ...view, key },
        insights,
    };

    cacheView(key, payload);
    self.postMessage({
        type: "view",
        requestId,
        payload,
    });
}

/**
 * Reset all worker state, clearing stored data and caches.
 */
function handleClear() {
    sharesData = null;
    commentsData = null;
    resetAnalyticsState();
    currentRequestId = 0;
    self.postMessage({ type: "cleared" });
}

self.addEventListener("message", (event) => {
    const rawMessage = event.data || {};
    const type = rawMessage && typeof rawMessage.type === "string" ? rawMessage.type : "";
    if (!WORKER_REQUEST_TYPES.has(type)) {
        return;
    }

    const parsed = parseAnalyticsWorkerRequest(rawMessage);
    /* v8 ignore next 4 */
    if (!parsed.valid) {
        postError(0, parsed.error || "Invalid analytics worker message.");
        return;
    }

    const message = parsed.value;
    /* v8 ignore next 6 */
    const handlers = {
        addFile: () => handleAddFile(message.payload),
        restoreFiles: () => handleRestoreFiles(message.payload),
        initBase: () => handleInitBase(message.payload),
        view: () => handleView(message.requestId, message.filters),
        clear: () => handleClear(),
    };
    const handler = handlers[message.type];
    /* v8 ignore next */
    if (handler) {
        try {
            handler();
        } catch (error) {
            postError(message.requestId || 0, toErrorMessage(error));
        }
    }
});

self.addEventListener("error", (event) => {
    /* v8 ignore next */
    postError(0, toErrorMessage(event && event.error ? event.error : event && event.message));
});

self.addEventListener("unhandledrejection", (event) => {
    postError(0, toErrorMessage(event && event.reason));
});

export {
    normalizeFilters,
    getViewKey,
    handleAddFile,
    handleRestoreFiles,
    handleInitBase,
    handleView,
    handleClear,
};
