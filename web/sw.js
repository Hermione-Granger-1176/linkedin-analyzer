/* LinkedIn Analyzer - Service Worker */

const CACHE_NAME = 'li-analyzer-cache';
const CACHE_PREFIX = 'li-analyzer-';

const CDN_ASSETS = [
    'https://cdn.jsdelivr.net/npm/roughjs@4.6.6/bundled/rough.min.js',
    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
];

const STATIC_ASSETS = [
    './',
    './index.html',
    './css/variables.css',
    './css/style.css',
    './css/screens.css',
    './css/sketch.css',
    './css/tutorial.css',
    './fonts/PatrickHand-Regular.woff2',
    './fonts/Caveat-Regular.woff2',
    './js/runtime.js',
    './js/theme.js',
    './js/decorations.js',
    './js/storage.js',
    './js/data-cache.js',
    './js/session.js',
    './js/router.js',
    './js/loading-overlay.js',
    './js/cleaner.js',
    './js/messages-analytics.js',
    './js/excel.js',
    './js/charts.js',
    './js/upload.js',
    './js/clean.js',
    './js/analytics-ui.js',
    './js/connections-ui.js',
    './js/messages-insights.js',
    './js/insights-ui.js',
    './js/screen-manager.js',
    './js/tutorial-steps.js',
    './js/tutorial.js',
    './js/app.js',
    './js/analytics-worker.js',
    './js/analytics.js',
    './js/messages-worker.js',
    './js/connections-worker.js',
    './assets/icon.svg',
    './assets/favicon.ico',
    './assets/apple-touch-icon.png',
    './assets/icon-192.png',
    './assets/icon-512.png',
    './assets/manifest.webmanifest'
];

/**
 * Check if a fetch response can be cached.
 * @param {Response} response - Fetch response
 * @returns {boolean}
 */
function isCacheable(response) {
    return Boolean(response && (response.status === 200 || response.type === 'opaque'));
}

/**
 * Cache one URL with a reload fetch to avoid stale HTTP cache.
 * @param {Cache} cache - Cache instance
 * @param {string} url - Asset URL
 * @returns {Promise<void>}
 */
async function cacheUrl(cache, url) {
    const request = new Request(url, { cache: 'reload' });
    const response = await fetch(request);
    if (!isCacheable(response)) {
        return;
    }
    await cache.put(request, response.clone());
}

/** Pre-cache static and CDN assets without failing install for one bad asset. */
async function preCacheAssets() {
    const cache = await caches.open(CACHE_NAME);
    const assets = [...STATIC_ASSETS, ...CDN_ASSETS];
    await Promise.allSettled(assets.map(url => cacheUrl(cache, url)));
}

/**
 * Detect app-shell HTML requests.
 * @param {Request} request - Fetch request
 * @returns {boolean}
 */
function isDocumentRequest(request) {
    if (request.mode === 'navigate') {
        return true;
    }

    if (request.destination === 'document') {
        return true;
    }

    const accept = request.headers.get('accept') || '';
    return accept.includes('text/html');
}

/**
 * Save a response to app cache when valid.
 * @param {Request} request - Fetch request
 * @param {Response} response - Fetch response
 * @returns {Promise<void>}
 */
async function putInCache(request, response) {
    if (!isCacheable(response)) {
        return;
    }
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
}

/**
 * Network-first for HTML to keep users on latest app shell.
 * @param {Request} request - Fetch request
 * @returns {Promise<Response>}
 */
async function networkFirst(request) {
    try {
        const response = await fetch(request);
        await putInCache(request, response);
        return response;
    } catch {
        const cached = await caches.match(request);
        if (cached) {
            return cached;
        }

        const fallbackUrl = new URL('./index.html', self.registration.scope).toString();
        const fallback = await caches.match(fallbackUrl);
        if (fallback) {
            return fallback;
        }

        return Response.error();
    }
}

/**
 * Cache-first with background revalidation for static assets.
 * @param {FetchEvent} event - Fetch event
 * @returns {Promise<Response>}
 */
async function staleWhileRevalidate(event) {
    const request = event.request;
    const cached = await caches.match(request);

    const networkUpdate = fetch(request)
        .then(async response => {
            await putInCache(request, response);
            return response;
        })
        .catch(() => null);

    event.waitUntil(networkUpdate.then(() => {}).catch(() => {}));

    if (cached) {
        return cached;
    }

    const fresh = await networkUpdate;
    return fresh || Response.error();
}

self.addEventListener('install', event => {
    event.waitUntil(
        preCacheAssets().then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') {
        return;
    }

    if (isDocumentRequest(event.request)) {
        event.respondWith(networkFirst(event.request));
        return;
    }

    event.respondWith(staleWhileRevalidate(event));
});
