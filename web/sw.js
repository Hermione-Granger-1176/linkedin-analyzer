/* LinkedIn Analyzer - Service Worker */

const CACHE_NAME = 'li-analyzer-v1';

const STATIC_ASSETS = [
    './',
    './index.html',
    './css/variables.css',
    './css/style.css',
    './css/screens.css',
    './css/sketch.css',
    './fonts/PatrickHand-Regular.woff2',
    './fonts/Caveat-Regular.woff2',
    './js/runtime.js',
    './js/theme.js',
    './js/decorations.js',
    './js/storage.js',
    './js/data-cache.js',
    './js/router.js',
    './js/loading-overlay.js',
    './js/cleaner.js',
    './js/excel.js',
    './js/charts.js',
    './js/upload.js',
    './js/clean.js',
    './js/analytics-ui.js',
    './js/connections-ui.js',
    './js/messages-insights.js',
    './js/insights-ui.js',
    './js/screen-manager.js',
    './js/app.js',
    './js/analytics-worker.js',
    './js/analytics.js',
    './js/messages-worker.js',
    './js/connections-worker.js',
    './assets/icon.svg',
    './assets/favicon.ico',
    './assets/apple-touch-icon.png',
    './assets/icon-192.png',
    './assets/manifest.webmanifest'
];

/** Pre-cache all static assets on install. */
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

/** Remove stale caches on activation. */
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

/** Cache-first fetch with dynamic caching for uncached requests. */
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;

            return fetch(event.request).then(response => {
                // Only cache same-origin successful responses
                if (!response || response.status !== 200 || response.type !== 'basic') {
                    return response;
                }
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                return response;
            });
        })
    );
});
