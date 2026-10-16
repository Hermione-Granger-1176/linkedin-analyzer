/**
 * CSV sources handed to parsing workers.
 *
 * A source is the stored upload as a Blob, which the worker reads off the main
 * thread, or CSV text from a caller that already holds it. These helpers keep
 * the two interchangeable for the size checks the transports make.
 */

/**
 * Normalize a value to a CSV source: a non-empty Blob, or text. Anything else,
 * and an empty Blob, becomes an empty string so callers test one falsy value.
 * @param {unknown} value - Candidate source
 * @returns {Blob|string}
 */
export function toCsvSource(value) {
    if (typeof Blob !== "undefined" && value instanceof Blob) {
        return value.size > 0 ? value : "";
    }
    return typeof value === "string" ? value : "";
}

/**
 * Size of one CSV source: characters of text, or bytes of a Blob. Missing
 * sources count as empty.
 * @param {Blob|string|null|undefined} source - CSV text or stored upload
 * @returns {number}
 */
export function csvSourceSize(source) {
    if (typeof source === "string") {
        return source.length;
    }
    return source ? source.size : 0;
}
