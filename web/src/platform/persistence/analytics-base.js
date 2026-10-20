/* Read the stored analytics base, through the in-memory cache */

import { DataCache } from "./data-cache.js";
import { Storage } from "./storage.js";

const ANALYTICS_BASE_CACHE_KEY = "storage:analyticsBase";

/** @typedef {import("./storage.js").StoredAnalytics} StoredAnalytics */

/**
 * Read the analytics base from the cache, or from storage on a miss.
 *
 * A miss caches whatever storage returns. An empty result is falsy, so it
 * counts as a miss again and storage is read on the next call.
 * @returns {Promise<StoredAnalytics|null>} Stored analytics base, or null when none is stored
 */
export async function loadAnalyticsBase() {
    const cached = /** @type {StoredAnalytics|undefined} */ (DataCache.get(ANALYTICS_BASE_CACHE_KEY));
    if (cached) {
        return cached;
    }
    const stored = await Storage.getAnalytics();
    DataCache.set(ANALYTICS_BASE_CACHE_KEY, stored);
    return stored;
}
