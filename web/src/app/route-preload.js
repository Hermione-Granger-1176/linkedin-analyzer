/* Fetch a likely next screen's code while the browser is idle */

import { getDeviceProfile } from "../platform/device/capabilities.js";

import { ScreenManager } from "./screen-manager.js";

// Without requestIdleCallback, wait this long so the preload stays out of the
// way of whatever the page is doing right now.
const IDLE_FALLBACK_MS = 2000;
// An idle callback is still run after this long on a page that is never idle.
const IDLE_TIMEOUT_MS = 5000;

/** @type {Set<string>} */
const requested = new Set();

/**
 * Load a route's screen code when the browser is next idle, once per route.
 * Skipped on the lite tier with Save-Data on, where the visitor has asked for
 * fewer bytes and the screen can still load when it is opened.
 * @param {string} routeName - Route to preload
 */
export function preloadRouteWhenIdle(routeName) {
    if (requested.has(routeName)) {
        return;
    }
    const profile = getDeviceProfile();
    if (profile.tier === "lite" && profile.signals.saveData) {
        return;
    }
    requested.add(routeName);
    const load = () => {
        void ScreenManager.loadController(routeName);
    };
    if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(load, { timeout: IDLE_TIMEOUT_MS });
    } else {
        window.setTimeout(load, IDLE_FALLBACK_MS);
    }
}
