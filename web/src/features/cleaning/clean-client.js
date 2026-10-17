/**
 * Page-side client for the Clean screen's worker.
 *
 * One request is in flight at a time: a new one settles the previous as a
 * failure, and the screen ignores replies for a selection it has moved past.
 * Where Workers are unavailable the same job runs on the main thread.
 */

import { parseCleaningWorkerMessage } from "../../app/worker-contracts.js";
import { captureError } from "../../platform/observability/sentry.js";
import { MAIN_THREAD_MAX_FILE_BYTES } from "../../shared/limits.js";
import { createWorkerHandle } from "../../shared/worker-handle.js";
import { computeWorkerTimeout } from "../../shared/worker-timeout.js";

import { runCleanJob } from "./clean-job.js";

// Fixed text: a failure inside the worker can carry a row of the user's file.
const CLEAN_FAILURE = "Unable to parse file.";
const MAIN_THREAD_TOO_LARGE =
    "This file is too large to clean without background workers. Open this page from a local server.";

/** @typedef {import("../../app/worker-contracts.js").CleaningRequestPayload} CleaningRequestPayload */
/** @typedef {{success: boolean, error: string|null, rowCount: number, previewRows: string[][], blob: Blob|null}} CleanReply */

let requestCount = 0;
/** @type {{id: number, resolve: (reply: CleanReply) => void}|null} */
let pending = null;

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
 * @param {string} [error] - Failure text
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

/** Terminate the worker and fail whatever it was answering. */
function terminateCleanWorker() {
    workers.terminate();
    settle(failure());
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

/** A worker that fell over cannot answer; start a fresh one next time. */
function onError() {
    captureError(new Error("Cleaning worker failed."), {
        module: "clean",
        operation: "worker-error",
    });
    terminateCleanWorker();
}

/**
 * Run the job on the main thread, reporting a fixed error if it throws. A file
 * above the main-thread limit is refused rather than risk freezing the tab.
 * @param {CleaningRequestPayload} payload - Request payload
 * @returns {Promise<CleanReply>}
 */
async function runOnMainThread(payload) {
    const { source } = payload;
    const size = typeof source === "string" ? source.length : source.size;
    if (size > MAIN_THREAD_MAX_FILE_BYTES) {
        return failure(MAIN_THREAD_TOO_LARGE);
    }
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
    const active = workers.ensure();
    if (!active) {
        return runOnMainThread(payload);
    }
    settle(failure());
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
            terminateCleanWorker();
        });
        try {
            active.postMessage({ type: "clean", requestId: id, payload });
        } catch {
            terminateCleanWorker();
        }
    });
}
