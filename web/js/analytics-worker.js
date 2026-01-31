/* LinkedIn Analyzer - Analytics Web Worker */

const WORKER_VERSION = '20260131-1';
importScripts(`cleaner.js?v=${WORKER_VERSION}`, `analytics.js?v=${WORKER_VERSION}`);

let sharesData = null;
let commentsData = null;
let analytics = null;
let viewCache = new Map();

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

function serializeAnalytics(analyticsData) {
    if (!analyticsData || !analyticsData.events) return null;
    const events = analyticsData.events.map(event => ({
        timestamp: event.timestamp,
        dateKey: event.dateKey,
        monthKey: event.monthKey,
        dayIndex: event.dayIndex,
        hour: event.hour,
        type: event.type,
        topics: Array.from(event.topicSet || []),
        hasMedia: event.hasMedia,
        hasLink: event.hasLink
    }));
    return {
        events,
        latestDate: analyticsData.latestDate ? analyticsData.latestDate.getTime() : null,
        topics: analyticsData.topics || []
    };
}

function hydrateAnalytics(base) {
    if (!base || !base.events) return null;
    const events = base.events.map(event => ({
        timestamp: event.timestamp,
        date: new Date(event.timestamp),
        dateKey: event.dateKey,
        monthKey: event.monthKey,
        dayIndex: event.dayIndex,
        hour: event.hour,
        type: event.type,
        topicSet: new Set(event.topics || []),
        hasMedia: event.hasMedia,
        hasLink: event.hasLink
    }));
    return {
        events,
        latestDate: base.latestDate ? new Date(base.latestDate) : null,
        topics: base.topics || []
    };
}

self.addEventListener('message', (event) => {
    const message = event.data || {};

    if (message.type === 'addFile') {
        const payload = message.payload || {};
        const csvText = payload.csvText || '';
        const fileName = payload.fileName || '';
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
                topics: analytics ? analytics.topics : [],
                hasData: Boolean(analytics && analytics.events && analytics.events.length)
            }
        });
        return;
    }

    if (message.type === 'initBase') {
        analytics = hydrateAnalytics(message.payload);
        viewCache = new Map();
        const hasData = Boolean(analytics && analytics.events && analytics.events.length);
        const topics = analytics && analytics.topics ? analytics.topics.slice(0, 60) : [];
        self.postMessage({
            type: 'init',
            payload: { hasData, topics }
        });
        return;
    }

    if (message.type === 'view') {
        if (!analytics) {
            self.postMessage({
                type: 'error',
                requestId: message.requestId,
                payload: { message: 'Analytics not ready.' }
            });
            return;
        }
        const filters = normalizeFilters(message.filters || {});
        const key = getViewKey(filters);
        if (viewCache.has(key)) {
            self.postMessage({
                type: 'view',
                requestId: message.requestId,
                payload: viewCache.get(key)
            });
            return;
        }
        const view = AnalyticsEngine.buildView(analytics, filters);
        if (!view) {
            self.postMessage({
                type: 'error',
                requestId: message.requestId,
                payload: { message: 'Unable to build analytics view.' }
            });
            return;
        }
        const insights = AnalyticsEngine.generateInsights(view);
        const payload = {
            view: { ...view, key },
            insights
        };
        viewCache.set(key, payload);
        if (viewCache.size > 30) {
            viewCache.clear();
            viewCache.set(key, payload);
        }
        self.postMessage({
            type: 'view',
            requestId: message.requestId,
            payload
        });
        return;
    }

    if (message.type === 'clear') {
        sharesData = null;
        commentsData = null;
        analytics = null;
        viewCache = new Map();
        self.postMessage({ type: 'cleared' });
    }
});
