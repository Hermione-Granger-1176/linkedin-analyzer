import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('workbox-precaching', () => ({
    precacheAndRoute: vi.fn(),
    cleanupOutdatedCaches: vi.fn()
}));

vi.mock('workbox-routing', () => ({
    registerRoute: vi.fn()
}));

vi.mock('workbox-expiration', () => ({
    ExpirationPlugin: vi.fn(class MockExpirationPlugin {
        constructor(options) {
            return options;
        }
    })
}));

vi.mock('workbox-strategies', () => ({
    NetworkFirst: vi.fn(class MockNetworkFirst {
        constructor() {
            return {
                handle: vi.fn(async () => new Response('network'))
            };
        }
    }),
    StaleWhileRevalidate: vi.fn(class MockStaleWhileRevalidate {
        constructor(options) {
            return options;
        }
    }),
    CacheFirst: vi.fn(class MockCacheFirst {
        constructor(options) {
            return options;
        }
    })
}));

describe('service worker', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        globalThis.self = { __WB_MANIFEST: [] };
        globalThis.caches = {
            match: vi.fn(async () => new Response('cached-shell'))
        };
    });

    it('registers precache and cleanup handlers', async () => {
        await import('../src/sw.js');
        const workbox = await import('workbox-precaching');
        expect(workbox.cleanupOutdatedCaches).toHaveBeenCalled();
        expect(workbox.precacheAndRoute).toHaveBeenCalled();
    });

    it('registers navigation, static, and media runtime routes', async () => {
        await import('../src/sw.js');
        const routing = await import('workbox-routing');
        expect(routing.registerRoute).toHaveBeenCalledTimes(3);
    });

    it('falls back to cached app shell when network-first navigation fails', async () => {
        await import('../src/sw.js');

        const routing = await import('workbox-routing');
        const strategies = await import('workbox-strategies');

        const networkFirstInstance = strategies.NetworkFirst.mock.results[0].value;
        networkFirstInstance.handle.mockRejectedValueOnce(new Error('offline'));

        const navigationHandler = routing.registerRoute.mock.calls[0][1];
        const response = await navigationHandler({
            event: {
                request: new Request('https://example.com/app', { method: 'GET' })
            }
        });

        expect(globalThis.caches.match).toHaveBeenCalled();
        expect(response).toBeInstanceOf(Response);
    });

    it('returns Response.error when cache fallback is unavailable', async () => {
        globalThis.caches.match = vi.fn(async () => undefined);
        await import('../src/sw.js');

        const routing = await import('workbox-routing');
        const strategies = await import('workbox-strategies');

        const networkFirstInstance = strategies.NetworkFirst.mock.results[0].value;
        networkFirstInstance.handle.mockRejectedValueOnce(new Error('offline'));

        const navigationHandler = routing.registerRoute.mock.calls[0][1];
        const response = await navigationHandler({
            event: {
                request: new Request('https://example.com/app', { method: 'GET' })
            }
        });

        expect(globalThis.caches.match).toHaveBeenCalledWith('/index.html', { ignoreSearch: true });
        expect(response.type).toBe('error');
    });

    it('registers expected route matchers for navigation, static assets, and media', async () => {
        await import('../src/sw.js');
        const routing = await import('workbox-routing');

        const navigationMatcher = routing.registerRoute.mock.calls[0][0];
        const staticMatcher = routing.registerRoute.mock.calls[1][0];
        const mediaMatcher = routing.registerRoute.mock.calls[2][0];

        expect(navigationMatcher({ request: { mode: 'navigate' } })).toBe(true);
        expect(navigationMatcher({ request: { mode: 'same-origin' } })).toBe(false);

        expect(staticMatcher({ request: { destination: 'script' } })).toBe(true);
        expect(staticMatcher({ request: { destination: 'style' } })).toBe(true);
        expect(staticMatcher({ request: { destination: 'image' } })).toBe(false);

        expect(mediaMatcher({ request: { destination: 'font' } })).toBe(true);
        expect(mediaMatcher({ request: { destination: 'image' } })).toBe(true);
        expect(mediaMatcher({ request: { destination: 'script' } })).toBe(false);
    });
});
