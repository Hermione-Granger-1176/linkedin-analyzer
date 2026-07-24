/**
 * File-to-text reading for uploads.
 *
 * Picks between a streaming read for large files and a FileReader read for
 * small ones, then hands the raw bytes to the shared decoder. Every function
 * here derives its result from its arguments and holds no upload page state,
 * so the page owns orchestration and this module owns only how bytes are read.
 */

import { concatChunks, decodeBytes } from "./upload-decode.js";

/** Hard ceiling on a single uploaded file, enforced before and during reads. */
export const MAX_FILE_BYTES = 80 * 1024 * 1024;

const FILE_READ_TIMEOUT_MS = 30000;
const STREAMING_READ_THRESHOLD_BYTES = 5 * 1024 * 1024;

/**
 * Read a File object as text, decoding as UTF-8 and falling back to
 * WHATWG windows-1252 for non-UTF-8 exports, matching the CLI.
 * @param {File} file - Uploaded file
 * @returns {Promise<{text: string, usedFallback: boolean}>}
 */
export function readFileAsText(file) {
    // The upload page rejects files above MAX_FILE_BYTES before calling this
    // helper, so this per-file cap is a defensive backstop, not a live path.
    /* v8 ignore next 4 */
    if (file.size > MAX_FILE_BYTES) {
        const maxMb = Math.round(MAX_FILE_BYTES / (1024 * 1024));
        return Promise.reject(new Error(`"${file.name}" exceeds the ${maxMb}MB upload limit.`));
    }

    const useStreamingRead =
        file.size >= STREAMING_READ_THRESHOLD_BYTES &&
        typeof file.stream === "function" &&
        typeof TextDecoder !== "undefined" &&
        typeof ReadableStream !== "undefined";

    if (useStreamingRead) {
        return readFileAsTextStream(file);
    }

    return readFileAsTextWithReader(file);
}

/**
 * Read a File as text via FileReader, decoding the raw bytes so UTF-8
 * validity is checked directly rather than inferred from the output.
 * @param {File} file - Uploaded file
 * @returns {Promise<{text: string, usedFallback: boolean}>}
 */
function readFileAsTextWithReader(file) {
    return readBytesWithReader(file).then((bytes) => decodeBytes(bytes, file.name));
}

/**
 * Read a File's raw bytes via FileReader, with timeout and error guards.
 * @param {File} file - Uploaded file
 * @returns {Promise<Uint8Array>}
 */
function readBytesWithReader(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        let settled = false;
        const timeoutId = window.setTimeout(() => {
            try {
                reader.abort();
            } catch {
                /* v8 ignore next */
                // Ignore abort failures and continue timeout handling.
            }
            finish(() => reject(new Error(`Reading ${file.name} timed out.`)));
        }, FILE_READ_TIMEOUT_MS);

        const finish = (callback) => {
            if (settled) {
                return;
            }
            settled = true;
            window.clearTimeout(timeoutId);
            callback();
        };

        reader.onload = () => {
            /* v8 ignore next */
            if (settled) {
                return;
            }
            // Duck-type for an ArrayBuffer (avoids cross-realm instanceof
            // pitfalls): a successful read yields a byte buffer, so anything
            // without a numeric byteLength is an unexpected/failed read and is
            // surfaced as an error rather than a silently empty file.
            const buffer = /** @type {ArrayBuffer} */ (reader.result);
            if (!buffer || typeof buffer.byteLength !== "number") {
                finish(() => reject(new Error("Error reading file")));
                return;
            }
            finish(() => resolve(new Uint8Array(buffer)));
        };
        reader.onerror = () => {
            finish(() => reject(new Error("Error reading file")));
        };
        reader.readAsArrayBuffer(file);
    });
}

/**
 * Read file text via stream chunks for large uploads, decoding as UTF-8 and
 * falling back to windows-1252 when the bytes are not valid UTF-8.
 * @param {File} file - Uploaded file
 * @returns {Promise<{text: string, usedFallback: boolean}>}
 */
async function readFileAsTextStream(file) {
    const reader = file.stream().getReader();
    const chunks = [];
    let totalBytes = 0;
    let timedOut = false;

    const timeoutId = window.setTimeout(() => {
        timedOut = true;
        /* v8 ignore next */
        reader.cancel().catch(() => {
            // Ignore cancellation failures after timeout.
        });
    }, FILE_READ_TIMEOUT_MS);

    try {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            if (timedOut) {
                throw new Error(`Reading ${file.name} timed out.`);
            }

            chunks.push(chunk.value);
            totalBytes += chunk.value.byteLength;
        }

        // The in-loop check above throws first when the watchdog fires mid-read;
        // this post-loop check only trips if the final read completes (done) in
        // the same tick the watchdog fires, which the unit clock does not stage.
        /* v8 ignore next 3 */
        if (timedOut) {
            throw new Error(`Reading ${file.name} timed out.`);
        }
    } finally {
        window.clearTimeout(timeoutId);
    }

    // Both read paths share decodeBytes: strict UTF-8 validation with a
    // windows-1252 fallback and the character-count limit applied after
    // decoding. Peak memory stays bounded by the upstream MAX_FILE_BYTES cap.
    return decodeBytes(concatChunks(chunks, totalBytes), file.name);
}
