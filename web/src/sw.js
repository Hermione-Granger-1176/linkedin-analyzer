import { ExpirationPlugin } from "workbox-expiration";
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from "workbox-strategies";

const SW_LOCATION_HREF =
    self.location && self.location.href ? self.location.href : "https://example.com/sw.js";
const APP_SHELL_URL = new URL("./index.html", SW_LOCATION_HREF).pathname;

cleanupOutdatedCaches();
/** @typedef {{__WB_MANIFEST?: Array<string|{url: string, revision: string|null}>}} ManifestScope */
// The build injects the precache manifest onto the worker's global scope.
const manifestScope = /** @type {ManifestScope} */ (/** @type {unknown} */ (self));
precacheAndRoute(/* v8 ignore next */ manifestScope.__WB_MANIFEST || []);

const navigationStrategy = new NetworkFirst({
    cacheName: "app-shell-v1",
    networkTimeoutSeconds: 4,
});

registerRoute(
    ({ request }) => request.mode === "navigate",
    async ({ event }) => {
        try {
            return await navigationStrategy.handle({
                event,
                request: /** @type {FetchEvent} */ (event).request,
            });
        } catch {
            const cachedShell = await caches.match(APP_SHELL_URL, { ignoreSearch: true });
            return cachedShell || Response.error();
        }
    },
);

registerRoute(
    ({ request }) => request.destination === "style" || request.destination === "script",
    new StaleWhileRevalidate({
        cacheName: "static-resources-v1",
        plugins: [
            new ExpirationPlugin({
                maxEntries: 60,
                maxAgeSeconds: 60 * 60 * 24 * 30,
            }),
        ],
    }),
);

registerRoute(
    ({ request }) => request.destination === "font" || request.destination === "image",
    new CacheFirst({
        cacheName: "static-media-v1",
        plugins: [
            new ExpirationPlugin({
                maxEntries: 120,
                maxAgeSeconds: 60 * 60 * 24 * 30,
            }),
        ],
    }),
);
