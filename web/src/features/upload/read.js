/**
 * File-to-text reading for uploads.
 *
 * Picks between a streaming read for large files and a FileReader read for
 * small ones, then hands the raw bytes to the shared decoder. Every function
 * here derives its result from its arguments and holds no upload page state,
 * so the page owns orchestration and this module owns only how bytes are read.
 * Nothing here touches the DOM, so the analytics worker reads uploads with it.
 */

import { toCsvSource } from "../../shared/csv-source.js";
import { MAX_CSV_CHARS, MAX_FILE_BYTES } from "../../shared/limits.js";

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
 * Read a worker's CSV source as text. Text passes through unchanged; a stored
 * upload Blob is decoded the same way an upload is, so every screen sees the
 * text the upload produced.
 * Anything else reads as empty text.
 * @param {unknown} source - Stored upload or CSV text
 * @returns {Promise<string>}
 */
export async function readCsvSource(source) {
    const value = toCsvSource(source);
    if (typeof value === "string") {
        return value;
    }
    const { text } = await readFileAsText(/** @type {File} */ (value));
    return text;
}

/**
 * Read an optional CSV source, such as Connections. A file that cannot be read
 * counts as absent, and `failed` tells the caller to warn about it.
 * @param {Blob|string|null|undefined} source - Stored upload or CSV text
 * @returns {Promise<{text: string, failed: boolean}>}
 */
export async function readOptionalCsvSource(source) {
    try {
        return { text: await readCsvSource(source), failed: false };
    } catch {
        return { text: "", failed: true };
    }
}

/**
 * Read several CSV sources for a main-thread fallback parse, or resolve null
 * when any of them cannot be read.
 * @param {...(Blob|string)} sources - Stored uploads or CSV text
 * @returns {Promise<string[]|null>}
 */
export async function readCsvSourcesOrNull(...sources) {
    try {
        return await Promise.all(sources.map((source) => readCsvSource(source)));
    } catch {
        return null;
    }
}

/**
 * Cancel a stream reader whose read is being abandoned, ignoring a failed cancel.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader - Stream reader
 */
function cancelReader(reader) {
    reader.cancel().catch(() => {
        // The read is abandoned either way.
    });
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
        cancelReader(reader);
    }, FILE_READ_TIMEOUT_MS);

    try {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            if (timedOut) {
                throw new Error(`Reading ${file.name} timed out.`);
            }
            if (signal && signal.aborted) {
                cancelReader(reader);
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

/**
 * @typedef {object} StreamTextOptions
 * @property {AbortSignal} [signal] - Stops the read when aborted
 * @property {(bytesRead: number, totalBytes: number) => void} [onProgress] - Called as bytes arrive
 * @property {(text: string) => void} onText - Receives each decoded text chunk in order
 * @property {() => void} onRestart - Called before re-reading from the start as windows-1252
 */

/** Thrown inside decodeStream when the bytes are not valid UTF-8. */
class Utf8DecodeError extends Error {}

/**
 * Check whether the streaming text read can run in this environment.
 * @param {File} file - Uploaded file
 * @returns {boolean}
 */
export function canStreamFileText(file) {
    return typeof file.stream === "function" && typeof TextDecoder !== "undefined";
}

/**
 * Read a File as decoded text chunks without holding the whole file.
 *
 * Decodes as strict UTF-8 in streaming mode. On a decode error it calls
 * onRestart and reads the File again from the start as windows-1252, matching
 * decodeBytes(). The character limit applies as a running count with the same
 * message. The timeout applies to each chunk read rather than the whole file,
 * because the caller may parse and clean between chunks.
 * @param {File} file - Uploaded file
 * @param {StreamTextOptions} options - Chunk, restart, cancellation, and progress hooks
 * @returns {Promise<{usedFallback: boolean}>}
 */
export async function streamFileText(file, options) {
    try {
        await decodeStream(file, "utf-8", options);
        return { usedFallback: false };
    } catch (error) {
        if (!(error instanceof Utf8DecodeError)) {
            throw error;
        }
    }
    options.onRestart();
    await decodeStream(file, "windows-1252", options);
    return { usedFallback: true };
}

/**
 * Read one chunk, rejecting when it takes longer than the read timeout.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader - Stream reader
 * @param {File} file - Uploaded file
 * @returns {Promise<ReadableStreamReadResult<Uint8Array>>}
 */
function readChunkWithTimeout(reader, file) {
    let timeoutId;
    const timeout = new Promise((_resolve, reject) => {
        timeoutId = globalThis.setTimeout(() => {
            // Reject first: cancelling settles the pending read with done, which
            // would otherwise win the race and pass a partial file as complete.
            reject(new Error(`Reading ${file.name} timed out.`));
            cancelReader(reader);
        }, FILE_READ_TIMEOUT_MS);
    });
    return Promise.race([reader.read(), timeout]).finally(() => {
        globalThis.clearTimeout(timeoutId);
    });
}

/**
 * Stream and decode a File once with the given encoding.
 * @param {File} file - Uploaded file
 * @param {string} encoding - "utf-8" (strict) or "windows-1252"
 * @param {StreamTextOptions} options - Chunk, cancellation, and progress hooks
 * @returns {Promise<void>}
 */
async function decodeStream(file, encoding, { signal, onProgress, onText }) {
    const decoder = new TextDecoder(encoding, { fatal: encoding === "utf-8" });
    const reader = file.stream().getReader();
    let bytesRead = 0;
    let totalChars = 0;

    const emit = (bytes, stream) => {
        let text;
        try {
            text = decoder.decode(bytes, { stream });
        } catch {
            cancelReader(reader);
            throw new Utf8DecodeError();
        }
        totalChars += text.length;
        if (totalChars > MAX_CSV_CHARS) {
            cancelReader(reader);
            const maxMb = Math.round(MAX_CSV_CHARS / (1024 * 1024));
            throw new Error(`"${file.name}" exceeds the ${maxMb}MB text limit.`);
        }
        if (text) {
            onText(text);
        }
    };

    for (
        let chunk = await readChunkWithTimeout(reader, file);
        !chunk.done;
        chunk = await readChunkWithTimeout(reader, file)
    ) {
        if (signal && signal.aborted) {
            cancelReader(reader);
            throw abortError(file);
        }
        bytesRead += chunk.value.byteLength;
        emit(chunk.value, true);
        if (onProgress) {
            onProgress(bytesRead, file.size);
        }
    }
    emit(undefined, false);
}
