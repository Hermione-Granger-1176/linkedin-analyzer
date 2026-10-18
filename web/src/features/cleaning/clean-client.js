/**
 * Page-side client for the Clean screen's worker.
 *
 * One request is in flight at a time: a new one stops the worker answering the
 * previous request and settles it as cancelled, which the screen ignores.
 * Where Workers are unavailable the same job runs on the main thread, where it
 * cannot be stopped, so a superseded run's result is reported as cancelled
 * instead. Clearing stored data drops the worker and the rows it holds.
 */

import { parseCleaningWorkerMessage } from "../../app/worker-contracts.js";
import { captureError } from "../../platform/observability/sentry.js";
import { DataCache } from "../../platform/persistence/data-cache.js";
import { MAIN_THREAD_MAX_FILE_BYTES } from "../../shared/limits.js";
import { createWorkerHandle } from "../../shared/worker-handle.js";
import { computeWorkerTimeout } from "../../shared/worker-timeout.js";

import { resetCleanJob, runCleanJob } from "./clean-job.js";

// Fixed text: a failure inside the worker can carry a row of the user's file.
const CLEAN_FAILURE = "Unable to parse file.";
const CLEAN_TIMEOUT = "Cleaning took too long. Try again.";
const MAIN_THREAD_TOO_LARGE =
    "This file is too large to clean without background workers. Open this page from a local server.";

/** @typedef {import("../../app/worker-contracts.js").CleaningRequestPayload} CleaningRequestPayload */
/** @typedef {{success: boolean, error: string|null, rowCount: number, previewRows: string[][], blob: Blob|null, cancelled?: boolean}} CleanReply */

let requestCount = 0;
/** @type {{id: number, resolve: (reply: CleanReply) => void}|null} */
let pending = null;
// Main-thread runs: the latest one started, and how many Clears have happened.
let fallbackRun = 0;
let clearCount = 0;

const workers = createWorkerHandle({
    create: () => new Worker(new URL("./cleaning-worker.js", import.meta.url), { type: "module" }),
    onMessage,
    onError,
    onStartError: () => {
        captureError(new Error("Cleaning worker could not start."), {
            module: "clean",
            operation: "worker-init",
        });
    },
});

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
    const { resolve } = pending;
    pending = null;
    workers.unwatch();
    resolve(reply);
}

/**
 * Terminate the worker and settle whatever it was answering.
 * @param {CleanReply} [reply] - Outcome for the request in flight
 */
function terminateCleanWorker(reply = failure()) {
    workers.terminate();
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

/** @returns {CleanReply} */
function cancelled() {
    return { ...failure(null), cancelled: true };
}

/**
 * Run the job on the main thread, reporting a fixed error if it throws. A file
 * above the main-thread limit is refused rather than risk freezing the tab. A
 * run that a newer request or a Clear overtook reports cancelled, and one that
 * outlived a Clear drops the rows it kept.
 * @param {CleaningRequestPayload} payload - Request payload
 * @returns {Promise<CleanReply>}
 */
async function runOnMainThread(payload) {
    const run = ++fallbackRun;
    const clears = clearCount;
    const { source } = payload;
    const size = typeof source === "string" ? source.length : source.size;
    if (size > MAIN_THREAD_MAX_FILE_BYTES) {
        return failure(MAIN_THREAD_TOO_LARGE);
    }
    let reply;
    try {
        reply = await runCleanJob(payload);
    } catch {
        captureError(new Error(CLEAN_FAILURE), { module: "clean", operation: "main-thread-clean" });
        reply = failure();
    }
    if (clears !== clearCount) {
        resetCleanJob();
        return cancelled();
    }
    return run === fallbackRun ? reply : cancelled();
}

/**
 * Ask for one output of a stored upload: the preview, an Excel workbook, or a
 * cleaned CSV.
 * @param {{fileType: string, output: "preview"|"xlsx"|"csv", source: Blob|string, key: string}} payload - Request payload
 * @returns {Promise<CleanReply>}
 */
export function requestClean(payload) {
    const active = workers.ensure();
    if (!active) {
        return runOnMainThread(payload);
    }
    if (pending) {
        // The worker may still be busy with the abandoned job; a fresh one
        // starts on this request instead of waiting behind it.
        terminateCleanWorker(cancelled());
        return requestClean(payload);
    }
    const id = ++requestCount;
    return new Promise((resolve) => {
        // A workbook takes longer than a clean, so a download gets twice the budget.
        const budget =
            computeWorkerTimeout(payload.source) * (payload.output === "preview" ? 1 : 2);
        pending = { id, resolve };
        workers.watch(budget, () => {
            captureError(new Error("Cleaning worker timed out."), {
                module: "clean",
                operation: "worker-timeout",
            });
            terminateCleanWorker(failure(CLEAN_TIMEOUT));
        });
        try {
            active.postMessage({ type: "clean", requestId: id, payload });
        } catch {
            terminateCleanWorker();
        }
    });
}

// Clearing stored data must not leave the last file's cleaned rows in memory.
DataCache.subscribe((event) => {
    const type = /** @type {{type?: string}|null} */ (event)?.type;
    if (type === "storageCleared") {
        clearCount += 1;
        terminateCleanWorker(cancelled());
        resetCleanJob();
    }
});
