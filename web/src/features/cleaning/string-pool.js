/**
 * Clean each repeated cell value once and store the result once.
 *
 * Most of the memory a worker spends on a file's rows is the cell strings, and
 * many cells repeat: the same names, profile URLs, conversation ids and folder
 * appear on row after row. Looking a raw value up before cleaning it means a
 * repeat skips the cleaning work and shares the one cleaned copy, so the rows
 * get smaller and the clean gets faster.
 *
 * Some columns almost never repeat, such as dates and message bodies, and
 * looking every one of them up costs time and saves nothing. So each column
 * checks every window of values and stops caching once a window is nearly all
 * new, which also catches a column that repeats at first and not after.
 *
 * A cached value is stored as a copy. A value sliced out of a decoded chunk
 * can keep that whole chunk alive, and one cached slice per distinct value
 * would hold most of the file's text. Values that are not cached are left
 * as they are: copying them measured slower and larger.
 */

/** Values in each window a column checks to decide whether caching pays. */
const SAMPLE_SIZE = 4096;

/** A column whose window was at least this share new values stops caching. */
const MAX_DISTINCT_SHARE = 0.9;

/**
 * Cleans one raw cell value, the same way every time.
 * @typedef {(value: unknown) => string} CellCleaner
 */

/**
 * Returns the cleaned value of one cell of a column.
 * @typedef {(value: unknown, clean: CellCleaner) => string} ColumnCache
 */

/**
 * Returns the cleaned value of one cell of a named column.
 * @typedef {(column: string, value: unknown, clean: CellCleaner) => string} ValueCache
 */

/**
 * Copy a string so it no longer shares memory with the text it was cut from.
 * Joining forces a fresh string, and slicing that drops the added space.
 * @param {string} value - String to copy
 * @returns {string}
 */
export function copyString(value) {
    return ` ${value}`.slice(1);
}

/**
 * Make a cache of cleaned values for one column. A raw value seen before
 * returns the cleaned copy made the first time.
 * @returns {ColumnCache}
 */
export function createColumnCache() {
    let seen = 0;
    let added = 0;
    /** @type {Map<string, string>|null} */
    let cleaned = new Map();
    return (value, clean) => {
        if (!cleaned || typeof value !== "string") {
            return clean(value);
        }
        let kept = cleaned.get(value);
        if (kept === undefined) {
            kept = copyString(clean(value));
            cleaned.set(copyString(value), kept);
            added += 1;
        }
        seen += 1;
        if (seen === SAMPLE_SIZE) {
            if (added >= SAMPLE_SIZE * MAX_DISTINCT_SHARE) {
                cleaned = null;
            }
            seen = 0;
            added = 0;
        }
        return kept;
    };
}

/**
 * Make a cache of cleaned values for any number of named columns.
 * @returns {ValueCache}
 */
export function createValueCache() {
    /** @type {Map<string, ColumnCache>} */
    const columns = new Map();
    return (column, value, clean) => {
        let cache = columns.get(column);
        if (!cache) {
            cache = createColumnCache();
            columns.set(column, cache);
        }
        return cache(value, clean);
    };
}
