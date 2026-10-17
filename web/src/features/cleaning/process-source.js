/**
 * Read and clean one CSV source for a worker.
 *
 * A stored upload streams through the cleaner chunk by chunk, so the worker
 * never holds the whole file as one string. When the stream cannot finish as
 * the requested type, the source is read whole and cleaned that way instead, so
 * results and messages match the whole-text path.
 */

import { toCsvSource } from "../../shared/csv-source.js";
import { canStreamFileText, readCsvSource, streamFileText } from "../upload/read.js";

import { LinkedInCleaner } from "./cleaner.js";

/** @typedef {import("./cleaner.js").ProcessResult} ProcessResult */

/**
 * Options for one streamed clean.
 * @typedef {object} StreamCleanOptions
 * @property {((record: Record<string, unknown>) => void)|null} [onRecord] - Receives each parsed record
 * @property {() => void} [onRestart] - Runs before the file is sent again in another encoding
 * @property {AbortSignal} [signal] - Stops the read when aborted
 * @property {(bytesRead: number, totalBytes: number) => void} [onProgress] - Called as bytes arrive
 */

/**
 * Stream a stored upload through the cleaner chunk by chunk. When the stream
 * restarts in another encoding, the cleaner starts over too.
 * @param {File} file - Stored upload
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
 * Clean a stored upload or CSV text as one file type.
 * @param {unknown} source - Stored upload Blob or CSV text
 * @param {string} fileType - File type to clean as
 * @returns {Promise<ProcessResult>}
 */
export async function processCsvSource(source, fileType) {
    const value = toCsvSource(source);
    if (typeof value !== "string" && canStreamFileText(/** @type {File} */ (value))) {
        const { processed } = await streamCleanFile(/** @type {File} */ (value));
        if (processed && processed.fileType === fileType) {
            return processed;
        }
    }
    return LinkedInCleaner.process(await readCsvSource(source), fileType);
}
