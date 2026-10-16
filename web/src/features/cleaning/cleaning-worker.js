/* LinkedIn Analyzer - Clean screen worker: preview, Excel, and CSV builds */

import { parseCleaningWorkerRequest } from "../../app/worker-contracts.js";

import { runCleanJob } from "./clean-job.js";

const RUNTIME_FAILURE = "Cleaning worker runtime failure.";

/**
 * Post a failure under a request id. Only fixed text leaves the worker: a
 * thrown value can carry a row of the user's export.
 * @param {number|string} requestId - Request id being answered
 * @param {string} error - Fixed failure text
 */
function postFailure(requestId, error) {
    self.postMessage({
        type: "cleaned",
        requestId,
        payload: { success: false, error, rowCount: 0, previewRows: [], blob: null },
    });
}

/**
 * Answer one raw worker message.
 * @param {unknown} data - Raw message data
 * @returns {Promise<void>}
 */
export async function handleMessage(data) {
    const parsed = parseCleaningWorkerRequest(data);
    if (!parsed.valid) {
        postFailure(parsed.requestId, parsed.error || "Invalid worker request payload.");
        return;
    }
    try {
        self.postMessage({
            type: "cleaned",
            requestId: parsed.value.requestId,
            payload: await runCleanJob(parsed.value.payload),
        });
    } catch {
        postFailure(parsed.value.requestId, RUNTIME_FAILURE);
    }
}

/* v8 ignore next 3 */
if (typeof self !== "undefined" && typeof window === "undefined") {
    self.addEventListener("message", (event) => handleMessage(event.data));
}
