/* LinkedIn Analyzer - Analytics Web Worker */

const WORKER_VERSION = '20260131-5';
importScripts(`cleaner.js?v=${WORKER_VERSION}`, `analytics.js?v=${WORKER_VERSION}`);

let sharesData = null;
let commentsData = null;
let analytics = null;
let viewCache = new Map();
let currentRequestId = 0;
const VIEW_CACHE_LIMIT = 50;
const VIEW_CACHE_TRIM = 20;

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

function computeAnalytics() {
    analytics = AnalyticsEngine.compute(sharesData, commentsData);
    viewCache = new Map();
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

function postError(requestId, message) {
    self.postMessage({
        type: 'error',
        requestId,
        payload: { message }
    });
}

function cacheView(key, payload) {
    viewCache.set(key, payload);
    if (viewCache.size > VIEW_CACHE_LIMIT) {
        const keysToDelete = Array.from(viewCache.keys()).slice(0, VIEW_CACHE_TRIM);
        keysToDelete.forEach(k => viewCache.delete(k));
    }
}

function handleAddFile(payload) {
    const csvText = payload && payload.csvText ? payload.csvText : '';
    const fileName = payload && payload.fileName ? payload.fileName : '';

    const processed = LinkedInCleaner.process(csvText, 'auto');
    if (!processed.success) {
        self.postMessage({
            type: 'fileProcessed',
            payload: { error: processed.error || 'Unable to process file.' }
        });
        return;
    }

    const fileType = processed.fileType;
    if (fileType === 'shares') {
        sharesData = processed.cleanedData;
    }
    if (fileType === 'comments') {
        commentsData = processed.cleanedData;
    }

    computeAnalytics();

    const base = serializeAnalytics(analytics);
    self.postMessage({
        type: 'fileProcessed',
        payload: {
            fileType,
            fileName,
            rowCount: processed.rowCount,
            analyticsBase: base,
            hasData: Boolean(analytics && analytics.totals && analytics.totals.total > 0)
        }
    });
}

function handleInitBase(payload) {
    analytics = hydrateAnalytics(payload);
    viewCache = new Map();
    const hasData = Boolean(analytics && analytics.totals && analytics.totals.total > 0);
    self.postMessage({
        type: 'init',
        payload: { hasData }
    });
}

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

function handleClear() {
    sharesData = null;
    commentsData = null;
    analytics = null;
    viewCache = new Map();
    currentRequestId = 0;
    self.postMessage({ type: 'cleared' });
}

self.addEventListener('message', (event) => {
    const message = event.data || {};
    switch (message.type) {
        case 'addFile':
            handleAddFile(message.payload || {});
            break;
        case 'initBase':
            handleInitBase(message.payload || null);
            break;
        case 'view':
            handleView(message.requestId, message.filters || {});
            break;
        case 'clear':
            handleClear();
            break;
        default:
            break;
    }
});
