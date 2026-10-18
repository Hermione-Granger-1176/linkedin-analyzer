/**
 * Page-side client for the Clean screen's worker.
 *
 * One request is in flight at a time: a new one stops the worker answering the
 * previous request and settles it as cancelled, which the screen ignores.
 * Where Workers are unavailable the same job runs on the main thread. Clearing
 * stored data drops the worker and the rows it holds.
 */

import { parseCleaningWorkerMessage } from "../../app/worker-contracts.js";
import { captureError } from "../../platform/observability/sentry.js";
import { DataCache } from "../../platform/persistence/data-cache.js";
import { computeWorkerTimeout } from "../../shared/worker-timeout.js";

import { resetCleanJob, runCleanJob } from "./clean-job.js";

// Fixed text: a failure inside the worker can carry a row of the user's file.
const CLEAN_FAILURE = "Unable to parse file.";
const CLEAN_TIMEOUT = "Cleaning took too long. Try again.";

/** @typedef {{success: boolean, error: string|null, rowCount: number, previewRows: string[][], blob: Blob|null, cancelled?: boolean}} CleanReply */

/** @type {Worker|null} */
let worker = null;
let requestCount = 0;
/** @type {{id: number, resolve: (reply: CleanReply) => void, timeoutId: number}|null} */
let pending = null;

/**
 * Build a failed reply.
 * @param {string|null} [error] - Failure text, or null for a cancelled request
 * @returns {CleanReply}
 */
function failure(error = CLEAN_FAILURE) {
    return { success: false, error, rowCount: 0, previewRows: [], blob: null };
}

/**
 * Settle the request in flight, if any.
 * @param {CleanReply} reply - Outcome to settle it with
 */
function settle(reply) {
    if (!pending) {
        return;
    }
    const { resolve, timeoutId } = pending;
    pending = null;
    window.clearTimeout(timeoutId);
    resolve(reply);
}

/**
 * Terminate the worker and settle whatever it was answering.
 * @param {CleanReply} [reply] - Outcome for the request in flight
 */
function terminateCleanWorker(reply = failure()) {
    if (worker) {
        worker.terminate();
        worker = null;
    }
    settle(reply);
}

/**
 * Read one worker message into the reply for the request in flight.
 * @param {MessageEvent} event - Worker message event
 */
function onMessage(event) {
    const parsed = parseCleaningWorkerMessage(event.data);
    if (!parsed.valid || !pending || parsed.value.requestId !== pending.id) {
        return;
    }
    settle(parsed.value.payload);
}

/**
 * A worker that fell over, or a reply that cannot be read, cannot answer;
 * start a fresh worker next time.
 * @param {Event} event - Worker error or messageerror event
 */
function onError(event) {
    // Handled here; keep the browser from also logging it as uncaught.
    event.preventDefault();
    captureError(new Error("Cleaning worker failed."), {
        module: "clean",
        operation: "worker-error",
    });
    terminateCleanWorker();
}

/**
 * Create the worker on first use, or leave it null where Workers are missing.
 * @returns {Worker|null}
 */
function getWorker() {
    if (worker || typeof Worker === "undefined") {
        return worker;
    }
    try {
        worker = new Worker(new URL("./cleaning-worker.js", import.meta.url), { type: "module" });
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        worker.addEventListener("messageerror", onError);
    } catch {
        worker = null;
        captureError(new Error("Cleaning worker could not start."), {
            module: "clean",
            operation: "worker-init",
        });
    }
    return worker;
}

/**
 * Run the job on the main thread, reporting a fixed error if it throws.
 * @param {object} payload - Request payload
 * @returns {Promise<CleanReply>}
 */
async function runOnMainThread(payload) {
    try {
        return await runCleanJob(payload);
    } catch {
        captureError(new Error(CLEAN_FAILURE), { module: "clean", operation: "main-thread-clean" });
        return failure();
    }
}

/**
 * Ask for one output of a stored upload: the preview, an Excel workbook, or a
 * cleaned CSV.
 * @param {{fileType: string, output: "preview"|"xlsx"|"csv", source: Blob|string, key: string}} payload - Request payload
 * @returns {Promise<CleanReply>}
 */
export function requestClean(payload) {
    const active = getWorker();
    if (!active) {
        return runOnMainThread(payload);
    }
    if (pending) {
        // The worker may still be busy with the abandoned job; a fresh one
        // starts on this request instead of waiting behind it.
        terminateCleanWorker({ ...failure(null), cancelled: true });
        return requestClean(payload);
    }
    const id = ++requestCount;
    return new Promise((resolve) => {
        // A workbook takes longer than a clean, so a download gets twice the budget.
        const budget =
            computeWorkerTimeout(payload.source) * (payload.output === "preview" ? 1 : 2);
        const timeoutId = window.setTimeout(() => {
            captureError(new Error("Cleaning worker timed out."), {
                module: "clean",
                operation: "worker-timeout",
            });
            terminateCleanWorker(failure(CLEAN_TIMEOUT));
        }, budget);
        pending = { id, resolve, timeoutId };
        try {
            active.postMessage({ type: "clean", requestId: id, payload });
        } catch {
            terminateCleanWorker();
        }
    });
}

// Clearing stored data must not leave the last file's cleaned rows in memory.
DataCache.subscribe((event) => {
    if (event && event.type === "storageCleared") {
        terminateCleanWorker({ ...failure(null), cancelled: true });
        resetCleanJob();
    }
});
