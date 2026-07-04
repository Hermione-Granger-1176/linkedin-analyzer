/* Storage keys and safe localStorage access for the guided tutorial */

const TUTORIAL_STORAGE_VERSION = "v1";
const STORAGE_PREFIX = `linkedin-analyzer:tutorial:${TUTORIAL_STORAGE_VERSION}`;

/**
 * Build completion storage key.
 * @param {string} routeName - Route name
 * @returns {string}
 */
export function getCompletionKey(routeName) {
    return `${STORAGE_PREFIX}:route:${routeName}:complete`;
}

/**
 * Build mini-tip storage key.
 * @param {string} routeName - Route name
 * @param {string} tipId - Tip id
 * @returns {string}
 */
export function getMiniTipKey(routeName, tipId) {
    return `${STORAGE_PREFIX}:route:${routeName}:tip:${tipId}:dismissed`;
}

/**
 * Build mini-tip engagement visit count storage key.
 * @returns {string}
 */
export function getMiniTipVisitCountKey() {
    return `${STORAGE_PREFIX}:mini-tip:route-visits`;
}

/**
 * Build mini-tip last shown timestamp storage key.
 * @returns {string}
 */
export function getMiniTipLastShownAtKey() {
    return `${STORAGE_PREFIX}:mini-tip:last-shown-at`;
}

/**
 * Safe localStorage getter.
 * @param {string} key - Storage key
 * @returns {string|null}
 */
export function getStorageValue(key) {
    try {
        return window.localStorage.getItem(key);
    } catch {
        /* v8 ignore next */
        return null;
    }
}

/**
 * Safe localStorage number getter.
 * @param {string} key - Storage key
 * @param {number} fallbackValue - Fallback value
 * @returns {number}
 */
export function getStorageNumberValue(key, fallbackValue) {
    const rawValue = getStorageValue(key);
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
        return fallbackValue;
    }
    return parsed;
}

/**
 * Safe localStorage setter.
 * @param {string} key - Storage key
 * @param {string} value - Value
 */
export function setStorageValue(key, value) {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        /* v8 ignore next */
        return;
    }
}

/**
 * Remove a localStorage value safely.
 * @param {string} key - Storage key
 */
export function removeStorageValue(key) {
    try {
        window.localStorage.removeItem(key);
    } catch {
        /* v8 ignore next */
        return;
    }
}
