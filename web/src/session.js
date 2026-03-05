/* Session TTL cleanup */

import { DataCache } from './data-cache.js';
import { Storage } from './storage.js';

export const Session = (() => {
    'use strict';

    const STORAGE_KEY = 'linkedin-analyzer:last-activity';
    const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
    const CLEANUP_PROMISE_KEY = '__linkedinAnalyzerSessionCleanupPromise';

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

        touch();
        return true;
    }

    /**
     * Wait for any in-flight session cleanup to finish.
     * @returns {Promise<void>}
     */
    async function waitForCleanup() {
        const cleanupPromise = window[CLEANUP_PROMISE_KEY];
        if (!cleanupPromise || typeof cleanupPromise.then !== 'function') {
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
        touch,
        waitForCleanup
    };
})();
