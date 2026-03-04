/* In-memory cache helpers for SPA screens */

export const DataCache = (() => {
    'use strict';

    const values = new Map();
    const listeners = new Set();

    /**
     * Read a value from cache.
     * @param {string} key - Cache key
     * @returns {*|undefined}
     */
    function get(key) {
        return values.get(key);
    }

    /**
     * Save a value in cache.
     * @param {string} key - Cache key
     * @param {*} value - Cached value
     * @returns {*}
     */
    function set(key, value) {
        values.set(key, value);
        return value;
    }

    /**
     * Check cache key existence.
     * @param {string} key - Cache key
     * @returns {boolean}
     */
    function has(key) {
        return values.has(key);
    }

    /**
     * Remove one key from cache.
     * @param {string} key - Cache key
     */
    function del(key) {
        values.delete(key);
    }

    /**
     * Remove all keys that match a prefix.
     * @param {string} prefix - Key prefix
     */
    function invalidate(prefix) {
        if (!prefix) {
            return;
        }
        const keys = Array.from(values.keys());
        keys.forEach(key => {
            if (key.startsWith(prefix)) {
                values.delete(key);
            }
        });
    }

    /** Clear all cached values. */
    function clear() {
        values.clear();
    }

    /**
     * Subscribe to app-level cache notifications.
     * @param {function(object): void} listener - Change listener
     * @returns {function(): void} Unsubscribe function
     */
    function subscribe(listener) {
        if (typeof listener !== 'function') {
            return () => {};
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    /**
     * Notify listeners about cache/storage changes.
     * @param {object} payload - Event payload
     */
    function notify(payload) {
        listeners.forEach(listener => {
            try {
                listener(payload || {});
            } catch {
                // Ignore listener errors to keep cache notifications resilient.
            }
        });
    }

    return {
        get,
        set,
        has,
        delete: del,
        invalidate,
        clear,
        subscribe,
        notify
    };
})();
