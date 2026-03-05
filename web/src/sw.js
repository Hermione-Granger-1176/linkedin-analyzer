import { ExpirationPlugin } from 'workbox-expiration';
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies';

const APP_SHELL_URL = '/index.html';

cleanupOutdatedCaches();
precacheAndRoute(/* v8 ignore next */ self.__WB_MANIFEST || []);

const navigationStrategy = new NetworkFirst({
    cacheName: 'app-shell-v1',
    networkTimeoutSeconds: 4
});

registerRoute(
    ({ request }) => request.mode === 'navigate',
    async ({ event }) => {
        try {
            return await navigationStrategy.handle({ event, request: event.request });
        } catch {
            const cachedShell = await caches.match(APP_SHELL_URL, { ignoreSearch: true });
            return cachedShell || Response.error();
        }
    }
);

registerRoute(
    ({ request }) => request.destination === 'style' || request.destination === 'script',
    new StaleWhileRevalidate({
        cacheName: 'static-resources-v1'
    })
);

registerRoute(
    ({ request }) => request.destination === 'font' || request.destination === 'image',
    new CacheFirst({
        cacheName: 'static-media-v1',
        plugins: [
            new ExpirationPlugin({
                maxEntries: 120,
                maxAgeSeconds: 60 * 60 * 24 * 30
            })
        ]
    })
);
