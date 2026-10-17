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
 * Clean a stored upload or CSV text as one file type.
 * @param {unknown} source - Stored upload Blob or CSV text
 * @param {string} fileType - File type to clean as
 * @returns {Promise<ProcessResult>}
 */
export async function processCsvSource(source, fileType) {
    const value = toCsvSource(source);
    if (typeof value !== "string" && canStreamFileText(/** @type {File} */ (value))) {
        let processor = LinkedInCleaner.createStreamProcessor();
        await streamFileText(/** @type {File} */ (value), {
            onText: (text) => {
                processor.push(text);
            },
            onRestart: () => {
                processor = LinkedInCleaner.createStreamProcessor();
            },
        });
        const streamed = processor.finish();
        if (streamed && streamed.fileType === fileType) {
            return streamed;
        }
    }
    return LinkedInCleaner.process(await readCsvSource(source), fileType);
}
