/* LinkedIn Analyzer - Analytics Web Worker */

import { AnalyticsEngine } from './analytics.js';
import { LinkedInCleaner } from './cleaner.js';

let sharesData = null;
let commentsData = null;
let analytics = null;
let viewCache = new Map();
let currentRequestId = 0;
const VIEW_CACHE_LIMIT = 50;
const VIEW_CACHE_TRIM = 20;
const ANALYTICS_SOURCE_TYPES = Object.freeze(['shares', 'comments']);

/**
 * Normalize raw filter values into a safe, complete filter object.
 * @param {object} filters - Raw filter values from the UI
 * @returns {{timeRange: string, topic: string, monthFocus: string|null, day: number|null, hour: number|null, shareType: string}}
 */
function normalizeFilters(filters) {
    const safe = filters || {};
    return {
        timeRange: safe.timeRange || '12m',
        topic: safe.topic || 'all',
        monthFocus: safe.monthFocus || null,
        day: typeof safe.day === 'number' ? safe.day : null,
        hour: typeof safe.hour === 'number' ? safe.hour : null,
        shareType: safe.shareType || 'all'
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
        safe.monthFocus || 'none',
        safe.day !== null ? safe.day : 'none',
        safe.hour !== null ? safe.hour : 'none',
        safe.shareType || 'all'
    ].join('|');
}

/**
 * Recompute analytics aggregates from current shares and comments data.
 * @description Clears the view cache since aggregates have changed.
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
 */
function serializeAnalytics(analyticsData) {
    if (!analyticsData) return null;
    // The new format is already serializable (no Date objects, no Sets in final output)
    return analyticsData;
}

/**
 * Hydrate analytics from storage - minimal work needed now
 */
function hydrateAnalytics(base) {
    if (!base || !base.months) return null;

    // Convert activeDays arrays back to Sets for streak calculation
    const months = {};
    for (const [key, bucket] of Object.entries(base.months)) {
        months[key] = {
            ...bucket,
            activeDays: new Set(bucket.activeDays || [])
        };
    }

    return {
        ...base,
        months,
        activeDays: new Set(base.activeDays || [])
    };
}

/**
 * Post an error message back to the main thread.
 * @param {number} requestId - ID of the originating request
 * @param {string} message - Human-readable error description
 */
function postError(requestId, message) {
    self.postMessage({
        type: 'error',
        requestId,
        payload: { message }
    });
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
        keysToDelete.forEach(k => viewCache.delete(k));
    }
}

/**
 * Process an uploaded CSV file: parse, clean, recompute analytics, and reply.
 * @param {{csvText: string, fileName: string, jobId?: string, totalSize?: number}} payload - File content and name
 */
function handleAddFile(payload) {
    const {
        csvText = '',
        fileName = '',
        jobId = null
    } = payload || {};

    self.postMessage({
        type: 'progress',
        payload: { jobId, fileName, percent: 0.02 }
    });

    self.postMessage({
        type: 'progress',
        payload: { jobId, fileName, percent: 0.08 }
    });

    const processed = LinkedInCleaner.process(csvText, 'auto');
    if (!processed.success) {
        self.postMessage({
            type: 'fileProcessed',
            payload: { error: processed.error || 'Unable to process file.', jobId, fileName }
        });
        return;
    }

    const fileType = processed.fileType;
    let analyticsBase = null;
    const updateSourceByType = {
        shares: () => {
            sharesData = processed.cleanedData;
        },
        comments: () => {
            commentsData = processed.cleanedData;
        }
    };
    const updateSource = updateSourceByType[fileType];
    if (updateSource) {
        updateSource();
        self.postMessage({
            type: 'progress',
            payload: { jobId, fileName, percent: 0.6 }
        });
        computeAnalytics();
        self.postMessage({
            type: 'progress',
            payload: { jobId, fileName, percent: 0.92 }
        });
        analyticsBase = serializeAnalytics(analytics);
    }
    self.postMessage({
        type: 'fileProcessed',
        payload: {
            fileType,
            fileName,
            jobId,
            rowCount: processed.rowCount,
            analyticsBase,
            hasData: hasAnalyticsData()
        }
    });
}

/**
 * Restore worker source datasets from persisted CSV texts.
 * @param {{sharesCsv?: string, commentsCsv?: string}} payload - Persisted analytics inputs
 */
function handleRestoreFiles(payload) {
    const {
        sharesCsv = '',
        commentsCsv = ''
    } = payload || {};

    const sourceCsvByType = {
        shares: sharesCsv,
        comments: commentsCsv
    };
    const assignSourceByType = {
        shares: (cleanedData) => {
            sharesData = cleanedData;
        },
        comments: (cleanedData) => {
            commentsData = cleanedData;
        }
    };

    sharesData = null;
    commentsData = null;

    ANALYTICS_SOURCE_TYPES.forEach(type => {
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
        resetAnalyticsState();
    }

    self.postMessage({
        type: 'restored',
        payload: {
            hasData: hasAnalyticsData()
        }
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
        type: 'init',
        payload: { hasData }
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
        postError(requestId, 'Analytics not ready.');
        return;
    }

    const safeFilters = normalizeFilters(filters || {});
    const key = getViewKey(safeFilters);

    if (viewCache.has(key)) {
        if (currentRequestId !== requestId) return;
        self.postMessage({
            type: 'view',
            requestId,
            payload: viewCache.get(key)
        });
        return;
    }

    const view = AnalyticsEngine.buildView(analytics, safeFilters);

    if (currentRequestId !== requestId) return;

    if (!view) {
        postError(requestId, 'Unable to build analytics view.');
        return;
    }

    const insights = AnalyticsEngine.generateInsights(view);
    const payload = {
        view: { ...view, key },
        insights
    };

    cacheView(key, payload);
    self.postMessage({
        type: 'view',
        requestId,
        payload
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
    self.postMessage({ type: 'cleared' });
}

self.addEventListener('message', (event) => {
    const message = event.data || {};
    const handlers = {
        addFile: () => handleAddFile(message.payload || {}),
        restoreFiles: () => handleRestoreFiles(message.payload || {}),
        initBase: () => handleInitBase(message.payload || null),
        view: () => handleView(message.requestId, message.filters || {}),
        clear: () => handleClear()
    };
    const handler = handlers[message.type];
    if (handler) {
        handler();
    }
});

export { normalizeFilters, getViewKey, handleAddFile, handleRestoreFiles, handleInitBase, handleView, handleClear };
