/**
 * File-to-text reading for uploads.
 *
 * Picks between a streaming read for large files and a FileReader read for
 * small ones, then hands the raw bytes to the shared decoder. Every function
 * here derives its result from its arguments and holds no upload page state,
 * so the page owns orchestration and this module owns only how bytes are read.
 * Nothing here touches the DOM, so the analytics worker reads uploads with it.
 */

import { MAX_FILE_BYTES } from "../../shared/limits.js";

import { concatChunks, decodeBytes } from "./decode.js";

const FILE_READ_TIMEOUT_MS = 30000;
const STREAMING_READ_THRESHOLD_BYTES = 5 * 1024 * 1024;

/**
 * @typedef {object} ReadOptions
 * @property {AbortSignal} [signal] - Stops the read when aborted
 * @property {(bytesRead: number, totalBytes: number) => void} [onProgress] - Called as bytes arrive
 */

/**
 * Read a File object as text, decoding as UTF-8 and falling back to
 * WHATWG windows-1252 for non-UTF-8 exports, matching the CLI.
 * @param {File} file - Uploaded file
 * @param {ReadOptions} [options] - Cancellation and progress hooks
 * @returns {Promise<{text: string, usedFallback: boolean}>}
 */
export function readFileAsText(file, options = {}) {
    // The upload page rejects oversized files before calling this helper. Keep
    // this check for direct callers that bypass page-level validation.
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
        return readFileAsTextStream(file, options);
    }

    return readFileAsTextWithReader(file, options);
}

/**
 * Build the error a cancelled read rejects with.
 * @param {File} file - Uploaded file
 * @returns {Error}
 */
function abortError(file) {
    const error = new Error(`Reading ${file.name} was cancelled.`);
    error.name = "AbortError";
    return error;
}

/**
 * Read a File as text via FileReader, decoding the raw bytes so UTF-8
 * validity is checked directly rather than inferred from the output.
 * @param {File} file - Uploaded file
 * @param {ReadOptions} options - Cancellation and progress hooks
 * @returns {Promise<{text: string, usedFallback: boolean}>}
 */
function readFileAsTextWithReader(file, { signal, onProgress }) {
    return readBytesWithReader(file).then((bytes) => {
        if (signal && signal.aborted) {
            throw abortError(file);
        }
        if (onProgress) {
            onProgress(bytes.byteLength, file.size);
        }
        return decodeBytes(bytes, file.name);
    });
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
        const timeoutId = globalThis.setTimeout(() => {
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
            globalThis.clearTimeout(timeoutId);
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
            // reported as an error rather than treated as an empty file.
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
 * @param {ReadOptions} options - Cancellation and progress hooks
 * @returns {Promise<{text: string, usedFallback: boolean}>}
 */
async function readFileAsTextStream(file, { signal, onProgress }) {
    const reader = file.stream().getReader();
    const chunks = [];
    let totalBytes = 0;
    let timedOut = false;

    const timeoutId = globalThis.setTimeout(() => {
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
            if (signal && signal.aborted) {
                reader.cancel().catch(() => {
                    // The read is abandoned either way.
                });
                throw abortError(file);
            }

            chunks.push(chunk.value);
            totalBytes += chunk.value.byteLength;
            if (onProgress) {
                onProgress(totalBytes, file.size);
            }
        }

        // The in-loop check above throws first when the watchdog fires mid-read;
        // this post-loop check only trips if the final read completes (done) in
        // the same tick the watchdog fires, which the unit clock does not stage.
        /* v8 ignore next 3 */
        if (timedOut) {
            throw new Error(`Reading ${file.name} timed out.`);
        }
    } finally {
        globalThis.clearTimeout(timeoutId);
    }

    // Both read paths share decodeBytes: strict UTF-8 validation with a
    // windows-1252 fallback and the character-count limit applied after
    // decoding. Peak memory stays bounded by the upstream MAX_FILE_BYTES cap.
    return decodeBytes(concatChunks(chunks, totalBytes), file.name);
}
