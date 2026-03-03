/* Session TTL cleanup */

(function() {
    'use strict';

    const STORAGE_KEY = 'linkedin-analyzer:last-activity';
    const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

    /** Safe localStorage getter. */
    function getStorageValue(key) {
        try {
            return window.localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    /** Safe localStorage setter. */
    function setStorageValue(key, value) {
        try {
            window.localStorage.setItem(key, value);
        } catch {
            return;
        }
    }

    /** Read last activity timestamp from storage. */
    function getLastActivity() {
        const raw = getStorageValue(STORAGE_KEY);
        if (!raw) {
            return null;
        }
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
    }

    /** Check if stored activity is beyond the session TTL. */
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

        if (typeof Storage !== 'undefined' && Storage.clearAll) {
            await Storage.clearAll();
        }
        if (typeof DataCache !== 'undefined' && DataCache.clear) {
            DataCache.clear();
        }

        touch();
        return true;
    }

    window.Session = {
        cleanIfStale,
        touch
    };
})();
