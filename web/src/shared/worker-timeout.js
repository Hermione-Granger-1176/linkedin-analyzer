/**
 * Shared timeout calculation for parsing workers.
 *
 * The Messages screen and PDF export transports use the same size-based budget.
 * Requests with the same input size receive the same timeout.
 *
 * Larger files need more time to parse. A fixed timeout can terminate a worker
 * that is still processing and trigger an unnecessary main-thread fallback.
 */

import { csvSourceSize } from "./csv-source.js";

// A base allowance, plus more time for every whole megabyte of CSV.
const WORKER_TIMEOUT_BASE_MS = 30000;
const WORKER_TIMEOUT_PER_MB_MS = 5000;
const BYTES_PER_MB = 1024 * 1024;

/**
 * Compute a size-scaled worker watchdog timeout.
 *
 * Accept any number of sources so callers pass only the files sent to the worker.
 * @param {...(Blob|string|null|undefined)} sources - CSV text or stored upload for every file the worker is given
 * @returns {number} Timeout in milliseconds
 */
export function computeWorkerTimeout(...sources) {
    const size = sources.reduce((total, source) => total + csvSourceSize(source), 0);
    const megabytes = size / BYTES_PER_MB;
    return WORKER_TIMEOUT_BASE_MS + Math.floor(megabytes) * WORKER_TIMEOUT_PER_MB_MS;
}
