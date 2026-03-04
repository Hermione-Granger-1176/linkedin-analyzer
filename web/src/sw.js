import { precacheAndRoute } from 'workbox-precaching';

precacheAndRoute(self.__WB_MANIFEST || []);

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') {
        return;
    }
});
