/**
 * The watchdog budget a parsing worker is given.
 *
 * Four transports arm a watchdog over a worker parsing raw CSV: the Messages
 * screen's own, and the PDF export's three. One budget across all of them is
 * the point, because two of them hand their workers the very same pair of
 * files, and two different allowances over one export was an accident of one
 * module having been written first.
 *
 * It lived in `features/messages/format.js` for exactly that reason: the
 * Messages screen needed it before anything else did. By the time the export
 * had three transports of its own, all four callers were reaching across
 * features into a module whose own header calls it the messages page.
 *
 * Scaled to input size rather than fixed. A real export runs to tens of
 * megabytes, and a fixed allowance generous enough for a small one cuts a large
 * one off mid-parse, sending to the UI thread a parse the worker was still
 * doing.
 */

// A base allowance, plus more time for every whole megabyte of CSV.
const WORKER_TIMEOUT_BASE_MS = 30000;
const WORKER_TIMEOUT_PER_MB_MS = 5000;
const BYTES_PER_MB = 1024 * 1024;

/**
 * Compute a size-scaled worker watchdog timeout.
 *
 * Variadic so each caller passes only the files it actually hands the worker.
 * The connections transport used to pad the call with an empty messages file it
 * does not have, which read as a fact about that transport rather than as
 * filler for a fixed second parameter.
 * @param {...string} texts - Raw CSV text for every file the worker is given
 * @returns {number} Timeout in milliseconds
 */
export function computeWorkerTimeout(...texts) {
    const characters = texts.reduce((total, text) => total + text.length, 0);
    const megabytes = characters / BYTES_PER_MB;
    return WORKER_TIMEOUT_BASE_MS + Math.floor(megabytes) * WORKER_TIMEOUT_PER_MB_MS;
}
