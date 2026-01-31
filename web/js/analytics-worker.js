/* LinkedIn Analyzer - Analytics Web Worker */

const WORKER_VERSION = '20260131-3';
importScripts(`cleaner.js?v=${WORKER_VERSION}`, `analytics.js?v=${WORKER_VERSION}`);

let sharesData = null;
let commentsData = null;
let analytics = null;
let viewCache = new Map();
let currentRequestId = 0;

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

self.addEventListener('message', (event) => {
    const message = event.data || {};

    if (message.type === 'addFile') {
        const payload = message.payload || {};
        const csvText = payload.csvText || '';
        const fileName = payload.fileName || '';
        
        // Process CSV
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
        
        // Compute pre-aggregated analytics
        computeAnalytics();
        
        const base = serializeAnalytics(analytics);
        self.postMessage({
            type: 'fileProcessed',
            payload: {
                fileType,
                fileName,
                rowCount: processed.rowCount,
                analyticsBase: base,
                topics: analytics ? analytics.topics : [],
                hasData: Boolean(analytics && analytics.totals && analytics.totals.total > 0)
            }
        });
        return;
    }

    if (message.type === 'initBase') {
        analytics = hydrateAnalytics(message.payload);
        viewCache = new Map();
        const hasData = Boolean(analytics && analytics.totals && analytics.totals.total > 0);
        const topics = analytics && analytics.topics ? analytics.topics.slice(0, 60) : [];
        self.postMessage({
            type: 'init',
            payload: { hasData, topics }
        });
        return;
    }

    if (message.type === 'view') {
        const requestId = message.requestId;
        currentRequestId = requestId;
        
        if (!analytics) {
            self.postMessage({
                type: 'error',
                requestId,
                payload: { message: 'Analytics not ready.' }
            });
            return;
        }
        
        const filters = normalizeFilters(message.filters || {});
        const key = getViewKey(filters);
        
        // Check cache first
        if (viewCache.has(key)) {
            // Verify this request is still current
            if (currentRequestId !== requestId) return;
            
            self.postMessage({
                type: 'view',
                requestId,
                payload: viewCache.get(key)
            });
            return;
        }
        
        // Build view from pre-aggregated data - now O(months) not O(events)
        const view = AnalyticsEngine.buildView(analytics, filters);
        
        // Check if request is still current before sending
        if (currentRequestId !== requestId) return;
        
        if (!view) {
            self.postMessage({
                type: 'error',
                requestId,
                payload: { message: 'Unable to build analytics view.' }
            });
            return;
        }
        
        const insights = AnalyticsEngine.generateInsights(view);
        const payload = {
            view: { ...view, key },
            insights
        };
        
        // Cache with size limit
        viewCache.set(key, payload);
        if (viewCache.size > 50) {
            // Remove oldest entries
            const keysToDelete = Array.from(viewCache.keys()).slice(0, 20);
            keysToDelete.forEach(k => viewCache.delete(k));
        }
        
        self.postMessage({
            type: 'view',
            requestId,
            payload
        });
        return;
    }

    if (message.type === 'clear') {
        sharesData = null;
        commentsData = null;
        analytics = null;
        viewCache = new Map();
        currentRequestId = 0;
        self.postMessage({ type: 'cleared' });
    }
});
