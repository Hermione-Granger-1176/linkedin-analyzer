/**
 * Decode upload bytes, join stream chunks, and identify storage quota errors.
 * The helpers depend on their arguments and the shared CSV character limit.
 */

import { MAX_CSV_CHARS } from "../../shared/limits.js";

/**
 * Decode raw file bytes to text. Validates UTF-8 strictly (fatal) and only
 * falls back to WHATWG windows-1252 on a genuine decode error, matching the
 * CLI and avoiding false positives on files that legitimately
 * contain U+FFFD. Enforces the character limit after decoding.
 * @param {Uint8Array} bytes - Raw file bytes
 * @param {string} fileName - Original file name, used in error messages
 * @returns {{text: string, usedFallback: boolean}}
 */
export function decodeBytes(bytes, fileName) {
    if (typeof TextDecoder === "undefined") {
        // The streaming path already routes around a missing TextDecoder; the
        // FileReader path lands here, so fail with a clear, user-facing error
        // instead of a bare ReferenceError from `new TextDecoder(...)`.
        throw new Error(
            `Cannot read "${fileName}": your browser is missing required text-decoding support. Please use a newer browser.`,
        );
    }
    let text;
    let usedFallback = false;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        text = new TextDecoder("windows-1252").decode(bytes);
        usedFallback = true;
    }
    if (text.length > MAX_CSV_CHARS) {
        const maxMb = Math.round(MAX_CSV_CHARS / (1024 * 1024));
        throw new Error(`"${fileName}" exceeds the ${maxMb}MB text limit.`);
    }
    return { text, usedFallback };
}

/**
 * Concatenate raw stream byte chunks into a single byte array.
 * @param {Uint8Array[]} chunks - Collected stream chunks
 * @param {number} totalBytes - Sum of all chunk byte lengths
 * @returns {Uint8Array}
 */
export function concatChunks(chunks, totalBytes) {
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

/**
 * Detect a storage quota error, walking the `cause` chain since Storage wraps
 * the native DOMException inside a descriptive Error.
 * @param {unknown} error - The caught error
 * @returns {boolean}
 */
export function isQuotaExceededError(error) {
    let current = error;
    for (let depth = 0; current && depth < 10; depth += 1) {
        const candidate = /** @type {{name?: string, code?: number, cause?: unknown}} */ (current);
        if (
            candidate.name === "QuotaExceededError" ||
            candidate.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
            candidate.code === 22
        ) {
            return true;
        }
        current = candidate.cause;
    }
    return false;
}
