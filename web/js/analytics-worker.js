/* LinkedIn Analyzer - Analytics Web Worker */

importScripts('analytics.js');

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

self.addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type === 'init') {
        const payload = message.payload || {};
        analytics = AnalyticsEngine.compute(payload.shares || null, payload.comments || null);
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
        analytics = null;
        viewCache = new Map();
        self.postMessage({ type: 'cleared' });
    }
});
