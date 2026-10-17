/**
 * Store the values of many parsed rows once each.
 *
 * Most of the memory a worker spends on a file's rows is the cell strings, and
 * many cells repeat: the same names, profile URLs, conversation ids and folder
 * appear on row after row. Sharing one copy of each repeated value shrinks the
 * rows several times over.
 *
 * Some columns almost never repeat, such as dates and message bodies, and
 * looking every one of them up costs time and saves nothing. So each column
 * samples its first values and stops sharing when nearly all were new.
 *
 * Every kept value is a copy. A value sliced out of a decoded chunk can keep
 * that whole chunk alive, so keeping slices would hold the file's text as well.
 */

/** Values a column sees before it decides whether sharing pays. */
const SAMPLE_SIZE = 4096;

/** A column whose sample was at least this share distinct values stops sharing. */
const MAX_DISTINCT_SHARE = 0.9;

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
 * Make a function that returns a detached copy of each value, the same copy
 * for every repeat of a value in a column that repeats.
 * @returns {(value: string, column: string) => string}
 */
export function createStringPool() {
    /** @type {Map<string, {seen: number, pool: Map<string, string>|null}>} */
    const columns = new Map();
    return (value, column) => {
        let state = columns.get(column);
        if (!state) {
            state = { seen: 0, pool: new Map() };
            columns.set(column, state);
        }
        const { pool } = state;
        if (!pool) {
            return copyString(value);
        }
        let kept = pool.get(value);
        if (kept === undefined) {
            kept = copyString(value);
            pool.set(kept, kept);
        }
        state.seen += 1;
        if (state.seen === SAMPLE_SIZE && pool.size >= SAMPLE_SIZE * MAX_DISTINCT_SHARE) {
            state.pool = null;
        }
        return kept;
    };
}
