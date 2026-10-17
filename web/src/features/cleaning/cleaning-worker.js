/* LinkedIn Analyzer - Clean screen worker: preview, Excel, and CSV builds */

import { parseCleaningWorkerRequest } from "../../app/worker-contracts.js";
import { serveWorker } from "../../shared/worker-entry.js";

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

/** Answers one raw worker message; exported so tests can drive it. */
export const handleMessage = serveWorker({
    requestType: "clean",
    parse: parseCleaningWorkerRequest,
    handle: async (request) => {
        self.postMessage({
            type: "cleaned",
            requestId: request.requestId,
            payload: await runCleanJob(request.payload),
        });
    },
    postFailure,
    runtimeFailure: RUNTIME_FAILURE,
});
