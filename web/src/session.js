/* Session TTL cleanup */

import { SESSION_CLEANUP_PROMISE_KEY } from "./constants.js";
import { DataCache } from "./data-cache.js";
import { Storage } from "./storage.js";

export const Session = (() => {
    "use strict";

    const STORAGE_KEY = "linkedin-analyzer:last-activity";
    const EXPIRY_NOTICE_KEY = "linkedin-analyzer:expiry-notice";
    const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

    /**
     * Safe localStorage getter.
     * @param {string} key
     * @returns {string|null}
     */
    function getStorageValue(key) {
        try {
            return window.localStorage.getItem(key);
        } catch {
            /* v8 ignore next */
            return null;
        }
    }

    /**
     * Safe localStorage setter.
     * @param {string} key
     * @param {string} value
     */
    function setStorageValue(key, value) {
        try {
            window.localStorage.setItem(key, value);
        } catch {
            /* v8 ignore next */
            return;
        }
    }

    /**
     * Safe localStorage remover.
     * @param {string} key
     */
    function removeStorageValue(key) {
        try {
            window.localStorage.removeItem(key);
        } catch {
            /* v8 ignore next */
            return;
        }
    }

    /**
     * Read last activity timestamp from storage.
     * @returns {number|null}
     */
    function getLastActivity() {
        const raw = getStorageValue(STORAGE_KEY);
        if (!raw) {
            return null;
        }
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
    }

    /**
     * Check if stored activity is beyond the session TTL.
     * @param {number} lastActivity
     * @returns {boolean}
     */
    function isStale(lastActivity) {
        return Date.now() - lastActivity > SESSION_TTL_MS;
    }

    /** Update last activity timestamp. */
    function touch() {
        setStorageValue(STORAGE_KEY, String(Date.now()));
    }

    /**
     * Clear stored data when session has expired.
     * @returns {Promise<boolean>} true when cleanup runs
     */
    async function cleanIfStale() {
        const lastActivity = getLastActivity();
        if (!lastActivity || !isStale(lastActivity)) {
            touch();
            return false;
        }

        await Storage.clearAll();
        DataCache.clear();
        // Record that data was wiped so the next screen can show a one-time
        // notice instead of the data silently disappearing.
        setStorageValue(EXPIRY_NOTICE_KEY, "1");

        touch();
        return true;
    }

    /**
     * Read and clear the one-time "data expired" notice flag.
     * @returns {boolean} true when stale cleanup wiped data since the last check
     */
    function consumeExpiryNotice() {
        const hasNotice = getStorageValue(EXPIRY_NOTICE_KEY) === "1";
        if (hasNotice) {
            removeStorageValue(EXPIRY_NOTICE_KEY);
        }
        return hasNotice;
    }

    /**
     * Wait for any in-flight session cleanup to finish.
     * @returns {Promise<void>}
     */
    async function waitForCleanup() {
        const cleanupPromise = window[SESSION_CLEANUP_PROMISE_KEY];
        if (!cleanupPromise || typeof cleanupPromise.then !== "function") {
            return;
        }
        try {
            await cleanupPromise;
        } catch {
            return;
        }
    }

    return {
        cleanIfStale,
        consumeExpiryNotice,
        touch,
        waitForCleanup
    };
})();
