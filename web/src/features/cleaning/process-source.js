/**
 * Read and clean one CSV source for a worker.
 *
 * Stream File and Blob sources when streaming is available. If streaming
 * cannot finish as the requested type, read the source as one string. Use the
 * whole-text cleaner so results and error messages match.
 */

import { toCsvSource } from "../../shared/csv-source.js";
import { canStreamFileText, readCsvSource, streamFileText } from "../upload/read.js";

import { LinkedInCleaner } from "./cleaner.js";

/** @typedef {import("./cleaner.js").ProcessResult} ProcessResult */

/**
 * Options for one streamed clean.
 * @typedef {object} StreamCleanOptions
 * @property {((record: Record<string, unknown>) => void)|null} [onRecord] - Receives each parsed record
 * @property {() => void} [onRestart] - Runs before reading the file again in another encoding
 * @property {AbortSignal} [signal] - Stops the read when aborted
 * @property {(bytesRead: number, totalBytes: number) => void} [onProgress] - Called as bytes arrive
 */

/**
 * Stream a file through the cleaner chunk by chunk. When the stream
 * restarts in another encoding, the cleaner starts over too.
 * @param {File} file - File to read
 * @param {StreamCleanOptions} [options] - Record, restart, cancellation, and progress hooks
 * @returns {Promise<{usedFallback: boolean, processed: ProcessResult|null}>} Processed is null when the stream cannot finish
 */
export async function streamCleanFile(file, options = {}) {
    const { onRecord = null, onRestart = () => {}, ...readOptions } = options;
    let processor = LinkedInCleaner.createStreamProcessor(onRecord);
    const { usedFallback } = await streamFileText(file, {
        ...readOptions,
        onText: (text) => {
            processor.push(text);
        },
        onRestart: () => {
            onRestart();
            processor = LinkedInCleaner.createStreamProcessor(onRecord);
        },
    });
    return { usedFallback, processed: processor.finish() };
}

/**
 * Clean a Blob or CSV text as one file type.
 * @param {unknown} source - File, Blob, or CSV text
 * @param {string} fileType - File type to clean as
 * @param {{signal?: AbortSignal}} [options] - Stops the read when aborted
 * @returns {Promise<ProcessResult>} Rejects when the read fails or is aborted
 */
export async function processCsvSource(source, fileType, { signal } = {}) {
    const value = toCsvSource(source);
    if (typeof value !== "string" && canStreamFileText(/** @type {File} */ (value))) {
        const { processed } = await streamCleanFile(/** @type {File} */ (value), { signal });
        signal?.throwIfAborted();
        if (processed && processed.fileType === fileType) {
            return processed;
        }
    }
    const text = await readCsvSource(source);
    // An abort during a whole read lands here; skip the clean it no longer needs.
    signal?.throwIfAborted();
    return LinkedInCleaner.process(text, fileType);
}
